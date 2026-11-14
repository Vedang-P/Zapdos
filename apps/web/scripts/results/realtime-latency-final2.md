# Realtime latency (Socket.IO + Redis adapter, 2 instances)

Generated 2026-11-14T04:38:16.913Z. Reproduce: `pnpm --filter web bench:realtime`.

| path | n | mean ms | p50 | p90 | p95 | p99 | p99.9 | max |
|---|---|---|---|---|---|---|---|---|
| same instance (no Redis hop) | 5000 | 1.26 | 0.999 | 1.677 | 2.452 | **8.54** | 19.862 | 31.359 |
| cross instance (Redis pub/sub) | 5000 | 2.191 | 1.806 | 2.74 | 3.905 | **12.433** | 30.314 | 42.254 |
| HTTP bridge ack (POST /emit round trip) | 5000 | 1.543 | 1.312 | 2.122 | 2.911 | **9.445** | 28.827 | 31.599 |

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
      30.31,
      42.82,
      43.38
    ],
    "loadavg_after": [
      29.04,
      41.4,
      42.85
    ]
  }
}
```
