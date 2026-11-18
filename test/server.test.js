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

  it('allows multiple devices to control a room via /admin host events', async () => {
    const createRes = await fetch(`${baseUrl}/api/rooms`, { method: 'POST' });
    const created = await createRes.json();
    const code = created.code;

    async function connectPollingClient() {
      const r1 = await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&room=${code}`);
      const t1 = await r1.text();
      const { sid } = JSON.parse(t1.slice(t1.indexOf('{')));
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid}`, { method: 'POST', body: '40' });
      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid}`); // drain initial connect/state
      return sid;
    }

    const sid1 = await connectPollingClient();
    const sid2 = await connectPollingClient();

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
});
