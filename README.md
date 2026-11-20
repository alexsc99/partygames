# 🎉 PartyGame (Version 3.9.2)

**PartyGame** ist ein selbstgehostetes Multiplayer-Partyspiel für Freunde, WG-Abende und Feiern. Gespielt wird entweder klassisch mit einem Fernseher/Beamer als Hauptbildschirm und Smartphones als Controller – oder komplett ohne TV.

---

## 🚀 Wie es funktioniert (Multi-Room)

Jede Runde läuft in einem **eigenen geschützten Raum** mit 4-stelligem Raumcode (z. B. `/?room=K7M2`). Ohne gültigen Raumcode oder Einladungslink/QR-Code hat niemand Zugriff auf laufende Lobbys.

Es gibt drei URLs:

| Ansicht | Pfad | Zweck |
|---|---|---|
| **Spieler** | `/` oder `/play` | Beitritt per Name & Avatar, Fragen beantworten, Zeichnen, Raten |
| **TV / Host** | `/host` | Große Leinwand-Ansicht mit QR-Code, Timer, Auflösung, Konfetti & Soundeffekten |
| **Admin** | `/admin` | Fernbedienung für Spielwahl, Kategorien, Runden, Modi, QR-URL & eigene Fragen |

### Die 3 Anzeige-Modi (in `/admin` umschaltbar)
1. **📺 Mit TV (`/host`):** Fragen und Ergebnisse laufen groß auf dem TV; alle antworten auf ihren Handys.
2. **📱 Ohne TV (jeder am Handy):** Alles (Fragen, Zeichnungen, Song-Audio, Auflösung) läuft direkt auf den Smartphones der Mitspieler.
3. **🤝 Ein Gerät (Pass & Play):** Spielen mit nur einem einzigen Handy oder Tablet. Spieler werden direkt auf dem Gerät angelegt und ein Schutz-Screen (*„Gib das Gerät an [Name] weiter“*) verhindert, dass jemand heimlich mitliest.

---

## 🎮 Alle 18 Spielmodi

| Modus | Beschreibung |
|---|---|
| 🎉 **Party-Quiz** | Multiple-Choice-Fragen mit Zeitbonus |
| 🍻 **Wer würde am ehesten?** | Alle stimmen ab, wer aus der Runde am ehesten passt |
| ⚖️ **Entweder-Oder** | Zwei Optionen – die Minderheit trinkt |
| 🎯 **Schätz-Duell** | Zahlen schätzen; der nächste Tipp gewinnt |
| ⚡ **Reaktions-Buzzer** | Drücken, sobald der Screen GRÜN wird (nur Mehrgeräte-Modus) |
| 🙈 **Ich hab noch nie…** | Ehrlich antworten – wer es schon gemacht hat, trinkt |
| 🕵️ **Imposter** | Alle bekommen dasselbe Wort, 1–2 Imposter ein leicht anderes – danach wird abgestimmt |
| 🎨 **Zeichnen & Raten** | Einer malt live auf dem Handy, alle anderen raten den Begriff |
| 🗣️ **Erklär-Spiel (Tabu)** | Einer erklärt das Wort mündlich ohne die verbotenen Tabu-Wörter, der Rest tippt die Lösung |
| 🔢 **Sortier-Duell** | 4 Begriffe/Ereignisse von 1 bis 4 in die richtige Reihenfolge bringen |
| 🫶 **Kennenlernen** | Offene Fragen zum Austauschen und Vorlesen |
| 🏆 **Team-Wahl** | Alle wählen eine Antwort; die kleinste Gruppe trinkt |
| 📊 **Skala 1–10** | Jeder bewertet auf einer Skala von 1 bis 10 |
| 🎭 **2 Wahrheiten, 1 Lüge** | Ein Spieler schreibt 2 Wahrheiten & 1 Lüge, die anderen entlarven die Lüge |
| ⚡ **Wort-Assoziation** | Schnell das erste Wort eintippen, das zum Begriff passt |
| 🎵 **Erkenne den Song** | Spielt 30s-iTunes-Previews ab und fragt nach Interpret, Titel, Jahr, Jahrzehnt oder Solo/Gruppe |
| 🖼️ **Bild-Quiz** | Firmenlogos ohne Schriftzug (50), Sehenswürdigkeiten (40), Flaggen (41), Automarken-Embleme ohne Schriftzug (30) & Länder-Umrisse (40) per 4-Optionen-Quiz erraten |
| 🎲 **Party-Mix** | 12 bunte Runden aus den ausgewählten Spielmodi |

---

## ✨ Weitere Features & Animationen
- **🎡 Animiertes Glücksrad (Drehrad):**
  - **Spieler-Rad:** Vor jeder Runde bei *Zeichnen & Raten*, *Erklär-Spiel (Tabu)* und *2 Wahrheiten, 1 Lüge* dreht sich ein Glücksrad mit Soundeffekten und lost fair aus, wer als Nächstes dran ist.
  - **Modus-Rad im Party-Mix:** Vor jeder Mix-Runde dreht sich das Rad und zeigt, welches Minispiel als Nächstes kommt.
  - **Zufalls-Rad in der Lobby (`/admin` & Taste `W`):** Jederzeit per Knopfdruck ein zufälliges Spiel (`🎰 Zufalls-Spiel`) oder einen zufälligen Spieler (`🎡 Spieler auslosen`) bestimmen. In `/admin` auch komplett abschaltbar.
- **💿 Vinyl-Schallplatte & Equalizer (`songquiz`):** Drehende Schallplatte mit animierten Frequenz-Balken während der Song läuft; bei der Auflösung erscheint das echte Album-Cover auf der Schallplatte.
- **💬 Live-Avatar-Pop-In:** Sobald ein Spieler am Handy antwortet, ploppt sein Avatar-Badge auf dem TV mit Häkchen und kurzem Soundeffekt auf.
- **📈 Kahoot-Sieger-Treppchen & Punkte-Ticker:** Punkte zählen nach einer Runde flüssig hoch (`+850` Badge) und am Spielende fahren nacheinander Platz 3 (🥉), Platz 2 (🥈) und Platz 1 (🥇) als Podium nach oben.
- **🔥 „On Fire“-Streak:** Wer mehrere Runden hintereinander punktet, erhält ein leuchtendes Flammen-Badge (`🔥 3×`).
- **⚖️ Tauziehen, 🕵️ 3D-Imposter-Flip & 🎯 Schätz-Radar:** Eigene Auflösungs-Animationen für *Entweder-Oder* (Kraftbalken mit Avataren), *Imposter* (3D-Karten-Enthüllung) und *Schätz-Duell* (Zahlenstrahl mit Spieler-Pins).
- **😂 Live-Emoji-Katapult:** Spieler können in Warte- und Ergebnisphasen Emojis (`😂`, `🔥`, `💀`, `🤡`, `🍻`, `❤️`) vom Handy live über den TV-Bildschirm schicken.
- **Kategorien-Filter:** 5 klare Kategorien — *🎉 Party & Freunde*, *🍻 Peinlich & Eskaliert*, *💬 Kennenlernen & Deep Talk*, *💘 Date* und *🔥 Hot 18+* (in `/admin` frei kombinierbar; Standard: Party & Freunde, Peinlich & Eskaliert, Kennenlernen & Deep Talk).
- **Song-Sprachen & Russisch-Anteil:** In `/admin` unter *Erkenne den Song* sind `🇬🇧 Englisch` und `🇩🇪 Deutsch` standardmäßig aktiv; der `🇷🇺 Russisch-Anteil` lässt sich per Slider von `0%` bis `100%` regeln (Standard: `0%`). Optional auf *Nur Interpret & Titel* begrenzbar.
- **🕵️ Geheime Missionen:** Optional in `/admin` aktivierbar — ein zufälliger Spieler erhält auf seinem Handy eine geheime Runden-Aufgabe (+150 Bonus-Punkte bei Erfolg, Auflösung & Bewertung am Rundenende).
- **Lautstärke-Regler & Auto-Timer-Sync:** Eigener Lautstärke-Slider auf TV und Handy; der Song-Timer synchronisiert sich unabhängig von unterschiedlichen Geräte-Uhrzeiten exakt mit dem Audio-Start.
- **Finalrunde (2× Punkte):** Die letzte Runde eines Spiels zählt automatisch doppelt (in `/admin` ein-/ausschaltbar).
- **Sieger-Awards:** Am Spielende gibt es Auszeichnungen (*Trinkkönig*, *Blitzdenker*, *Rate-Profi*, *Schätz-Meister*).
- **Reconnect-Schutz:** Bricht bei einem Spieler kurz das WLAN ab, bleiben Punkte, Team und Schlücke 120 Sekunden lang erhalten.
- **Kein Wiederholen:** Gespielte Fragen/Songs werden in `data/used.json` gespeichert und erst zurückgesetzt, wenn ein Pool durchgespielt ist.
- **Eigene Insider-Fragen:** Über `/admin` hinzugefügte Fragen werden dauerhaft in `data/custom.json` gespeichert.
- **QR-Code-URL änderbar:** Die Ziel-URL des QR-Codes lässt sich direkt in `/admin` (oder über `PUBLIC_URL`) anpassen.
- **Kontextabhängiges `/admin`:** Es werden jeweils nur die Optionen angezeigt, die zum gewählten Spiel passen (z. B. bei *Bild-Quiz* direkt *Beide / Nur Firmen-Logos / Nur Sehenswürdigkeiten*, bei *Erkenne den Song* nur die Sprach- & Fragetyp-Filter).
- **Lobby-Komfort in `/host`:** Ein Klick auf den Lobby-QR-Code kopiert direkt den Beitritts-Link (`✅ Link kopiert!`); unten rechts gibt es zudem einen kleinen `🎮 Als Spieler beitreten (/)`-Button, der nach Spielstart automatisch ausgeblendet wird.

---

## 📁 Aufbau des Projekts

```text
partygame/
├── server.js            # Express-Webserver, Socket.IO-Logik, Spielablauf, iTunes-API
├── package.json         # Projekt-Metadaten & npm-Abhängigkeiten
├── public/
│   ├── play.html        # Handy-Client (/ und /play) inkl. One-Device-Modus
│   ├── host.html        # TV-Ansicht (/host) mit QR-Code, Konfetti, Web-Audio-SFX & iPad-Wach-Modus
│   ├── admin.html       # Admin-Fernbedienung (/admin, mehrgerätefähig pro Raum)
│   ├── js/ux-helpers.js # Wake-Lock (+ iOS Silent-Video-Fallback), Haptik, Escaping
│   ├── keepalive.mp4    # Stilles 1×1-Loop-Video für iPadOS Display-Wachhaltung
│   └── style.css        # Gemeinsames Styling
├── data/
│   ├── questions.json   # Party-Quiz
│   ├── mostlikely.json  # Wer würde am ehesten?
│   ├── wouldyourather.json
│   ├── estimates.json   # Schätz-Duell
│   ├── neverhavei.json  # Ich hab noch nie…
│   ├── imposter.json    # Imposter-Wortpaare
│   ├── draw.json        # Zeichenbegriffe
│   ├── taboo.json       # Erklär-Spiel (Tabu)
│   ├── sort.json        # Sortier-Duell
│   ├── icebreaker.json  # Kennenlernen
│   ├── teams.json       # Team-Wahl
│   ├── scale.json       # Skala 1–10
│   ├── wordassoc.json   # Wort-Assoziation
│   ├── songs.json       # Erkenne den Song (227 EN, 30 DE, 116 RU = 373 Songs)
│   ├── song-audio/      # Lokale Song-Vorschau-MP3s (0.mp3–372.mp3)
│   ├── song-art/        # Lokale Album-Cover (0.jpg–372.jpg)
│   ├── imagequiz.json   # Bild-Quiz (201 Fragen: Logos, Sehenswürdigkeiten, Flaggen, Automarken, Länder-Umrisse)
│   ├── iq-images/       # Lokale Bilder für das Bild-Quiz (neutrale Dateinamen)
│   ├── used.json        # Automatisch verwaltet: bereits gespielte Indizes
│   └── custom.json      # Automatisch erzeugt: eigene Fragen aus /admin
├── start.sh             # Startet Server + Firefox im TV-Vollbild
├── start-server.sh      # Startet nur den Node.js-Server im Hintergrund
├── open-tv.sh           # Öffnet nur Firefox auf /host
└── stop.sh              # Stoppt den Server (--all beendet auch Firefox)
```

---

## 📦 Voraussetzungen & Pakete

Es wird **keine Datenbank** benötigt – alles läuft über Node.js und lokale JSON-Dateien.

- **Node.js:** Version **>= 18** (wegen nativem `fetch` für die iTunes-Vorschau; getestet mit **Node.js v20.19.2**)
- **npm** (wird mit Node.js mitgeliefert)
- **npm-Pakete (aus `package.json`):**
  - `express` (`^4.19.2`) – Webserver & statische Dateien
  - `socket.io` (`^4.7.5`) – Echtzeit-Kommunikation zwischen Server, TV und Handys
  - `qrcode` (`^1.5.3`) – Generierung von `/qr.png`
- Optional für **Erkenne den Song**: Internetzugang vom Server zu `https://itunes.apple.com` und `https://*.mzstatic.com` (für 30s-Audio-Previews & Albumcover).

---

## 🛠️ Installation auf einem neuen Server (Übergabe)

### 1. Node.js installieren (Beispiel Ubuntu/Debian)
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
```

### 2. Projekt kopieren & Pakete installieren
```bash
cd /pfad/zu/partygame
npm install
```

### 3. Umgebungsvariablen (optional, aber empfohlen)
Standardwerte im Code:
- `PORT`: `3000`
- `HOST`: `0.0.0.0`
- `PUBLIC_URL`: `https://party.goldens.cloud/` *(Standard-Ziel des QR-Codes; lässt sich auch jederzeit live in `/admin` ändern)*
- `ALLOWED_ORIGINS`: `https://party.goldens.cloud,http://localhost:3000,http://127.0.0.1:3000` *(kommagetrennte Liste erlaubter Origins für Socket.IO bei Betrieb hinter einer eigenen Domain/Reverse-Proxy; im lokalen Netz per IP/localhost automatisch erlaubt)*

Beispiel für eigene Domain:
```bash
PUBLIC_URL="https://deine-domain.de/" \
ALLOWED_ORIGINS="https://deine-domain.de,http://localhost:3000" \
PORT=3000 \
npm start
```

#### Standard-Domain / Link des QR-Codes ändern
Der Link, den der QR-Code und der Button „Einladungs-Link kopieren“ verwenden, wird pro Raum so bestimmt (der Raumcode `?room=XXXX` wird automatisch angehängt, wenn er in der URL fehlt):
1. **Nur für den laufenden Raum:** `/admin` → Karte **🔗 QR-Code / Spieler-URL** → URL eintragen → **Speichern** (**Standard** setzt auf die Standard-Domain zurück).
2. **Standard-Domain für alle neuen Räume (Umgebungsvariable):** `PUBLIC_URL` setzen, z. B. in der systemd-Unit `Environment=PUBLIC_URL=https://deine-domain.de` (`install.sh` schreibt sie dort hinein) oder beim Start per `PUBLIC_URL=… npm start`; danach Dienst neu starten.
3. **Fest im Code:** Fallback-Wert (ohne `PUBLIC_URL`) in `server.js`, Konstante `DEFAULT_URL_PLAY` (`process.env.PUBLIC_URL || 'https://party.goldens.cloud'`).
4. **Weitere Stellen, wenn man die Domain komplett tauschen will:**
   - `src/security.js`: Standardliste erlaubter Origins (`ALLOWED_ORIGINS`-Fallback); alternativ einfach die Umgebungsvariable `ALLOWED_ORIGINS` setzen.
   - `public/admin.html`: nur der Platzhalter-Text (`placeholder="https://party.goldens.cloud/"`) im Eingabefeld `qrInput`.

Räume speichern ihre URL in `data/rooms.json`; bereits bestehende Räume behalten daher die alte URL, bis sie in `/admin` geändert oder neu angelegt werden.

### 4. Server starten & stoppen
- Direkt im Vordergrund:
  ```bash
  npm start
  ```
- Im Hintergrund (Linux):
  ```bash
  ./start-server.sh   # Log liegt unter /tmp/partygame.log
  ./stop.sh           # Server stoppen
  ```
- Mit lokalem TV-Browser (Firefox):
  ```bash
  ./start.sh
  ./stop.sh --all
  ```
- **Produktiv (systemd, Server `palworld`)** – als `schultheissa` in `/opt/partygame`:
  ```bash
  scripts/deploy.sh          # holt main, startet neu – bricht ab, wenn gerade jemand verbunden ist
  scripts/deploy.sh --wait   # wartet, bis niemand mehr verbunden ist
  scripts/deploy.sh --force  # trotzdem neu starten (laufende Räume gehen verloren!)
  ```
  `/health` zeigt `sockets` (aktive Verbindungen). Laufende Räume werden in `data/rooms.json` gesichert (entprellt, atomar, beim Stoppen synchron) und beim Start wiederhergestellt (max. 2 h alt): Handys steigen mit Punkten wieder ein, Timer laufen weiter.
- Log-Rotation einmalig installieren: `sudo install -m 644 scripts/logrotate-partygame /etc/logrotate.d/partygame`
- **Automatisierung (systemd-Timer, Units in `scripts/systemd/`):**
  - `partygame-backup.timer` – täglich 04:30 `scripts/backup.sh` → `backups/data-*.tgz` (custom/used/rooms/Host-PIN, 14 Stück).
  - `partygame-autodeploy.timer` – alle 5 min `scripts/auto-deploy.sh`: neuer Commit auf `origin/main` + GitHub-CI grün + niemand verbunden → `deploy.sh`.
- **Monitoring:** Server schreibt jede Minute eine `metrics`-Zeile (Räume, Spieler, Sockets, CPU, RAM, Event-Loop-Lag p50/p99/max, Broadcasts, KB/min). Grafana-Dashboard `scripts/grafana/homelab-partygame.json` (Loki, `{app="partygame"}`).
- **Lasttest:** `URL=http://localhost:3999 ROOMS=8 PLAYERS=12 ROUNDS=5 node scripts/loadtest.js` (devDependency `socket.io-client`).

### 5. Hinweis für Reverse Proxy (Nginx / Caddy / Cloudflare)
Falls das Spiel über eine eigene HTTPS-Domain erreichbar sein soll:
- **WebSockets (`Upgrade` / `Connection`)** müssen an `http://127.0.0.1:3000` weitergeleitet werden (für Socket.IO).
- `ALLOWED_ORIGINS` auf die eigene Domain setzen, sonst blockt Socket.IO externe Browser-Verbindungen.
- `PUBLIC_URL` setzen (oder nach dem Start einfach einmal in `/admin` unter **QR-Code / Spieler-URL** eintragen).
- **HTTP/2 aktivieren** (bei Wildcard-Zertifikaten sonst `421 Misdirected Request`, wenn der Browser Verbindungen anderer Subdomains wiederverwendet) und **gzip für CSS/JS/JSON/SVG** (`gzip_types text/css application/javascript application/json image/svg+xml …`). Bei `party.goldens.cloud` ist beides im Nginx Proxy Manager (Host 24, „Advanced“) gesetzt.

---

## 💾 Backups & Versionen

- **v3.9.2 (Aktueller Stand):** „Link kopieren“ (Admin, Handy, TV) funktioniert auch über `http://<IP>`: gemeinsamer Helfer `pgCopyText` mit Fallback, wenn die Clipboard-API fehlt; „✅ kopiert“ erscheint nur noch, wenn wirklich kopiert wurde.
- **v3.9.1:** Versionsnummer wird unten in `/admin` angezeigt (Platzhalter `__APP_VERSION__` wird beim Start aus `package.json` gefüllt).
- **v3.9.0:** Neues Bild-Quiz-Thema **🗺️ Länder-Umrisse** (40 Länder, "Welches Land hat diese Umrisse?"), in `/admin` unter *Bild-Quiz Themen* einzeln an-/abwählbar und in „Alle“ enthalten.
- **v3.8.2:** Bild-Quiz ohne Namen im Bild: Schriftzüge aus Logos/Emblemen entfernt (u. a. Pepsi, BMW, Porsche, Burger King, Mastercard, Airbnb, Target, Adobe, Peugeot, Volvo, Nissan, Alfa Romeo, Aston Martin); TikTok, Red Bull und Reddit als Symbol-Logo; reine Wortmarken ersetzt (KFC → Lufthansa, Uber → Shazam, NASA → Duolingo, Ford → Jaguar, Fiat → Chevrolet, Kia → Suzuki).
- **v3.8.1:** QR-/Spieler-URL in `/admin`: Raumcode (`?room=…`) wird automatisch an eigene URLs angehängt, „Standard“ setzt den Link inkl. Raumcode zurück, „Einladungs-Link kopieren“ (Admin + Handy) nutzt die eingestellte Spieler-URL.
- **v3.8.0:** Stabilität & flüssiges Spiel. Laufende Spiele überstehen Neustarts/Deploys (Raum-Snapshot + Wiederherstellung, Handys steigen automatisch mit Punkten wieder ein, Timer laufen weiter). WebSocket-Kompression (permessage-deflate) für State-Updates – deutlich weniger Daten im Mobilfunk. Service Worker: Seite lädt auch bei Funkloch/langsamem Netz aus dem Cache (HTML immer zuerst frisch vom Netz), Bilder/Cover gecacht. Leichtere `pub()`-Berechnung pro Update. Metrik-Logzeile + Grafana-Dashboard (Event-Loop-Lag als „Ruckel-Indikator“), tägliches Backup, Auto-Deploy nach grüner CI, Lasttest-Script. Sicherheit: X-Forwarded-For wird fälschungssicher ausgewertet (echte Client-IP von rechts).
- **v3.7.2:** TV/Tablet: Bei 5–6 Antwortmöglichkeiten (z. B. „Von wem ist dieser Song?“) passt die Auflösung jetzt komplett ins Bild – Frage in 3 Spalten, Auflösung in 2 Spalten mit flacheren Kacheln, Zeilen werden nicht mehr auf die höchste Kachel gestreckt, lange Namen werden sauber umbrochen. Geprüft auf 1024×768, 1180×820, 820×1180, 1366×1024 und 1920×1080.
- **v3.7.1:** Erkenne den Song: Die Musik wird in der Auflösung (nachdem alle abgestimmt haben) nicht mehr leiser gedreht, die Lautstärke bleibt gleich – auf TV und Handy.
- **v3.7.0:** UI-Überarbeitung. **TV:** falsche Antworten werden in der Auflösung wirklich abgedunkelt, Antwortfelder mit ▲◆●■ (Zuordnung zum Handy ohne Farbe), Avatare zeigen, wer was gewählt/wen gewählt hat, „Keine Stimmen“-Karte statt leerem Bild, größere Schrift & Antwortfelder für Sofa-Abstand, Bedienleiste blendet sich nach ein paar Sekunden aus, Lobby mit großem Raumcode, Avatar-Karten und „So geht's“-Regel. **Handy:** Name zuerst + Avatar-Leiste zum Wischen beim Beitreten, Lobby mit Mitspielern, Spielregel und „Avatar ändern“, Hinweis „Frage steht auf dem TV“, Antwortstatus als klare Rückmeldung, Avatare beim Abstimmen. **Admin:** feste Aktionsleiste unten (Start/Weiter/Pause/Reset), Einstellungen in einklappbaren Gruppen. **Server:** Standard-Rundenlimit 10 (Party-Mix behält eigene Rundenzahl), Ergebnis enthält, wer welche Antwort gewählt hat.
- **v3.6.0:** Besseres Handling für Handys & Mobilfunk: automatischer Wiedereinstieg nach Neuladen/verworfenem Tab; sofortiger Reconnect nach Bildschirmsperre/App-Wechsel (statt bis zu 35 s Ping-Timeout) mit Session-Wiederherstellung; Antworten mit Empfangsbestätigung („⏳ wird gesendet“ → „✅ angekommen“), unbestätigte Antworten werden nach Reconnect nachgesendet; Haptik-Countdown in den letzten 3 s und Feedback bei richtig/falsch; Konfetti auch am Handy (richtige Antwort, Podium); weiche Phasenübergänge (View Transitions) auf TV & Handy; Konfetti zeitbasiert (gleich schnell auf 120-Hz-Displays); Safe-Area für iPhone-Homescreen-App; JS-Fehler der Clients und Verbindungsart werden im Server-Log protokolliert; `scripts/deploy.sh` (startet nur neu, wenn niemand verbunden ist) und Log-Rotation.
- **v3.5.3:** Fix: Handys mit gecachter alter `ux-helpers.js` blieben nach dem Update auf dem Lobby-Screen hängen, obwohl das Spiel (und die Musik) weiterlief. CSS/JS werden jetzt mit Inhalts-Hash (`?v=…`) eingebunden und dauerhaft gecacht; ohne Hash wird immer revalidiert.
- **v3.5.2:** Performance für schwache Geräte & Mobilfunk: Rate-Limit nur noch auf `/api`, `/qr.png`, `/info` (Partygäste teilen sich eine NAT-IP); HTML wird per ETag revalidiert statt jedes Mal neu geladen; Socket.IO verbindet per WebSocket zuerst (`socket.io.min.js`); Handys laden den nächsten Song nur noch im Ohne-TV-Modus mit Ton und erst, wenn der aktuelle Song fertig gepuffert ist; Zeichnen sendet gebündelte Punkt-Chunks (~15–20/s statt einer Nachricht pro Fingerbewegung); Glücksrad wird offscreen gerendert und stoppt nach dem Auslaufen; Timer-Balken per `transform`; Glow-Animationen nur noch über `opacity`; Emoji-Reaktionen begrenzt; Lobby auf `/host` aktualisiert nur noch geänderte Teile; Bild-Quiz-Bilder komprimiert (12,6 MB → 5,4 MB).
- **v3.5.1:** iPadOS `<audio>`-Element-Unlock über `/silent.mp3` & Ergebnis-Ducking im Song-Quiz, Render-Diffing & Reconnect-Banner in `/admin` und `/play`, 4s Reconnect-Grace-Period bei Netzrucklern, Pinselgröße + Undo beim Zeichnen, saubere Trennung von Test- und Produktions-Logs.
- **v3.5.0:** PWA & iPad-Wake-Lock (inkl. Silent-Video-Fallback), lokale Album-Cover (`data/song-art/`) & bereinigte Original-Song-Previews, Render-Diffing & Performance-Optimierungen in `/play` und `/host`, Geheime Missionen auf `/play` & `/host` gefixt, Auto-Next für *Kennenlernen*, Mehrgeräte-`/admin` pro Raum.
- **v3.4.0:** Modularisierte Security-/Logger-Helfer, isolierte Custom-Fragen, Haptik- & Reconnect-Basis.
- **v3.3.0:** 1.708 Einträge (Fragenpools +230 aufgestockt), 36 Avatare, Schnell-Presets, Timer-Tempo, Alkoholfrei-Modus, Party-Mix-Rundenwahl (8/12/16) sowie neue Animationen (Wortwolke, Sortier-Snap, Reaktions-Schockwelle).
- **v3.2.0:** 373 Songs, 161 Bilderquiz-Einträge, 944 Fragen/Modi (1.478 Einträge gesamt), `install.sh` für einfache Linux-Installation.
- **v3.1.0:** Gesichert unter `/opt/partygame/backups/partygame-v3.1.0.tar.gz` (Multi-Room, Bild-Quiz mit 90 Bildern, kontextabhängiges `/admin`, Preloading & Lobby-Komfort).
- **v2.2.0 (Single-Lobby-Stand):** Gesichert unter `/opt/partygame/backups/partygame-v2.2.0.tar.gz` (5 Kategorien, Song-Sprach-Slider, Geheime Missionen, aufgestockte Fragenpools). Wiederherstellung bei Bedarf mit:
  ```bash
  tar -xzf /opt/partygame/backups/partygame-v2.2.0.tar.gz -C /opt/partygame
  systemctl restart partygame.service
  ```

---

## 📊 Aktueller Content-Umfang (Stand: 17.11.2026)

Insgesamt **1708 Einträge** in `/opt/partygame/data/`:

### 🎵 Lieder (`songs.json`: 373 gesamt)
- **Nach Sprache (`lang`):** `en`: 227 · `ru`: 116 · `de`: 30
- **Nach Typ (`type`):** `gruppe`: 218 · `solo`: 155

### 🖼️ Bilderquiz (`imagequiz.json`: 201 gesamt)
- `logos`: 50 · `flags`: 41 · `landmarks`: 40 · `countries`: 40 · `cars`: 30
- Länder-Umrisse aus Natural Earth (gemeinfrei, über `world-atlas`), flächentreu um das jeweilige Land projiziert.

### ❓ Fragen & Spielmodi nach Kategorie (1174 gesamt)

| Datei / Modus | Gesamt | `party` | `peinlich` | `hot18` | `kennenlernen` | `date` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `mostlikely.json` | **107** | 29 | 29 | 25 | 14 | 10 |
| `neverhavei.json` | **106** | 28 | 29 | 25 | 14 | 10 |
| `wouldyourather.json` | **102** | 28 | 28 | 22 | 14 | 10 |
| `questions.json` | **106** | 30 | 26 | 15 | 18 | 17 |
| `estimates.json` | **95** | 27 | 24 | 13 | 15 | 16 |
| `scale.json` | **94** | 17 | 18 | 20 | 21 | 18 |
| `teams.json` | **89** | 19 | 16 | 14 | 22 | 18 |
| `icebreaker.json` | **88** | 15 | 12 | 13 | 32 | 16 |
| `taboo.json` | **88** | 19 | 21 | 13 | 18 | 17 |
| `wordassoc.json` | **86** | 16 | 12 | 16 | 22 | 20 |
| `draw.json` | **80** | 24 | 24 | 12 | 10 | 10 |
| `imposter.json` | **70** | 20 | 20 | 10 | 10 | 10 |
| `sort.json` | **63** | 16 | 12 | 11 | 13 | 11 |
| **Summe** | **1174** | **288** | **271** | **209** | **223** | **183** |
