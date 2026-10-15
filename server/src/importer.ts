import type { RecipeDraft } from '../../shared/types.js';
import { parseIngredientLine, parseQuantity } from '../../shared/units.js';
import { AiError, type Ai } from './ai.js';

/**
 * Turning a web page or a pasted block of text into a recipe draft.
 *
 * Most recipe sites embed schema.org Recipe data (JSON-LD) for search engines,
 * which is far better input than the page itself: no adverts, no life story,
 * every ingredient already on its own line. That is tried first; the AI then
 * splits those lines into item, amount and note. Without structured data the
 * AI reads the page's text, and without AI the hand parser does what it can.
 */

export class ImportError extends Error {
  constructor(
    message: string,
    readonly statusCode = 422,
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

const MAX_PAGE_BYTES = 3 * 1024 * 1024;

export async function fetchPage(url: string, timeoutMs = 15_000): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ImportError('That is not a web address');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ImportError('Only http and https addresses can be imported');
  }

  let res: Response;
  try {
    res = await fetch(parsed, {
      headers: {
        // Some recipe sites turn away anything that does not look like a browser.
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'da,en;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ImportError(`Could not fetch the page: ${(err as Error).message}`, 502);
  }
  if (!res.ok) throw new ImportError(`The page answered ${res.status}`, 502);

  // Read at most a few megabytes: a recipe page is never bigger, a mistake can be.
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PAGE_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/* --------------------------------------------------------------- images */

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];

/** A picture from the web, kept as it is. Recipe sites already serve them at a sensible size. */
export async function fetchImage(url: string, timeoutMs = 20_000): Promise<{ mime: string; data: Buffer }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ImportError('That is not a picture address');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ImportError('Only http and https pictures can be fetched');
  }
  let res: Response;
  try {
    res = await fetch(parsed, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ImportError(`Could not fetch the picture: ${(err as Error).message}`, 502);
  }
  if (!res.ok) throw new ImportError(`The picture answered ${res.status}`, 502);
  const mime = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!IMAGE_TYPES.includes(mime)) throw new ImportError(`That is not a picture (${mime || 'no type'})`);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.byteLength > MAX_IMAGE_BYTES) throw new ImportError('The picture is too big to keep');
  return { mime, data };
}

/** schema.org's image: a string, a list, or an ImageObject. */
function imageFrom(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = imageFrom(v);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>;
    return imageFrom(v.url ?? v.contentUrl ?? v['@id']);
  }
  return null;
}

/**
 * The page's picture of the dish: the recipe data's own, else the picture the
 * page offers for link previews (og:image), which on a recipe page is the dish.
 */
export function findImage(html: string, pageUrl: string): string | null {
  const candidates: Array<string | null> = [findStructuredRecipe(html)?.image ?? null];
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\b(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["']/i.test(tag)) continue;
    candidates.push(/\bcontent=["']([^"']+)["']/i.exec(tag)?.[1] ?? null);
  }
  for (const c of candidates) {
    if (!c) continue;
    try {
      const url = new URL(decodeEntities(c), pageUrl);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    } catch {
      /* try the next */
    }
  }
  return null;
}

/* ------------------------------------------------------ structured data */

export interface StructuredRecipe {
  name: string;
  servings: number | null;
  ingredients: string[];
  instructions: string[];
  tags: string[];
  image?: string | null;
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  aelig: 'æ', AElig: 'Æ', oslash: 'ø', Oslash: 'Ø', aring: 'å', Aring: 'Å',
  frac12: '½', frac14: '¼', frac34: '¾', deg: '°', ndash: '–', mdash: '—', hellip: '…',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code] ?? whole;
  });
}

const clean = (s: unknown): string =>
  typeof s === 'string' ? decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : '';

function isRecipe(node: unknown): node is Record<string, unknown> {
  if (typeof node !== 'object' || node === null) return false;
  const type = (node as { '@type'?: unknown })['@type'];
  return type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'));
}

function findRecipeNode(node: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 6 || typeof node !== 'object' || node === null) return null;
  if (isRecipe(node)) return node;
  const children = Array.isArray(node)
    ? node
    : [(node as Record<string, unknown>)['@graph'], (node as Record<string, unknown>).mainEntity];
  for (const child of children) {
    const found = findRecipeNode(child, depth + 1);
    if (found) return found;
  }
  return null;
}

/** HowToStep, HowToSection, plain strings — all flattened to lines of text. */
function instructionLines(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(/\n+|(?<=\.)\s+(?=[A-ZÆØÅ])/)
      .map(clean)
      .filter(Boolean);
  }
  if (Array.isArray(value)) return value.flatMap(instructionLines);
  if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>;
    if (v.itemListElement) return instructionLines(v.itemListElement);
    return instructionLines(v.text ?? v.name ?? '');
  }
  return [];
}

function yieldToServings(value: unknown): number | null {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first === 'number') return Math.round(first) || null;
  const m = typeof first === 'string' ? /(\d+(?:[.,]\d+)?)/.exec(first) : null;
  const n = m ? parseQuantity(m[1]!) : null;
  return n ? Math.max(1, Math.round(n)) : null;
}

/**
 * The inner HTML of the element whose opening tag starts at `start`, counting
 * nested elements of the same name so a <div> inside a <div> does not end it.
 */
function innerHtml(html: string, start: number, tag: string): string {
  const open = html.indexOf('>', start) + 1;
  const pattern = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  pattern.lastIndex = open;
  let depth = 1;
  for (let m = pattern.exec(html); m; m = pattern.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(open, m.index);
  }
  return html.slice(open, open + 2000);
}

/** Every element carrying `itemprop="name"`, as its `content` attribute or its text. */
function itemprops(html: string, prop: string): Array<{ text: string; inner: string }> {
  const out = [];
  const pattern = new RegExp(`<([a-z][a-z0-9]*)\\b[^>]*\\bitemprop=["']${prop}["'][^>]*>`, 'gi');
  for (const m of html.matchAll(pattern)) {
    const content = /\bcontent=["']([^"']*)["']/i.exec(m[0]);
    const inner = content ? '' : innerHtml(html, m.index, m[1]!);
    out.push({ text: clean(content ? content[1] : inner), inner });
  }
  return out;
}

/**
 * schema.org microdata — attributes on the page's own markup rather than a
 * JSON block. Older WordPress recipe sites use it, Valdemarsro among them.
 */
function findMicrodataRecipe(html: string): StructuredRecipe | null {
  const scope = /itemtype=["']https?:\/\/schema\.org\/Recipe["']/i.exec(html);
  if (!scope) return null;
  const body = html.slice(Math.max(0, html.lastIndexOf('<', scope.index)));
  const ingredients = itemprops(body, 'recipeIngredient').map((i) => i.text).filter(Boolean);
  if (!ingredients.length) return null;

  const name =
    itemprops(body, 'headline')[0]?.text ||
    itemprops(body, 'name')[0]?.text ||
    clean(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1]) ||
    'Imported recipe';
  const instructions = itemprops(body, 'recipeInstructions').flatMap((i) =>
    i.inner ? htmlToText(i.inner).split('\n').map((l) => l.replace(/^-\s*/, '').trim()).filter(Boolean) : [i.text],
  );
  const tags = [
    ...itemprops(body, 'recipeCategory').map((t) => t.text),
    ...itemprops(body, 'keywords').flatMap((t) => t.text.split(',')),
  ];
  const picture = /<[a-z]+\b[^>]*\bitemprop=["']image["'][^>]*>/i.exec(body)?.[0];
  return {
    name,
    image: picture ? (/\b(?:content|src|href)=["']([^"']+)["']/i.exec(picture)?.[1] ?? null) : null,
    servings: yieldToServings(itemprops(body, 'recipeYield')[0]?.text),
    ingredients,
    instructions,
    tags: tags
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t && t.length <= 24)
      .slice(0, 4),
  };
}

export function findStructuredRecipe(html: string): StructuredRecipe | null {
  return findJsonLdRecipe(html) ?? findMicrodataRecipe(html);
}

function findJsonLdRecipe(html: string): StructuredRecipe | null {
  const scripts = html.matchAll(/<script[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi);
  for (const [, body] of scripts) {
    let data: unknown;
    try {
      data = JSON.parse(body!.trim());
    } catch {
      continue; // One malformed block should not hide a good one after it.
    }
    const node = findRecipeNode(data);
    if (!node) continue;
    const ingredients = (Array.isArray(node.recipeIngredient) ? node.recipeIngredient : [])
      .map(clean)
      .filter(Boolean);
    if (!ingredients.length) continue;
    const keywords = typeof node.keywords === 'string' ? node.keywords.split(',') : [];
    const category = Array.isArray(node.recipeCategory) ? node.recipeCategory : [node.recipeCategory];
    return {
      name: clean(node.name) || 'Imported recipe',
      image: imageFrom(node.image),
      servings: yieldToServings(node.recipeYield),
      ingredients,
      instructions: instructionLines(node.recipeInstructions),
      tags: [...category, ...keywords]
        .map(clean)
        .map((t) => t.toLowerCase())
        .filter((t) => t && t.length <= 24)
        .slice(0, 4),
    };
  }
  return null;
}

/** The readable text of a page: enough for a model to find the recipe in. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 30_000);
}

/* --------------------------------------------------------------- drafts */

function heuristicFromStructured(s: StructuredRecipe, sourceUrl: string): RecipeDraft {
  return {
    name: s.name,
    servings: s.servings ?? 4,
    instructions: s.instructions.map((line, i) => `${i + 1}. ${line}`).join('\n'),
    sourceUrl,
    tags: s.tags,
    ingredients: s.ingredients.map((line) => {
      const { name, quantity, unit, note } = parseIngredientLine(line);
      return { name, quantity, unit, note };
    }),
    via: 'structured-data',
  };
}

/** Pasted text with no AI: the first line is the name, quantified lines are ingredients. */
export function heuristicFromText(text: string): RecipeDraft {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const [first = 'New recipe', ...rest] = lines;
  const ingredients = [];
  const method = [];
  for (const line of rest) {
    const looksLikeIngredient = /^([-*•▢☐]|\d|[½¼¾])/.test(line) && line.length < 80 && !/^\d+\.\s/.test(line);
    if (looksLikeIngredient) {
      const { name, quantity, unit, note } = parseIngredientLine(line);
      ingredients.push({ name, quantity, unit, note });
    } else {
      method.push(line);
    }
  }
  return {
    name: first.replace(/^#+\s*/, ''),
    servings: 4,
    instructions: method.join('\n'),
    sourceUrl: '',
    tags: [],
    ingredients,
    via: 'heuristic',
  };
}

function structuredAsText(s: StructuredRecipe): string {
  return [
    s.name,
    s.servings ? `Serves ${s.servings}` : '',
    '',
    'Ingredients:',
    ...s.ingredients.map((i) => `- ${i}`),
    '',
    'Method:',
    ...s.instructions,
  ].join('\n');
}

export interface ImportDeps {
  ai: Ai;
  catalogue: () => string[];
  /** Told about an AI failure the import recovered from, so it is not lost. */
  onAiFailure?: (err: unknown) => void;
}

export async function importRecipe(
  input: { url?: string; text?: string },
  deps: ImportDeps,
  fetcher: (url: string) => Promise<string> = fetchPage,
): Promise<RecipeDraft> {
  const { ai } = deps;
  const fromAi = async (text: string, sourceUrl: string): Promise<RecipeDraft> => {
    const r = await ai.parseRecipe(text, deps.catalogue());
    return { ...r, sourceUrl, via: 'ai' };
  };

  if (input.url) {
    const url = input.url.trim();
    const html = await fetcher(url);
    const withImage = (draft: RecipeDraft): RecipeDraft => {
      const imageUrl = findImage(html, url);
      return imageUrl ? { ...draft, imageUrl } : draft;
    };
    const structured = findStructuredRecipe(html);
    if (structured) {
      if (!ai.enabled) return withImage(heuristicFromStructured(structured, url));
      try {
        return withImage(await fromAi(structuredAsText(structured), url));
      } catch (err) {
        // The page's own data is good enough to fall back on.
        if (!(err instanceof AiError)) throw err;
        deps.onAiFailure?.(err);
        return withImage(heuristicFromStructured(structured, url));
      }
    }
    if (!ai.enabled) {
      throw new ImportError(
        'That page has no recipe data a program can read, and AI is not set up to read it instead. Paste the recipe text instead.',
      );
    }
    return withImage(await fromAi(`Web page: ${url}\n\n${htmlToText(html)}`, url));
  }

  const text = (input.text ?? '').trim();
  if (!text) throw new ImportError('Paste a recipe or give an address');
  if (!ai.enabled) return heuristicFromText(text);
  try {
    return await fromAi(text, '');
  } catch (err) {
    if (!(err instanceof AiError)) throw err;
    deps.onAiFailure?.(err);
    return heuristicFromText(text);
  }
}
