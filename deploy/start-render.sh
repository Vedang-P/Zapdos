#!/usr/bin/env bash
set -euo pipefail

# Render sets PORT (10000 by default). The realtime server and the web bridge
# both run inside this one container, so prefer a loopback address.
export REALTIME_URL="${REALTIME_URL:-http://127.0.0.1:${PORT:-10000}}"
export REALTIME_PORT="${REALTIME_PORT:-${PORT:-10000}}"

# Local Redis for the matchmaking queue and Socket.IO adapter. Render's free
# plan has no managed Redis, and Upstash's free tier is too small for the 2s
# matchmaker poll. Nothing here needs persistence between deploys.
redis-server \
  --port 6379 \
  --bind 127.0.0.1 \
  --save "" \
  --appendonly no \
  --maxmemory 96mb \
  --maxmemory-policy allkeys-lru \
  --daemonize yes

for _ in $(seq 1 50); do
  if redis-cli ping >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done
if ! redis-cli ping >/dev/null 2>&1; then
  echo "[render] Redis failed to start" >&2
  exit 1
fi

pnpm --filter web exec tsx server/index.ts &
REALTIME_PID=$!

pnpm --filter web exec tsx server/workers.ts &
WORKERS_PID=$!

shutdown() {
  kill -TERM "$REALTIME_PID" "$WORKERS_PID" 2>/dev/null || true
  redis-cli shutdown nosave >/dev/null 2>&1 || true
  wait "$REALTIME_PID" "$WORKERS_PID" 2>/dev/null || true
}
trap shutdown TERM INT

# If either process dies, tear the other one down and exit non-zero so Render
# restarts the service instead of leaving it half-alive.
set +e
wait -n "$REALTIME_PID" "$WORKERS_PID"
STATUS=$?
set -e

shutdown
exit "$STATUS"
