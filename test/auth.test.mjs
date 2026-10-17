/**
 * The login, end to end: a server started with GROCER_PASSWORD keeps its API
 * behind the password, lets a logged-in browser through for good — across a
 * restart too — and signs everyone out when the login generation changes.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), 'grocer-auth-'));
const PASSWORD = 'correct horse battery';
const port = 19000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}/api`;
let server;

async function start() {
  server = spawn(process.execPath, ['server/dist/server/src/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'error',
      GROCER_DATA_DIR: dataDir,
      GROCER_CLIENT_DIR: join(dataDir, 'no-client'),
      GROCER_PASSWORD: PASSWORD,
      LOGIN_MAX_FAILURES: '3',
      AI_BASE_URL: '',
      SENTRY_DSN: '',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

async function stop() {
  const exited = new Promise((r) => server.once('exit', r));
  server.kill();
  await exited;
}

after(async () => {
  if (server && server.exitCode === null) await stop();
  rmSync(dataDir, { recursive: true, force: true });
});

const send = (path, { method = 'GET', body, cookie, headers = {} } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

test('the API is closed until the household password is given, and stays open after', async () => {
  await start();

  // Health and the login itself answer; the rest refuse.
  assert.equal((await send('/health')).status, 200);
  assert.deepEqual(await (await send('/session')).json(), { required: true, authenticated: false });
  assert.equal((await send('/shop')).status, 401);
  assert.equal((await send('/recipes')).status, 401);
  assert.equal((await send('/events')).status, 401);

  assert.equal((await send('/login', { method: 'POST', body: { password: 'nope' } })).status, 401);
  const ok = await send('/login', { method: 'POST', body: { password: PASSWORD } });
  assert.equal(ok.status, 204);
  const setCookie = ok.headers.get('set-cookie');
  assert.match(setCookie, /^grocer_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  // Ten years: as good as for good.
  assert.match(setCookie, /Max-Age=315360000/);
  const cookie = setCookie.split(';')[0];

  assert.deepEqual(await (await send('/session', { cookie })).json(), { required: true, authenticated: true });
  assert.equal((await send('/shop', { cookie })).status, 200);
  const added = await send('/shop/items', {
    method: 'POST',
    cookie,
    body: { entries: [{ name: 'Mælk', quantity: null, unit: '', note: '' }] },
  });
  assert.equal(added.status, 200);

  // A change from another site is refused, logged in or not.
  const forged = await send('/shop/clear', {
    method: 'POST',
    cookie,
    body: { onlyChecked: false },
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(forged.status, 403);
  const own = await send('/shop/clear', {
    method: 'POST',
    cookie,
    body: { onlyChecked: true },
    headers: { origin: `http://127.0.0.1:${port}` },
  });
  assert.equal(own.status, 200);

  // A forged or altered cookie gets nowhere.
  assert.equal((await send('/shop', { cookie: `${cookie}x` })).status, 401);
  assert.equal((await send('/shop', { cookie: 'grocer_session=1.abc.def' })).status, 401);

  // The login survives a restart: the signing key lives in the data volume.
  await stop();
  await start();
  assert.equal((await send('/shop', { cookie })).status, 200);

  // Logging out clears the cookie.
  const out = await send('/logout', { method: 'POST', cookie });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
});

test('too many wrong passwords pause further attempts', async () => {
  // Three wrong (the limit for this server), then even the right one waits.
  const visitor = { 'cf-connecting-ip': '203.0.113.9' };
  for (let i = 0; i < 3; i++) {
    const res = await send('/login', { method: 'POST', body: { password: `wrong ${i}` }, headers: visitor });
    assert.equal(res.status, 401);
  }
  const paused = await send('/login', { method: 'POST', body: { password: PASSWORD }, headers: visitor });
  assert.equal(paused.status, 429);
  assert.ok(Number(paused.headers.get('retry-after')) > 0);
  // Someone else is not held up by it.
  const other = await send('/login', { method: 'POST', body: { password: PASSWORD }, headers: { 'cf-connecting-ip': '203.0.113.10' } });
  assert.equal(other.status, 204);
});

test('a new login generation, or a new password, signs everyone out', async () => {
  const { createAuth } = await import('../server/dist/server/src/auth.js');
  const secret = 'x'.repeat(64);
  const first = createAuth({ password: PASSWORD, secret, generation: 1 });
  const token = first.issue();
  assert.equal(first.verify(token), true);
  assert.equal(createAuth({ password: PASSWORD, secret, generation: 2 }).verify(token), false);
  assert.equal(createAuth({ password: 'another password', secret, generation: 1 }).verify(token), false);
  // Without a password, the app is open.
  assert.equal(createAuth({ password: '', secret: '' }).verify(undefined), true);
});
