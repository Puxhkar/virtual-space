#!/usr/bin/env bash
# Sweeps browsers left behind by an interrupted end-to-end run.
#
# Playwright cleans up when it exits normally. Killed mid-run — a timeout, a
# cancelled job — its browsers survive. Nine of them accumulated during one
# session, holding 4GB and pushing the machine into swap: load average 15 with
# the CPU idle. The suite then failed eight tests and took twenty minutes,
# which looked exactly like an application regression and was not.
#
# Run this before trusting a red end-to-end result.
set -uo pipefail

before="$(pgrep -f 'headless_shell|Chromium|chrome-mac' 2>/dev/null | wc -l | tr -d ' ')"

pkill -f 'playwright' 2>/dev/null || true
pkill -f 'headless_shell' 2>/dev/null || true
pkill -f 'ms-playwright.*[Cc]hrom' 2>/dev/null || true
sleep 2

after="$(pgrep -f 'headless_shell|Chromium|chrome-mac' 2>/dev/null | wc -l | tr -d ' ')"
echo "swept $((before - after)) orphaned browser process(es); $after remaining"

# A machine already in swap will fail the suite whatever the code does, so say
# so rather than letting it look like a test failure.
if [ "$(uname)" = "Darwin" ]; then
  used="$(sysctl -n vm.swapusage | sed -n 's/.*used = \([0-9.]*\)M.*/\1/p')"
  if [ -n "$used" ] && [ "${used%%.*}" -gt 4096 ]; then
    echo "warning: ${used}M of swap in use — end-to-end timings will be unreliable" >&2
  fi
fi
