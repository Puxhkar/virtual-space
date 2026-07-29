#!/usr/bin/env bash
#
# The phase gate (CLAUDE.md §36).
#
# Every check gates on its real exit code. An earlier version of this used
# `cmd && echo PASS || echo FAIL` inline and printed PASS unconditionally,
# which hid two real lint errors — hence the explicit `run` helper.
#
#   pnpm verify              full gate
#   pnpm verify --fast       skip e2e, build and migration checks
#
set -uo pipefail
cd "$(dirname "$0")/.."

FAST=0
[[ "${1:-}" == "--fast" ]] && FAST=1

PASS=0
FAIL=0
FAILED_NAMES=()

run() {
  local name="$1"
  shift
  printf '  %-42s' "$name"
  if output=$("$@" 2>&1); then
    printf 'PASS\n'
    PASS=$((PASS + 1))
  else
    printf 'FAIL\n'
    FAIL=$((FAIL + 1))
    FAILED_NAMES+=("$name")
    echo "$output" | tail -25 | sed 's/^/      | /'
  fi
}

echo ""
echo "static analysis"
run "typecheck (all packages)" pnpm typecheck
run "lint" pnpm lint
run "format" pnpm format:check

echo ""
echo "tests"
run "shared unit" pnpm --filter @vo/shared test
run "server unit + integration" pnpm --filter @vo/server test

if [[ $FAST -eq 0 ]]; then
  run "browser end-to-end" pnpm --filter @vo/web e2e

  echo ""
  echo "build"
  run "shared package" pnpm --filter @vo/shared build
  run "web production build" pnpm --filter @vo/web build
  run "server build" pnpm --filter @vo/server build

  echo ""
  echo "runtime"
  run "migrations apply to an empty database" bash scripts/check-migrations.sh
  run "server boots and reports healthy" bash scripts/check-boot.sh
fi

echo ""
if [[ $FAIL -eq 0 ]]; then
  echo "GATE GREEN — $PASS checks passed. Proceed to the next phase."
  exit 0
fi

echo "GATE RED — $FAIL of $((PASS + FAIL)) checks failed:"
for name in "${FAILED_NAMES[@]}"; do echo "  - $name"; done
echo ""
echo "Fix the current phase before starting the next one."
exit 1
