const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'partygame.log');
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (err) {
  process.stderr.write(`Failed to create log dir: ${err?.message || err}\n`);
}

function writeLog(level, event, meta = {}) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${event}${Object.keys(meta).length ? ' ' + JSON.stringify(meta) : ''}\n`;
  process.stdout.write(line);
  fs.appendFile(LOG_FILE, line, () => {});
}

module.exports = { writeLog, LOG_DIR, LOG_FILE };
