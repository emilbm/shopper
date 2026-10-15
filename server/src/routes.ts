import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CATEGORY_KEYS } from '../../shared/categories.js';
import type { Meta } from '../../shared/types.js';
import { parseIngredientLine, splitItems } from '../../shared/units.js';
import { AiError, type Ai } from './ai.js';
import type { Config } from './config.js';
import { fetchImage, fetchPage, findImage, IMAGE_TYPES, ImportError, importRecipe } from './importer.js';
import { applyToBasket, planShop, type Nemlig } from './nemlig.js';
import type { ErrorReporter } from './sentry.js';
import type { Store } from './store.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

/** A local calendar date. */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A day is written YYYY-MM-DD');

const quantity = z.number().positive().max(100_000).nullable().default(null);
const unit = z.string().trim().max(20).default('');
const category = z.enum(CATEGORY_KEYS).nullable().optional();

const entryBody = z.object({
  name: z.string().trim().min(1).max(80),
  quantity,
  unit,
  note: z.string().trim().max(200).default(''),
  category,
});

const recipeBody = z.object({
  name: z.string().trim().min(1).max(120),
  servings: z.number().int().min(1).max(100).default(4),
  instructions: z.string().max(20_000).default(''),
  sourceUrl: z.string().max(2000).default(''),
  notes: z.string().max(2000).default(''),
  tags: z.array(z.string().max(30)).max(12).default([]),
  ingredients: z.array(entryBody).max(100).default([]),
  /** A picture to fetch and keep with it, as an import found on the page. */
  imageUrl: z.string().trim().url().max(2000).optional(),
});

const listBody = z.object({
  name: z.string().trim().min(1).max(80),
  notes: z.string().max(1000).default(''),
  entries: z
    .array(z.object({ name: z.string().trim().min(1).max(80), quantity, unit, category }))
    .max(200)
    .default([]),
});

const itemBody = z.object({
  name: z.string().trim().min(1).max(80),
  category: z.enum(CATEGORY_KEYS).nullable().default(null),
  notes: z.string().max(500).default(''),
});

const lineBody = z.object({
  checked: z.boolean().optional(),
  note: z.string().max(200).optional(),
  amount: z.object({ quantity, unit }).optional(),
});

const clientErrorBody = z.object({
  message: z.string().max(2000),
  name: z.string().max(200).optional(),
  stack: z.string().max(20_000).optional(),
  url: z.string().max(2000).optional(),
  userAgent: z.string().max(500).optional(),
});

export interface RouteDeps {
  store: Store;
  ai: Ai;
  nemlig: Nemlig;
  reporter: ErrorReporter;
  config: Config;
  categoriseNow: () => Promise<number>;
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { store, ai, nemlig, reporter, config } = deps;
  const reportAi = (err: unknown) =>
    reporter.capture(err, { level: 'warning', tags: { feature: 'ai' } });

  // Pictures are uploaded as they are, not wrapped in JSON or a form.
  app.addContentTypeParser(IMAGE_TYPES, { parseAs: 'buffer', bodyLimit: 10 * 1024 * 1024 }, (_req, body, done) =>
    done(null, body),
  );

  /** Fetch and keep a recipe's picture. A failure costs only the picture, never the recipe. */
  const keepImageFrom = async (recipeId: number, imageUrl: string) => {
    try {
      store.recipes.setImage(recipeId, { ...(await fetchImage(imageUrl)), sourceUrl: imageUrl });
    } catch (err) {
      app.log.warn({ err, recipeId, imageUrl }, 'could not keep the recipe picture');
    }
  };

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/meta', async (): Promise<Meta> => ({
    version: config.version,
    builtAt: config.builtAt,
    ai: { enabled: ai.enabled, model: ai.model },
    nemlig: { enabled: nemlig.enabled },
    errorReporting: reporter.enabled,
  }));

  /* ------------------------------------------------------------ items */

  app.get('/api/items', async () => store.items.list());

  app.put('/api/items/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    return store.items.update(id, itemBody.parse(req.body));
  });

  app.delete('/api/items/:id', async (req, reply) => {
    store.items.remove(idParam.parse(req.params).id);
    return reply.status(204).send();
  });

  app.post('/api/items/:id/merge', async (req) => {
    const { id } = idParam.parse(req.params);
    const { intoId } = z.object({ intoId: z.number().int().positive() }).parse(req.body);
    return store.items.merge(id, intoId);
  });

  app.post('/api/items/categorise', async () => ({ categorised: await deps.categoriseNow() }));

  app.get('/api/items/:id/uses', async (req) => store.items.uses(idParam.parse(req.params).id));

  /* ---------------------------------------------------------- recipes */

  app.get('/api/recipes', async () => store.recipes.list());

  app.get('/api/recipes/:id', async (req) => store.recipes.get(idParam.parse(req.params).id));

  app.post('/api/recipes', async (req, reply) => {
    const { imageUrl, ...input } = recipeBody.parse(req.body);
    const recipe = store.recipes.create(input);
    if (imageUrl) await keepImageFrom(recipe.id, imageUrl);
    return reply.status(201).send(store.recipes.get(recipe.id));
  });

  app.put('/api/recipes/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const { imageUrl, ...input } = recipeBody.parse(req.body);
    store.recipes.update(id, input);
    if (imageUrl) await keepImageFrom(id, imageUrl);
    return store.recipes.get(id);
  });

  app.get('/api/recipes/:id/image', async (req, reply) => {
    const image = store.recipes.image(idParam.parse(req.params).id);
    // The address changes with the picture (?v=), so it can be kept forever.
    return reply
      .type(image.mime)
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(Buffer.from(image.data));
  });

  /** Upload a picture: the body is the image itself. */
  app.put('/api/recipes/:id/image', async (req) => {
    const { id } = idParam.parse(req.params);
    const mime = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (!IMAGE_TYPES.includes(mime) || !Buffer.isBuffer(req.body) || !req.body.byteLength) {
      throw new ImportError('Send a JPEG, PNG, WebP, GIF or AVIF picture', 415);
    }
    return store.recipes.setImage(id, { mime, data: req.body });
  });

  /**
   * Fetch a picture from an address — a picture's, or a recipe page's, whose
   * picture of the dish is used. Without one, the recipe's own source page.
   */
  app.post('/api/recipes/:id/image/fetch', async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ url: z.string().trim().url().max(2000).optional() }).parse(req.body ?? {});
    const url = body.url || store.recipes.get(id).sourceUrl;
    if (!url) throw new ImportError('This recipe has no source page to take a picture from');
    let image: { mime: string; data: Buffer };
    let imageUrl = url;
    try {
      image = await fetchImage(url);
    } catch (err) {
      // Not a picture itself: read it as a page and find the dish on it.
      if (!(err instanceof ImportError) || err.statusCode !== 422) throw err;
      const found = findImage(await fetchPage(url), url);
      if (!found) throw new ImportError('That page has no picture of the dish');
      imageUrl = found;
      image = await fetchImage(found);
    }
    return store.recipes.setImage(id, { ...image, sourceUrl: imageUrl });
  });

  app.delete('/api/recipes/:id/image', async (req) => store.recipes.removeImage(idParam.parse(req.params).id));

  app.delete('/api/recipes/:id', async (req, reply) => {
    store.recipes.remove(idParam.parse(req.params).id);
    return reply.status(204).send();
  });

  /** A draft only — the editor shows it for review, and saving is a normal POST. */
  app.post('/api/recipes/import', async (req) => {
    const input = z
      .object({ url: z.string().trim().max(2000).optional(), text: z.string().max(50_000).optional() })
      .refine((v) => v.url || v.text, 'Give a url or some text')
      .parse(req.body);
    return importRecipe(input, {
      ai,
      catalogue: () => store.items.names(),
      onAiFailure: reportAi,
    });
  });

  /* ----------------------------------------------------- staple lists */

  app.get('/api/lists', async () => store.lists.all());

  app.post('/api/lists', async (req, reply) => {
    return reply.status(201).send(store.lists.save(null, listBody.parse(req.body)));
  });

  app.put('/api/lists/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    return store.lists.save(id, listBody.parse(req.body));
  });

  app.delete('/api/lists/:id', async (req, reply) => {
    store.lists.remove(idParam.parse(req.params).id);
    return reply.status(204).send();
  });

  /* ----------------------------------------------------------- dinners */

  app.get('/api/dinners', async () => store.dinners.list());

  app.get('/api/dinners/:id', async (req) => store.dinners.get(idParam.parse(req.params).id));

  app.post('/api/dinners', async (req, reply) => {
    const body = z
      .object({
        title: z.string().trim().max(120).optional(),
        recipeId: z.number().int().positive().nullable().optional(),
        servings: z.number().int().min(1).max(100).optional(),
        note: z.string().max(500).optional(),
        day: day.nullable().optional(),
        addToShop: z.boolean().default(true),
      })
      .refine((v) => v.title || v.recipeId, 'Give a title or a recipe')
      .parse(req.body);
    return reply.status(201).send(store.dinners.add(body));
  });

  app.patch('/api/dinners/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const patch = z
      .object({
        title: z.string().trim().min(1).max(120).optional(),
        recipeId: z.number().int().positive().nullable().optional(),
        servings: z.number().int().min(1).max(100).optional(),
        note: z.string().max(500).optional(),
        day: day.nullable().optional(),
        cooked: z.boolean().optional(),
      })
      .parse(req.body);
    return store.dinners.update(id, patch);
  });

  app.delete('/api/dinners/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { keepOnShop } = z
      .object({ keepOnShop: z.enum(['true', 'false']).optional() })
      .parse(req.query);
    store.dinners.remove(id, keepOnShop === 'true');
    return reply.status(204).send();
  });

  app.post('/api/dinners/clear-cooked', async () => ({ removed: store.dinners.clearCooked() }));

  /* ------------------------------------------------------ week planner */

  /** The days from `from`, which the browser gives so "today" is the household's today. */
  app.get('/api/plan', async (req) => {
    const { from, days } = z
      .object({ from: day, days: z.coerce.number().int().min(1).max(31).default(7) })
      .parse(req.query);
    return store.plan.get(from, days);
  });

  app.put('/api/plan/:day/note', async (req, reply) => {
    const params = z.object({ day }).parse(req.params);
    const { note } = z.object({ note: z.string().max(1000) }).parse(req.body);
    store.plan.setNote(params.day, note);
    return reply.status(204).send();
  });

  /* ------------------------------------------------------ shopping list */

  app.get('/api/shop', async () => store.shop.get());

  app.post('/api/shop/recipes', async (req) => {
    const { recipeId, servings } = z
      .object({ recipeId: z.number().int().positive(), servings: z.number().int().min(1).max(100).optional() })
      .parse(req.body);
    return store.shop.addRecipe(recipeId, servings);
  });

  app.delete('/api/shop/recipes/:id', async (req) =>
    store.shop.removeContributor('recipe', idParam.parse(req.params).id),
  );

  /** Put a planned dinner's ingredients on the list — one added from the phone, say. */
  app.post('/api/shop/dinners', async (req) => {
    const { dinnerId } = z.object({ dinnerId: z.number().int().positive() }).parse(req.body);
    const dinner = store.dinners.get(dinnerId);
    // Twice would double every amount; once on is enough.
    if (dinner.onShop) return store.shop.get();
    return store.shop.addDinner(dinnerId);
  });

  /** Take a dinner's ingredients off the list; the dinner itself stays planned. */
  app.delete('/api/shop/dinners/:id', async (req) =>
    store.shop.removeContributor('dinner', idParam.parse(req.params).id),
  );

  app.post('/api/shop/lists', async (req) => {
    const { listId } = z.object({ listId: z.number().int().positive() }).parse(req.body);
    return store.shop.addList(listId);
  });

  app.delete('/api/shop/lists/:id', async (req) =>
    store.shop.removeContributor('list', idParam.parse(req.params).id),
  );

  app.post('/api/shop/items', async (req) => {
    const { entries } = z.object({ entries: z.array(entryBody).min(1).max(100) }).parse(req.body);
    return store.shop.addItems(entries);
  });

  /**
   * Read a typed list into entries for the person to confirm. The AI handles
   * "noget til tacos"; without it, each comma-separated chunk is parsed by hand.
   */
  app.post('/api/shop/parse', async (req) => {
    const { text, useAi } = z
      .object({ text: z.string().trim().min(1).max(5000), useAi: z.boolean().default(true) })
      .parse(req.body);
    const byHand = () =>
      splitItems(text).map((chunk) => ({ ...parseIngredientLine(chunk), category: null as string | null }));
    if (!ai.enabled || !useAi) return { entries: byHand(), via: 'heuristic' };
    try {
      return { entries: await ai.parseItems(text, store.items.names()), via: 'ai' };
    } catch (err) {
      if (!(err instanceof AiError)) throw err;
      reportAi(err);
      return { entries: byHand(), via: 'heuristic', warning: err.message };
    }
  });

  app.patch('/api/shop/lines/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const body = lineBody.parse(req.body);
    if (body.checked !== undefined) store.shop.setChecked(id, body.checked);
    if (body.note !== undefined || body.amount) {
      return store.shop.updateLine(id, { note: body.note, amount: body.amount });
    }
    return store.shop.get();
  });

  app.delete('/api/shop/lines/:id', async (req) => store.shop.removeLine(idParam.parse(req.params).id));

  app.post('/api/shop/clear', async (req) => {
    const { onlyChecked } = z.object({ onlyChecked: z.boolean().default(true) }).parse(req.body ?? {});
    return store.shop.clear(onlyChecked);
  });

  /* ------------------------------------------------------------ Nemlig */

  /** Whether the harness's gateway answers and offers the Nemlig tools. */
  app.get('/api/nemlig/status', async () => {
    await nemlig.withSession(async () => undefined);
    return { ok: true, server: nemlig.server };
  });

  /** Proposals for review: nothing is put in the basket here. */
  app.post('/api/nemlig/plan', async () =>
    planShop({ store, ai, nemlig, onAiFailure: (err) => reportAi(err) }),
  );

  app.post('/api/nemlig/apply', async (req) => {
    const { entries } = z
      .object({
        entries: z
          .array(
            z.object({
              lineId: z.number().int().positive(),
              itemId: z.number().int().positive(),
              productId: z.string().min(1).max(40),
              productName: z.string().max(200),
              description: z.string().max(200).default(''),
              quantity: z.number().int().min(1).max(50),
            }),
          )
          .min(1)
          .max(200),
      })
      .parse(req.body);
    return applyToBasket(entries, { store, nemlig });
  });

  /** Forget what an item was bought as, so the next shop searches for it afresh. */
  app.delete('/api/items/:id/nemlig', async (req, reply) => {
    store.items.setNemlig(idParam.parse(req.params).id, null);
    return reply.status(204).send();
  });

  /* ------------------------------------------------------------ errors */

  /** The browser's uncaught errors, forwarded so they land in GlitchTip too. */
  app.post('/api/client-errors', async (req, reply) => {
    const body = clientErrorBody.parse(req.body);
    const err = new Error(body.message);
    err.name = body.name || 'ClientError';
    if (body.stack) err.stack = body.stack;
    const eventId = reporter.capture(err, {
      logger: 'client',
      platform: 'javascript',
      tags: { side: 'client' },
      request: { url: body.url, headers: body.userAgent ? { 'User-Agent': body.userAgent } : {} },
    });
    return reply.status(202).send({ eventId });
  });

  /** A deliberate failure, to prove error reporting is wired up after a deploy. */
  app.get('/api/throw', async () => {
    const err = new Error('Test exception from /api/throw — error reporting is wired up');
    err.name = 'GrocerTestError';
    throw err;
  });
}
