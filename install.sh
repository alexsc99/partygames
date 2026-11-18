#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

echo "=== PartyGame v3.3.0 Installer ==="

# 1. Node.js prüfen (>= 18)
need_node=0
if ! command -v node >/dev/null 2>&1; then
  need_node=1
else
  NODE_MAJOR="$(node -v | sed -E "s/^v([0-9]+).*/\1/")"
  if [ "${NODE_MAJOR:-0}" -lt 18 ]; then
    echo "Gefundene Node.js-Version $(node -v) ist zu alt (benötigt >= 18)."
    need_node=1
  fi
fi

if [ "$need_node" -eq 1 ]; then
  if [ "$(id -u)" -eq 0 ] && command -v apt-get >/dev/null 2>&1; then
    echo "Installiere Node.js 20 LTS (Debian/Ubuntu)..."
    apt-get update -qq
    apt-get install -y -qq curl ca-certificates gnupg
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y -qq nodejs
  else
    echo "Fehler: Node.js >= 18 wird benötigt."
    echo "Bitte zuerst installieren (z. B. unter Ubuntu/Debian):"
    echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
    echo "  sudo apt-get install -y nodejs"
    exit 1
  fi
fi

echo "Node.js: $(node -v), npm: $(npm -v)"

# 2. Abhängigkeiten installieren
echo "Installiere npm-Pakete..."
npm install --omit=dev
mkdir -p logs

# 3. Optional: systemd-Service einrichten
if [ "${1:-}" = "--systemd" ]; then
  if [ "$(id -u)" -ne 0 ]; then
    echo "Für --systemd bitte mit sudo ausführen: sudo ./install.sh --systemd"
    exit 1
  fi
  PORT_VAL="${PORT:-3000}"
  PUBLIC_URL_VAL="${PUBLIC_URL:-http://$(hostname -I | awk "{print \$1}"):${PORT_VAL}}"
  ALLOWED_ORIGINS_VAL="${ALLOWED_ORIGINS:-${PUBLIC_URL_VAL},http://localhost:${PORT_VAL},http://127.0.0.1:${PORT_VAL}}"

  if ! id -u partygame >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin partygame
  fi
  chown -R partygame:partygame "$APP_DIR"

  cat << SERVICE > /etc/systemd/system/partygame.service
[Unit]
Description=PartyGame Multiplayer Server
After=network.target

[Service]
Type=simple
User=partygame
Group=partygame
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=PORT=${PORT_VAL}
Environment=HOST=0.0.0.0
Environment=PUBLIC_URL=${PUBLIC_URL_VAL}
Environment=ALLOWED_ORIGINS=${ALLOWED_ORIGINS_VAL}
ExecStart=/usr/bin/node ${APP_DIR}/server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
SERVICE

  systemctl daemon-reload
  systemctl enable --now partygame.service
  echo ""
  echo "systemd-Service installiert und gestartet!"
  echo "Status prüfen: systemctl status partygame.service"
  echo "Erreichbar unter: http://localhost:${PORT_VAL} (bzw. ${PUBLIC_URL_VAL})"
else
  echo ""
  echo "Installation abgeschlossen!"
  echo "Starten (Vordergrund):   npm start"
  echo "Starten (Hintergrund):   ./start-server.sh"
  echo "Als systemd-Service:     sudo ./install.sh --systemd"
  echo "Standard-Port:           3000 (anpassbar mit PORT=3002 npm start)"
fi
