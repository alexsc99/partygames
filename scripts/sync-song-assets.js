#!/usr/bin/env node
/**
 * Syncs and audits SongQuiz assets:
 *  - Verifies clean original matches on Deezer / iTunes (ranked, strict non-original exclusion)
 *  - Downloads local album covers to data/song-art/<idx>.jpg
 *  - When --fix-audio is passed, replaces local MP3s with verified official 30s studio previews
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SONGS_PATH = path.join(ROOT, 'data', 'songs.json');
const AUDIO_DIR = path.join(ROOT, 'data', 'song-audio');
const ART_DIR = path.join(ROOT, 'data', 'song-art');

const FIX_AUDIO = process.argv.includes('--fix-audio');
const FORCE_ART = process.argv.includes('--force-art');

fs.mkdirSync(ART_DIR, { recursive: true });
fs.mkdirSync(AUDIO_DIR, { recursive: true });

const songs = JSON.parse(fs.readFileSync(SONGS_PATH, 'utf8'));

const RU_MAP = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

const cleanApos = (s) => String(s || '').replace(/['’´`ʹ]/g, '');

const norm = (s) => cleanApos(s)
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]/g, '');

const toLat = (s) => cleanApos(s)
  .toLowerCase()
  .replace(/[а-яё]/g, (ch) => RU_MAP[ch] ?? ch)
  .replace(/j([auo])/g, 'y$1')
  .replace(/j/g, 'y')
  .replace(/[^\p{L}\p{N}]/gu, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastItunesAt = 0;
async function fetchJsonRateLimited(url, isItunes = false) {
  if (isItunes) {
    const wait = Math.max(0, 3100 - (Date.now() - lastItunesAt));
    if (wait > 0) await sleep(wait);
    lastItunesAt = Date.now();
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 7000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (res.status === 403 || res.status === 429) {
      await sleep(isItunes ? 6500 : 1500);
      const retry = await fetch(url, { signal: ctrl.signal });
      if (!retry.ok) return null;
      return await retry.json();
    }
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function buildMatcher(song) {
  const allowRemix = /remix/i.test(song.title || '') || /remix/i.test(song.artist || '');
  const badBase = /\b(karaoke|tribute|cover|instrumental|live|demo|acoustic|unplugged|a?\s*cappella|a?\s*capella|slow(?:ed)?(?:\s*version)?|sped\s*up|reverb|nightcore|lullaby|piano\s*version|8d|re-?recorded|taylor'?s\s*version|bootleg|mashup|parody|orchestral|symphonic|hoodtrap|dance\s*version|new\s*version|big\s*band|g-?mix|low\s*sunday|no\s*rap|originally\s*performed|made\s*famous|in\s*the\s*style\s*of)\b|инструмент/i;
  const isBadText = (txt) => {
    const s = String(txt || '');
    if (badBase.test(s)) return true;
    if (!allowRemix) {
      const strippedAllowedMix = s.replace(/\b(?:original\s*)?(?:7["”']?\s*|radio\s*)mix\b/gi, '');
      if (/\b(remix|mix)\b/i.test(strippedAllowedMix)) return true;
    }
    return false;
  };

  const stripParens = (s) => String(s || '').replace(/\(.*?\)|\[.*?\]/g, '').trim();
  const tFull = norm(song.title);
  const tStrip = norm(stripParens(song.title));
  const tLatFull = toLat(song.title);
  const tLatStrip = toLat(stripParens(song.title));

  const primArtistRaw = String(song.artist || '').split(/[,&]|feat\.|vs\./i)[0];
  const aNorm = norm(primArtistRaw);
  const aLat = toLat(primArtistRaw);
  const qNorm = norm(song.query || '');
  const qLat = toLat(song.query || '');

  const titleMatch = (tr) => {
    const nt = norm(tr);
    const nts = norm(stripParens(tr));
    const lt = toLat(tr);
    const lts = toLat(stripParens(tr));
    if (nts === tStrip || lts === tLatStrip) return 3;
    const pairs = [[tStrip, nts], [tFull, nt], [tLatStrip, lts], [tLatFull, lt]];
    for (const [a, b] of pairs) {
      if (a && b && (b.includes(a) || a.includes(b))) return 1;
    }
    if (qLat && lts && lts.length >= 3 && qLat.includes(lts)) return 1;
    return 0;
  };

  const artistMatch = (ar) => {
    const na = norm(ar);
    const la = toLat(ar);
    if (!na && !la) return 0;
    if (aNorm && na === aNorm) return 2;
    if (aLat && la === aLat) return 2;
    if (aNorm && na && (na.includes(aNorm) || aNorm.includes(na))) return 1;
    if (aLat && la && (la.includes(aLat) || aLat.includes(la))) return 1;
    if (qNorm && na && na.length >= 3 && qNorm.includes(na)) return 1;
    if (qLat && la && la.length >= 3 && qLat.includes(la)) return 1;
    return 0;
  };

  const scoreCandidate = (ar, tr) => {
    if (isBadText(ar) || isBadText(tr)) return -1;
    if (!/[&/]/.test(song.title || '') && /&/.test(stripParens(tr))) return -1;
    const am = artistMatch(ar);
    const tm = titleMatch(tr);
    if (!am || !tm) return -1;
    let score = am * 10 + tm * 25;
    if (!/\(.*?(version|edit|remaster|mix)/i.test(tr || '')) score += 15;
    if (/\b(single\s*edit|radio\s*edit|7["”']?\s*mix)\b/i.test(tr || '')) score += 8;
    if (norm(stripParens(tr)) === tStrip || toLat(stripParens(tr)) === tLatStrip) score += 20;
    return score;
  };

  return { scoreCandidate };
}

function pickBest(list, getArtist, getTitle, getArt, getPreview, scoreCandidate) {
  let best = null;
  let bestScore = -1;
  for (const item of list) {
    const art = getArt(item);
    const preview = getPreview(item);
    if (!art || !preview) continue;
    const sc = scoreCandidate(getArtist(item), getTitle(item));
    if (sc > bestScore) {
      bestScore = sc;
      best = { item, art, preview, matched: `${getArtist(item)} - ${getTitle(item)}`, score: sc };
    }
  }
  return best;
}

async function findMatch(song) {
  const { scoreCandidate } = buildMatcher(song);
  const cleanQuery = String(song.query || `${song.artist} ${song.title}`)
    .replace(/feat\.|ft\.|\(.*?\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const noContraction = cleanQuery.replace(/\b\w+['’`]\w+\b/g, '').replace(/\s+/g, ' ').trim();
  const terms = [...new Set([
    song.query,
    `${song.artist} ${song.title}`,
    cleanQuery,
    noContraction,
  ].filter(Boolean))];

  let fallbackDz = null;
  for (const term of terms) {
    const dz = await fetchJsonRateLimited(`https://api.deezer.com/search?q=${encodeURIComponent(term)}&limit=12`, false);
    const best = pickBest(
      (dz && dz.data) || [],
      (r) => r.artist?.name,
      (r) => r.title,
      (r) => r.album?.cover_big || r.album?.cover_medium || r.album?.cover,
      (r) => r.preview,
      scoreCandidate
    );
    if (best && best.score >= 50) return { ...best, source: 'deezer' };
    if (best && (!fallbackDz || best.score > fallbackDz.score)) fallbackDz = { ...best, source: 'deezer' };
    await sleep(90);
  }

  for (const country of ['de', 'us']) {
    for (const term of terms.slice(0, 3)) {
      const it = await fetchJsonRateLimited(
        `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=12&country=${country}`,
        true
      );
      const best = pickBest(
        (it && it.results) || [],
        (r) => r.artistName,
        (r) => r.trackName,
        (r) => (r.artworkUrl100 ? r.artworkUrl100.replace('100x100bb', '300x300bb') : null),
        (r) => r.previewUrl,
        scoreCandidate
      );
      if (best) return { ...best, source: `itunes-${country}` };
    }
  }

  return fallbackDz || null;
}

async function downloadToFile(url, outPath) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 500) return false;
    fs.writeFileSync(outPath, buf);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

function transcodeTo96kMp3(inputPath, outMp3) {
  execFileSync('ffmpeg', [
    '-y', '-i', inputPath, '-vn', '-acodec', 'libmp3lame', '-b:a', '96k', '-ar', '44100', outMp3,
  ], { stdio: 'ignore' });
}

(async () => {
  const report = { matched: [], missed: [], artSaved: 0, audioReplaced: 0 };
  for (let i = 0; i < songs.length; i++) {
    const song = songs[i];
    const artFile = path.join(ART_DIR, `${i}.jpg`);
    const audioFile = path.join(AUDIO_DIR, `${i}.mp3`);
    const needArt = FORCE_ART || !fs.existsSync(artFile);
    if (!needArt && !FIX_AUDIO) continue;

    // Special case: Estelle feat. Kanye West (Lost Frequencies Remix) keeps its existing remix MP3
    // and uses the official Estelle - American Boy album cover.
    let match = null;
    // keepAudio in songs.json: Audio wurde bewusst von Hand gewählt (z. B. russische Fassung) – nie überschreiben
    let keepExistingAudio = !!song.keepAudio;
    if (/lost frequencies remix/i.test(song.title || '')) {
      keepExistingAudio = true;
      const dz = await fetchJsonRateLimited('https://api.deezer.com/search?q=Estelle%20American%20Boy&limit=3', false);
      const hit = (dz && dz.data || []).find((r) => r.album?.cover_big || r.album?.cover_medium);
      if (hit) {
        match = {
          source: 'deezer-cover',
          matched: `${hit.artist?.name} - ${hit.title} (cover only)`,
          art: hit.album.cover_big || hit.album.cover_medium,
          preview: null,
          score: 100,
        };
      }
    } else {
      match = await findMatch(song);
    }

    if (!match) {
      report.missed.push({ idx: i, artist: song.artist, title: song.title, query: song.query || null });
      console.log(`[MISS] ${i}: ${song.artist} - ${song.title}`);
      continue;
    }
    report.matched.push({ idx: i, song: `${song.artist} - ${song.title}`, matched: match.matched, source: match.source, score: match.score });

    if (needArt && match.art) {
      if (await downloadToFile(match.art, artFile)) report.artSaved++;
    }

    if (FIX_AUDIO && !keepExistingAudio && match.preview) {
      const ext = match.preview.includes('.m4a') ? '.m4a' : '.mp3';
      const tmp = path.join(os.tmpdir(), `pg_sync_${i}${ext}`);
      if (await downloadToFile(match.preview, tmp)) {
        try {
          transcodeTo96kMp3(tmp, audioFile);
          report.audioReplaced++;
        } finally {
          try { fs.unlinkSync(tmp); } catch {}
        }
      }
    }

    if ((i + 1) % 25 === 0) {
      console.log(`Progress: ${i + 1}/${songs.length} | matched=${report.matched.length} artSaved=${report.artSaved} audioReplaced=${report.audioReplaced} missed=${report.missed.length}`);
    }
  }

  console.log('=== SUMMARY ===');
  console.log(JSON.stringify({
    matched: report.matched.length,
    artSaved: report.artSaved,
    audioReplaced: report.audioReplaced,
    missedCount: report.missed.length,
  }, null, 2));

  const outPath = '/home/openclaw/.gemini/antigravity-cli/brain/31eb629f-27f3-4a73-a65b-bb11e2f164ed/scratch/song-audit-v2.json';
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
})();
