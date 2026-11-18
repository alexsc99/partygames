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
});
