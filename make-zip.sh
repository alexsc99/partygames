#!/usr/bin/env bash
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_FILE="${1:-$HOME/partygame-$(date +%Y%m%d-%H%M%S).zip}"

cd "$SRC_DIR"
zip -r "$OUT_FILE" . \
  -x "node_modules/*" \
  -x "logs/*" \
  -x "backups/*" \
  -x "*.zip" \
  -x "data/.host-secret" \
  -x "data/used.json"

echo "ZIP erstellt: $OUT_FILE ($(du -h "$OUT_FILE" | cut -f1))"
