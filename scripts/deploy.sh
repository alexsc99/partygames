#!/usr/bin/env bash
# Deploy auf dem Server (als schultheissa in /opt/partygame ausführen).
# Holt main, installiert Abhängigkeiten nur bei Änderungen und startet partygame neu –
# aber nur, wenn gerade niemand verbunden ist (laufende Räume werden gesichert und wiederhergestellt,
# trotzdem soll ein Neustart kein Spiel unterbrechen).
# Antwortet der Server nach dem Neustart nicht innerhalb von 30 s mit der neuen Version auf /health,
# wird automatisch auf den vorherigen Stand zurückgerollt.
#
#   scripts/deploy.sh                 # abbrechen, falls jemand verbunden ist
#   scripts/deploy.sh --wait          # warten, bis niemand mehr verbunden ist
#   scripts/deploy.sh --force         # trotzdem neu starten
#   scripts/deploy.sh --rev <sha>     # genau diesen Commit deployen (auto-deploy.sh: der von der CI geprüfte)
#   scripts/deploy.sh --from <quelle> # andere Git-Quelle (z. B. Bundle-Datei), Standard: origin
#
# Exit: 0 = deployt, 1 = abgebrochen/Fehler (nichts geändert), 3 = neuer Stand lief nicht → zurückgerollt
set -euo pipefail
cd "$(dirname "$0")/.."

WAIT=0 FORCE=0 SRC=origin REV=""
while [ $# -gt 0 ]; do
  case "$1" in
    --wait) WAIT=1 ;;
    --force) FORCE=1 ;;
    --from) SRC="$2"; shift ;;
    --rev) REV="$2"; shift ;;
    *) echo "Unbekannte Option: $1" >&2; exit 2 ;;
  esac
  shift
done

PORT=$(systemctl show partygame -p Environment --value | tr ' ' '\n' | sed -n 's/^PORT=//p')
PORT=${PORT:-3002}
HEALTH_URL="http://127.0.0.1:$PORT/health"
HEALTH_TIMEOUT_S=${HEALTH_TIMEOUT_S:-30}
active_sockets() {
  curl -fsS "$HEALTH_URL" | grep -o '"sockets":[0-9]*' | cut -d: -f2 || echo 0
}

# Ohne saubere Arbeitskopie könnte ein Rollback (git reset --hard) lokale Änderungen löschen
if ! git diff --quiet HEAD --; then
  echo "Abbruch: lokale Änderungen an versionierten Dateien in $(pwd) – bitte erst klären (git status)." >&2
  exit 1
fi

while :; do
  n=$(active_sockets)
  if [ "${n:-0}" = 0 ] || [ "$FORCE" = 1 ]; then break; fi
  if [ "$WAIT" = 1 ]; then
    echo "Noch $n Verbindung(en) aktiv – warte 30 s…"
    sleep 30
  else
    echo "Abbruch: $n Verbindung(en) aktiv. Mit --wait warten oder mit --force trotzdem neu starten." >&2
    exit 1
  fi
done

before=$(git rev-parse HEAD)
git fetch -q "$SRC" main
target=$(git rev-parse --verify "${REV:-FETCH_HEAD}^{commit}")
git merge --ff-only -q "$target"

deps_changed() { ! git diff --quiet "$1" "$2" -- package.json package-lock.json; }
restart() { sudo -n /usr/bin/systemctl restart partygame; }
# Gesund = /health antwortet mit der Version aus package.json des ausgecheckten Stands
healthy() {
  local want
  want=$(node -p "require('./package.json').version")
  for _ in $(seq 1 "$HEALTH_TIMEOUT_S"); do
    sleep 1
    if curl -fsS --max-time 2 "$HEALTH_URL" 2>/dev/null | grep -q "\"version\":\"$want\""; then return 0; fi
  done
  return 1
}

if deps_changed "$before" HEAD; then npm ci --omit=dev; fi
restart
if healthy; then
  curl -fsS "$HEALTH_URL"; echo
  git log --oneline -1
  exit 0
fi

echo "FEHLER: ${target:0:7} antwortet nach ${HEALTH_TIMEOUT_S} s nicht auf $HEALTH_URL – Rollback auf ${before:0:7}" >&2
git reset -q --hard "$before"
if deps_changed "$target" HEAD; then npm ci --omit=dev; fi
restart
if healthy; then
  echo "Rollback ok: $(git log --oneline -1)" >&2
else
  echo "Rollback: Server antwortet auch mit ${before:0:7} nicht – bitte journalctl -u partygame prüfen!" >&2
fi
exit 3
