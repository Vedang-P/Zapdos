# Realtime latency benchmark (Socket.IO + Redis pub/sub)

Resume claim under test: *"Socket.IO + Redis pub/sub at p99 < 20 ms"*.

`pnpm --filter web bench:realtime` ([`apps/web/scripts/bench-realtime.ts`](../apps/web/scripts/bench-realtime.ts)) starts **two real
instances** of the realtime server (`apps/web/server/index.ts`) on ports 3112 and 3113, both using the
`@socket.io/redis-adapter` against the same Redis, then:

1. creates 100 matches / 200 users in Postgres (removed afterwards) and connects **200 socket.io clients** over WebSocket
   with real HMAC tokens - player A of every match to instance 1, player B to instance 2 - and joins them to their `match:<id>` room;
2. publishes **500 warm-up + 5,000 measured events** at 250/s (open loop) through the HMAC-signed `POST /emit` bridge, the
   same path the web app and matchmaker use, alternating which instance receives the POST;
3. timestamps each event with `process.hrtime` just before the POST and again when a client receives it (one process, one
   monotonic clock) and splits the deliveries by path:
   * **same-instance** - the room member connected to the instance that received the POST (no Redis hop);
   * **cross-instance** - the member on the other instance, delivered through Redis pub/sub.

The latency therefore **includes the HTTP bridge hop**. `cross - same` is the cost of the Redis fan-out. Payload: 252 bytes.
Every run delivered 11,000 of 11,000 expected messages with 0 emit failures.

## Results

MacBook (Apple M1, 8 cores, macOS 27.2), Node 22.14, Redis 7 and Postgres 16 in Docker Desktop. Everything is on localhost, so this is
**not** a production network measurement. The laptop was never idle: iCloud Drive's `bird`/`fileproviderd` daemons used 50-100% of a core
the whole session (load average ~30 with nothing else running), so two regimes are reported separately.

**A. Quiet window** - no other CPU-heavy jobs running (load average 29-37, caused by the system daemons alone):

| run | same-instance p50 / p95 / **p99** / max (ms) | cross-instance p50 / p95 / **p99** / max (ms) | p99 < 20 ms? |
|---|---|---|---|
| final 1 | 1.02 / 2.62 / **7.32** / 38.5 | 1.82 / 4.85 / **10.07** / 43.0 | yes / yes |
| final 2 (median run, canonical `realtime-latency.json`) | 1.00 / 2.45 / **8.54** / 31.4 | 1.81 / 3.91 / **12.43** / 42.3 | yes / yes |
| final 3 | 1.04 / 6.39 / **13.02** / 42.5 | 1.91 / 10.57 / **18.81** / 42.8 | yes / yes |

**B. Earlier runs**, taken while other jobs were active on the machine (installs, test suites and a data download were running in parallel; I did not log which job overlapped which run; load average 31-55):

| run | load | same-instance p99 (ms) | cross-instance p50 / p95 / **p99** / max (ms) |
|---|---|---|---|
| run 1 | 52.7 | 19.19 | 2.26 / 13.33 / **23.77** / 67.0 |
| run 2 | 45.4 | 24.01 | 2.95 / 16.54 / **30.53** / 65.3 |
| run 3 | 55.4 | 15.98 | 2.08 / 6.71 / **27.25** / 114.1 |
| earlier run | 30.7 | 18.60 | 2.09 / 11.20 / **25.11** / 43.5 |
| 100 events/s instead of 250 | 32.4 | 16.82 | 2.43 / 11.23 / **23.62** / 113.4 |

Raw data: [`apps/web/scripts/results/`](../apps/web/scripts/results) (`realtime-latency*.json|md`; a 20-client smoke run is also there and is too small to be meaningful).

### Reading it honestly

* **The claim held in 3 of 3 quiet-window runs** (cross-instance p99 10.1, 12.4, 18.8 ms; same-instance 7.3, 8.5, 13.0 ms) and **the cross-instance p99 was
  above 20 ms in 5 of 5 earlier runs** (23.6-30.5 ms), all taken while other jobs were active. So the number is real but **sensitive to what else is running**,
  and the margin is thin: the third quiet run, with slightly more background load, reached 18.8 ms. Run it on an idle machine before quoting it.
* **Medians are tiny**: ~1.0 ms same-instance and ~1.8-1.9 ms cross-instance, so the Redis hop costs about 0.8 ms at the median.
* **The tail is scheduling noise, not the code path.** Maxima of 30-114 ms are single dropped scheduler quanta. Cutting the rate from 250/s to 100/s did not
  improve the tail, and there is no logging or other avoidable work on the `/emit` -> broadcast hot path.
* Suggested wording that is fully supported: *"p99 < 20 ms (median ~2 ms) for cross-instance fan-out through Socket.IO + Redis pub/sub across two
  server instances, 200 connections at 250 events/s, measured on localhost"*. Say that it is a localhost measurement if asked.

## Reproduce

```bash
docker compose up -d postgres redis          # Zapdos compose: Postgres 16 + Redis 7 (requirepass)
pnpm install && pnpm db:generate && pnpm db:push
pnpm --filter web bench:realtime             # writes apps/web/scripts/results/realtime-latency.{json,md}
# knobs: BENCH_CLIENTS=200 BENCH_EVENTS=5000 BENCH_WARMUP=500 BENCH_RATE=250 BENCH_PAYLOAD_PAD=200 BENCH_OUT_NAME=custom.json
```

Run it when `uptime` shows a low load average; the benchmark records the load average before and after.
