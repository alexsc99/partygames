#!/usr/bin/env bash
# Automatisches Deploy für den systemd-Timer (partygame-autodeploy.timer, alle 5 min).
# Deployt origin/main nur, wenn
#   - origin/main ein Fast-Forward von HEAD ist und
#   - alle GitHub-Check-Runs des Commits "completed" mit "success" sind
# und ruft dann scripts/deploy.sh --from origin auf (ohne --force: bei aktiven Verbindungen
# bricht deploy.sh ab, der nächste Timer-Lauf versucht es erneut).
#
#   scripts/auto-deploy.sh        # als schultheissa in /opt/partygame (braucht git, curl, node)
#
# Ausgabe: knappe Zeilen auf stdout (journald). Wiederholte gleiche Meldungen zum selben Commit
# werden unterdrückt (Zustand in .git/partygame-auto-deploy.state).
# Exit: 0 = nichts zu tun / übersprungen / verschoben / deployt, 1 = Fehler (kein Fast-Forward,
# GitHub-API nicht erreichbar, deploy.sh fehlgeschlagen).
set -euo pipefail
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.."

REPO="alexsc99/partygames"
NO_CI_GRACE_S=$((30 * 60))
STATE_FILE="$(git rev-parse --git-dir)/partygame-auto-deploy.state"

log() { echo "auto-deploy: $*"; }
# Meldung nur einmal pro Commit+Status ausgeben (Timer läuft alle 5 min)
log_once() {
  local key="$1"; shift
  if [ "$(cat "$STATE_FILE" 2>/dev/null || true)" != "$key" ]; then
    log "$*"
    printf '%s\n' "$key" > "$STATE_FILE" 2>/dev/null || true
  fi
}

for cmd in git curl node; do
  command -v "$cmd" >/dev/null || { log "$cmd nicht im PATH ($PATH)"; exit 1; }
done

git fetch -q origin main
head=$(git rev-parse HEAD)
remote=$(git rev-parse origin/main)
[ "$head" = "$remote" ] && exit 0
short=${remote:0:7}

if ! git merge-base --is-ancestor "$head" "$remote"; then
  log_once "$remote noff" "origin/main ($short) ist kein Fast-Forward von HEAD (${head:0:7}) – manuell prüfen"
  exit 1
fi

if ! json=$(curl -fsS --max-time 10 \
    -H 'Accept: application/vnd.github+json' -H 'User-Agent: partygame-auto-deploy' \
    "https://api.github.com/repos/$REPO/commits/$remote/check-runs?per_page=100"); then
  log "GitHub-API nicht erreichbar (Check-Runs für $short)"
  exit 1
fi

# Ausgabe: "success <n>" | "pending <namen>" | "failed <name=ergebnis,…>" | "none"
ci=$(printf '%s' "$json" | node -e '
let s = "";
process.stdin.on("data", d => { s += d; }).on("end", () => {
  const runs = (JSON.parse(s).check_runs) || [];
  if (!runs.length) return console.log("none");
  const pending = runs.filter(r => r.status !== "completed");
  if (pending.length) return console.log("pending " + pending.map(r => r.name).join(","));
  const bad = runs.filter(r => r.conclusion !== "success");
  if (bad.length) return console.log("failed " + bad.map(r => r.name + "=" + r.conclusion).join(","));
  console.log("success " + runs.length);
});') || { log "Antwort der GitHub-API nicht lesbar (Check-Runs für $short)"; exit 1; }

case "$ci" in
  success*) ;;
  pending*)
    log_once "$remote pending" "CI für $short läuft noch (${ci#pending }) – warte"
    exit 0 ;;
  failed*)
    log_once "$remote failed" "CI für $short fehlgeschlagen (${ci#failed }) – kein Deploy"
    exit 0 ;;
  none)
    age=$(( $(date +%s) - $(git log -1 --format=%ct "$remote") ))
    if [ "$age" -ge "$NO_CI_GRACE_S" ]; then
      log_once "$remote noci" "keine CI-Check-Runs für $short nach $((age / 60)) min – übersprungen"
    else
      log_once "$remote waitci" "noch keine CI-Check-Runs für $short – warte (max. 30 min)"
    fi
    exit 0 ;;
  *)
    log "unerwartete CI-Auswertung für $short: $ci"
    exit 1 ;;
esac

log "deploye $short ($(git log -1 --format=%s "$remote"))"
rc=0
out=$(scripts/deploy.sh --from origin 2>&1) || rc=$?
if [ "$rc" -ne 0 ]; then
  if grep -q '^Abbruch: .*Verbindung' <<<"$out"; then
    # Spieler verbunden – kein Fehler, nächster Timer-Lauf versucht es erneut
    log_once "$remote deferred" "verschoben: $(grep '^Abbruch:' <<<"$out" | head -1)"
    exit 0
  fi
  printf '%s\n' "$out"
  log "deploy.sh fehlgeschlagen (Exit $rc)"
  exit "$rc"
fi
printf '%s\n' "$out"
now=$(git rev-parse HEAD)
if [ "$now" != "$remote" ]; then
  # deploy.sh holt origin/main erneut – ein inzwischen gepushter Commit wäre ungeprüft
  log "WARNUNG: deployt wurde ${now:0:7} statt geprüftem $short (neuer Push während des Deploys)"
fi
printf '%s\n' "$remote deployed" > "$STATE_FILE" 2>/dev/null || true
log "fertig: $short läuft"
