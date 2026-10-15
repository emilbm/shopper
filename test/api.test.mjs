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
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), 'grocer-test-'));

/* ------------------------------------------------------- the fakes */

const envelopes = [];
const aiCalls = [];

const RECIPE_PAGE = `<html><head><script type="application/ld+json">
{"@type":"Recipe","name":"Chili","recipeYield":"4","image":{"@type":"ImageObject","url":"/dish.png"},"recipeIngredient":["400 g hakket oksekød","1 dåse kidneybønner"],
 "recipeInstructions":"Brun kødet. Kog i 30 min."}
</script></head><body></body></html>`;

/** A page with no recipe data, only a link-preview picture. */
const PREVIEW_PAGE = '<html><head><meta property="og:image" content="/dish.png"></head><body>Hi</body></html>';
/** A 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function aiReply(system, user) {
  if (system.includes('grocery shop at Nemlig')) {
    // Deliberately wrong on quantity: the pack arithmetic should overrule it.
    const lines = JSON.parse(user);
    return {
      picks: lines.map((l) => ({
        line: l.line,
        productId: l.item === 'Hvedemel' ? 'm3' : l.item === 'Mælk' ? 'k1' : null,
        quantity: 7,
        reason: 'test pick',
      })),
    };
  }
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

/**
 * The harness's MCP gateway in front of nemlig-mcp: a real MCP server, with the
 * tool names prefixed the way a multi-server gateway does it.
 */
const nemligState = {
  basket: new Map([['k1', 3]]), // three of the milk are already in the basket
  sets: [],
  headers: [],
};

const PRODUCTS = {
  hvedemel: [
    { id: 'm1', name: 'Hvedemel tipo 00', price: 26.25, inStock: true, deliverable: true, labels: [], description: '1 kg / Caputo' },
    { id: 'm2', name: 'Hvedemel', price: 16.75, inStock: false, deliverable: true, labels: [], description: '2 kg / Valsemøllen' },
    { id: 'm3', name: 'Hvedemel', price: 9.95, inStock: true, deliverable: true, labels: [], description: '1 kg / Valsemøllen' },
  ],
  mælk: [{ id: 'k1', name: 'Letmælk', price: 12.5, inStock: true, deliverable: true, labels: [], description: '1 l / Arla' }],
};

function fakeNemligServer() {
  const server = new McpServer({ name: 'fake-nemlig', version: '1' });
  const json = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] });
  server.registerTool('nemlig-search_products', { inputSchema: { searchterm: z.string() } }, async ({ searchterm }) =>
    json({ sessionId: 's', searchterm, products: PRODUCTS[searchterm.toLowerCase()] ?? [] }),
  );
  server.registerTool('nemlig-get_favourite_products', { inputSchema: {} }, async () =>
    json({ sessionId: 's', products: [PRODUCTS.mælk[0]] }),
  );
  server.registerTool('nemlig-get_basket', { inputSchema: {} }, async () =>
    json({
      sessionId: 's',
      basket: {
        TotalPrice: [...nemligState.basket.values()].reduce((a, q) => a + q * 10, 0),
        Lines: [...nemligState.basket].map(([Id, Quantity]) => ({ Id, Quantity })),
      },
    }),
  );
  server.registerTool(
    'nemlig-set_basket_quantity',
    { inputSchema: { productId: z.string(), quantity: z.number() } },
    async ({ productId, quantity }) => {
      nemligState.sets.push({ productId, quantity });
      nemligState.basket.set(productId, quantity);
      return json({ sessionId: 's', line: { productId, quantity } });
    },
  );
  return server;
}

let fake;
let fakeUrl;

function startFake() {
  fake = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();

    if (req.url.startsWith('/mcp')) {
      nemligState.headers.push({ key: req.headers['x-litellm-api-key'], servers: req.headers['x-mcp-servers'] });
      const server = fakeNemligServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      return;
    }

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
    if (req.url === '/dish.png') {
      res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
      return;
    }
    if (req.url === '/preview.html') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(PREVIEW_PAGE);
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
  // The page's picture of the dish, made absolute.
  assert.equal(draft.imageUrl, `${fakeUrl}/dish.png`);
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

test('nemlig: a plan proposes products and packs, apply fills the basket, and choices are remembered', async () => {
  assert.equal((await call('GET', '/meta')).body.nemlig.enabled, true);
  assert.equal((await call('GET', '/nemlig/status')).status, 200);

  await call('POST', '/shop/clear', { onlyChecked: false });
  await call('POST', '/shop/items', {
    entries: [
      { name: 'Hvedemel', quantity: 1.5, unit: 'kg', note: '' },
      { name: 'Mælk', quantity: 2, unit: 'l', note: '' },
      { name: 'Safran', quantity: null, unit: '', note: '' },
    ],
  });

  const { body: plan } = await call('POST', '/nemlig/plan');
  const line = (name) => plan.lines.find((l) => l.name === name);

  // The model chose m3; the arithmetic overruled its count: 1,5 kg in 1 kg bags is 2.
  assert.equal(line('Hvedemel').product.id, 'm3');
  assert.equal(line('Hvedemel').source, 'ai');
  assert.equal(line('Hvedemel').quantity, 2);
  assert.equal(line('Hvedemel').product.description, '1 kg / Valsemøllen');
  assert.ok(line('Hvedemel').alternatives.some((a) => a.id === 'm1'));
  // Milk is a favourite, and 2 l in 1 l cartons is 2.
  assert.equal(line('Mælk').product.id, 'k1');
  assert.equal(line('Mælk').product.favourite, true);
  assert.equal(line('Mælk').quantity, 2);
  // Nothing found is reported, not guessed.
  assert.equal(line('Safran').product, null);

  // Every call went through the gateway with the app's key, scoped to nemlig.
  assert.ok(nemligState.headers.length > 0);
  assert.ok(nemligState.headers.every((h) => h.key === 'Bearer test-key' && h.servers === 'nemlig'));

  const entries = ['Hvedemel', 'Mælk'].map((n) => ({
    lineId: line(n).lineId,
    itemId: line(n).itemId,
    productId: line(n).product.id,
    productName: line(n).product.name,
    description: line(n).product.description ?? '',
    quantity: line(n).quantity,
  }));
  const { body: applied } = await call('POST', '/nemlig/apply', { entries });
  assert.ok(applied.results.every((r) => r.ok));
  // Flour went in; the basket's three milk were never lowered to two.
  assert.deepEqual(nemligState.sets, [{ productId: 'm3', quantity: 2 }]);
  assert.deepEqual(applied.results.find((r) => r.productId === 'k1'), {
    productId: 'k1', name: 'Letmælk', quantity: 3, previous: 3, ok: true,
  });
  assert.equal(applied.basketTotal, 50);

  // The lines are in the basket — not ticked off as in stock — and the items
  // remember what they were bought as.
  const { body: shop } = await call('GET', '/shop');
  assert.equal(shop.lines.find((l) => l.name === 'Hvedemel').inBasket, true);
  assert.equal(shop.lines.find((l) => l.name === 'Hvedemel').checked, false);
  const flour = (await call('GET', '/items')).body.find((i) => i.name === 'Hvedemel');
  assert.deepEqual(flour.nemlig, { productId: 'm3', name: 'Hvedemel', description: '1 kg / Valsemøllen' });

  // Next time, a remembered item needs no model: more flour comes back as m3 at once.
  const callsBefore = aiCalls.length;
  await call('POST', '/shop/items', { entries: [{ name: 'Hvedemel', quantity: 500, unit: 'g', note: '' }] });
  const { body: again } = await call('POST', '/nemlig/plan');
  const flourAgain = again.lines.find((l) => l.name === 'Hvedemel');
  assert.equal(flourAgain.source, 'remembered');
  assert.equal(flourAgain.product.id, 'm3');
  assert.equal(flourAgain.quantity, 2); // 1,5 kg + 0,5 kg = 2 kg
  assert.equal(aiCalls.filter((c) => c.messages[0].content.includes('grocery shop at Nemlig')).length,
    aiCalls.slice(0, callsBefore).filter((c) => c.messages[0].content.includes('grocery shop at Nemlig')).length);

  // And it can be forgotten.
  assert.equal((await call('DELETE', `/items/${flour.id}/nemlig`)).status, 204);
  assert.equal((await call('GET', '/items')).body.find((i) => i.name === 'Hvedemel').nemlig, null);
});

test('shopping lines: in stock and in the basket are separate, and both clear as done', async () => {
  await call('POST', '/shop/clear', { onlyChecked: false });
  let { body: shop } = await call('POST', '/shop/items', {
    entries: ['Smør', 'Mælk', 'Rugbrød'].map((name) => ({ name, quantity: null, unit: '', note: '' })),
  });
  const line = (n) => shop.lines.find((l) => l.name === n);
  ({ body: shop } = await call('PATCH', `/shop/lines/${line('Smør').id}`, { checked: true }));
  assert.equal(line('Smør').checked, true);
  assert.equal(line('Smør').inBasket, false);

  const milk = line('Mælk');
  await call('POST', '/nemlig/apply', {
    entries: [{ lineId: milk.id, itemId: milk.itemId, productId: 'k1', productName: 'Letmælk', quantity: 1 }],
  });
  ({ body: shop } = await call('GET', '/shop'));
  assert.equal(line('Mælk').inBasket, true);
  assert.equal(line('Mælk').checked, false);

  // Nothing in stock or in the basket is proposed for Nemlig.
  const { body: plan } = await call('POST', '/nemlig/plan');
  assert.deepEqual(plan.lines.map((l) => l.name), ['Rugbrød']);

  // Putting it back makes it something to get again.
  ({ body: shop } = await call('PATCH', `/shop/lines/${line('Mælk').id}`, { checked: false }));
  assert.equal(line('Mælk').inBasket, false);

  // So does asking for it again.
  await call('POST', '/nemlig/apply', {
    entries: [{ lineId: milk.id, itemId: milk.itemId, productId: 'k1', productName: 'Letmælk', quantity: 1 }],
  });
  ({ body: shop } = await call('POST', '/shop/items', { entries: [{ name: 'Mælk', quantity: 1, unit: 'l', note: '' }] }));
  assert.equal(line('Mælk').inBasket, false);

  // Clearing what is done takes in-stock and in-basket lines alike.
  await call('POST', '/nemlig/apply', {
    entries: [{ lineId: milk.id, itemId: milk.itemId, productId: 'k1', productName: 'Letmælk', quantity: 1 }],
  });
  ({ body: shop } = await call('POST', '/shop/clear', { onlyChecked: true }));
  assert.deepEqual(shop.lines.map((l) => l.name), ['Rugbrød']);
});

test('items say how many recipes and lists use them, and which', async () => {
  const { body: recipe } = await call('POST', '/recipes', {
    name: 'Kartoffelsuppe',
    ingredients: [
      { name: 'Porrer', quantity: 2, unit: 'stk', note: '' },
      { name: 'Porrer', quantity: 1, unit: 'stk', note: 'til pynt' },
    ],
  });
  await call('POST', '/lists', { name: 'Grønt', entries: [{ name: 'Porrer', quantity: 1, unit: 'stk' }] });
  const leek = (await call('GET', '/items')).body.find((i) => i.name === 'Porrer');
  // Twice in one recipe is still one recipe.
  assert.equal(leek.recipes, 1);
  assert.equal(leek.lists, 1);
  assert.equal(leek.usage, 3);
  const { body: uses } = await call('GET', `/items/${leek.id}/uses`);
  assert.deepEqual(uses.recipes, [{ id: recipe.id, name: 'Kartoffelsuppe' }]);
  assert.deepEqual(uses.lists.map((l) => l.name), ['Grønt']);
});

test('recipe pictures: kept from an import, uploaded, fetched from a page, removed', async () => {
  const origin = base.replace(/\/api$/, '');
  const { status, body: recipe } = await call('POST', '/recipes', {
    name: 'Chili med billede',
    sourceUrl: `${fakeUrl}/preview.html`,
    imageUrl: `${fakeUrl}/dish.png`,
    ingredients: [{ name: 'Chili', quantity: 1, unit: '', note: '' }],
  });
  assert.equal(status, 201);
  assert.ok(recipe.image.startsWith(`/api/recipes/${recipe.id}/image?v=`));
  let res = await fetch(origin + recipe.image);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  assert.ok((await call('GET', '/recipes')).body.find((r) => r.id === recipe.id).image);

  // An upload is the picture itself as the body.
  res = await fetch(`${base}/recipes/${recipe.id}/image`, {
    method: 'PUT',
    headers: { 'content-type': 'image/jpeg' },
    body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  });
  assert.equal(res.status, 200);
  const uploaded = await res.json();
  assert.notEqual(uploaded.image, recipe.image);
  res = await fetch(origin + uploaded.image);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');

  res = await fetch(`${base}/recipes/${recipe.id}/image`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'hi' });
  assert.equal(res.status, 415);

  const removed = await call('DELETE', `/recipes/${recipe.id}/image`);
  assert.equal(removed.body.image, null);
  assert.equal((await call('GET', `/recipes/${recipe.id}/image`)).status, 404);

  // From the recipe's own source page, which only has a link-preview picture.
  const fetched = await call('POST', `/recipes/${recipe.id}/image/fetch`, {});
  assert.equal(fetched.status, 200);
  assert.ok(fetched.body.image);

  // A picture that cannot be fetched costs only the picture.
  const noPic = await call('POST', '/recipes', { name: 'Uden billede', imageUrl: `${fakeUrl}/missing.png` });
  assert.equal(noPic.status, 201);
  assert.equal(noPic.body.image, null);
});

test('week plan: dinners on days, notes, and moving between days', async () => {
  const from = '2031-03-03';
  const titles = (plan) => plan.days.map((d) => d.dinners.map((x) => x.title));
  const { body: recipe } = await call('POST', '/recipes', {
    name: 'Pastaret',
    servings: 2,
    ingredients: [{ name: 'Pasta', quantity: 250, unit: 'g', note: '' }],
  });
  const { body: monday } = await call('POST', '/dinners', { recipeId: recipe.id, day: '2031-03-03' });
  assert.equal(monday.day, '2031-03-03');
  assert.equal(monday.onShop, true);
  await call('POST', '/dinners', { title: 'Takeaway', day: '2031-03-05', addToShop: false });
  const { body: loose } = await call('POST', '/dinners', { title: 'Rester', addToShop: false });
  assert.equal((await call('PUT', '/plan/2031-03-04/note', { note: 'Fodbold — spis tidligt' })).status, 204);

  let { body: plan } = await call('GET', `/plan?from=${from}&days=3`);
  assert.deepEqual(plan.days.map((d) => d.day), ['2031-03-03', '2031-03-04', '2031-03-05']);
  assert.deepEqual(titles(plan), [['Pastaret'], [], ['Takeaway']]);
  assert.equal(plan.days[1].note, 'Fodbold — spis tidligt');
  assert.ok(plan.unscheduled.some((d) => d.id === loose.id));

  // Move to another day; give one a day; an empty note is no note.
  await call('PATCH', `/dinners/${monday.id}`, { day: '2031-03-04' });
  await call('PATCH', `/dinners/${loose.id}`, { day: '2031-03-03' });
  await call('PUT', '/plan/2031-03-04/note', { note: '  ' });
  ({ body: plan } = await call('GET', `/plan?from=${from}&days=3`));
  assert.deepEqual(titles(plan), [['Rester'], ['Pastaret'], ['Takeaway']]);
  assert.equal(plan.days[1].note, '');
  assert.equal(plan.unscheduled.some((d) => d.id === loose.id), false);
  // Moving a dinner leaves the shopping list alone.
  assert.equal(plan.days[1].dinners[0].onShop, true);

  await call('PATCH', `/dinners/${loose.id}`, { day: null });
  ({ body: plan } = await call('GET', `/plan?from=${from}&days=3`));
  assert.ok(plan.unscheduled.some((d) => d.id === loose.id));

  assert.equal((await call('GET', '/plan?from=3/3/2031&days=3')).status, 400);
  assert.equal((await call('PATCH', `/dinners/${loose.id}`, { day: 'tomorrow' })).status, 400);
});
