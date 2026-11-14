# Realtime latency (Socket.IO + Redis adapter, 2 instances)

Generated 2026-11-14T04:25:29.243Z. Reproduce: `pnpm --filter web bench:realtime`.

| path | n | mean ms | p50 | p90 | p95 | p99 | p99.9 | max |
|---|---|---|---|---|---|---|---|---|
| same instance (no Redis hop) | 300 | 2.35 | 1.844 | 3.919 | 5.599 | **10.608** | 33.535 | 33.535 |
| cross instance (Redis pub/sub) | 300 | 3.852 | 3.106 | 5.77 | 7.123 | **12.504** | 34.309 | 34.309 |
| HTTP bridge ack (POST /emit round trip) | 300 | 2.985 | 2.479 | 5.245 | 6.732 | **11.164** | 34.124 | 34.124 |

p99 < 20 ms: same-instance **true**, cross-instance **true**.

Deliveries: expected 700, received 700, emit failures 0.

```json
{
  "config": {
    "clients": 20,
    "matches": 10,
    "instances": 2,
    "transport": "websocket",
    "measured_events": 300,
    "warmup_events": 50,
    "target_rate_per_s": 100,
    "achieved_rate_per_s": 98.8,
    "payload_bytes": 251,
    "redis": "local Docker redis:7-alpine with requirepass"
  },
  "machine": {
    "platform": "darwin 27.2.0",
    "cpus": 8,
    "cpu_model": "Apple M1",
    "node": "v22.14.0",
    "loadavg_before": [
      30.77,
      56.43,
      46.21
    ],
    "loadavg_after": [
      29.75,
      55.79,
      46.04
    ]
  }
}
```
