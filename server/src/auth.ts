import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Bump this number, build and deploy to sign every device out: logins made
 * under an older number stop working, and everyone logs in again. (Changing
 * GROCER_PASSWORD does the same.)
 */
export const LOGIN_GENERATION = 1;

export const COOKIE_NAME = 'grocer_session';

/** "Indefinitely", as far as a browser is concerned: ten years. */
export const COOKIE_MAX_AGE_S = 10 * 365 * 24 * 60 * 60;

const digest = (value: string) => crypto.createHash('sha256').update(value).digest();

function sameBytes(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * The signing secret, made once and kept in the data volume, so logins
 * survive restarts and redeploys without another setting to manage.
 */
export function loadSecret(path: string): string {
  if (existsSync(path)) {
    const secret = readFileSync(path, 'utf8').trim();
    if (secret.length >= 32) return secret;
  }
  mkdirSync(dirname(path), { recursive: true });
  const secret = crypto.randomBytes(32).toString('hex');
  writeFileSync(path, `${secret}\n`, { mode: 0o600 });
  return secret;
}

/**
 * One shared password for the household, no users. A login is a signed
 * `<generation>.<random>` with no expiry; nothing is stored server-side. The
 * signing key mixes in the password and LOGIN_GENERATION, so changing either
 * signs out everything signed before.
 */
export function createAuth(opts: { password: string; secret: string; generation?: number }) {
  const enabled = opts.password.length > 0;
  const generation = String(opts.generation ?? LOGIN_GENERATION);
  const expected = digest(opts.password);
  const key = crypto.createHmac('sha256', opts.secret).update(`${generation}\0${opts.password}`).digest();
  const sign = (payload: string) => crypto.createHmac('sha256', key).update(payload).digest('base64url');

  return {
    enabled,

    /** Constant time, including guesses of another length. */
    checkPassword(candidate: unknown): boolean {
      if (!enabled || typeof candidate !== 'string' || !candidate) return false;
      return crypto.timingSafeEqual(digest(candidate), expected);
    },

    issue(): string {
      const payload = `${generation}.${crypto.randomBytes(12).toString('base64url')}`;
      return `${payload}.${sign(payload)}`;
    },

    verify(token: string | undefined): boolean {
      if (!enabled) return true;
      if (typeof token !== 'string') return false;
      const parts = token.split('.');
      if (parts.length !== 3 || parts[0] !== generation) return false;
      return sameBytes(parts[2]!, sign(`${parts[0]}.${parts[1]}`));
    },
  };
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * Counts wrong passwords per visitor and refuses more attempts once a visitor
 * reaches the limit, until the oldest failure ages out. A right one clears it.
 */
export function createLoginLimiter(opts: { maxFailures: number; windowMs: number; now?: () => number }) {
  const now = opts.now ?? Date.now;
  const failures = new Map<string, number[]>();

  const recent = (key: string) => {
    const cutoff = now() - opts.windowMs;
    const list = (failures.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) failures.set(key, list);
    else failures.delete(key);
    return list;
  };

  return {
    /** Seconds until this visitor may try again; 0 when allowed now. */
    retryAfter(key: string): number {
      const list = recent(key);
      if (list.length < opts.maxFailures) return 0;
      return Math.max(1, Math.ceil((list[0]! + opts.windowMs - now()) / 1000));
    },
    fail(key: string) {
      const list = recent(key);
      list.push(now());
      failures.set(key, list);
      // Bound memory if someone sprays from many addresses.
      if (failures.size > 10_000) failures.delete(failures.keys().next().value!);
    },
    succeed(key: string) {
      failures.delete(key);
    },
  };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      /* keep it raw */
    }
    if (name && !(name in out)) out[name] = value;
  }
  return out;
}
