import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError } from 'fastify';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { AiError, createAi } from './ai.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { createNemlig, NemligError } from './nemlig.js';
import { registerRoutes } from './routes.js';
import { createErrorReporter } from './sentry.js';
import { createEvents } from './events.js';
import { createStore } from './store.js';

const here = dirname(fileURLToPath(import.meta.url));

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const app = Fastify({
  logger: { level: config.logLevel },
  // Behind a Cloudflare tunnel or reverse proxy, trust the forwarded headers so
  // request logs show the real client rather than the proxy.
  trustProxy: true,
});

const reporter = createErrorReporter(
  {
    dsn: config.sentry.dsn,
    environment: config.sentry.environment,
    release: config.sentry.release || undefined,
    serverName: config.sentry.serverName || undefined,
    maxEventsPerMinute: config.sentry.maxEventsPerMinute,
  },
  app.log,
);

const ai = createAi(config.ai);
const nemlig = createNemlig(config.nemlig, config.ai.apiKey);
const db = openDatabase(config.dbPath);
const events = createEvents();

/**
 * New items are put in aisles in the background, a few seconds after they
 * appear, so typing a recipe never waits on the model. Several items made in
 * one save are sorted in one call.
 */
let categoriseTimer: NodeJS.Timeout | null = null;
let categorising: Promise<number> | null = null;

async function categoriseNow(): Promise<number> {
  if (!ai.enabled) return 0;
  if (categorising) return categorising;
  categorising = (async () => {
    let total = 0;
    try {
      for (let round = 0; round < 10; round += 1) {
        const batch = store.items.uncategorised(60);
        if (!batch.length) break;
        const changed = store.items.fillCategories(await ai.categorise(batch));
        total += changed;
        if (!changed) break; // The model is not placing these; do not spin.
      }
    } catch (err) {
      app.log.warn({ err }, 'could not categorise items');
      if (err instanceof AiError) reporter.capture(err, { level: 'warning', tags: { feature: 'categorise' } });
      else throw err;
    } finally {
      categorising = null;
    }
    if (total) {
      app.log.info({ total }, 'categorised items');
      events.changed(undefined);
    }
    return total;
  })();
  return categorising;
}

const store = createStore(db, {
  onItemsCreated: () => {
    if (!ai.enabled) return;
    if (categoriseTimer) clearTimeout(categoriseTimer);
    categoriseTimer = setTimeout(() => {
      categoriseTimer = null;
      categoriseNow().catch((err) => reporter.capture(err));
    }, 3000);
    categoriseTimer.unref();
  },
});

app.setErrorHandler((error: FastifyError | Error, req, reply) => {
  if (error instanceof ZodError) {
    const message = error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    return reply.status(400).send({ error: message });
  }
  const status =
    'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode >= 400
      ? error.statusCode
      : 500;
  if (status >= 500) {
    req.log.error({ err: error }, 'request failed');
    const eventId = reporter.capture(error, {
      // The harness or Nemlig being away is worth knowing about, not an app bug.
      level: error instanceof AiError || error instanceof NemligError ? 'warning' : 'error',
      request: { method: req.method, url: req.url },
      tags: { route: req.routeOptions.url ?? 'unknown' },
    });
    return reply.status(status).send({
      error: status === 500 ? 'Something went wrong on the server' : error.message,
      eventId,
    });
  }
  return reply.status(status).send({ error: error.message });
});

await registerRoutes(app, { store, ai, nemlig, reporter, config, events, categoriseNow });

// Open event streams would otherwise hold the server open on shutdown.
app.addHook('preClose', async () => events.close());

const clientDir = config.clientDir || resolve(here, '../../../../client/dist');
if (existsSync(join(clientDir, 'index.html'))) {
  // `index` must name the shell: without it a request for "/" resolves to a
  // directory, which the static plugin refuses outright.
  await app.register(fastifyStatic, { root: clientDir, index: ['index.html'] });

  // Single-page app: anything that isn't an API route or a real file is a client route.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Not found' });
    return reply.sendFile('index.html');
  });
} else {
  app.log.warn(
    { clientDir },
    'No client build found — serving the API only. Run `npm run build` or use the Vite dev server.',
  );
}

app.log.info(
  {
    ai: ai.enabled ? { baseUrl: config.ai.baseUrl, model: config.ai.model } : 'disabled',
    nemlig: nemlig.enabled ? { mcpUrl: config.nemlig.mcpUrl, server: config.nemlig.server } : 'disabled',
    db: config.dbPath,
  },
  'grocer starting',
);

process.on('unhandledRejection', (reason) => {
  app.log.error({ reason }, 'unhandled rejection');
  reporter.capture(reason, { level: 'error', tags: { kind: 'unhandledRejection' } });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app
      .close()
      .then(() => reporter.flush())
      .then(() => {
        db.close();
        process.exit(0);
      });
  });
}

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  reporter.capture(err, { level: 'fatal' });
  await reporter.flush();
  process.exit(1);
}
