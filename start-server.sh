#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

if pgrep -f "$DIR/server.js" >/dev/null 2>&1 || pgrep -x node >/dev/null 2>&1; then
  echo "Server läuft bereits."
  exit 0
fi

setsid -f node "$DIR/server.js" >/tmp/partygame.log 2>&1 </dev/null
sleep 1
echo "Server gestartet (Log: /tmp/partygame.log)"
cat /tmp/partygame.log || true
