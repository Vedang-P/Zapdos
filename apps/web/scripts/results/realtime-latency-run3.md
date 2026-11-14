# Realtime latency (Socket.IO + Redis adapter, 2 instances)

Generated 2026-11-14T04:35:27.072Z. Reproduce: `pnpm --filter web bench:realtime`.

| path | n | mean ms | p50 | p90 | p95 | p99 | p99.9 | max |
|---|---|---|---|---|---|---|---|---|
| same instance (no Redis hop) | 5000 | 1.705 | 1.129 | 2.353 | 3.814 | **15.984** | 50.813 | 60.267 |
| cross instance (Redis pub/sub) | 5000 | 3.183 | 2.075 | 4.009 | 6.712 | **27.252** | 99.643 | 114.072 |
| HTTP bridge ack (POST /emit round trip) | 5000 | 2.075 | 1.511 | 2.902 | 4.433 | **16.028** | 51.047 | 60.442 |

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
      55.42,
      47.27,
      44.43
    ],
    "loadavg_after": [
      53.01,
      47.41,
      44.56
    ]
  }
}
```
