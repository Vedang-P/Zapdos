# Realtime latency (Socket.IO + Redis adapter, 2 instances)

Generated 2026-11-14T04:30:47.247Z. Reproduce: `pnpm --filter web bench:realtime`.

| path | n | mean ms | p50 | p90 | p95 | p99 | p99.9 | max |
|---|---|---|---|---|---|---|---|---|
| same instance (no Redis hop) | 5000 | 2.191 | 1.361 | 3.616 | 6.143 | **16.821** | 67.817 | 97.73 |
| cross instance (Redis pub/sub) | 5000 | 3.858 | 2.425 | 6.573 | 11.226 | **23.616** | 89.514 | 113.384 |
| HTTP bridge ack (POST /emit round trip) | 5000 | 2.584 | 1.733 | 4.264 | 6.872 | **17.642** | 77.603 | 97.99 |

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
    "target_rate_per_s": 100,
    "achieved_rate_per_s": 99.9,
    "payload_bytes": 252,
    "redis": "local Docker redis:7-alpine with requirepass"
  },
  "machine": {
    "platform": "darwin 27.2.0",
    "cpus": 8,
    "cpu_model": "Apple M1",
    "node": "v22.14.0",
    "loadavg_before": [
      32.4,
      42.09,
      42.39
    ],
    "loadavg_after": [
      33.8,
      40.85,
      41.91
    ]
  }
}
```
