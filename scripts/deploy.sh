#!/usr/bin/env bash
# Deploy auf dem Server (als schultheissa in /opt/partygame ausführen).
# Holt main, installiert Abhängigkeiten nur bei Änderungen und startet partygame neu –
# aber nur, wenn gerade niemand verbunden ist (ein Neustart löscht alle laufenden Räume).
#
#   scripts/deploy.sh                 # abbrechen, falls jemand verbunden ist
#   scripts/deploy.sh --wait          # warten, bis niemand mehr verbunden ist
#   scripts/deploy.sh --force         # trotzdem neu starten
#   scripts/deploy.sh --from <quelle> # andere Git-Quelle (z. B. Bundle-Datei), Standard: origin
set -euo pipefail
cd "$(dirname "$0")/.."

WAIT=0 FORCE=0 SRC=origin
while [ $# -gt 0 ]; do
  case "$1" in
    --wait) WAIT=1 ;;
    --force) FORCE=1 ;;
    --from) SRC="$2"; shift ;;
    *) echo "Unbekannte Option: $1" >&2; exit 2 ;;
  esac
  shift
done

PORT=$(systemctl show partygame -p Environment --value | tr ' ' '\n' | sed -n 's/^PORT=//p')
PORT=${PORT:-3002}
active_sockets() {
  curl -fsS "http://127.0.0.1:$PORT/health" | grep -o '"sockets":[0-9]*' | cut -d: -f2 || echo 0
}

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
git merge --ff-only -q FETCH_HEAD
if ! git diff --quiet "$before" HEAD -- package.json package-lock.json; then
  npm ci --omit=dev
fi
sudo -n /usr/bin/systemctl restart partygame
sleep 1
curl -fsS "http://127.0.0.1:$PORT/health"; echo
git log --oneline -1
