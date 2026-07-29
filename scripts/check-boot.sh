#!/usr/bin/env bash
# Starts the built server, waits for health, then shuts it down cleanly.
# Catches the class of failure that only appears outside the dev watcher.
set -uo pipefail
cd "$(dirname "$0")/../apps/server"

PORT=4123
DATABASE_URL="${DATABASE_URL:-postgres://vo:vo_local_dev_only@localhost:5432/virtual_office}"

PORT=$PORT \
DATABASE_URL="$DATABASE_URL" \
WEB_ORIGIN="http://localhost:3100" \
BETTER_AUTH_URL="http://localhost:$PORT" \
BETTER_AUTH_SECRET="verification-only-secret-not-used-anywhere-real" \
NODE_ENV=production \
  node dist/index.js > /tmp/vo-boot.log 2>&1 &
PID=$!

cleanup() { kill -TERM "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; }
trap cleanup EXIT

for _ in $(seq 1 40); do
  if curl -fsS "http://localhost:$PORT/healthz" >/dev/null 2>&1; then
    ready=$(curl -fsS "http://localhost:$PORT/readyz" 2>/dev/null || echo "")
    if [[ "$ready" != *'"database":true'* ]]; then
      echo "readyz did not report a healthy database: $ready"
      exit 1
    fi
    echo "booted and healthy on :$PORT"
    exit 0
  fi
  sleep 0.25
done

echo "server did not become healthy"
tail -20 /tmp/vo-boot.log
exit 1
