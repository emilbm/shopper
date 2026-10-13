/**
 * End to end: boots the built server against a throwaway database, a fake
 * LiteLLM harness and a fake GlitchTip, and walks the whole flow — recipes,
 * lists, the shopping list, the AI features and error reporting.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), 'grocer-test-'));

/* ------------------------------------------------------- the fakes */

const envelopes = [];
const aiCalls = [];

const RECIPE_PAGE = `<html><head><script type="application/ld+json">
{"@type":"Recipe","name":"Chili","recipeYield":"4","recipeIngredient":["400 g hakket oksekød","1 dåse kidneybønner"],
 "recipeInstructions":"Brun kødet. Kog i 30 min."}
</script></head><body></body></html>`;

function aiReply(system, user) {
  if (system.includes('supermarket aisles')) {
    const items = JSON.parse(user);
    return { items: items.map((i) => ({ id: i.id, category: /mælk|ost/i.test(i.name) ? 'dairy' : 'pantry' })) };
  }
  if (system.includes('structured data')) {
    return {
      name: 'Chili con carne',
      servings: '4',
      tags: ['tex-mex'],
      instructions: ['1. Brun kødet.', '2. Kog i 30 min.'],
      ingredients: [
        { name: 'Hakket oksekød', quantity: '400', unit: 'gram', note: '', category: 'meat' },
        { name: 'Kidneybønner', quantity: 1, unit: 'dåse', note: '', category: 'pantry' },
        { name: 'Chili', quantity: '1-2', unit: null, note: 'frisk', category: 'produce' },
      ],
    };
  }
  if (system.includes('shopping list')) {
    if (user.includes('KABOOM')) return null; // makes the fake answer 500
    if (user.includes('GARBAGE')) return 'not json';
    return {
      items: [
        { name: 'Tortillas', quantity: 8, unit: 'stk', note: 'til tacos', category: 'bakery' },
        { name: 'Mælk', quantity: 1, unit: 'l', note: '', category: 'dairy' },
      ],
    };
  }
  return {};
}

let fake;
let fakeUrl;

function startFake() {
  fake = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();

    if (req.url === '/v1/chat/completions') {
      assert.equal(req.headers.authorization, 'Bearer test-key');
      const payload = JSON.parse(body);
      aiCalls.push(payload);
      const system = payload.messages[0].content;
      const user = payload.messages[1].content;
      const reply = aiReply(system, user);
      if (reply === null) {
        res.writeHead(500).end('{"error":"boom"}');
        return;
      }
      const content = typeof reply === 'string' ? reply : '```json\n' + JSON.stringify(reply) + '\n```';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
      return;
    }
    if (req.url === '/recipe.html') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(RECIPE_PAGE);
      return;
    }
    if (req.url === '/api/7/envelope/') {
      const [, , event] = body.split('\n');
      envelopes.push(JSON.parse(event));
      res.writeHead(200).end('{}');
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => fake.listen(0, '127.0.0.1', () => resolve(fake.address().port)));
}

/* ------------------------------------------------------- the server */

let server;
let base;

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function until(fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 100));
  }
}

before(async () => {
  const fakePort = await startFake();
  fakeUrl = `http://127.0.0.1:${fakePort}`;
  const port = 18000 + Math.floor(Math.random() * 1000);
  base = `http://127.0.0.1:${port}/api`;
  server = spawn(process.execPath, ['server/dist/server/src/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'warn',
      GROCER_DATA_DIR: dataDir,
      GROCER_CLIENT_DIR: join(dataDir, 'no-client'),
      AI_BASE_URL: `${fakeUrl}/v1/`,
      AI_API_KEY: 'test-key',
      AI_MODEL: 'app-fast',
      SENTRY_DSN: `http://publickey@127.0.0.1:${fakePort}/7`,
      SENTRY_ENVIRONMENT: 'test',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await until(async () => {
    try {
      return (await fetch(base + '/health')).ok;
    } catch {
      return false;
    }
  }, 15000);
});

after(async () => {
  server?.kill();
  fake?.close();
  await new Promise((r) => setTimeout(r, 200));
  rmSync(dataDir, { recursive: true, force: true });
});

/* ------------------------------------------------------- the tests */

test('meta reports AI and error reporting', async () => {
  const { body } = await call('GET', '/meta');
  assert.deepEqual(body.ai, { enabled: true, model: 'app-fast' });
  assert.equal(body.errorReporting, true);
});

let lasagne;
let weekly;

test('recipes save ingredients by name, reusing items', async () => {
  const res = await call('POST', '/recipes', {
    name: 'Lasagne',
    servings: 4,
    tags: ['Pasta', 'pasta', ' Aftensmad '],
    ingredients: [
      { name: 'hakket oksekød', quantity: 500, unit: 'g', note: '' },
      { name: 'Mælk', quantity: 5, unit: 'dl', note: '' },
      { name: 'Lasagneplader', quantity: 1, unit: 'pk', note: '' },
      { name: 'salt', quantity: null, unit: '', note: '' },
    ],
  });
  assert.equal(res.status, 201);
  lasagne = res.body;
  assert.deepEqual(lasagne.tags, ['pasta', 'aftensmad']);
  assert.equal(lasagne.ingredients[0].name, 'Hakket oksekød');

  const list = await call('POST', '/lists', {
    name: 'Ugentlig',
    entries: [
      { name: 'mælk', quantity: 1, unit: 'l' },
      { name: 'Havregryn', quantity: null, unit: '' },
    ],
  });
  assert.equal(list.status, 201);
  weekly = list.body;
  // "mælk" found "Mælk" rather than making a second item.
  assert.equal(weekly.entries[0].itemId, lasagne.ingredients[1].itemId);

  const dup = await call('POST', '/lists', { name: 'ugentlig', entries: [] });
  assert.equal(dup.status, 409);
});

test('new items are put in aisles in the background', async () => {
  const items = await until(async () => {
    const { body } = await call('GET', '/items');
    return body.every((i) => i.category) ? body : null;
  });
  assert.equal(items.find((i) => i.name === 'Mælk').category, 'dairy');
  assert.equal(items.find((i) => i.name === 'Havregryn').category, 'pantry');
  assert.ok(aiCalls.some((c) => c.model === 'app-fast' && c.response_format?.type === 'json_object'));
});

test('the shopping list merges recipes and lists, and unmerges them', async () => {
  let { body: shop } = await call('POST', '/shop/recipes', { recipeId: lasagne.id, servings: 8 });
  const line = (name) => shop.lines.find((l) => l.name === name);
  assert.deepEqual(line('Hakket oksekød').amounts, [{ quantity: 1, unit: 'kg' }]);
  assert.deepEqual(line('Mælk').amounts, [{ quantity: 1, unit: 'l' }]);
  assert.deepEqual(shop.contributors, [{ kind: 'recipe', refId: lasagne.id, label: 'Lasagne (8 pers.)', lines: 4 }]);

  ({ body: shop } = await call('POST', '/shop/lists', { listId: weekly.id }));
  assert.deepEqual(line('Mælk').amounts, [{ quantity: 2, unit: 'l' }]);
  assert.equal(line('Mælk').sources.length, 2);

  // Lines come grouped by aisle, in shop order: meat before dairy before pantry.
  const order = shop.lines.map((l) => l.category);
  assert.ok(order.indexOf('meat') < order.indexOf('dairy') && order.indexOf('dairy') < order.indexOf('pantry'));

  // Tick the milk, then a recipe needing milk puts it back.
  ({ body: shop } = await call('PATCH', `/shop/lines/${line('Mælk').id}`, { checked: true }));
  assert.equal(line('Mælk').checked, true);

  ({ body: shop } = await call('DELETE', `/shop/recipes/${lasagne.id}`));
  assert.equal(line('Hakket oksekød'), undefined);
  assert.deepEqual(line('Mælk').amounts, [{ quantity: 1, unit: 'l' }]);

  ({ body: shop } = await call('POST', '/shop/recipes', { recipeId: lasagne.id }));
  assert.equal(line('Mælk').checked, false);
  assert.deepEqual(line('Mælk').amounts, [{ quantity: 1.5, unit: 'l' }]);

  // A hand-corrected amount replaces the sources.
  ({ body: shop } = await call('PATCH', `/shop/lines/${line('Mælk').id}`, { amount: { quantity: 2, unit: 'l' }, note: 'Øko' }));
  assert.deepEqual(line('Mælk').amounts, [{ quantity: 2, unit: 'l' }]);
  assert.equal(line('Mælk').note, 'Øko');

  ({ body: shop } = await call('PATCH', `/shop/lines/${line('Havregryn').id}`, { checked: true }));
  ({ body: shop } = await call('POST', '/shop/clear', { onlyChecked: true }));
  assert.equal(line('Havregryn'), undefined);
  assert.ok(line('Mælk'));
});

test('typed items: by hand, and read by the AI', async () => {
  const plain = await call('POST', '/shop/parse', { text: 'smør, 2,5 kg kartofler', useAi: false });
  assert.equal(plain.body.via, 'heuristic');
  assert.deepEqual(
    plain.body.entries.map((e) => [e.name, e.quantity, e.unit]),
    [['smør', null, ''], ['kartofler', 2.5, 'kg']],
  );

  const smart = await call('POST', '/shop/parse', { text: 'noget til tacos og mælk' });
  assert.equal(smart.body.via, 'ai');
  assert.equal(smart.body.entries[0].name, 'Tortillas');

  const { body: shop } = await call('POST', '/shop/items', { entries: smart.body.entries });
  const tortillas = shop.lines.find((l) => l.name === 'Tortillas');
  assert.equal(tortillas.category, 'bakery');
  assert.equal(tortillas.sources[0].label, 'til tacos');
});

test('an AI failure falls back to plain reading, and is reported', async () => {
  const before = envelopes.length;
  const res = await call('POST', '/shop/parse', { text: 'KABOOM, mælk' });
  assert.equal(res.status, 200);
  assert.equal(res.body.via, 'heuristic');
  assert.match(res.body.warning, /refused/);
  const event = await until(() => envelopes.slice(before).find((e) => e.tags.feature === 'ai'));
  assert.equal(event.level, 'warning');
  assert.equal(event.environment, 'test');
});

test('an AI answer that is not JSON gets one retry, then fails cleanly', async () => {
  const calls = aiCalls.length;
  const res = await call('POST', '/shop/parse', { text: 'GARBAGE' });
  assert.equal(res.body.via, 'heuristic');
  assert.equal(aiCalls.length - calls, 2);
  assert.match(aiCalls.at(-1).messages.at(-1).content, /not usable/);
});

test('importing a recipe page goes through its structured data and the AI', async () => {
  const res = await call('POST', '/recipes/import', { url: `${fakeUrl}/recipe.html` });
  assert.equal(res.status, 200);
  const draft = res.body;
  assert.equal(draft.via, 'ai');
  assert.equal(draft.servings, 4);
  assert.equal(draft.sourceUrl, `${fakeUrl}/recipe.html`);
  assert.equal(draft.instructions, '1. Brun kødet.\n2. Kog i 30 min.');
  assert.deepEqual(draft.ingredients[0], { name: 'Hakket oksekød', quantity: 400, unit: 'g', note: '', category: 'meat' });
  assert.equal(draft.ingredients[2].quantity, 2);
  // The model was handed the page's own recipe data, not its HTML.
  assert.match(aiCalls.at(-1).messages[1].content, /- 400 g hakket oksekød/);

  const bad = await call('POST', '/recipes/import', { url: 'ftp://example.test/x' });
  assert.equal(bad.status, 422);
});

test('items merge, and refuse deletion while in use', async () => {
  const { body: items } = await call('GET', '/items');
  const milk = items.find((i) => i.name === 'Mælk');
  const dupe = await call('POST', '/shop/items', { entries: [{ name: 'Minimælk', quantity: 1, unit: 'l' }] });
  const mini = (await call('GET', '/items')).body.find((i) => i.name === 'Minimælk');

  const refused = await call('DELETE', `/items/${milk.id}`);
  assert.equal(refused.status, 409);

  const merged = await call('POST', `/items/${mini.id}/merge`, { intoId: milk.id });
  assert.equal(merged.status, 200);
  const { body: shop } = await call('GET', '/shop');
  assert.equal(shop.lines.filter((l) => /mælk/i.test(l.name)).length, 1);
  // 2 l hand-corrected + 1 l from the AI's taco list + the 1 l of Minimælk.
  assert.deepEqual(shop.lines.find((l) => l.name === 'Mælk').amounts, [{ quantity: 4, unit: 'l' }]);
  assert.ok(dupe.status === 200);

  const rename = await call('PUT', `/items/${milk.id}`, { name: 'havregryn', category: 'dairy' });
  assert.equal(rename.status, 409);
});

test('server and client errors reach GlitchTip', async () => {
  const before = envelopes.length;
  const thrown = await call('GET', '/throw');
  assert.equal(thrown.status, 500);
  assert.match(thrown.body.eventId, /^[0-9a-f]{32}$/);

  const client = await call('POST', '/client-errors', {
    name: 'TypeError',
    message: 'x is undefined',
    stack: 'TypeError: x is undefined\n    at render (http://grocer.local/assets/index.js:1:200)',
    url: 'http://grocer.local/recipes',
  });
  assert.equal(client.status, 202);

  const events = await until(() => (envelopes.length >= before + 2 ? envelopes.slice(before) : null));
  const server = events.find((e) => e.exception.values[0].type === 'GrocerTestError');
  assert.equal(server.request.url, '/api/throw');
  const fromClient = events.find((e) => e.logger === 'client');
  assert.equal(fromClient.platform, 'javascript');
  assert.equal(fromClient.exception.values[0].stacktrace.frames[0].in_app, true);
});

test('validation errors are 400s and are not reported', async () => {
  const before = envelopes.length;
  const res = await call('POST', '/recipes', { name: '' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /name/);
  const missing = await call('GET', '/recipes/9999');
  assert.equal(missing.status, 404);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(envelopes.length, before);
});

test('dinners: planning one puts its recipe on the list, scaled, and follows changes', async () => {
  const { body: recipe } = await call('POST', '/recipes', {
    name: 'Kylling i karry',
    servings: 4,
    ingredients: [
      { name: 'Kyllingebryst', quantity: 600, unit: 'g', note: '' },
      { name: 'Ris', quantity: 4, unit: 'dl', note: '' },
      { name: 'Løg', quantity: 1, unit: '', note: '' },
    ],
  });

  const created = await call('POST', '/dinners', { recipeId: recipe.id, servings: 6 });
  assert.equal(created.status, 201);
  const dinner = created.body;
  assert.equal(dinner.title, 'Kylling i karry');
  assert.equal(dinner.recipeName, 'Kylling i karry');
  assert.equal(dinner.onShop, true);

  let { body: shop } = await call('GET', '/shop');
  const line = (name) => shop.lines.find((l) => l.name === name);
  assert.deepEqual(line('Kyllingebryst').amounts, [{ quantity: 900, unit: 'g' }]);
  assert.deepEqual(line('Løg').amounts, [{ quantity: 2, unit: '' }]); // 1.5 onions, bought whole
  assert.ok(shop.contributors.some((c) => c.kind === 'dinner' && c.refId === dinner.id && c.label === 'Kylling i karry (6 pers.)'));

  // Fewer servings: the list follows.
  await call('PATCH', `/dinners/${dinner.id}`, { servings: 2 });
  ({ body: shop } = await call('GET', '/shop'));
  assert.deepEqual(line('Kyllingebryst').amounts, [{ quantity: 300, unit: 'g' }]);

  // A dinner without a recipe adds nothing to the list.
  const takeaway = await call('POST', '/dinners', { title: 'Takeaway', note: 'Fredag' });
  assert.equal(takeaway.body.recipeId, null);
  assert.equal(takeaway.body.onShop, false);

  // Cooked dinners go to the end; the rest stay in planned order.
  await call('PATCH', `/dinners/${dinner.id}`, { cooked: true });
  const { body: list } = await call('GET', '/dinners');
  assert.deepEqual(list.map((d) => d.title), ['Takeaway', 'Kylling i karry']);
  assert.ok(list[1].cookedAt);

  // Clearing cooked dinners keeps what they left on the list.
  const cleared = await call('POST', '/dinners/clear-cooked', {});
  assert.equal(cleared.body.removed, 1);
  ({ body: shop } = await call('GET', '/shop'));
  assert.ok(line('Kyllingebryst'));
  assert.ok(!shop.contributors.some((c) => c.kind === 'dinner' && c.refId === dinner.id));
});

test('dinners: removing one takes its ingredients off, and a deleted recipe leaves the dinner', async () => {
  const { body: recipe } = await call('POST', '/recipes', {
    name: 'Fiskefrikadeller',
    servings: 4,
    ingredients: [{ name: 'Fiskefars', quantity: 500, unit: 'g', note: '' }],
  });
  const { body: a } = await call('POST', '/dinners', { recipeId: recipe.id });
  const { body: b } = await call('POST', '/dinners', { recipeId: recipe.id, addToShop: false });
  assert.equal(b.onShop, false);

  let { body: shop } = await call('GET', '/shop');
  assert.ok(shop.lines.find((l) => l.name === 'Fiskefars'));

  assert.equal((await call('DELETE', `/dinners/${a.id}`)).status, 204);
  ({ body: shop } = await call('GET', '/shop'));
  assert.equal(shop.lines.find((l) => l.name === 'Fiskefars'), undefined);

  await call('DELETE', `/recipes/${recipe.id}`);
  const { body: kept } = await call('GET', `/dinners/${b.id}`);
  assert.equal(kept.recipeId, null);
  assert.equal(kept.title, 'Fiskefrikadeller');

  assert.equal((await call('POST', '/dinners', {})).status, 400);
  assert.equal((await call('GET', '/dinners/9999')).status, 404);
});

test('dinners: one planned without its ingredients can put them on later, once', async () => {
  const { body: recipe } = await call('POST', '/recipes', {
    name: 'Boller i karry',
    servings: 4,
    ingredients: [{ name: 'Svinefars', quantity: 500, unit: 'g', note: '' }],
  });
  const { body: dinner } = await call('POST', '/dinners', { recipeId: recipe.id, addToShop: false });
  assert.equal(dinner.onShop, false);

  await call('POST', '/shop/dinners', { dinnerId: dinner.id });
  const { body: shop } = await call('POST', '/shop/dinners', { dinnerId: dinner.id });
  assert.deepEqual(shop.lines.find((l) => l.name === 'Svinefars').amounts, [{ quantity: 500, unit: 'g' }]);
  assert.equal((await call('GET', `/dinners/${dinner.id}`)).body.onShop, true);
});
