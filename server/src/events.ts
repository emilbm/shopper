import type { ServerResponse } from 'node:http';

/**
 * Live updates for everyone with the app open, as Server-Sent Events: a plain
 * HTTP response that stays open and gets a line written to it whenever
 * something changes. Browsers reconnect by themselves, and it goes through
 * any proxy that passes a normal request — no socket server, nothing to run.
 *
 * Events say only that something changed and who changed it. Each browser
 * then refetches what it is showing, through the same API as always, so
 * there is one way data reaches the screen.
 */
export function createEvents(heartbeatMs = 25_000) {
  const clients = new Set<ServerResponse>();

  // Proxies close connections that stay silent; a comment line keeps it open.
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, heartbeatMs);
  heartbeat.unref();

  return {
    /** Take over a response and keep it open for events. */
    subscribe(res: ServerResponse) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // nginx and some others buffer responses unless told not to.
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      clients.add(res);
      res.on('close', () => clients.delete(res));
    },

    /** Tell every open browser that something changed, and which browser did it. */
    changed(by: string | undefined) {
      const line = `data: ${JSON.stringify({ type: 'changed', by: by ?? null })}\n\n`;
      for (const res of clients) res.write(line);
    },

    get count() {
      return clients.size;
    },

    /** End every stream, so the server can shut down without waiting on them. */
    close() {
      clearInterval(heartbeat);
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}

export type Events = ReturnType<typeof createEvents>;
