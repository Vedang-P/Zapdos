# Realtime latency (Socket.IO + Redis adapter, 2 instances)

Generated 2026-11-14T04:37:42.586Z. Reproduce: `pnpm --filter web bench:realtime`.

| path | n | mean ms | p50 | p90 | p95 | p99 | p99.9 | max |
|---|---|---|---|---|---|---|---|---|
| same instance (no Redis hop) | 5000 | 1.243 | 1.016 | 1.701 | 2.62 | **7.317** | 19.949 | 38.506 |
| cross instance (Redis pub/sub) | 5000 | 2.228 | 1.823 | 3.002 | 4.847 | **10.067** | 20.312 | 42.978 |
| HTTP bridge ack (POST /emit round trip) | 5000 | 1.523 | 1.316 | 2.173 | 3.165 | **8.206** | 20.021 | 38.907 |

p99 < 20 ms: same-instance **true**, cross-instance **true**.

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
    "achieved_rate_per_s": 249.5,
    "payload_bytes": 252,
    "redis": "local Docker redis:7-alpine with requirepass"
  },
  "machine": {
    "platform": "darwin 27.2.0",
    "cpus": 8,
    "cpu_model": "Apple M1",
    "node": "v22.14.0",
    "loadavg_before": [
      36.62,
      45.3,
      44.24
    ],
    "loadavg_after": [
      31.51,
      43.48,
      43.62
    ]
  }
}
```
