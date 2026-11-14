# Realtime latency (Socket.IO + Redis adapter, 2 instances)

Generated 2026-11-14T04:35:00.401Z. Reproduce: `pnpm --filter web bench:realtime`.

| path | n | mean ms | p50 | p90 | p95 | p99 | p99.9 | max |
|---|---|---|---|---|---|---|---|---|
| same instance (no Redis hop) | 5000 | 3.303 | 1.468 | 7.646 | 12.11 | **24.011** | 49.139 | 61.901 |
| cross instance (Redis pub/sub) | 5000 | 5.228 | 2.95 | 11.44 | 16.536 | **30.533** | 52.388 | 65.325 |
| HTTP bridge ack (POST /emit round trip) | 5000 | 3.595 | 1.779 | 8.156 | 12.422 | **24.24** | 49.192 | 62.231 |

p99 < 20 ms: same-instance **false**, cross-instance **false**.

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
      45.35,
      44.81,
      43.5
    ],
    "loadavg_after": [
      55.42,
      47.27,
      44.43
    ]
  }
}
```
