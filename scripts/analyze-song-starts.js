#!/usr/bin/env node
// Findet in jeder 30-s-Vorschau (data/song-audio/N.mp3) die erste wirklich laute Stelle und schreibt
// den Startversatz nach data/song-starts.json ({ "Index": Sekunden }). Der Server hängt ihn als
// Media-Fragment an (…/N.mp3#t=12), damit Songs nicht mit leisem Intro oder Stille beginnen.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AUDIO_DIR = path.join(ROOT, 'data', 'song-audio');
const OUT = path.join(ROOT, 'data', 'song-starts.json');
const DROP_LU = 4; // „laut“ = höchstens 4 LU unter dem lautesten 3-s-Abschnitt
const MAX_START = 12; // nie später starten (Runde dauert ~25 s, Vorschau 30 s)
const MIN_REST = 15; // mindestens so viele Sekunden Musik bleiben übrig
const MIN_START = 2; // kleinere Versätze lohnen nicht

// Kurzzeit-Lautheit (EBU R128, 3-s-Fenster) alle 100 ms – ffmpeg schreibt das Protokoll nach stderr
function shortTermLoudness(file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-v', 'verbose', '-i', file, '-af', 'ebur128=framelog=verbose', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error; // z. B. ffmpeg nicht installiert
  return [...(r.stderr || '').matchAll(/t:\s*([\d.]+)\s+TARGET:\S+\s+LUFS\s+M:\s*(-?[\d.]+)\s+S:\s*(-?[\d.]+)/g)].map(m => [Number(m[1]), Number(m[3])]);
}

function startFor(points) {
  if (!points.length) return 0;
  const dur = points[points.length - 1][0];
  const valid = points.filter(([t]) => t >= 3); // vorher ist das 3-s-Fenster noch nicht voll
  if (!valid.length) return 0;
  const maxS = Math.max(...valid.map(p => p[1]));
  const hit = valid.find(([, s]) => s >= maxS - DROP_LU);
  let start = hit ? Math.max(0, hit[0] - 3) : 0; // Fensteranfang = Beginn des lauten Teils
  start = Math.min(start, MAX_START, Math.max(0, dur - MIN_REST));
  return start < MIN_START ? 0 : Math.round(start * 2) / 2;
}

// Nur Dateien N.mp3 (nicht stillschweigend etwas anderes überspringen)
const files = fs.readdirSync(AUDIO_DIR).filter(f => /^\d+\.mp3$/.test(f)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
const starts = {};
for (const f of files) {
  const s = startFor(shortTermLoudness(path.join(AUDIO_DIR, f)));
  if (s > 0) starts[parseInt(f, 10)] = s;
}
fs.writeFileSync(OUT, JSON.stringify(starts, null, 1) + '\n');
console.log(`${files.length} Vorschauen analysiert, ${Object.keys(starts).length} starten später → ${path.relative(ROOT, OUT)}`);
