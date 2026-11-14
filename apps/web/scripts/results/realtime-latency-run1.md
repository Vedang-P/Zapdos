# Realtime latency (Socket.IO + Redis adapter, 2 instances)

Generated 2026-11-14T04:34:33.269Z. Reproduce: `pnpm --filter web bench:realtime`.

| path | n | mean ms | p50 | p90 | p95 | p99 | p99.9 | max |
|---|---|---|---|---|---|---|---|---|
| same instance (no Redis hop) | 5000 | 2.604 | 1.207 | 6.181 | 9.628 | **19.185** | 43.809 | 53.757 |
| cross instance (Redis pub/sub) | 5000 | 4.085 | 2.26 | 8.986 | 13.33 | **23.766** | 48.803 | 66.957 |
| HTTP bridge ack (POST /emit round trip) | 5000 | 2.946 | 1.583 | 6.754 | 10.187 | **19.531** | 43.878 | 54.392 |

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
      52.72,
      45.99,
      43.86
    ],
    "loadavg_after": [
      45.99,
      44.93,
      43.54
    ]
  }
}
```
