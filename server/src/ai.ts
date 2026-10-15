import { z } from 'zod';
import { CATEGORY_KEYS, isCategory } from '../../shared/categories.js';
import { normaliseUnit, parseQuantity } from '../../shared/units.js';
import type { Config } from './config.js';
import type { NamedEntry } from './store.js';

/**
 * The AI half of the app, spoken through the homelab's LiteLLM harness. It is
 * OpenAI-compatible, so this is a plain `fetch` to /chat/completions with a
 * model alias the harness resolves — no SDK, and nothing here knows which
 * provider is actually answering.
 *
 * Every feature has a non-AI fallback elsewhere; this module only ever makes
 * things better, so when it is not configured the app still works.
 */

export class AiError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 502, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AiError';
    this.statusCode = statusCode;
  }
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const UNITS = 'g, kg, ml, cl, dl, l, spsk, tsk, stk, fed, dåse, pk, bundt, glas, pose, flaske, knsp';

/** Models write quantities every which way; accept them all and settle on a number. */
const quantity = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((v) => {
    if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
    if (typeof v === 'string') {
      // A range ("2-3") buys the upper end, as the hand parser does.
      const last = v.split(/[-–]/).pop() ?? '';
      return parseQuantity(last);
    }
    return null;
  });

const entry = z.object({
  name: z.string().trim().min(1),
  quantity,
  unit: z
    .string()
    .nullish()
    .transform((u) => normaliseUnit(u ?? '')),
  note: z
    .string()
    .nullish()
    .transform((n) => (n ?? '').trim()),
  category: z
    .string()
    .nullish()
    .transform((c) => (isCategory(c) ? c : null)),
});

const recipeShape = z.object({
  name: z.string().trim().min(1),
  servings: z.coerce.number().int().min(1).max(100).catch(4),
  tags: z.array(z.string()).catch([]),
  instructions: z
    .union([z.string(), z.array(z.string())])
    .catch('')
    .transform((v) => (Array.isArray(v) ? v.join('\n') : v)),
  ingredients: z.array(entry).min(1),
});

const itemsShape = z.object({ items: z.array(entry) });

const categoriesShape = z.object({
  items: z.array(z.object({ id: z.coerce.number().int(), category: z.string() })),
});

const picksShape = z.object({
  picks: z.array(
    z.object({
      line: z.coerce.number().int(),
      productId: z.union([z.string(), z.number()]).nullable().transform((v) => (v === null ? null : String(v))),
      quantity: z.coerce.number().int().min(1).max(50).catch(1),
      reason: z.string().catch(''),
    }),
  ),
});

export interface PickRequest {
  line: number;
  item: string;
  /** What the list wants, as written on it ("1,5 kg", "6"). */
  wants: string;
  note: string;
  candidates: Array<{
    id: string;
    name: string;
    description?: string;
    price: number;
    inStock: boolean;
    favourite: boolean;
    offer?: string;
  }>;
}

export type ParsedEntry = z.infer<typeof entry> & NamedEntry;
export type ParsedRecipe = z.infer<typeof recipeShape>;

/** Models like to wrap JSON in a fence even when asked not to. */
export function extractJson(content: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(content);
  const body = (fenced ? fenced[1]! : content).trim();
  const start = body.search(/[[{]/);
  if (start < 0) throw new Error('no JSON object in the reply');
  return JSON.parse(body.slice(start));
}

function knownItems(names: string[]): string {
  return names.length
    ? `KNOWN ITEMS (reuse these exact spellings when one means the same thing):\n${names.join('; ')}`
    : 'KNOWN ITEMS: none yet.';
}

const ENTRY_RULES = `Each entry is {"name", "quantity", "unit", "note", "category"}:
- "name": only the thing you buy, in its plain base form and in the language it was written in — no amounts, no preparation. "2 løg, finthakket" → name "Løg", note "finthakket".
- "quantity": a number or null. Turn fractions into decimals. For a range take the upper end.
- "unit": one of ${UNITS}, or "" for a plain count.
- "note": preparation or a qualifier, otherwise "".
- "category": the supermarket aisle, one of ${CATEGORY_KEYS.join(', ')}.
Split combined items ("salt og peber" → two entries). Leave out tap water.`;

export function createAi(cfg: Config['ai']) {
  const enabled = Boolean(cfg.baseUrl && cfg.apiKey);

  async function complete(messages: ChatMessage[]): Promise<string> {
    if (!enabled) throw new AiError('AI is not configured on this server', 503);
    let res: Response;
    try {
      res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          temperature: 0.1,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (err) {
      const timedOut = (err as Error).name === 'TimeoutError';
      // "fetch failed" says nothing; the cause's code (ENOTFOUND, ECONNREFUSED)
      // and host say whether it is the name, the port or the harness itself.
      const cause = (err as { cause?: { code?: string; hostname?: string; address?: string } }).cause;
      const why = cause?.code ? ` (${[cause.code, cause.hostname ?? cause.address].filter(Boolean).join(' ')})` : '';
      throw new AiError(
        timedOut ? 'The AI service took too long to answer' : `Could not reach the AI service at ${new URL(cfg.baseUrl).host}${why}`,
        timedOut ? 504 : 502,
        { cause: err },
      );
    }
    const text = await res.text();
    if (!res.ok) {
      throw new AiError(`The AI service refused the request (${res.status}): ${text.slice(0, 300)}`);
    }
    let content: unknown;
    try {
      content = (JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]
        ?.message?.content;
    } catch (err) {
      throw new AiError('The AI service sent something that is not JSON', 502, { cause: err });
    }
    if (typeof content !== 'string' || !content.trim()) {
      throw new AiError('The AI service sent an empty answer');
    }
    return content;
  }

  /**
   * Ask for JSON of a known shape. One wrong answer gets one chance to correct
   * itself, told what was wrong; a second wrong answer is an error.
   */
  async function chatJson<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, system: string, user: string): Promise<T> {
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    let lastProblem = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const content = await complete(messages);
      try {
        return schema.parse(extractJson(content));
      } catch (err) {
        lastProblem = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : (err as Error).message;
        messages.push(
          { role: 'assistant', content },
          { role: 'user', content: `That reply was not usable (${lastProblem}). Reply again with the JSON object only.` },
        );
      }
    }
    throw new AiError(`The AI answer did not have the expected shape: ${lastProblem}`);
  }

  return {
    enabled,
    model: enabled ? cfg.model : null,

    /** A recipe from pasted text or a web page's text, ready for review. */
    parseRecipe(text: string, catalogue: string[]): Promise<ParsedRecipe> {
      const system = `You turn recipes into structured data for a household shopping app. Reply with a single JSON object:
{"name": string, "servings": integer, "tags": string[], "instructions": string, "ingredients": [entry, ...]}
${ENTRY_RULES}
"instructions": the method as numbered steps, one per line, in the recipe's own language. Do not invent steps.
"tags": two to four short lowercase words (e.g. "pasta", "vegetarian", "hverdagsmad").
If the servings are not stated, estimate them.
${knownItems(catalogue)}`;
      return chatJson(recipeShape, system, `RECIPE:\n${text.slice(0, 30_000)}`);
    },

    /**
     * Free text into shopping entries: "mælk, 2 kg mel og noget til tacos".
     * A dish named outright is expanded into what it usually needs.
     */
    async parseItems(text: string, catalogue: string[]): Promise<ParsedEntry[]> {
      const system = `You turn what someone typed or dictated into entries on their grocery shopping list. Reply with a JSON object {"items": [entry, ...]}.
${ENTRY_RULES}
If they name a dish or occasion instead of products ("noget til tacos", "stuff for pancakes"), expand it into the groceries it usually needs and put the dish in each entry's note.
${knownItems(catalogue)}`;
      return (await chatJson(itemsShape, system, text.slice(0, 5_000))).items;
    },

    /**
     * For each shopping line, the Nemlig product to buy and how many packs.
     * Every line is decided in one call; a pick naming a product that was not
     * among that line's candidates is dropped rather than trusted.
     */
    async pickProducts(requests: PickRequest[]): Promise<Map<number, { productId: string | null; quantity: number; reason: string }>> {
      const out = new Map<number, { productId: string | null; quantity: number; reason: string }>();
      if (!requests.length) return out;
      const system = `You do a Danish household's online grocery shop at Nemlig. For each shopping-list line you get the item, how much the list wants, and the products Nemlig's search found. Pick the one product to buy and how many packs. Reply with a JSON object {"picks": [{"line": number, "productId": string | null, "quantity": integer, "reason": string}, ...]}, one pick per line.
Rules:
- Prefer products marked favourite: the household buys those.
- Pick what the item plainly means: ordinary "Hvedemel", not tipo 00 or manitoba; ordinary milk, not lactose-free — unless the item or note says otherwise.
- Only pick products that are inStock.
- quantity is the number of packs. Use each candidate's description for the pack size ("1 kg", "6 stk.") and buy enough to cover what the list wants, rounding up. With no amount wanted, buy 1.
- Take a multi-buy offer only when the list needs that many anyway.
- productId null when nothing fits; say why in reason.
- reason: a few words, in English.`;
      const result = await chatJson(picksShape, system, JSON.stringify(requests));
      const allowed = new Map(requests.map((r) => [r.line, new Set(r.candidates.map((c) => c.id))]));
      for (const pick of result.picks) {
        const ids = allowed.get(pick.line);
        if (!ids) continue;
        out.set(pick.line, {
          productId: pick.productId && ids.has(pick.productId) ? pick.productId : null,
          quantity: pick.quantity,
          reason: pick.reason,
        });
      }
      return out;
    },

    /** Put items in aisles. Returns only the assignments that name a real aisle. */
    async categorise(items: Array<{ id: number; name: string }>): Promise<Array<{ id: number; category: string }>> {
      if (!items.length) return [];
      const system = `You sort grocery items into supermarket aisles. Reply with a JSON object {"items": [{"id": number, "category": string}, ...]} with one entry per item given. category is one of ${CATEGORY_KEYS.join(', ')}.`;
      const result = await chatJson(categoriesShape, system, JSON.stringify(items));
      const ids = new Set(items.map((i) => i.id));
      return result.items.filter((a) => ids.has(a.id) && isCategory(a.category));
    },
  };
}

export type Ai = ReturnType<typeof createAi>;
