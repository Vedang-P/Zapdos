# Realtime latency (Socket.IO + Redis adapter, 2 instances)

Generated 2026-11-14T04:43:20.688Z. Reproduce: `pnpm --filter web bench:realtime`.

| path | n | mean ms | p50 | p90 | p95 | p99 | p99.9 | max |
|---|---|---|---|---|---|---|---|---|
| same instance (no Redis hop) | 5000 | 1.735 | 1.147 | 2.635 | 4.546 | **14.032** | 32.634 | 54.083 |
| cross instance (Redis pub/sub) | 5000 | 2.971 | 2.097 | 4.398 | 7.354 | **20.214** | 45.86 | 58.479 |
| HTTP bridge ack (POST /emit round trip) | 5000 | 2.122 | 1.519 | 3.18 | 5.237 | **14.984** | 36.137 | 57.329 |

p99 < 20 ms: same-instance **true**, cross-instance **false**.

Deliveries: expected 11000, received 11000, emit failures 0.

```json
{
  "config": {
    "clients": 200,
    "matches": 100,
    "instances": 2,
    "transport": "websocket",
    "measured_events": 5000,
    "warmup_events": 500,
    "target_rate_per_s": 250,
    "achieved_rate_per_s": 249.4,
    "payload_bytes": 252,
    "redis": "local Docker redis:7-alpine with requirepass"
  },
  "machine": {
    "platform": "darwin 27.2.0",
    "cpus": 8,
    "cpu_model": "Apple M1",
    "node": "v22.14.0",
    "loadavg_before": [
      41.09,
      37.43,
      40.37
    ],
    "loadavg_after": [
      45.31,
      38.74,
      40.75
    ]
  }
}
```
