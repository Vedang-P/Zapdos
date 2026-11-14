# Realtime latency (Socket.IO + Redis adapter, 2 instances)

Generated 2026-11-14T04:26:03.969Z. Reproduce: `pnpm --filter web bench:realtime`.

| path | n | mean ms | p50 | p90 | p95 | p99 | p99.9 | max |
|---|---|---|---|---|---|---|---|---|
| same instance (no Redis hop) | 5000 | 1.935 | 0.997 | 3.96 | 7.33 | **18.596** | 31.092 | 35.122 |
| cross instance (Redis pub/sub) | 5000 | 3.494 | 2.091 | 6.982 | 11.201 | **25.112** | 35.413 | 43.488 |
| HTTP bridge ack (POST /emit round trip) | 5000 | 2.203 | 1.249 | 4.419 | 7.744 | **19.061** | 31.228 | 35.298 |

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
      30.72,
      55.15,
      45.93
    ],
    "loadavg_after": [
      30.81,
      53.28,
      45.52
    ]
  }
}
```
