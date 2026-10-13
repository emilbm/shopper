import { resolve } from 'node:path';
import { parseDsn } from './sentry.js';

function str(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const v = env[name];
  return v === undefined || v === '' ? fallback : v;
}

function int(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  problems: string[],
  { min = 0, max = Number.MAX_SAFE_INTEGER } = {},
): number {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name} must be an integer between ${min} and ${max}, got "${v}"`);
    return fallback;
  }
  return n;
}

export type Config = ReturnType<typeof loadConfig>;

/**
 * Everything the server reads from its environment, checked once at startup.
 * A bad value stops the container with a list of what is wrong, rather than
 * surfacing as a confusing failure on first use.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const problems: string[] = [];
  const version = str(env, 'GROCER_VERSION', 'dev');
  const dataDir = str(env, 'GROCER_DATA_DIR', resolve(process.cwd(), 'data'));

  const cfg = {
    port: int(env, 'PORT', 8080, problems, { min: 1, max: 65535 }),
    // All interfaces: the container is reached from the LAN, or a tunnel.
    host: str(env, 'HOST', '0.0.0.0'),
    logLevel: str(env, 'LOG_LEVEL', 'info'),
    dataDir,
    dbPath: str(env, 'GROCER_DB_PATH', resolve(dataDir, 'grocer.db')),
    clientDir: str(env, 'GROCER_CLIENT_DIR', ''),
    version,
    builtAt: str(env, 'GROCER_BUILT_AT', '') || null,

    ai: {
      // The OpenAI-compatible endpoint of the homelab's LiteLLM harness, e.g.
      // http://ai-ops:4000/v1. Empty turns every AI feature off; the app falls
      // back to its own parsing.
      baseUrl: str(env, 'AI_BASE_URL', '').replace(/\/+$/, ''),
      apiKey: str(env, 'AI_API_KEY', ''),
      // A harness alias rather than a provider model, so the harness decides
      // what actually answers.
      model: str(env, 'AI_MODEL', 'app-fast'),
      timeoutMs: int(env, 'AI_TIMEOUT_SECONDS', 60, problems, { min: 5, max: 600 }) * 1000,
    },

    sentry: {
      // Empty disables reporting. GlitchTip ingests the Sentry envelope format.
      dsn: str(env, 'SENTRY_DSN', ''),
      environment: str(env, 'SENTRY_ENVIRONMENT', 'production'),
      release: str(env, 'SENTRY_RELEASE', version === 'dev' ? '' : `grocer@${version}`),
      serverName: str(env, 'SENTRY_SERVER_NAME', ''),
      maxEventsPerMinute: int(env, 'SENTRY_MAX_EVENTS_PER_MINUTE', 30, problems, { min: 1 }),
    },
  };

  if (cfg.ai.baseUrl) {
    try {
      const u = new URL(cfg.ai.baseUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
    } catch {
      problems.push(`AI_BASE_URL must be an http(s) URL, got "${cfg.ai.baseUrl}"`);
    }
    if (!cfg.ai.apiKey) problems.push('AI_API_KEY is required when AI_BASE_URL is set');
  }

  // Fail at startup on a malformed DSN, rather than silently dropping the
  // first real error weeks later.
  if (cfg.sentry.dsn) {
    try {
      parseDsn(cfg.sentry.dsn);
    } catch (err) {
      problems.push((err as Error).message);
    }
  }

  if (problems.length) {
    throw new Error(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
  return cfg;
}
