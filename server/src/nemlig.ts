import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  NemligApplyEntry,
  NemligApplyResult,
  NemligPlan,
  NemligPlanLine,
  NemligProduct,
  NemligProgress,
  ShoppingLine,
} from '../../shared/types.js';
import { formatAmounts, normaliseUnit, packsNeeded, parsePackSize, type Amount } from '../../shared/units.js';
import { AiError, type Ai, type PickRequest } from './ai.js';
import type { Config } from './config.js';
import type { Store } from './store.js';

/**
 * Nemlig, through the homelab harness. The harness (LiteLLM) fronts the
 * nemlig-mcp server as an MCP gateway, so Grocer speaks MCP to the harness with
 * its own key and never holds Nemlig credentials. Grocer drives: it searches,
 * asks the model only to choose among what came back, and sets the basket
 * itself — every step visible, and nothing ordered, only put in the basket.
 */

export class NemligError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 502, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NemligError';
    this.statusCode = statusCode;
  }
}

/** The nemlig-mcp tools Grocer uses. The gateway may prefix their names. */
const TOOLS = ['search_products', 'get_favourite_products', 'get_basket', 'set_basket_quantity'] as const;
type ToolName = (typeof TOOLS)[number];

interface RawProduct {
  id: string;
  name: string;
  price: number;
  inStock?: boolean;
  deliverable?: boolean;
  labels?: string[];
  description?: string;
  brand?: string;
  offer?: { description?: string; minQuantity?: number; offerPrice?: number };
}

interface RawBasket {
  TotalPrice?: number;
  Lines?: Array<{ Id?: string; ProductId?: string; Quantity?: number }>;
}

function toProduct(raw: RawProduct, favourites: Set<string>): NemligProduct {
  return {
    id: String(raw.id),
    name: raw.name,
    price: raw.price,
    inStock: raw.inStock ?? true,
    deliverable: raw.deliverable ?? true,
    labels: raw.labels ?? [],
    ...(raw.description ? { description: raw.description } : {}),
    ...(raw.brand ? { brand: raw.brand } : {}),
    ...(raw.offer?.description
      ? {
          offer: {
            description: raw.offer.description,
            ...(raw.offer.minQuantity ? { minQuantity: raw.offer.minQuantity } : {}),
            ...(raw.offer.offerPrice ? { offerPrice: raw.offer.offerPrice } : {}),
          },
        }
      : {}),
    ...(favourites.has(String(raw.id)) ? { favourite: true } : {}),
  };
}

export interface NemligSession {
  search(term: string): Promise<RawProduct[]>;
  favourites(): Promise<RawProduct[]>;
  basket(): Promise<RawBasket>;
  setQuantity(productId: string, quantity: number): Promise<void>;
}

export function createNemlig(cfg: Config['nemlig'], apiKey: string) {
  const enabled = cfg.enabled && Boolean(cfg.mcpUrl);

  /** Open one MCP connection to the gateway for a piece of work, and close it after. */
  async function withSession<T>(work: (session: NemligSession) => Promise<T>): Promise<T> {
    if (!enabled) throw new NemligError('Nemlig is not configured on this server', 503);
    const transport = new StreamableHTTPClientTransport(new URL(cfg.mcpUrl), {
      requestInit: {
        headers: {
          // LiteLLM's MCP gateway: the app's own key, scoped to the one server.
          'x-litellm-api-key': `Bearer ${apiKey}`,
          'x-mcp-servers': cfg.server,
        },
      },
    });
    const client = new Client({ name: 'grocer', version: '1' });
    try {
      await client.connect(transport, { timeout: cfg.timeoutMs });
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause;
      const why = [(err as Error).message, cause?.code].filter(Boolean).join(' — ');
      throw new NemligError(`Could not reach Nemlig through the AI harness at ${new URL(cfg.mcpUrl).host}: ${why}`, 502, {
        cause: err,
      });
    }

    try {
      const { tools } = await client.listTools(undefined, { timeout: cfg.timeoutMs });
      // A gateway in front of several servers prefixes tool names
      // ("nemlig-search_products"); match on the ending either way.
      const names = new Map<ToolName, string>();
      for (const wanted of TOOLS) {
        const found = tools.find((t) => t.name === wanted || t.name.endsWith(`-${wanted}`) || t.name.endsWith(`_${wanted}`));
        if (!found) {
          throw new NemligError(
            `The harness offers no "${wanted}" tool — is the "${cfg.server}" MCP server registered and allowed for this key?`,
          );
        }
        names.set(wanted, found.name);
      }

      const call = async <R>(tool: ToolName, args: Record<string, unknown>): Promise<R> => {
        const result = await client.callTool({ name: names.get(tool)!, arguments: args }, undefined, {
          timeout: cfg.timeoutMs,
        });
        const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
        const text = content.find((c) => c.type === 'text')?.text ?? '';
        if (result.isError) throw new NemligError(`Nemlig ${tool} failed: ${text.slice(0, 300)}`);
        try {
          return JSON.parse(text) as R;
        } catch (err) {
          throw new NemligError(`Nemlig ${tool} answered with something that is not JSON`, 502, { cause: err });
        }
      };

      return await work({
        search: async (term) => (await call<{ products?: RawProduct[] }>('search_products', { searchterm: term })).products ?? [],
        favourites: async () => (await call<{ products?: RawProduct[] }>('get_favourite_products', {})).products ?? [],
        basket: async () => (await call<{ basket?: RawBasket }>('get_basket', {})).basket ?? {},
        setQuantity: async (productId, quantity) => {
          await call('set_basket_quantity', { productId, quantity });
        },
      });
    } finally {
      await client.close().catch(() => {});
    }
  }

  return { enabled, server: cfg.server, withSession };
}

export type Nemlig = ReturnType<typeof createNemlig>;

/* ----------------------------------------------------------------- plan */

/** Run `fn` over `items`, a few at a time — enough to be quick, few enough to be polite. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/** Whether the line's amount can be measured against the pack: then arithmetic decides, not the model. */
function measurable(amounts: Amount[], pack: Amount | null): boolean {
  if (!pack) return false;
  const family = (u: string) => {
    const n = normaliseUnit(u);
    if (['g', 'kg'].includes(n)) return 'mass';
    if (['ml', 'cl', 'dl', 'l'].includes(n)) return 'volume';
    if (['', 'stk'].includes(n)) return 'count';
    return n;
  };
  return amounts.some((a) => a.quantity !== null && family(a.unit) === family(pack.unit));
}

const packOf = (p: { description?: string; name: string }) => parsePackSize(p.description) ?? parsePackSize(p.name);

/** In stock first, then favourites, keeping Nemlig's own relevance order otherwise. */
function rank(products: NemligProduct[]): NemligProduct[] {
  return products
    .map((p, i) => ({ p, i }))
    .sort((a, b) => Number(b.p.inStock) - Number(a.p.inStock) || Number(!!b.p.favourite) - Number(!!a.p.favourite) || a.i - b.i)
    .map(({ p }) => p);
}

export interface PlanDeps {
  store: Store;
  ai: Ai;
  nemlig: Nemlig;
  /** Told about a model failure the plan recovered from. */
  onAiFailure?: (err: unknown) => void;
  /** Told how far the work has got, for a progress bar. */
  onProgress?: (progress: NemligProgress) => void;
}

/**
 * A product and number of packs for every line still to get. Remembered items
 * are matched to what they were bought as last time; the rest are searched and
 * chosen by the model in one call, falling back to a favourite or the first
 * hit when the model cannot help. Nothing touches the basket here.
 */
export async function planShop(deps: PlanDeps): Promise<NemligPlan> {
  const lines = deps.store.shop.get().lines.filter((l) => !l.checked && !l.inBasket);
  if (!lines.length) return { lines: [] };
  const items = new Map(deps.store.items.list().map((i) => [i.id, i]));

  return deps.nemlig.withSession(async (session) => {
    const progress = deps.onProgress ?? (() => {});
    progress({ type: 'searching', total: lines.length, names: lines.map((l) => l.name) });
    const favouriteIds = new Set((await session.favourites().catch(() => [])).map((p) => String(p.id)));
    let searchedCount = 0;
    const searched = await mapLimited(lines, 4, async (line) => {
      const found = rank((await session.search(line.name).catch(() => [])).map((p) => toProduct(p, favouriteIds)));
      progress({ type: 'searched', name: line.name, found: found.length, done: ++searchedCount, total: lines.length });
      return found;
    });

    const plan: NemligPlanLine[] = lines.map((line, i) => {
      const candidates = searched[i]!;
      const remembered = items.get(line.itemId)?.nemlig ?? null;
      const base = { lineId: line.id, itemId: line.itemId, name: line.name, amount: formatAmounts(line.amounts) };
      if (remembered) {
        const fresh = candidates.find((c) => c.id === remembered.productId);
        const product: NemligProduct = fresh ?? {
          id: remembered.productId,
          name: remembered.name,
          price: 0,
          inStock: true,
          deliverable: true,
          labels: [],
          ...(remembered.description ? { description: remembered.description } : {}),
        };
        return {
          ...base,
          product,
          quantity: packsNeeded(line.amounts, packOf(product)),
          source: 'remembered',
          reason: fresh ? 'Bought as this last time' : 'Bought as this last time; not in today’s search, so no current price',
          alternatives: candidates.filter((c) => c.id !== product.id).slice(0, 6),
        };
      }
      return { ...base, product: null, quantity: 1, source: 'none', reason: 'Nothing found', alternatives: candidates.slice(0, 7) };
    });

    // Everything not remembered, decided by the model in one go.
    const open = plan.filter((p) => p.source === 'none' && p.alternatives.length);
    let warning: string | undefined;
    let picks = new Map<number, { productId: string | null; quantity: number; reason: string }>();
    if (open.length && deps.ai.enabled) {
      const byLine = new Map(lines.map((l) => [l.id, l]));
      const requests: PickRequest[] = open.map((p) => ({
        line: p.lineId,
        item: p.name,
        wants: p.amount,
        note: byLine.get(p.lineId)?.note ?? '',
        candidates: p.alternatives.map((c) => ({
          id: c.id,
          name: c.name,
          ...(c.description ? { description: c.description } : {}),
          price: c.price,
          inStock: c.inStock,
          favourite: !!c.favourite,
          ...(c.offer ? { offer: c.offer.description } : {}),
        })),
      }));
      deps.onProgress?.({ type: 'choosing', count: requests.length });
      try {
        picks = await deps.ai.pickProducts(requests);
      } catch (err) {
        if (!(err instanceof AiError)) throw err;
        deps.onAiFailure?.(err);
        warning = `The AI could not choose this time (${err.message}); these are favourites or the first match.`;
      }
    } else if (open.length) {
      warning = 'AI is not set up, so these are favourites or the first match.';
    }

    const lineById = new Map<number, ShoppingLine>(lines.map((l) => [l.id, l]));
    for (const p of open) {
      const line = lineById.get(p.lineId)!;
      const pick = picks.get(p.lineId);
      const chosen = pick?.productId ? p.alternatives.find((c) => c.id === pick.productId) : undefined;
      const fallback = p.alternatives.find((c) => c.inStock && c.favourite) ?? p.alternatives.find((c) => c.inStock);
      const product = chosen ?? (pick && !pick.productId ? undefined : fallback);
      if (!product) {
        p.reason = pick?.reason || 'Nothing in stock matched';
        continue;
      }
      const pack = packOf(product);
      p.product = product;
      // Arithmetic beats the model at arithmetic: use it whenever the sizes compare.
      p.quantity = measurable(line.amounts, pack) ? packsNeeded(line.amounts, pack) : (pick?.quantity ?? packsNeeded(line.amounts, pack));
      p.source = chosen ? 'ai' : product.favourite ? 'favourite' : 'first';
      p.reason = chosen ? pick!.reason : product.favourite ? 'One of your favourites' : 'First match in stock';
      p.alternatives = p.alternatives.filter((c) => c.id !== product.id);
    }

    return { lines: plan, ...(warning ? { warning } : {}) };
  });
}

/* ---------------------------------------------------------------- apply */

/**
 * Fill the basket. Quantities are absolute and never lowered: if the basket
 * already holds more of something, that stays — so running this twice, or after
 * adding things by hand in Nemlig, never doubles up or takes anything away.
 * Every line that made it in is marked as in the basket, and every item
 * remembers the product it was bought as.
 */
export async function applyToBasket(
  entries: NemligApplyEntry[],
  deps: { store: Store; nemlig: Nemlig; onProgress?: (progress: NemligProgress) => void },
): Promise<NemligApplyResult> {
  const wanted = new Map<string, { name: string; quantity: number; entries: NemligApplyEntry[] }>();
  for (const e of entries) {
    const w = wanted.get(e.productId) ?? { name: e.productName, quantity: 0, entries: [] };
    w.quantity += e.quantity;
    w.entries.push(e);
    wanted.set(e.productId, w);
  }

  return deps.nemlig.withSession(async (session) => {
    const before = new Map<string, number>();
    for (const line of (await session.basket()).Lines ?? []) {
      const id = String(line.Id ?? line.ProductId ?? '');
      if (id) before.set(id, line.Quantity ?? 0);
    }

    const results: NemligApplyResult['results'] = [];
    const progress = deps.onProgress ?? (() => {});
    const total = wanted.size;
    progress({ type: 'filling', total, names: [...wanted.values()].map((w) => w.name) });
    for (const [productId, w] of wanted) {
      const previous = before.get(productId) ?? 0;
      const target = Math.max(previous, w.quantity);
      try {
        if (target !== previous) await session.setQuantity(productId, target);
        results.push({ productId, name: w.name, quantity: target, previous, ok: true });
        progress({ type: 'filled', name: w.name, ok: true, done: results.length, total });
      } catch (err) {
        results.push({ productId, name: w.name, quantity: previous, previous, ok: false, error: (err as Error).message });
        progress({ type: 'filled', name: w.name, ok: false, done: results.length, total });
        continue;
      }
      for (const e of w.entries) {
        // A line or item deleted during the review is no reason to report the
        // basket — which did change — as failed.
        try {
          deps.store.items.setNemlig(e.itemId, { productId, name: e.productName, description: e.description });
          deps.store.shop.setInBasket(e.lineId);
        } catch {
          /* gone meanwhile */
        }
      }
    }

    const basketTotal = (await session.basket().catch(() => ({}) as RawBasket)).TotalPrice ?? null;
    return { results, basketTotal };
  });
}

/* ---------------------------------------------------------- finishing */

export interface OrderCheck {
  /** Whether the products sent to Nemlig have left the basket — ordered. */
  ordered: boolean;
  /** Lines cleared off the list because of it. */
  cleared: number;
}

/**
 * Has the basket Grocer filled been ordered? Nemlig empties the basket at
 * checkout, so once none of the products Grocer put in are in it any more —
 * an empty basket, or a new one already started for next time — the shop is
 * done: what was in the basket or already in stock comes off the list, and
 * what is still to get stays. While any of them is still there, nothing
 * happens. Nothing marked as in the basket means nothing to check.
 */
export async function checkOrdered(deps: { store: Store; nemlig: Nemlig }): Promise<OrderCheck> {
  const lines = deps.store.shop.get().lines;
  const sent = lines.filter((l) => l.inBasket);
  if (!sent.length || !deps.nemlig.enabled) return { ordered: false, cleared: 0 };

  const items = new Map(deps.store.items.list().map((i) => [i.id, i]));
  const ours = new Set(sent.map((l) => items.get(l.itemId)?.nemlig?.productId).filter((id): id is string => !!id));
  const basket = await deps.nemlig.withSession((session) => session.basket());
  const inBasket = new Set(
    (basket.Lines ?? []).filter((l) => (l.Quantity ?? 1) > 0).map((l) => String(l.Id ?? l.ProductId ?? '')),
  );
  // Without a product to look for, only an empty basket says it was ordered.
  const ordered = ours.size ? ![...ours].some((id) => inBasket.has(id)) : inBasket.size === 0;
  if (!ordered) return { ordered: false, cleared: 0 };

  const cleared = lines.filter((l) => l.checked || l.inBasket).length;
  deps.store.shop.clear(true);
  return { ordered: true, cleared };
}
