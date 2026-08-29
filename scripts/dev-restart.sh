#!/usr/bin/env bash
# Restarts the dev servers, leaving nothing behind.
#
# Killing whatever holds ports 4000 and 3100 is not enough: an instance that
# failed to bind stays alive, keeps its database pool, and competes for every
# connection. Seven of them accumulated during one session and starved the
# gateway tests into a 30s hook timeout that looked like a real failure.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pkill -f "$root/apps/server" 2>/dev/null || true
pkill -f "$root.*next" 2>/dev/null || true
for port in 4000 3100; do
  pid="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  [ -n "$pid" ] && kill -TERM $pid 2>/dev/null || true
done

# Wait for the ports to actually free, rather than assuming.
for _ in $(seq 1 30); do
  if ! lsof -tiTCP:4000 -sTCP:LISTEN >/dev/null 2>&1 &&
     ! lsof -tiTCP:3100 -sTCP:LISTEN >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if [ "${1:-}" = "--stop" ]; then
  echo "dev servers stopped"
  exit 0
fi

cd "$root"
pnpm dev > /tmp/vo-dev.log 2>&1 &

for _ in $(seq 1 90); do
  if curl -sf http://localhost:4000/healthz >/dev/null 2>&1 &&
     curl -sf http://localhost:3100/ >/dev/null 2>&1; then
    echo "dev servers up: api :4000, web :3100"
    exit 0
  fi
  sleep 1
done

echo "dev servers did not come up; see /tmp/vo-dev.log" >&2
tail -20 /tmp/vo-dev.log >&2
exit 1
