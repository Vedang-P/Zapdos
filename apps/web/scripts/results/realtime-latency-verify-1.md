# Realtime latency (Socket.IO + Redis adapter, 2 instances)

Generated 2026-11-14T04:42:24.736Z. Reproduce: `pnpm --filter web bench:realtime`.

| path | n | mean ms | p50 | p90 | p95 | p99 | p99.9 | max |
|---|---|---|---|---|---|---|---|---|
| same instance (no Redis hop) | 5000 | 1.675 | 1.139 | 2.356 | 4.136 | **15.199** | 40.431 | 54.932 |
| cross instance (Redis pub/sub) | 5000 | 2.787 | 2.056 | 3.854 | 6.241 | **18.922** | 44.469 | 80.533 |
| HTTP bridge ack (POST /emit round trip) | 5000 | 2.018 | 1.478 | 2.908 | 4.684 | **16.015** | 40.621 | 54.987 |

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
      29.2,
      35.55,
      39.99
    ],
    "loadavg_after": [
      31.11,
      35.48,
      39.84
    ]
  }
}
```
