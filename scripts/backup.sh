#!/usr/bin/env bash
# Sichert die veränderlichen Daten (eigene Fragen & Karten, abgeschaltete Karten, Verlauf, Raum-Snapshot, Host-PIN) nach backups/.
# Behält die neuesten 14 Sicherungen, ältere werden gelöscht. Gibt den Pfad der neuen Datei aus.
#
#   scripts/backup.sh                   # aus dem App-Verzeichnis oder per absolutem Pfad
#   /opt/partygame/scripts/backup.sh    # z. B. per systemd-Timer (partygame-backup.timer)
#
# Läuft als schultheissa (Gruppe games) oder als games: backups/ wird gruppenbeschreibbar (2770)
# angelegt, die Archive sind nicht für andere lesbar (enthalten den Host-PIN).
set -euo pipefail

APP_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
BACKUP_DIR="$APP_DIR/backups"
KEEP=14
FILES=(data/custom.json data/customcards.json data/disabledcards.json data/used.json data/rooms.json data/.host-secret)

umask 007
cd "$APP_DIR"

include=()
for f in "${FILES[@]}"; do
  [ -e "$f" ] || continue
  if [ -r "$f" ]; then
    include+=("$f")
  else
    echo "Warnung: $f nicht lesbar für $(id -un) – wird übersprungen" >&2
  fi
done
if [ ${#include[@]} -eq 0 ]; then
  echo "Nichts zu sichern (keine der Dateien vorhanden)."
  exit 0
fi

if [ ! -d "$BACKUP_DIR" ]; then
  mkdir -p "$BACKUP_DIR"
  chmod 2770 "$BACKUP_DIR" 2>/dev/null || true
fi

target="$BACKUP_DIR/data-$(date +%Y%m%d-%H%M).tgz"
tmp="$(mktemp "$BACKUP_DIR/.data-tmp.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
tar -czf "$tmp" "${include[@]}"
chmod 660 "$tmp"
mv -f "$tmp" "$target"
trap - EXIT

# Rotation: Dateinamen sind nach Datum sortierbar, die neuesten KEEP bleiben.
shopt -s nullglob
export LC_ALL=C
backups=("$BACKUP_DIR"/data-*.tgz)
excess=$(( ${#backups[@]} - KEEP ))
for (( i = 0; i < excess; i++ )); do
  rm -f -- "${backups[$i]}"
done

echo "$target"
