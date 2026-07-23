#!/usr/bin/env bash
# Stop the demo dev servers cleanly. The start script launches `npm run dev`
# with setsid, so the recorded PID is a process-GROUP leader - killing the
# group takes down turbo and every next/nest child, not just npm (killing
# only the top PID was exactly the bug that left stale servers running with
# old env). Falls back to pattern kills for untracked strays.
set -uo pipefail

PID_FILE=/tmp/irie-dev.pid
QUIET="${1:-}"
say() { [[ "$QUIET" == "quiet" ]] || echo "$@"; }

if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    say "==> Stopping dev process group ${PID}"
    kill -TERM -- "-${PID}" 2>/dev/null || kill -TERM "$PID" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "$PID" 2>/dev/null || break
      sleep 1
    done
    kill -0 "$PID" 2>/dev/null && kill -KILL -- "-${PID}" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
fi

# Strays from runs started outside the pid file (e.g. manual `npm run dev`).
pkill -f "turbo run dev" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
pkill -f "nest start" 2>/dev/null || true

say "==> Demo servers stopped"
