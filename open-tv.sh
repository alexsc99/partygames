#!/usr/bin/env bash
set -euo pipefail

URL="${1:-http://127.0.0.1:3002/host}"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"
export MOZ_ENABLE_WAYLAND=1

if pgrep -x firefox >/dev/null 2>&1; then
  setsid -f firefox --new-tab "$URL" >/tmp/partygame-tv.log 2>&1 </dev/null
else
  setsid -f firefox --kiosk "$URL" >/tmp/partygame-tv.log 2>&1 </dev/null
  sleep 4
  setsid -f firefox --new-tab "$URL" >/tmp/partygame-tv.log 2>&1 </dev/null
fi

echo "TV-Ansicht geöffnet: $URL"
