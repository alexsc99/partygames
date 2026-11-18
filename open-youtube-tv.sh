#!/usr/bin/env bash
set -euo pipefail

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"

UA="Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.93 Safari/537.36 TV"
PROFILE_DIR="$HOME/.config/youtube-tv-profile"

setsid -f chromium \
  --ozone-platform=wayland \
  --password-store=basic \
  --user-data-dir="$PROFILE_DIR" \
  --user-agent="$UA" \
  --app="https://www.youtube.com/tv" \
  --start-fullscreen \
  >/tmp/youtube-tv.log 2>&1 </dev/null

echo "YouTube TV gestartet (Log: /tmp/youtube-tv.log)"
