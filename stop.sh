#!/usr/bin/env bash
set -euo pipefail

pkill -x node 2>/dev/null && echo "Server gestoppt." || echo "Server lief nicht."

if [[ "${1:-}" == "--all" ]]; then
  pkill -x firefox 2>/dev/null && echo "Firefox gestoppt." || echo "Firefox lief nicht."
fi
