# Realtime latency (Socket.IO + Redis adapter, 2 instances)

Generated 2026-11-14T04:38:43.351Z. Reproduce: `pnpm --filter web bench:realtime`.

| path | n | mean ms | p50 | p90 | p95 | p99 | p99.9 | max |
|---|---|---|---|---|---|---|---|---|
| same instance (no Redis hop) | 5000 | 1.772 | 1.039 | 3.881 | 6.39 | **13.02** | 26.188 | 42.459 |
| cross instance (Redis pub/sub) | 5000 | 3.197 | 1.908 | 7.048 | 10.571 | **18.806** | 30.658 | 42.753 |
| HTTP bridge ack (POST /emit round trip) | 5000 | 2.047 | 1.357 | 4.229 | 6.812 | **13.162** | 30.257 | 42.623 |

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
      29.04,
      41.4,
      42.85
    ],
    "loadavg_after": [
      30.08,
      40.68,
      42.55
    ]
  }
}
```
