/**
 * Uncaught browser errors go to the server, which forwards them to GlitchTip
 * with its own DSN. Going through the server keeps the DSN — and the
 * GlitchTip host's certificate — out of the phone's way entirely.
 */

const MAX_PER_PAGE = 10;
let sent = 0;
const seen = new Set<string>();

export function reportClientError(error: unknown): void {
  try {
    const err = error instanceof Error ? error : new Error(String(error));
    const key = `${err.name}:${err.message}`;
    // A render loop can throw the same thing a thousand times; once is plenty.
    if (seen.has(key) || sent >= MAX_PER_PAGE) return;
    seen.add(key);
    sent += 1;
    void fetch('/api/client-errors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: err.name,
        message: err.message.slice(0, 2000),
        stack: err.stack?.slice(0, 20_000),
        url: location.href,
        userAgent: navigator.userAgent,
      }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Reporting must never become the error.
  }
}

export function installErrorReporting(): void {
  window.addEventListener('error', (e) => reportClientError(e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => reportClientError(e.reason));
}
