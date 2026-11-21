const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'partygame.log');
const SKIP_FILE_LOG =
  process.env.PARTYGAME_NO_FILE_LOG === '1' ||
  process.env.NODE_ENV === 'test' ||
  Boolean(process.env.NODE_TEST_CONTEXT);
// Notbremse gegen eine volle Platte: Ist die Logdatei größer, wird nicht mehr hineingeschrieben (stdout/journald
// läuft weiter), bis logrotate sie verkleinert hat (stündlich nach Größe, siehe scripts/systemd/partygame-logrotate.*).
const LOG_MAX_BYTES = (Number(process.env.PARTYGAME_LOG_MAX_MB) || 200) * 1024 * 1024;
let logBytes = 0;
let logCapped = false;

function refreshLogSize() {
  fs.stat(LOG_FILE, (err, st) => {
    logBytes = err ? 0 : st.size;
    if (logBytes < LOG_MAX_BYTES) logCapped = false;
  });
}

if (!SKIP_FILE_LOG) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (err) {
    process.stderr.write(`Failed to create log dir: ${err?.message || err}\n`);
  }
  refreshLogSize();
  setInterval(refreshLogSize, 30_000).unref(); // erkennt, wenn logrotate die Datei geleert hat
}

function writeLog(level, event, meta = {}) {
  if (SKIP_FILE_LOG) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${event}${Object.keys(meta).length ? ' ' + JSON.stringify(meta) : ''}\n`;
  process.stdout.write(line);
  if (logBytes >= LOG_MAX_BYTES) {
    if (!logCapped) {
      logCapped = true;
      fs.appendFile(LOG_FILE, `[${ts}] [WARN] log_file_capped {"maxMb":${LOG_MAX_BYTES / 1048576}}\n`, () => {});
    }
    return;
  }
  logBytes += Buffer.byteLength(line);
  fs.appendFile(LOG_FILE, line, () => {});
}

module.exports = { writeLog, LOG_DIR, LOG_FILE, LOG_MAX_BYTES };
