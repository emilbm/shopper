/**
 * Development entry point. The API always listens on 8080 here, whatever PORT
 * the surrounding tooling exports — that PORT belongs to the Vite server, which
 * proxies /api to this one.
 */
process.env.PORT = process.env.GROCER_DEV_PORT ?? '8080';

await import('./index.js');

export {};
