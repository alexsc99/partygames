const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  server,
  io,
  APP_VERSION,
  MAX_ROOMS,
  validHostSecret,
  checkHostAuth,
  hostAuthFails,
  getSocketIp,
  createRateLimiter,
  createRoom,
  rooms,
  snapshotRooms,
  restoreRooms,
  initWordMask,
  applyPartialGuess,
  formatWordMask,
} = require('../server.js');

const HOST_SECRET = fs.readFileSync(path.join(__dirname, '..', 'data', '.host-secret'), 'utf8').trim();
let baseUrl = '';

before(async () => {
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  for (const r of rooms.values()) r.destroy();
  rooms.clear();
  await new Promise((resolve) => io.close(() => resolve()));
});

describe('PartyGame Server', () => {
  it('GET /health returns ok and current package.json version', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.service, 'partygame');
    assert.equal(body.version, APP_VERSION);
  });

  it('serves HTML pages and PWA assets', async () => {
    for (const p of ['/', '/host', '/admin', '/rooms', '/manifest.json', '/icon.svg', '/js/ux-helpers.js']) {
      const res = await fetch(`${baseUrl}${p}`);
      assert.equal(res.status, 200, `Expected 200 for ${p}`);
    }
  });

  it('does not rate-limit static/media assets (party guests share one NAT IP)', async () => {
    for (let i = 0; i < 200; i++) {
      const res = await fetch(`${baseUrl}/style.css`);
      await res.arrayBuffer();
      assert.equal(res.status, 200, `request ${i} to /style.css was limited`);
    }
    const html = await fetch(`${baseUrl}/`);
    assert.equal(html.headers.get('cache-control'), 'no-cache');
    const etag = html.headers.get('etag');
    await html.arrayBuffer();
    // undici-fetch manipuliert Cache-Header bei bedingten Requests, daher roh über node:http
    const status = await new Promise((resolve, reject) => {
      require('node:http').get(`${baseUrl}/`, { headers: { 'If-None-Match': etag } }, r => { r.resume(); resolve(r.statusCode); }).on('error', reject);
    });
    assert.equal(status, 304, 'HTML must revalidate via ETag instead of re-downloading');
  });

  it('busts caches for CSS/JS so phones never combine a new page with a stale helper script', async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    const m = html.match(/"\/js\/ux-helpers\.js\?v=([0-9a-f]{10})"/);
    assert.ok(m, 'play page must reference ux-helpers.js with a content hash');
    assert.match(html, /"\/style\.css\?v=[0-9a-f]{10}"/);
    const versioned = await fetch(`${baseUrl}/js/ux-helpers.js?v=${m[1]}`);
    assert.match(versioned.headers.get('cache-control') || '', /immutable/);
    assert.ok((await versioned.text()).includes('pgSetBar'));
    const unversioned = await fetch(`${baseUrl}/js/ux-helpers.js`);
    assert.equal(unversioned.headers.get('cache-control'), 'no-cache');
  });

  it('rejects missing or invalid asset paths with 404', async () => {
    const r1 = await fetch(`${baseUrl}/iq/does-not-exist.png`);
    assert.equal(r1.status, 404);
    const r2 = await fetch(`${baseUrl}/song-audio/not-an-mp3.txt`);
    assert.equal(r2.status, 404);
  });

  it('creates, lists (authenticated), and deletes rooms via /api/rooms', async () => {
    const createRes = await fetch(`${baseUrl}/api/rooms`, { method: 'POST' });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.match(created.code, /^[A-Z0-9]{4}$/);
    assert.ok(created.hostToken);

    const unauthRes = await fetch(`${baseUrl}/api/rooms`);
    assert.equal(unauthRes.status, 401);

    const listRes = await fetch(`${baseUrl}/api/rooms`, {
      headers: { 'x-host-secret': HOST_SECRET },
    });
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.ok(listBody.rooms.some((r) => r.code === created.code));

    const delRes = await fetch(`${baseUrl}/api/rooms/${created.code}`, {
      method: 'DELETE',
      headers: { 'x-host-secret': HOST_SECRET },
    });
    assert.equal(delRes.status, 200);
    assert.equal(rooms.has(created.code), false);
  });

  it('validHostSecret validates timing-safely', () => {
    assert.equal(validHostSecret(HOST_SECRET), true);
    assert.equal(validHostSecret(` ${HOST_SECRET} `), true);
    assert.equal(validHostSecret('wrong'), false);
    assert.equal(validHostSecret(''), false);
    assert.equal(validHostSecret(null), false);
    assert.equal(validHostSecret(12345), false);
  });

  it('createRateLimiter blocks requests over limit with 429', () => {
    const mw = createRateLimiter({ windowMs: 60_000, max: 2 });
    const statuses = [];
    let nextCalls = 0;
    const req = { headers: {}, socket: { remoteAddress: '10.0.0.1' } };
    const makeRes = () => ({
      status(code) {
        statuses.push(code);
        return { send() {}, json() {} };
      },
    });
    mw(req, makeRes(), () => { nextCalls++; });
    mw(req, makeRes(), () => { nextCalls++; });
    mw(req, makeRes(), () => { nextCalls++; });
    assert.equal(nextCalls, 2);
    assert.deepEqual(statuses, [429]);
  });

  it('checkHostAuth locks out after 5 failed attempts and resets on success', () => {
    const testIp = '198.51.100.42';
    hostAuthFails.delete(testIp);
    for (let i = 0; i < 5; i++) {
      const r = checkHostAuth(testIp, 'wrong');
      assert.equal(r.ok, false);
      assert.equal(r.locked, false);
    }
    const locked = checkHostAuth(testIp, HOST_SECRET);
    assert.equal(locked.ok, false);
    assert.equal(locked.locked, true);

    hostAuthFails.delete(testIp);
    const ok = checkHostAuth(testIp, HOST_SECRET);
    assert.equal(ok.ok, true);
  });

  it('POST /api/rooms enforces MAX_ROOMS limit with 429', async () => {
    const dummyCodes = [];
    for (let i = rooms.size; i < MAX_ROOMS; i++) {
      const c = `T${String(i).padStart(3, '0')}`;
      rooms.set(c, createRoom(c, 'tok'));
      dummyCodes.push(c);
    }
    try {
      const res = await fetch(`${baseUrl}/api/rooms`, { method: 'POST' });
      assert.equal(res.status, 429);
    } finally {
      for (const c of dummyCodes) {
        rooms.get(c)?.destroy();
        rooms.delete(c);
      }
    }
  });

  it('getSocketIp only trusts x-forwarded-for from local/private proxy addresses', () => {
    const fromProxy = getSocketIp({
      handshake: { address: '10.0.5.11', headers: { 'x-forwarded-for': '203.0.113.9, 10.0.5.11' } },
    });
    assert.equal(fromProxy, '203.0.113.9');

    const fromPublic = getSocketIp({
      handshake: { address: '203.0.113.50', headers: { 'x-forwarded-for': '127.0.0.1' } },
    });
    assert.equal(fromPublic, '203.0.113.50');
  });

  async function connectPollingClient(code) {
    const r1 = await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&room=${code}`);
    const t1 = await r1.text();
    const { sid } = JSON.parse(t1.slice(t1.indexOf('{')));
    await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid}`, { method: 'POST', body: '40' });
    await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid}`); // drain initial connect/state
    return sid;
  }

  it('acknowledges answers so phones can show whether they arrived', async () => {
    const { code } = await (await fetch(`${baseUrl}/api/rooms`, { method: 'POST' })).json();
    const url = sid => `${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid}`;
    const post = (sid, body) => fetch(url(sid), { method: 'POST', body });
    const pollUntil = async (sid, re) => {
      let all = '';
      for (let i = 0; i < 6 && !re.test(all); i++) all += await (await fetch(url(sid))).text();
      return all;
    };
    const sidP = await connectPollingClient(code);
    const sidH = await connectPollingClient(code);
    try {
      await post(sidP, '42["join",{"name":"Acki"}]');
      await post(sidH, '42["host:wheelEnabled",false]\x1e42["host:mode","quiz"]');
      await post(sidH, '42["host:start"]');
      await post(sidP, '421["answer",0]');
      assert.match(await pollUntil(sidP, /431\[/), /431\[\{"ok":true\}\]/);
      // Einziger Spieler hat geantwortet → Auflösung; spätere Antworten werden abgelehnt
      await post(sidP, '422["answer",1]');
      assert.match(await pollUntil(sidP, /432\[/), /432\[\{"ok":false\}\]/);
    } finally {
      await post(sidP, '41');
      await post(sidH, '41');
      rooms.get(code)?.destroy();
      rooms.delete(code);
    }
  });

  it('allows multiple devices to control a room via /admin host events', async () => {
    const createRes = await fetch(`${baseUrl}/api/rooms`, { method: 'POST' });
    const created = await createRes.json();
    const code = created.code;

    const sid1 = await connectPollingClient(code);
    const sid2 = await connectPollingClient(code);

    try {
      // First device authenticates via hostToken, second device does not (simulating /admin?room=CODE)
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid1}`, {
        method: 'POST',
        body: `42["host:auth",${JSON.stringify(created.hostToken)}]`,
      });
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid2}`, {
        method: 'POST',
        body: '42["host:mode","songquiz"]',
      });
      // Drain state broadcast on sid1 and confirm mode changed by sid2
      const pollRes = await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid1}`);
      const pollBody = await pollRes.text();
      assert.ok(pollBody.includes('"mode":"songquiz"'), `Expected mode songquiz in ${pollBody}`);
    } finally {
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid1}`, { method: 'POST', body: '41' });
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid2}`, { method: 'POST', body: '41' });
      rooms.get(code)?.destroy();
      rooms.delete(code);
    }
  });

  it('delivers and resolves secret missions across play.html and host.html', async () => {
    const playHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'play.html'), 'utf8');
    const hostHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'host.html'), 'utf8');
    assert.ok(playHtml.includes('renderMissionBanner()'), 'play.html must render mission banner in renderView');
    const renderViewBody = playHtml.slice(playHtml.indexOf('function renderView()'));
    assert.ok(renderViewBody.includes('renderMissionBanner()'), 'renderView must include mission banner');
    assert.ok(
      hostHtml.includes('})();') && hostHtml.lastIndexOf('})();') < hostHtml.indexOf("if (S.phase === 'result' && S.missionReveal)"),
      'host.html must render missionReveal after mode body'
    );

    const createRes = await fetch(`${baseUrl}/api/rooms`, { method: 'POST' });
    const { code } = await createRes.json();
    const sid1 = await connectPollingClient(code);
    const sid2 = await connectPollingClient(code);
    const sidHost = await connectPollingClient(code);

    const origRandom = Math.random;
    try {
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid1}`, { method: 'POST', body: '42["join",{"name":"Alice","avatar":"😎"}]' });
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid2}`, { method: 'POST', body: '42["join",{"name":"Bob","avatar":"🦊"}]' });
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidHost}`, { method: 'POST', body: '42["host:wheelEnabled",false]\x1e42["host:secretMissions",true]' });
      // Drain pre-start state packets
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid1}`);
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid2}`);
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidHost}`);

      Math.random = () => 0.1; // ensure < 0.45 triggers a mission deterministically
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidHost}`, { method: 'POST', body: '42["host:start"]' });
      Math.random = origRandom;

      const p1Poll = await (await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid1}`)).text();
      const p2Poll = await (await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid2}`)).text();
      assert.ok(p1Poll.includes('"mission":') || p2Poll.includes('"mission":'), 'Expected one player to receive private mission');

      // Both players answer -> enters result with missionReveal
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid1}`, { method: 'POST', body: '42["answer",0]' });
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid2}`, { method: 'POST', body: '42["answer",0]' });
      const resPoll = await (await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidHost}`)).text();
      assert.ok(resPoll.includes('"missionReveal":{"playerName":'), `Expected missionReveal in ${resPoll}`);

      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidHost}`, { method: 'POST', body: '42["host:resolveMission",true]' });
      const resolvedPoll = await (await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidHost}`)).text();
      assert.ok(resolvedPoll.includes('"resolved":true,"success":true'), `Expected resolved mission in ${resolvedPoll}`);
    } finally {
      Math.random = origRandom;
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid1}`, { method: 'POST', body: '41' });
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid2}`, { method: 'POST', body: '41' });
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidHost}`, { method: 'POST', body: '41' });
      rooms.get(code)?.destroy();
      rooms.delete(code);
    }
  });

  it('serves local song-art covers and keepalive.mp4 with caching headers', async () => {
    const ka = await fetch(`${baseUrl}/keepalive.mp4`);
    assert.equal(ka.status, 200);
    const art = await fetch(`${baseUrl}/song-art/0.jpg`);
    assert.equal(art.status, 200);
    assert.match(art.headers.get('cache-control') || '', /max-age=86400/);
    const missing = await fetch(`${baseUrl}/song-art/0.txt`);
    assert.equal(missing.status, 404);
  });

  it('starts songquiz instantly from local assets and sets auto-next timer on icebreaker', async () => {
    const createRes = await fetch(`${baseUrl}/api/rooms`, { method: 'POST' });
    const { code } = await createRes.json();
    const sid1 = await connectPollingClient(code);
    const sidHost = await connectPollingClient(code);

    try {
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid1}`, { method: 'POST', body: '42["join",{"name":"Tester","avatar":"😎"}]' });
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidHost}`, {
        method: 'POST',
        body: '42["host:wheelEnabled",false]\x1e42["host:mode","songquiz"]',
      });
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidHost}`);

      const t0 = Date.now();
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidHost}`, { method: 'POST', body: '42["host:start"]' });
      const sqPoll = await (await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidHost}`)).text();
      assert.ok(Date.now() - t0 < 500, 'songquiz round must start locally in <500ms without external API blocking');
      assert.ok(sqPoll.includes('/song-audio/'), 'Expected local /song-audio/ preview');
      assert.ok(sqPoll.includes('/song-art/'), 'Expected local /song-art/ artPreload');

      // Switch to icebreaker and verify autoNextMs is 15000 (not 0 infinite freeze)
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidHost}`, { method: 'POST', body: '42["host:mode","icebreaker"]' });
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidHost}`, { method: 'POST', body: '42["host:start"]' });
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid1}`, { method: 'POST', body: '42["answer","Hallo Welt"]' });
      const icePoll = await (await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidHost}`)).text();
      assert.ok(icePoll.includes('"phase":"result"'), 'Expected icebreaker result phase');
      assert.ok(icePoll.includes('"totalMs":15000'), `Expected 15000ms autoNextMs in ${icePoll}`);
    } finally {
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid1}`, { method: 'POST', body: '41' });
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidHost}`, { method: 'POST', body: '41' });
      rooms.get(code)?.destroy();
      rooms.delete(code);
    }
  });

  it('includes performance, wake-lock fallback, and render-guard protections in client HTML', () => {
    const playHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'play.html'), 'utf8');
    const hostHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'host.html'), 'utf8');
    const uxJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ux-helpers.js'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

    assert.ok(playHtml.includes('if (phoneSig === lastPhoneSig) return;'), 'play.html must have render-diff guard');
    assert.ok(playHtml.includes('myAnswer = r.myAnswer; ansState = \'ok\''), 'play.html reconnect must restore myAnswer');
    assert.ok(playHtml.includes('id="connBanner"') && playHtml.includes('undoPad()'), 'play.html must provide offline banner and draw undo');
    assert.ok(hostHtml.includes('pgInitWakeLock({ videoFallback: true'), 'host.html must enable video fallback wake lock');
    assert.ok(hostHtml.includes('id="hostNextBtn"'), 'host.html must provide touch Next button');
    assert.ok(hostHtml.includes('/silent.mp3'), 'host.html must unlock HTMLAudio with /silent.mp3');
    assert.ok(uxJs.includes('/keepalive.mp4') && !uxJs.includes('{ once: true'), 'ux-helpers.js must re-acquire wake lock and use keepalive.mp4 fallback');
    assert.ok(!css.includes('background-attachment: fixed'), 'style.css must avoid background-attachment: fixed');
    const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
    assert.ok(adminHtml.includes('if (adminSig === lastAdminSig') && adminHtml.includes('id="adminConnBanner"'), 'admin.html must guard renders and show connection banner');
  });

  it('serves /silent.mp3 and supports draw:undo by stroke sid', async () => {
    const sRes = await fetch(`${baseUrl}/silent.mp3`);
    assert.equal(sRes.status, 200);

    const createRes = await fetch(`${baseUrl}/api/rooms`, { method: 'POST' });
    const { code } = await createRes.json();
    const sidDrawer = await connectPollingClient(code);
    const sidHost = await connectPollingClient(code);

    try {
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidDrawer}`, { method: 'POST', body: '42["join",{"name":"Maler","avatar":"🎨"}]' });
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidHost}`, {
        method: 'POST',
        body: '42["host:wheelEnabled",false]\x1e42["host:mode","draw"]',
      });
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidHost}`, { method: 'POST', body: '42["host:start"]' });
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidHost}`); // drain start state

      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidDrawer}`, {
        method: 'POST',
        body: '42["draw:stroke",{"p":[100,100,200,200],"c":"#111","w":6,"sid":1}]\x1e42["draw:stroke",{"p":[200,200,300,300],"c":"#e21b3c","w":11,"sid":2}]\x1e42["draw:stroke",{"p":[300,300,400,400],"c":"#e21b3c","w":11,"sid":2}]\x1e42["draw:stroke",{"p":[1,2,3],"c":"#111","w":6,"sid":3}]\x1e42["draw:stroke",{"p":[0.5,0.5,1,1],"c":"#111","w":6,"sid":4}]',
      });
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidHost}`); // drain strokes
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidDrawer}`, { method: 'POST', body: '42["draw:undo"]' });

      const histPoll = await (await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidHost}`)).text();
      assert.ok(histPoll.includes('"draw:history"'), `Expected draw:history in ${histPoll}`);
      assert.ok(histPoll.includes('"sid":1') && !histPoll.includes('"sid":2'), `Expected sid 1 kept and sid 2 removed in ${histPoll}`);
      assert.ok(!histPoll.includes('"sid":3') && !histPoll.includes('"sid":4'), `Expected malformed chunks (odd length, non-integer) rejected in ${histPoll}`);
    } finally {
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidDrawer}`, { method: 'POST', body: '41' });
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidHost}`, { method: 'POST', body: '41' });
      rooms.get(code)?.destroy();
      rooms.delete(code);
    }
  });

  it('persists rooms across restarts: serialize → restore → rejoin keeps score, answer, phase and idx', async () => {
    const { code, hostToken } = await (await fetch(`${baseUrl}/api/rooms`, { method: 'POST' })).json();
    const url = sid => `${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid}`;
    const post = (sid, body) => fetch(url(sid), { method: 'POST', body });
    const pollUntil = async (sid, re) => {
      let all = '';
      for (let i = 0; i < 8 && !re.test(all); i++) all += await (await fetch(url(sid))).text();
      return all;
    };
    const packet = (txt, prefix) => txt.split('\x1e').find(p => p.startsWith(prefix));
    const ackOf = (txt, id) => JSON.parse(packet(txt, `43${id}`).slice(2 + String(id).length))[0];
    const lastState = txt => {
      const states = txt.split('\x1e').filter(p => p.startsWith('42["state"'));
      return states.length ? JSON.parse(states[states.length - 1].slice(2))[1] : null;
    };
    const questions = require('../data/questions.json');

    const sidP = await connectPollingClient(code);
    const sidP2 = await connectPollingClient(code);
    const sidH = await connectPollingClient(code);
    let sidR = null;
    try {
      await post(sidP, '421["join",{"name":"Persi","avatar":"🦊"}]');
      const token = ackOf(await pollUntil(sidP, /431\[/), 1).reconnectToken;
      assert.ok(token, 'Expected reconnectToken from join');
      await post(sidP2, '42["join",{"name":"Zweit"}]');
      await post(sidH, '42["host:wheelEnabled",false]\x1e42["host:mode","quiz"]');
      await post(sidH, '42["host:start"]');
      const q1 = lastState(await pollUntil(sidH, /"phase":"question","idx":0/));
      const correct = questions.find(item => item.q === q1.q.q).c;

      // Runde 1: beide antworten → Auflösung mit Punkten
      await post(sidP, `422["answer",${correct}]`);
      assert.equal(ackOf(await pollUntil(sidP, /432\[/), 2).ok, true);
      await post(sidP2, `42["answer",${(correct + 1) % 4}]`);
      await pollUntil(sidH, /"phase":"result"/);

      // Runde 2: nur Persi antwortet, Runde läuft weiter
      await post(sidH, '42["host:next"]');
      await pollUntil(sidH, /"phase":"question","idx":1/);
      await post(sidP, '423["answer",2]');
      assert.equal(ackOf(await pollUntil(sidP, /433\[/), 3).ok, true);

      const snap = snapshotRooms();
      const roomSnap = snap.rooms.find(r => r.code === code);
      assert.ok(roomSnap, 'room must be part of the snapshot');
      const persiSnap = roomSnap.players.find(p => p.name === 'Persi');
      assert.ok(persiSnap.score > 0, 'correct answer in round 1 must have scored');
      assert.equal(persiSnap.answer, 2);
      assert.equal(persiSnap.reconnectToken, token);
      assert.equal(roomSnap.state.phase, 'question');
      assert.equal(roomSnap.state.idx, 1);
      assert.equal(roomSnap.state.imposterIds, undefined, 'socket ids must not be persisted');

      // "Neustart": Verbindungen weg, Raum zerstört, dann aus dem Schnappschuss wiederherstellen
      await post(sidP, '41\x1e1');
      await post(sidP2, '41\x1e1');
      await post(sidH, '41\x1e1');
      rooms.get(code).destroy();
      rooms.delete(code);
      assert.equal(rooms.has(code), false);

      const restored = restoreRooms({ ...snap, rooms: [roomSnap] });
      assert.deepEqual(restored, { count: 1, players: 2 });
      const room = rooms.get(code);
      assert.ok(room, 'room must exist again after restore');
      assert.equal(room.code, code);
      assert.equal(room.hostToken, hostToken);

      sidR = await connectPollingClient(code);
      await post(sidR, '421["join",{"name":"Persi"}]');
      assert.match(ackOf(await pollUntil(sidR, /431\[/), 1).error, /reserviert/);
      await post(sidR, `422["join",{"name":"Persi","avatar":"🦊","reconnectToken":${JSON.stringify(token)}}]`);
      const rejoinTxt = await pollUntil(sidR, /432\[/);
      const rejoinAck = ackOf(rejoinTxt, 2);
      assert.equal(rejoinAck.ok, true);
      assert.equal(rejoinAck.reconnectToken, token);
      assert.equal(rejoinAck.myAnswer, 2);

      const st = lastState(rejoinTxt.includes('"name":"Persi"') ? rejoinTxt : rejoinTxt + await pollUntil(sidR, /"name":"Persi"/));
      assert.equal(st.roomCode, code);
      assert.equal(st.phase, 'question');
      assert.equal(st.idx, 1);
      const persi = st.players.find(p => p.name === 'Persi');
      assert.equal(persi.score, persiSnap.score);
      assert.equal(persi.answered, true);
    } finally {
      // '1' = Engine.IO-Close: sofort schließen statt 30 s auf den nächsten Poll zu warten
      for (const sid of [sidP, sidP2, sidH, sidR]) if (sid) await post(sid, '41\x1e1').catch(() => {});
      rooms.get(code)?.destroy();
      rooms.delete(code);
    }
  });

  it('reveals contiguous partial word matches (>=3 chars) while ignoring short guesses', () => {
    const rev1 = initWordMask('Einkaufswagen');
    assert.equal(formatWordMask('Einkaufswagen', rev1), '_____________');
    assert.equal(applyPartialGuess('Einkaufswagen', rev1, 'ei'), false);
    assert.equal(applyPartialGuess('Einkaufswagen', rev1, 'einkaufen'), true);
    assert.equal(formatWordMask('Einkaufswagen', rev1), 'Einkauf______');
    assert.equal(applyPartialGuess('Einkaufswagen', rev1, 'einkaufen'), false);
    assert.equal(applyPartialGuess('Einkaufswagen', rev1, 'wagen'), true);
    assert.equal(formatWordMask('Einkaufswagen', rev1), 'Einkauf_wagen');

    const rev2 = initWordMask('Wahrheit oder Pflicht');
    assert.equal(formatWordMask('Wahrheit oder Pflicht', rev2), '________ ____ _______');
    assert.equal(applyPartialGuess('Wahrheit oder Pflicht', rev2, 'pflicht'), true);
    assert.equal(formatWordMask('Wahrheit oder Pflicht', rev2), '________ ____ Pflicht');

    const rev3 = initWordMask('U-Boot');
    assert.equal(formatWordMask('U-Boot', rev3), '_-____');
    assert.equal(applyPartialGuess('U-Boot', rev3, 'boot'), true);
    assert.equal(formatWordMask('U-Boot', rev3), '_-Boot');

    const revShort = initWordMask('DJ');
    assert.equal(applyPartialGuess('DJ', revShort, 'd'), false);
    assert.equal(formatWordMask('DJ', revShort), '__');
  });

  it('broadcasts updated word mask on partial guesses in draw and taboo', async () => {
    const extractJsonPayloads = (raw, eventName) => {
      const out = [];
      const marker = `"${eventName}",`;
      let idx = 0;
      while ((idx = raw.indexOf(marker, idx)) !== -1) {
        let start = idx + marker.length;
        while (start < raw.length && raw[start] !== '{') start++;
        let depth = 0;
        let inStr = false;
        let escNext = false;
        for (let i = start; i < raw.length; i++) {
          const c = raw[i];
          if (escNext) { escNext = false; continue; }
          if (c === '\\') { escNext = true; continue; }
          if (c === '"') { inStr = !inStr; continue; }
          if (!inStr) {
            if (c === '{') depth++;
            else if (c === '}') {
              depth--;
              if (depth === 0) {
                try { out.push(JSON.parse(raw.slice(start, i + 1))); } catch {}
                break;
              }
            }
          }
        }
        idx = start + 1;
      }
      return out;
    };

    for (const mode of ['draw', 'taboo']) {
      const createRes = await fetch(`${baseUrl}/api/rooms`, { method: 'POST' });
      const { code } = await createRes.json();
      const sidA = await connectPollingClient(code);
      const sidB = await connectPollingClient(code);
      const sidHost = await connectPollingClient(code);

      try {
        await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidA}`, { method: 'POST', body: '42["join",{"name":"Alice","avatar":"🦊"}]' });
        await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidB}`, { method: 'POST', body: '42["join",{"name":"Bob","avatar":"🐸"}]' });
        await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidHost}`, {
          method: 'POST',
          body: `42["host:wheelEnabled",false]\x1e42["host:mode","${mode}"]`,
        });
        await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidHost}`, { method: 'POST', body: '42["host:start"]' });

        const pollA = await (await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidA}`)).text();
        const pollB = await (await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidB}`)).text();
        const pollHost = await (await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidHost}`)).text();

        const privA = extractJsonPayloads(pollA, 'private').pop();
        const privB = extractJsonPayloads(pollB, 'private').pop();
        const isAActor = Boolean(privA && (privA.drawer || privA.explainer));
        const word = isAActor ? privA.word : privB.word;
        const guesserSid = isAActor ? sidB : sidA;
        assert.ok(word && word.length >= 2, `Expected secret word in ${mode}, got ${word}`);

        const hostStartState = extractJsonPayloads(pollHost, 'state').pop();
        assert.ok(hostStartState && hostStartState.q && typeof hostStartState.q.mask === 'string', `Expected mask in ${mode}`);

        // Pick a >=3-letter alphanumeric chunk if word is long enough
        const lettersOnly = word.replace(/[^\p{L}\p{N}]/gu, '');
        if (lettersOnly.length >= 4) {
          const part = lettersOnly.slice(0, 3);
          const ev = mode === 'draw' ? 'draw:guess' : 'taboo:guess';
          await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${guesserSid}`, {
            method: 'POST',
            body: `421["${ev}",${JSON.stringify(part)}]`,
          });
          const ackPoll = await (await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${guesserSid}`)).text();
          assert.ok(ackPoll.includes('"partial":true'), `Expected partial:true ack in ${mode}: ${ackPoll}`);

          const hostAfterPartial = extractJsonPayloads(
            await (await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidHost}`)).text(),
            'state',
          ).pop();
          assert.ok(hostAfterPartial.q.mask.toLowerCase().includes(part.toLowerCase()), `Expected mask "${hostAfterPartial.q.mask}" to reveal "${part}"`);
        }
      } finally {
        await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidA}`, { method: 'POST', body: '41' });
        await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidB}`, { method: 'POST', body: '41' });
        await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sidHost}`, { method: 'POST', body: '41' });
        rooms.get(code)?.destroy();
        rooms.delete(code);
      }
    }
  });

  it('shows a party card between rounds, applies its points via /admin and continues the game', async () => {
    const { io: ioc } = require('socket.io-client');
    const { code } = await (await fetch(`${baseUrl}/api/rooms`, { method: 'POST' })).json();
    const connect = () => ioc(baseUrl, { query: { room: code, page: 'play' }, transports: ['websocket'], forceNew: true });
    const admin = connect();
    const names = ['Ada', 'Bo', 'Cy'];
    const players = names.map(connect);
    let S = null;
    admin.on('state', s => { S = s; });
    const until = async (pred, ms = 3000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (S && pred(S)) return S; await new Promise(r => setTimeout(r, 20)); }
      throw new Error(`timeout, phase=${S && S.phase}`);
    };
    try {
      await Promise.all(players.map((p, i) => new Promise(res => p.emit('join', { name: names[i], avatar: '😎' }, res))));
      admin.emit('host:mode', 'quiz');
      admin.emit('host:wheelEnabled', false);
      admin.emit('host:partyCards', 'often');
      await until(s => s.partyCards === 'often' && s.players.length === 3);
      admin.emit('host:start');
      // „Oft“ = spätestens nach der dritten Runde kommt eine Karte
      for (let round = 0; round < 3 && S.phase !== 'card'; round++) {
        await until(s => s.phase === 'question' && s.idx === round);
        await Promise.all(players.map((p, i) => new Promise(res => p.emit('answer', i, res))));
        await until(s => s.phase === 'result');
        admin.emit('host:next');
        await until(s => s.phase === 'card' || (s.phase === 'question' && s.idx === round + 1));
      }
      assert.equal(S.phase, 'card', 'expected a party card within three rounds');
      const card = S.card;
      const idxAtCard = S.idx;
      assert.ok(card.text && !/[{}]/.test(card.text), `placeholders must be filled: ${card.text}`);
      const before = Object.fromEntries(S.players.map(p => [p.name, p.score]));
      const diff = () => Object.fromEntries(S.players.map(p => [p.name, p.score - before[p.name]]));

      if (card.act === 'vote') {
        players.forEach((p, i) => p.emit('card:vote', i === 1 ? 'Ada' : 'Bo')); // Bo: 2 Stimmen
        await until(s => s.card && s.card.resolved);
        assert.equal(diff().Bo, card.reward);
      } else if (card.act === 'yesno') {
        // Die Handys bewerten: alle Nicht-Betroffenen stimmen „gelungen“ → Mehrheit
        players.forEach((p, i) => { if (card.judges.includes(names[i])) p.emit('card:judge', true); });
        await until(s => s.card && s.card.resolved);
        const d = diff();
        const winners = card.pair || (card.type === 'group' || card.type === 'photo' ? names : [card.target]);
        winners.forEach(n => assert.equal(d[n], card.reward));
      } else if (card.act === 'duel') {
        admin.emit('host:cardResolve', { name: card.duel[0] });
        await until(s => s.card && s.card.resolved);
        assert.equal(diff()[card.duel[0]], card.reward);
      } else if (card.act === 'give') {
        admin.emit('host:cardResolve', { name: names.find(n => n !== card.target) });
        await until(s => s.card && s.card.resolved);
        assert.equal(Object.values(diff()).reduce((a, b) => a + b, 0), 0, 'point transfers must not create points');
      }
      if (card.act === 'rule') assert.equal(S.rule, card.text);

      admin.emit('host:next');
      await until(s => s.phase === 'question' && s.idx === idxAtCard + 1);
      assert.equal(S.card, null);
    } finally {
      admin.close();
      players.forEach(p => p.close());
      rooms.get(code)?.destroy();
      rooms.delete(code);
    }
  });

  // Raum im Remote-Modus bis zur ersten Party-Karte spielen; Math.random erzwingt dort die Foto-Challenge
  async function snapRoom(names) {
    const { io: ioc } = require('socket.io-client');
    const { code } = await (await fetch(`${baseUrl}/api/rooms`, { method: 'POST' })).json();
    const connect = () => ioc(baseUrl, { query: { room: code, page: 'play' }, transports: ['websocket'], forceNew: true });
    const r = { code, admin: connect(), players: names.map(connect), S: null, pops: 0, priv: names.map(() => null) };
    r.admin.on('state', s => { r.S = s; });
    r.admin.on('photo:new', () => { r.pops++; });
    r.players.forEach((p, i) => p.on('private', v => { r.priv[i] = v; }));
    r.until = async (pred, ms = 3000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (r.S && pred(r.S)) return r.S; await new Promise(res => setTimeout(res, 20)); }
      throw new Error(`timeout, phase=${r.S && r.S.phase} stage=${r.S && r.S.card && r.S.card.stage}`);
    };
    r.upload = (who, fill) => fetch(`${baseUrl}/api/photos/${code}`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg', 'x-photo-name': encodeURIComponent(who), 'x-card': r.S.card.id },
      body: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, fill), Buffer.from([0xff, 0xd9])]),
    });
    r.cleanup = () => {
      r.admin.close();
      r.players.forEach(p => p.close());
      rooms.get(code)?.destroy();
      rooms.delete(code);
      fs.rmSync(path.join(__dirname, '..', 'data', 'photos', code), { recursive: true, force: true });
    };
    const realRandom = Math.random;
    try {
      await Promise.all(r.players.map((p, i) => new Promise(res => p.emit('join', { name: names[i], avatar: '😎' }, res))));
      r.admin.emit('host:mode', 'quiz');
      r.admin.emit('host:wheelEnabled', false);
      r.admin.emit('host:partyCards', 'often');
      r.admin.emit('host:remote', true);
      await r.until(s => s.remote === true && s.players.length === names.length);
      r.admin.emit('host:start');
      for (let round = 0; round < 4 && r.S.phase !== 'card'; round++) {
        await r.until(s => s.phase === 'question' && s.idx === round);
        await Promise.all(r.players.map((p, i) => new Promise(res => p.emit('answer', i % 4, res))));
        await r.until(s => s.phase === 'result');
        Math.random = () => 0.9999; // gewichtete Typ-Wahl → letzter Typ = Foto-Challenge
        r.admin.emit('host:next');
        await r.until(s => s.phase === 'card' || (s.phase === 'question' && s.idx === round + 1));
        Math.random = realRandom;
      }
    } catch (e) {
      r.cleanup();
      throw e;
    } finally {
      Math.random = realRandom;
    }
    assert.equal(r.S.phase, 'card');
    assert.equal(r.S.card.act, 'snap');
    assert.equal(r.S.card.stage, 'collect');
    return r;
  }

  it('remote mode: photo challenge collects one photo per player, votes anonymously and awards the best photo', async () => {
    const r = await snapRoom(['Ada', 'Bo', 'Cy']);
    const { players, until, upload, code } = r;
    try {
      const before = Object.fromEntries(r.S.players.map(p => [p.name, p.score]));

      assert.equal((await upload('Ada', 1)).status, 201);
      assert.equal((await upload('Bo', 2)).status, 201);
      await until(s => s.card.submitted.length === 2);
      assert.equal(r.S.card.stage, 'collect');
      assert.equal(r.S.card.photos, null, 'photos stay hidden while collecting');
      assert.equal((await upload('Cy', 3)).status, 201);
      await until(s => s.card.stage === 'vote');
      assert.equal(r.S.card.photos.length, 3);
      assert.ok(r.S.card.photos.every(p => p.name === null), 'voting is anonymous');
      assert.equal(r.pops, 0, 'challenge photos must not pop up on the TV');

      const urls = Object.fromEntries((await (await fetch(`${baseUrl}/api/photos/${code}`)).json()).photos.map(p => [p.name, p.url]));
      const idxOf = who => r.S.card.photos.find(p => p.url === urls[who]).i;
      players[1].emit('card:vote', idxOf('Bo')); // eigenes Foto zählt nicht
      players[0].emit('card:vote', idxOf('Bo'));
      players[2].emit('card:vote', idxOf('Bo'));
      await until(s => s.card.voters.length === 2);
      assert.ok(!r.S.card.voters.includes('Bo'));
      players[1].emit('card:vote', idxOf('Ada'));
      await until(s => s.card.resolved);
      const diff = Object.fromEntries(r.S.players.map(p => [p.name, p.score - before[p.name]]));
      assert.deepEqual(diff, { Ada: 10, Bo: 40, Cy: 10 });
      assert.equal(r.S.card.photos.find(p => p.url === urls.Bo).name, 'Bo');
    } finally {
      r.cleanup();
    }
  });

  it('remote photo challenge: a player whose phone drops the connection while in the camera app still gets the photo counted', async () => {
    const r = await snapRoom(['Ada', 'Bo']);
    try {
      assert.equal((await r.upload('Ada', 1)).status, 201);
      await r.until(s => s.card.submitted.length === 1);
      r.players[1].close(); // Kamera-App offen → Handy getrennt
      await r.until(s => s.players.length === 1);
      await new Promise(res => setTimeout(res, 100));
      assert.equal(r.S.card.resolved, false, 'must not end with "too few photos" while someone is in the camera');
      assert.equal(r.S.card.stage, 'collect');
      assert.equal((await r.upload('Bo', 2)).status, 201); // kommt vor dem Rejoin an
      await r.until(s => s.card.stage === 'vote');
      assert.equal(r.S.card.photos.length, 2);
      assert.equal(r.pops, 0);
      // Ada stimmt für Bos Foto → fertig (Bo ist getrennt), Bo bekommt trotzdem die Punkte
      const bosPhoto = r.S.card.photos.find(p => p.i === 1);
      r.players[0].emit('card:vote', bosPhoto.i);
      await r.until(s => s.card.resolved);
      assert.match(r.S.card.outcome, /Bo gewinnt/);
    } finally {
      r.cleanup();
    }
  });

  it('photo vote has no time limit: "Weiter" only evaluates once 2 votes are in; phones learn which photo is their own', async () => {
    const r = await snapRoom(['Ada', 'Bo', 'Cy']);
    try {
      for (const [i, n] of ['Ada', 'Bo', 'Cy'].entries()) assert.equal((await r.upload(n, i + 1)).status, 201);
      await r.until(s => s.card.stage === 'vote');
      assert.equal(r.S.card.photos.length, 3);
      // Server meldet jedem Handy privat sein eigenes Foto (Index passt zur anonymen Liste)
      await new Promise(res => setTimeout(res, 50));
      const mine = r.priv[0];
      assert.equal(mine.mode, 'snap');
      assert.equal(r.S.card.photos.find(p => p.i === mine.snapMine).url, mine.snapUrl);
      assert.equal(r.S.skipVote, null, 'no skip vote before 2 votes');

      const other = r.S.card.photos.find(p => p.i !== mine.snapMine).i;
      r.players[0].emit('card:vote', other);
      await r.until(s => s.card.voters.length === 1);
      r.admin.emit('host:next');
      r.admin.emit('host:cardResolve', {});
      await new Promise(res => setTimeout(res, 150));
      assert.equal(r.S.phase, 'card');
      assert.equal(r.S.card.resolved, false, 'one vote is not enough to continue');

      const bosPick = r.S.card.photos.find(p => p.i !== r.priv[1].snapMine).i;
      r.players[1].emit('card:vote', bosPick);
      await r.until(s => s.card.voters.length === 2);
      r.admin.emit('host:next'); // ab 2 Stimmen: auswerten statt überspringen
      await r.until(s => s.card.resolved);
      assert.equal(r.S.phase, 'card');
      assert.ok(r.S.card.photos.every(p => p.name), 'names are revealed after evaluation');
    } finally {
      r.cleanup();
    }
  });

  it('photo duel: only the two drawn players shoot, the others vote; a single photo is still shown with +10', async () => {
    const r = await snapRoom(['Ada', 'Bo', 'Cy', 'Dee']);
    try {
      const duel = r.S.card.duel;
      assert.equal(r.S.card.type, 'snapduel');
      assert.equal(duel.length, 2);
      const outsider = ['Ada', 'Bo', 'Cy', 'Dee'].find(n => !duel.includes(n));
      await r.upload(outsider, 9); // gehört nicht zum Duell → landet nur in der Foto-Wand
      await r.until(() => r.pops === 1);
      assert.deepEqual(r.S.card.submitted, []);
      const before = Object.fromEntries(r.S.players.map(p => [p.name, p.score]));
      await r.upload(duel[0], 1);
      await r.upload(duel[1], 2);
      await r.until(s => s.card.stage === 'vote');
      assert.deepEqual([...r.S.card.snapVoters].sort(), ['Ada', 'Bo', 'Cy', 'Dee'].filter(n => !duel.includes(n)).sort());
      const urls = Object.fromEntries((await (await fetch(`${baseUrl}/api/photos/${r.code}`)).json()).photos.map(p => [p.name, p.url]));
      const idxOf = who => r.S.card.photos.find(p => p.url === urls[who]).i;
      const names = ['Ada', 'Bo', 'Cy', 'Dee'];
      names.forEach((n, i) => { if (!duel.includes(n)) r.players[i].emit('card:vote', idxOf(duel[0])); });
      await r.until(s => s.card.resolved);
      const diff = Object.fromEntries(r.S.players.map(p => [p.name, p.score - before[p.name]]));
      assert.equal(diff[duel[0]], 40 + 10);
      assert.equal(diff[duel[1]], 10);
      assert.match(r.S.card.outcome, /Foto-Duell/);
    } finally {
      r.cleanup();
    }

    const one = await snapRoom(['Ada', 'Bo']);
    try {
      const before = Object.fromEntries(one.S.players.map(p => [p.name, p.score]));
      await one.upload('Ada', 1);
      await one.until(s => s.card.submitted.length === 1);
      one.admin.emit('host:snapVote'); // Zeit abgelaufen / Admin startet: nur 1 Foto
      await one.until(s => s.card.resolved);
      assert.equal(one.S.card.photos.length, 1);
      assert.equal(one.S.card.photos[0].name, 'Ada');
      assert.equal(one.S.players.find(p => p.name === 'Ada').score - before.Ada, 10);
    } finally {
      one.cleanup();
    }
  });

  it('custom party cards from /admin are stored, listed and deletable', async () => {
    const { io: ioc } = require('socket.io-client');
    const { code } = await (await fetch(`${baseUrl}/api/rooms`, { method: 'POST' })).json();
    const admin = ioc(baseUrl, { query: { room: code, page: 'play' }, transports: ['websocket'], forceNew: true });
    const file = path.join(__dirname, '..', 'data', 'customcards.json');
    const hadFile = fs.existsSync(file);
    const backup = hadFile ? fs.readFileSync(file) : null;
    let S = null;
    admin.on('state', s => { S = s; });
    const until = async pred => {
      const end = Date.now() + 3000;
      while (Date.now() < end) { if (S && pred(S)) return S; await new Promise(res => setTimeout(res, 20)); }
      throw new Error('timeout');
    };
    try {
      await until(s => Array.isArray(s.customCards));
      const n0 = S.customCards.length;
      const bad = await new Promise(res => admin.emit('host:addCard', { type: 'nope', text: 'Hallo Welt' }, res));
      assert.equal(bad.ok, false);
      const ok = await new Promise(res => admin.emit('host:addCard', { type: 'duel', where: 'remote', text: 'Wer trinkt schneller aus?' }, res));
      assert.equal(ok.ok, true);
      await until(s => s.customCards.length === n0 + 1);
      const card = S.customCards[S.customCards.length - 1];
      assert.equal(card.text, '{a} gegen {b}: Wer trinkt schneller aus?');
      assert.equal(card.where, 'remote');
      await new Promise(res => setTimeout(res, 100));
      assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).some(c => c.id === card.id), 'saved to data/customcards.json');
      admin.emit('host:delCard', card.id);
      await until(s => s.customCards.length === n0);
    } finally {
      admin.close();
      rooms.get(code)?.destroy();
      rooms.delete(code);
      await new Promise(res => setTimeout(res, 100));
      if (hadFile) fs.writeFileSync(file, backup);
      else fs.rmSync(file, { force: true });
    }
  });

  it('Mitmach photo card: the first photo of each player during the card gives +5, later ones nothing', async () => {
    const { io: ioc } = require('socket.io-client');
    const nodeCrypto = require('node:crypto');
    const { code } = await (await fetch(`${baseUrl}/api/rooms`, { method: 'POST' })).json();
    const connect = () => ioc(baseUrl, { query: { room: code, page: 'play' }, transports: ['websocket'], forceNew: true });
    const admin = connect();
    const names = ['Ada', 'Bo'];
    const players = names.map(connect);
    const file = path.join(__dirname, '..', 'data', 'customcards.json');
    const backup = fs.existsSync(file) ? fs.readFileSync(file) : null;
    let S = null;
    let pops = [];
    admin.on('state', s => { S = s; });
    admin.on('photo:new', p => { pops.push(p); });
    const until = async (pred, ms = 3000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (S && pred(S)) return S; await new Promise(res => setTimeout(res, 20)); }
      throw new Error(`timeout, phase=${S && S.phase}`);
    };
    const upload = (who, fill) => fetch(`${baseUrl}/api/photos/${code}`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg', 'x-photo-name': encodeURIComponent(who) },
      body: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, fill), Buffer.from([0xff, 0xd9])]),
    });
    const realRandom = Math.random;
    const realRandomInt = nodeCrypto.randomInt;
    let cardId = null;
    try {
      await Promise.all(players.map((p, i) => new Promise(res => p.emit('join', { name: names[i], avatar: '😎' }, res))));
      const added = await new Promise(res => admin.emit('host:addCard', { type: 'crowd', where: 'local', text: 'Alle machen ein Gruppenfoto mit Grimasse!' }, res));
      assert.equal(added.ok, true);
      await until(s => s.customCards.some(c => c.text.includes('Grimasse')));
      cardId = S.customCards.find(c => c.text.includes('Grimasse')).id;
      admin.emit('host:mode', 'quiz');
      admin.emit('host:wheelEnabled', false);
      admin.emit('host:partyCards', 'often');
      await until(s => s.partyCards === 'often' && s.players.length === 2);
      admin.emit('host:start');
      for (let round = 0; round < 4 && S.phase !== 'card'; round++) {
        await until(s => s.phase === 'question' && s.idx === round);
        await Promise.all(players.map((p, i) => new Promise(res => p.emit('answer', i, res))));
        await until(s => s.phase === 'result');
        // vor Ort ist „Mitmach“ der letzte Kartentyp, die eigene Karte die letzte darin
        Math.random = () => 0.9999;
        nodeCrypto.randomInt = (...a) => (a.length === 1 && typeof a[0] === 'number' ? a[0] - 1 : realRandomInt(...a));
        admin.emit('host:next');
        await until(s => s.phase === 'card' || (s.phase === 'question' && s.idx === round + 1));
        Math.random = realRandom;
        nodeCrypto.randomInt = realRandomInt;
      }
      assert.equal(S.card.type, 'crowd');
      assert.equal(S.card.photo, true);
      assert.deepEqual(S.card.photoBonus, { pts: 5, got: [] });
      const before = Object.fromEntries(S.players.map(p => [p.name, p.score]));
      await upload('Ada', 1);
      await upload('Ada', 2);
      await upload('Bo', 3);
      await until(s => s.card.photoBonus.got.length === 2);
      const diff = Object.fromEntries(S.players.map(p => [p.name, p.score - before[p.name]]));
      assert.deepEqual(diff, { Ada: 5, Bo: 5 });
      assert.deepEqual(pops.map(p => p.bonus || 0), [5, 0, 5]);
    } finally {
      Math.random = realRandom;
      nodeCrypto.randomInt = realRandomInt;
      if (cardId) admin.emit('host:delCard', cardId);
      await new Promise(res => setTimeout(res, 100));
      admin.close();
      players.forEach(p => p.close());
      rooms.get(code)?.destroy();
      rooms.delete(code);
      fs.rmSync(path.join(__dirname, '..', 'data', 'photos', code), { recursive: true, force: true });
      if (backup) fs.writeFileSync(file, backup);
      else fs.rmSync(file, { force: true });
    }
  });

  // ---- Mehr Interaktion: Raum mit Spielern aufsetzen, Modus wählen, starten ----
  async function playRoom(names, mode, setup = () => {}) {
    const { io: ioc } = require('socket.io-client');
    const { code } = await (await fetch(`${baseUrl}/api/rooms`, { method: 'POST' })).json();
    const connect = () => ioc(baseUrl, { query: { room: code, page: 'play' }, transports: ['websocket'], forceNew: true });
    const r = { code, admin: connect(), players: names.map(connect), S: null, priv: names.map(() => null), played: [] };
    r.admin.on('state', s => { r.S = s; });
    r.admin.on('joker:played', j => r.played.push(j));
    r.players.forEach((p, i) => p.on('private', v => { r.priv[i] = v; }));
    r.until = async (pred, ms = 3000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (r.S && pred(r.S)) return r.S; await new Promise(res => setTimeout(res, 15)); }
      throw new Error(`timeout, phase=${r.S && r.S.phase} mode=${r.S && r.S.mode} idx=${r.S && r.S.idx}`);
    };
    r.answer = (i, val) => new Promise(res => r.players[i].emit('answer', val, a => res(a && a.ok)));
    r.score = n => r.S.players.find(p => p.name === n).score;
    r.cleanup = () => {
      r.admin.close();
      r.players.forEach(p => p.close());
      rooms.get(code)?.destroy();
      rooms.delete(code);
    };
    try {
      await Promise.all(r.players.map((p, i) => new Promise(res => p.emit('join', { name: names[i], avatar: '😎' }, res))));
      r.admin.emit('host:wheelEnabled', false);
      r.admin.emit('host:mode', mode);
      await r.until(s => s.mode === mode && s.players.length === names.length && s.wheelEnabled === false);
      await setup(r);
      r.admin.emit('host:start');
      await r.until(s => s.phase === 'question');
    } catch (e) {
      r.cleanup();
      throw e;
    }
    return r;
  }
  const QUIZ = require('../data/questions.json');
  const correctIdx = S => QUIZ.find(x => x.q === S.q.q && JSON.stringify(x.a) === JSON.stringify(S.q.a)).c;

  it('hot seat: everyone guesses what the person in the hot seat picks; right guesses +50, hot seat +10 each', async () => {
    const r = await playRoom(['Ada', 'Bo', 'Cy'], 'hotseat');
    try {
      const hot = r.S.q.hot;
      assert.ok(['Ada', 'Bo', 'Cy'].includes(hot));
      const idx = n => ['Ada', 'Bo', 'Cy'].indexOf(n);
      const [g1, g2] = ['Ada', 'Bo', 'Cy'].filter(n => n !== hot);
      assert.equal(await r.answer(idx(hot), 0), true);
      assert.equal(await r.answer(idx(g1), 0), true);
      assert.equal(await r.answer(idx(g2), 1), true);
      await r.until(s => s.phase === 'result');
      assert.equal(r.S.result.hot, hot);
      assert.equal(r.S.result.pick, 0);
      assert.deepEqual(r.S.result.correct, [g1]);
      assert.equal(r.score(g1), 50);
      assert.equal(r.score(g2), 0);
      assert.equal(r.score(hot), 10);
    } finally {
      r.cleanup();
    }
  });

  it('discussion first: "Entweder-Oder" rejects votes while the 15 s discussion runs', async () => {
    const r = await playRoom(['Ada', 'Bo'], 'wouldyourather');
    try {
      assert.ok(r.S.discussLeftMs > 10000 && r.S.discussLeftMs <= 15000, `discussLeftMs=${r.S.discussLeftMs}`);
      assert.ok(r.S.leftMs > r.S.discussLeftMs, 'voting time comes on top of the discussion');
      assert.equal(await r.answer(0, 0), false);
      r.admin.emit('host:discussVotes', false);
      await r.until(s => s.discussVotes === false);
    } finally {
      r.cleanup();
    }
  });

  it('stand-up round: "Ich hab noch nie" takes no phone answers and resolves as a stand-up result', async () => {
    const r = await playRoom(['Ada', 'Bo'], 'neverhavei');
    try {
      assert.equal(r.S.q.standup, true);
      assert.ok(r.S.leftMs <= 10000);
      assert.equal(await r.answer(0, true), false);
      r.admin.emit('host:next');
      await r.until(s => s.phase === 'result');
      assert.equal(r.S.result.standup, true);
      assert.ok(r.S.players.every(p => p.drinks === 0 && p.score === 0));
    } finally {
      r.cleanup();
    }
  });

  it('team captain: only the captain answers and the whole team gets the points', async () => {
    const r = await playRoom(['Ada', 'Bo', 'Cy', 'Dee'], 'quiz', async room => {
      room.admin.emit('host:teamMode', true);
      ['red', 'red', 'blue', 'blue'].forEach((t, i) => room.players[i].emit('player:team', t));
      await room.until(s => s.teamMode && s.players.every(p => p.team));
    });
    try {
      const groups = r.S.answerGroups;
      assert.equal(groups.length, 2);
      assert.ok(groups.every(g => g.kind === 'captain'));
      assert.deepEqual(groups.map(g => g.lead).sort(), ['Ada', 'Cy']); // Runde 1: alphabetisch Erste/r
      const c = correctIdx(r.S);
      assert.equal(await r.answer(1, c), false, 'Bo is not the captain');
      assert.equal(await r.answer(0, c), true);
      assert.equal(await r.answer(2, (c + 1) % r.S.q.a.length), true);
      await r.until(s => s.phase === 'result');
      assert.ok(r.score('Ada') > 0);
      assert.equal(r.score('Bo'), r.score('Ada'));
      assert.equal(r.score('Cy'), 0);
      assert.equal(r.score('Dee'), 0);
    } finally {
      r.cleanup();
    }
  });

  it('final duel: after the last round the two best answer 3 extra questions, everyone else watches', async () => {
    const r = await playRoom(['Ada', 'Bo', 'Cy'], 'quiz', async room => {
      room.admin.emit('host:rounds', 5);
      room.admin.emit('host:jokers', false);
      await room.until(s => s.roundLimit === 5 && s.jokersOn === false);
    });
    try {
      for (let round = 0; round < 5; round++) {
        await r.until(s => s.phase === 'question' && s.idx === round);
        const c = correctIdx(r.S);
        await r.answer(0, c); // Ada immer richtig
        await r.answer(1, round < 3 ? c : (c + 1) % r.S.q.a.length);
        await r.answer(2, (c + 1) % r.S.q.a.length); // Cy immer falsch
        await r.until(s => s.phase === 'result');
        r.admin.emit('host:next');
      }
      for (let n = 1; n <= 3; n++) {
        await r.until(s => s.phase === 'question' && s.duel && s.duel.n === n);
        assert.deepEqual(r.S.duel.names, ['Ada', 'Bo']);
        assert.equal(r.S.mode, 'quiz');
        assert.equal(r.S.isFinalRound, true);
        assert.equal(await r.answer(2, 0), false, 'spectators cannot answer');
        await r.answer(0, correctIdx(r.S));
        await r.answer(1, correctIdx(r.S));
        await r.until(s => s.phase === 'result');
        r.admin.emit('host:next');
      }
      await r.until(s => s.phase === 'end');
      assert.equal(r.S.duel, null);
    } finally {
      r.cleanup();
    }
  });

  it('jokers: the round winner gets one, "double" doubles her next round, players without a joker are refused', async () => {
    const nodeCrypto = require('node:crypto');
    const realRandomInt = nodeCrypto.randomInt;
    const r = await playRoom(['Ada', 'Bo'], 'quiz');
    try {
      const c = correctIdx(r.S);
      nodeCrypto.randomInt = (...a) => (a.length === 1 && a[0] === 4 ? 0 : realRandomInt(...a)); // Joker-Typ 0 = double
      await r.answer(0, c);
      await r.answer(1, (c + 1) % r.S.q.a.length);
      await r.until(s => s.phase === 'result');
      nodeCrypto.randomInt = realRandomInt;
      assert.deepEqual(r.S.jokerNews, [{ name: 'Ada', type: 'double' }]);
      assert.equal(r.S.players.find(p => p.name === 'Ada').jokers, 1);
      await new Promise(res => setTimeout(res, 30));
      assert.deepEqual(r.priv[0].jokers, ['double']);
      const used = await new Promise(res => r.players[0].emit('joker:use', { type: 'double' }, res));
      assert.equal(used.ok, true);
      assert.equal(r.played[0].type, 'double');
      r.admin.emit('host:next');
      await r.until(s => s.phase === 'question' && s.idx === 1);
      assert.deepEqual(r.S.roundJokers.map(j => j.type), ['double']);
      const late = await new Promise(res => r.players[1].emit('joker:use', { type: 'double' }, res));
      assert.equal(late.ok, false);
      const before = r.score('Ada');
      await r.answer(0, correctIdx(r.S));
      await r.answer(1, (correctIdx(r.S) + 1) % r.S.q.a.length);
      await r.until(s => s.phase === 'result');
      const gain = r.score('Ada') - before;
      assert.ok(gain >= 100 && gain % 2 === 0, `doubled gain expected, got ${gain}`);
    } finally {
      nodeCrypto.randomInt = realRandomInt;
      r.cleanup();
    }
  });

  it('partner round: only the first of each pair answers, the partner gets the same points', async () => {
    const realRandom = Math.random;
    let r;
    try {
      r = await playRoom(['Ada', 'Bo', 'Cy', 'Dee'], 'quiz', () => { Math.random = () => 0; }); // < PARTNER_CHANCE
      Math.random = realRandom;
      const groups = r.S.answerGroups;
      assert.equal(groups.length, 2);
      assert.ok(groups.every(g => g.kind === 'partner' && g.members.length === 2));
      const names = ['Ada', 'Bo', 'Cy', 'Dee'];
      const [g1, g2] = groups;
      const partner = g1.members.find(n => n !== g1.lead);
      const c = correctIdx(r.S);
      assert.equal(await r.answer(names.indexOf(partner), c), false);
      assert.equal(await r.answer(names.indexOf(g1.lead), c), true);
      assert.equal(await r.answer(names.indexOf(g2.lead), (c + 1) % r.S.q.a.length), true);
      await r.until(s => s.phase === 'result');
      assert.ok(r.score(g1.lead) > 0);
      assert.equal(r.score(partner), r.score(g1.lead));
      g2.members.forEach(n => assert.equal(r.score(n), 0));
    } finally {
      Math.random = realRandom;
      r && r.cleanup();
    }
  });

  it('joker "Punkteklau" moves 15 points from the target to the player immediately', async () => {
    const nodeCrypto = require('node:crypto');
    const realRandomInt = nodeCrypto.randomInt;
    const r = await playRoom(['Ada', 'Bo'], 'quiz');
    try {
      const c = correctIdx(r.S);
      nodeCrypto.randomInt = (...a) => (a.length === 1 && a[0] === 4 ? 3 : realRandomInt(...a)); // Joker-Typ 3 = steal
      await r.answer(0, c); // Ada schneller → Rundensiegerin
      await new Promise(res => setTimeout(res, 300));
      await r.answer(1, c);
      await r.until(s => s.phase === 'result');
      nodeCrypto.randomInt = realRandomInt;
      assert.deepEqual(r.S.jokerNews, [{ name: 'Ada', type: 'steal' }]);
      const ada = r.score('Ada'), bo = r.score('Bo');
      assert.ok(bo >= 15);
      const noTarget = await new Promise(res => r.players[0].emit('joker:use', { type: 'steal' }, res));
      assert.equal(noTarget.ok, false);
      const ok = await new Promise(res => r.players[0].emit('joker:use', { type: 'steal', target: 'Bo' }, res));
      assert.equal(ok.ok, true);
      await r.until(s => s.players.find(p => p.name === 'Ada').score === ada + 15);
      assert.equal(r.score('Bo'), bo - 15);
      assert.equal(r.played[0].detail, '15 Punkte');
    } finally {
      nodeCrypto.randomInt = realRandomInt;
      r.cleanup();
    }
  });

  it('timer tempo scales the result pause: "relaxed" waits for Weiter, "fast" is shorter', async () => {
    const { io: ioc } = require('socket.io-client');
    const { code } = await (await fetch(`${baseUrl}/api/rooms`, { method: 'POST' })).json();
    const connect = () => ioc(baseUrl, { query: { room: code, page: 'play' }, transports: ['websocket'], forceNew: true });
    const admin = connect();
    const player = connect();
    let S = null;
    admin.on('state', s => { S = s; });
    const until = async pred => {
      const end = Date.now() + 3000;
      while (Date.now() < end) { if (S && pred(S)) return S; await new Promise(r => setTimeout(r, 20)); }
      throw new Error(`timeout, phase=${S && S.phase}`);
    };
    const resultFor = async speed => {
      admin.emit('host:reset');
      admin.emit('host:mode', 'quiz');
      admin.emit('host:timerSpeed', speed);
      await until(s => s.phase === 'lobby' && s.timerSpeed === speed);
      admin.emit('host:start');
      await until(s => s.phase === 'question');
      await new Promise(res => player.emit('answer', 0, res));
      return until(s => s.phase === 'result');
    };
    try {
      await new Promise(res => player.emit('join', { name: 'Tempo', avatar: '😎' }, res));
      admin.emit('host:wheelEnabled', false);
      assert.equal((await resultFor('normal')).totalMs, 7000 + 1250); // + Trommelwirbel
      assert.equal((await resultFor('fast')).totalMs, 6000 + 1250);
      const relaxed = await resultFor('relaxed');
      assert.equal(relaxed.deadline, 0, 'relaxed result must not auto-advance');
      assert.equal(relaxed.leftMs, 0);
    } finally {
      admin.close();
      player.close();
      rooms.get(code)?.destroy();
      rooms.delete(code);
    }
  });

  it('keeps a player whose connection is recovered (phone back from background) instead of dropping them after the grace period', async () => {
    const { io: ioc } = require('socket.io-client');
    const { code } = await (await fetch(`${baseUrl}/api/rooms`, { method: 'POST' })).json();
    const connect = () => ioc(baseUrl, { query: { room: code, page: 'play' }, transports: ['websocket'], forceNew: true });
    const admin = connect();
    const phone = connect();
    let S = null;
    admin.on('state', s => { S = s; });
    try {
      await new Promise(res => phone.emit('join', { name: 'Handy', avatar: '😎' }, res));
      const recovered = new Promise(res => phone.once('connect', () => res(phone.recovered)));
      phone.io.engine.close(); // wie pgConnect nach >15 s im Hintergrund
      assert.equal(await recovered, true, 'expected socket.io connection state recovery');
      await new Promise(r => setTimeout(r, 4500)); // > RECONNECT_GRACE_MS
      assert.ok(S.players.some(p => p.name === 'Handy'), 'player must still be in the room');
    } finally {
      admin.close();
      phone.close();
      rooms.get(code)?.destroy();
      rooms.delete(code);
    }
  });

  it('pantomime: only the actor sees the term, can swap it and awards the guesser and the actor', async () => {
    const { io: ioc } = require('socket.io-client');
    const { code } = await (await fetch(`${baseUrl}/api/rooms`, { method: 'POST' })).json();
    const connect = () => ioc(baseUrl, { query: { room: code, page: 'play' }, transports: ['websocket'], forceNew: true });
    const admin = connect();
    const names = ['Ada', 'Bo', 'Cy'];
    const players = names.map(connect);
    const priv = {};
    players.forEach((p, i) => p.on('private', d => { priv[names[i]] = d; }));
    let S = null;
    admin.on('state', s => { S = s; });
    const until = async (pred, ms = 3000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (pred()) return; await new Promise(r => setTimeout(r, 20)); }
      throw new Error(`timeout, phase=${S && S.phase}`);
    };
    try {
      await Promise.all(players.map((p, i) => new Promise(res => p.emit('join', { name: names[i], avatar: '😎' }, res))));
      admin.emit('host:wheelEnabled', false);
      admin.emit('host:mode', 'pantomime');
      await until(() => S && S.mode === 'pantomime' && S.phase === 'lobby');
      admin.emit('host:start');
      await until(() => S.phase === 'question' && S.q && S.q.actor);
      const actor = S.q.actor;
      const actorIdx = names.indexOf(actor);
      await until(() => priv[actor] && priv[actor].word);
      assert.equal(JSON.stringify(S).includes(priv[actor].word), false, 'term must not leak into the public state');
      names.filter(n => n !== actor).forEach(n => assert.ok(!priv[n] || !priv[n].word, 'only the actor gets the term'));

      const firstWord = priv[actor].word;
      players[actorIdx].emit('mime:skip');
      await until(() => priv[actor].word !== firstWord);
      assert.equal(priv[actor].skipsLeft, 1);

      const guesser = names.find(n => n !== actor);
      players[names.indexOf(guesser)].emit('mime:guessed', guesser); // nur der Darsteller darf melden
      await new Promise(r => setTimeout(r, 100));
      assert.equal(S.phase, 'question');
      players[actorIdx].emit('mime:guessed', guesser);
      await until(() => S.phase === 'result');
      assert.deepEqual(S.result.guessedBy, [guesser]);
      const score = n => S.players.find(p => p.name === n).score;
      assert.equal(score(guesser), 80);
      assert.equal(score(actor), 50);
    } finally {
      admin.close();
      players.forEach(p => p.close());
      rooms.get(code)?.destroy();
      rooms.delete(code);
    }
  });

  it('photo wall: upload JPEG, list, serve, ZIP download; rejects non-JPEG and unknown rooms', async () => {
    const { code } = await (await fetch(`${baseUrl}/api/rooms`, { method: 'POST' })).json();
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7), Buffer.from([0xff, 0xd9])]);
    const photoDir = path.join(__dirname, '..', 'data', 'photos', code);
    try {
      const up = await fetch(`${baseUrl}/api/photos/${code}`, {
        method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'x-photo-name': encodeURIComponent('Jöran') }, body: jpeg,
      });
      assert.equal(up.status, 201);
      const { photo } = await up.json();
      assert.equal(photo.name, 'Jöran');

      const bad = await fetch(`${baseUrl}/api/photos/${code}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.from('nope') });
      assert.equal(bad.status, 400);
      assert.equal((await fetch(`${baseUrl}/api/photos/ZZZZ`)).status, 404);

      const list = await (await fetch(`${baseUrl}/api/photos/${code}`)).json();
      assert.equal(list.photos.length, 1);
      const img = Buffer.from(await (await fetch(baseUrl + photo.url)).arrayBuffer());
      assert.ok(img.equals(jpeg), 'served photo must be byte-identical');

      const zip = Buffer.from(await (await fetch(`${baseUrl}/api/photos/${code}/zip`)).arrayBuffer());
      assert.equal(zip.readUInt32LE(0), 0x04034b50, 'ZIP local header');
      const eocd = zip.length - 22;
      assert.equal(zip.readUInt32LE(eocd), 0x06054b50, 'ZIP end record');
      assert.equal(zip.readUInt16LE(eocd + 10), 1, 'one entry');
      assert.ok(zip.includes(jpeg), 'ZIP stores the photo uncompressed');
    } finally {
      fs.rmSync(photoDir, { recursive: true, force: true });
      rooms.get(code)?.destroy();
      rooms.delete(code);
    }
  });

  it('photo store deletes photos older than 7 days and keeps newer ones', () => {
    const os = require('node:os');
    const { createPhotoStore, PHOTO_TTL_MS } = require('../src/photos');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-photos-'));
    try {
      const store = createPhotoStore(dir);
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
      const { entry: oldOne } = store.add('ABCD', jpeg, 'alt');
      const { entry: newOne } = store.add('ABCD', jpeg, 'neu');
      const now = oldOne.ts + PHOTO_TTL_MS + 1;
      newOne.ts = now - 1000; // gerade erst hochgeladen
      assert.equal(store.cleanup(now), 1);
      assert.deepEqual(store.list('ABCD').map(p => p.name), ['neu']);
      // Admins (Gruppe) müssen Fotos per SSH löschen können, obwohl der Dienst als anderer User läuft
      assert.equal(fs.statSync(path.join(dir, 'ABCD')).mode & 0o7777, 0o2775);
      assert.equal(fs.statSync(store.file('ABCD', newOne.id)).mode & 0o777, 0o664);
      assert.equal(fs.existsSync(store.file('ABCD', oldOne.id)), false);
      assert.equal(store.cleanup(now + PHOTO_TTL_MS), 1);
      assert.equal(store.exists('ABCD'), false, 'empty room folder is removed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('photo store notices photos deleted by hand (SSH) and does not resurrect them on the next upload', async () => {
    const os = require('node:os');
    const { createPhotoStore } = require('../src/photos');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-photos-'));
    try {
      const store = createPhotoStore(dir);
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
      const { entry: a } = store.add('WXYZ', jpeg, 'a');
      const { entry: b } = store.add('WXYZ', jpeg, 'b');
      await new Promise(r => setTimeout(r, 20)); // Ordner-mtime muss sich messbar ändern
      fs.rmSync(store.file('WXYZ', a.id));
      assert.deepEqual(store.list('WXYZ').map(p => p.id), [b.id]);
      store.add('WXYZ', jpeg, 'c');
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'WXYZ', 'meta.json'), 'utf8'));
      assert.deepEqual(meta.map(p => p.name), ['b', 'c']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
