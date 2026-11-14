# Realtime latency (Socket.IO + Redis adapter, 2 instances)

Generated 2026-11-14T04:42:52.586Z. Reproduce: `pnpm --filter web bench:realtime`.

| path | n | mean ms | p50 | p90 | p95 | p99 | p99.9 | max |
|---|---|---|---|---|---|---|---|---|
| same instance (no Redis hop) | 5000 | 1.841 | 1.132 | 2.547 | 4.99 | **18.637** | 44.226 | 47.856 |
| cross instance (Redis pub/sub) | 5000 | 3.232 | 2.073 | 4.394 | 8.273 | **30.634** | 55 | 71.508 |
| HTTP bridge ack (POST /emit round trip) | 5000 | 2.192 | 1.49 | 3.021 | 5.531 | **19.083** | 44.258 | 48.187 |

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
      31.74,
      35.54,
      39.83
    ],
    "loadavg_after": [
      40.4,
      37.24,
      40.32
    ]
  }
}
```
