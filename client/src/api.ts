import type {
  Dinner,
  NemligApplyEntry,
  NemligApplyResult,
  NemligPlan,
  IngredientInput,
  Item,
  Meta,
  Recipe,
  RecipeDraft,
  RecipeSummary,
  ShoppingList,
  PlanSummary,
  StapleList,
  WeekPlan,
} from '../../shared/types';
import { CLIENT_ID } from './live';

/**
 * Requests are same-origin, so the app works unchanged on a LAN address or
 * behind a tunnel domain — nothing here knows where it is being served from.
 */
const BASE = '/api';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  // A picture goes up as itself; everything else as JSON.
  const raw = body instanceof Blob;
  try {
    res = await fetch(BASE + path, {
      method,
      // The id lets other tabs' live updates say who made a change.
      headers: {
        'x-grocer-client': CLIENT_ID,
        ...(body === undefined ? {} : { 'content-type': raw ? body.type : 'application/json' }),
      },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server');
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // A proxy's HTML error page, most likely.
    throw new ApiError(res.status, `Unexpected answer from the server (${res.status})`);
  }

  if (!res.ok) {
    const message =
      typeof parsed === 'object' && parsed !== null && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }

  return parsed as T;
}

export interface EntryInput extends IngredientInput {
  category?: string | null;
}

export interface RecipeInput {
  name: string;
  servings: number;
  instructions: string;
  sourceUrl: string;
  notes: string;
  tags: string[];
  ingredients: EntryInput[];
  /** A picture for the server to fetch and keep, as found by an import. */
  imageUrl?: string;
}

export interface ListInput {
  name: string;
  notes: string;
  entries: Array<{ name: string; quantity: number | null; unit: string; category?: string | null }>;
}

export interface DinnerInput {
  title?: string;
  recipeId?: number | null;
  servings?: number;
  note?: string;
  day?: string | null;
  /** Default true: a planned recipe's ingredients go on the shopping list. */
  addToShop?: boolean;
}

export interface DinnerPatch {
  title?: string;
  recipeId?: number | null;
  servings?: number;
  note?: string;
  day?: string | null;
  cooked?: boolean;
}

export interface ParsedEntries {
  entries: EntryInput[];
  via: 'ai' | 'heuristic';
  warning?: string;
}

export const api = {
  meta: () => request<Meta>('GET', '/meta'),

  items: {
    list: () => request<Item[]>('GET', '/items'),
    update: (id: number, input: { name: string; category: string | null; notes: string }) =>
      request<Item>('PUT', `/items/${id}`, input),
    remove: (id: number) => request<void>('DELETE', `/items/${id}`),
    merge: (id: number, intoId: number) => request<Item>('POST', `/items/${id}/merge`, { intoId }),
    categorise: () => request<{ categorised: number }>('POST', '/items/categorise', {}),
    forgetNemlig: (id: number) => request<void>('DELETE', `/items/${id}/nemlig`),
    uses: (id: number) =>
      request<{ recipes: Array<{ id: number; name: string }>; lists: Array<{ id: number; name: string }> }>(
        'GET',
        `/items/${id}/uses`,
      ),
  },

  recipes: {
    list: () => request<RecipeSummary[]>('GET', '/recipes'),
    get: (id: number) => request<Recipe>('GET', `/recipes/${id}`),
    create: (input: RecipeInput) => request<Recipe>('POST', '/recipes', input),
    update: (id: number, input: RecipeInput) => request<Recipe>('PUT', `/recipes/${id}`, input),
    remove: (id: number) => request<void>('DELETE', `/recipes/${id}`),
    import: (input: { url?: string; text?: string }) =>
      request<RecipeDraft>('POST', '/recipes/import', input),
    uploadImage: (id: number, image: Blob) => request<Recipe>('PUT', `/recipes/${id}/image`, image),
    /** A picture's address, or a page's; without one, the recipe's own source page. */
    fetchImage: (id: number, url?: string) => request<Recipe>('POST', `/recipes/${id}/image/fetch`, { url }),
    removeImage: (id: number) => request<Recipe>('DELETE', `/recipes/${id}/image`),
  },

  plan: {
    /** The current plan; `today` is this browser's, so "tomorrow" is the household's. */
    get: (today: string) => request<WeekPlan>('GET', `/plan?today=${today}`),
    setRange: (from: string, to: string, today: string) => request<WeekPlan>('PATCH', '/plan', { from, to, today }),
    /** File the current plan away and start the next. */
    startNext: (today: string) => request<WeekPlan>('POST', '/plans', { today }),
    history: () => request<PlanSummary[]>('GET', '/plans'),
    setNote: (day: string, note: string) => request<void>('PUT', `/plan/${day}/note`, { note }),
  },

  lists: {
    list: () => request<StapleList[]>('GET', '/lists'),
    create: (input: ListInput) => request<StapleList>('POST', '/lists', input),
    update: (id: number, input: ListInput) => request<StapleList>('PUT', `/lists/${id}`, input),
    remove: (id: number) => request<void>('DELETE', `/lists/${id}`),
  },

  nemlig: {
    plan: () => request<NemligPlan>('POST', '/nemlig/plan', {}),
    apply: (entries: NemligApplyEntry[]) => request<NemligApplyResult>('POST', '/nemlig/apply', { entries }),
  },

  dinners: {
    list: () => request<Dinner[]>('GET', '/dinners'),
    get: (id: number) => request<Dinner>('GET', `/dinners/${id}`),
    add: (input: DinnerInput) => request<Dinner>('POST', '/dinners', input),
    update: (id: number, patch: DinnerPatch) => request<Dinner>('PATCH', `/dinners/${id}`, patch),
    remove: (id: number, keepOnShop = false) =>
      request<void>('DELETE', `/dinners/${id}${keepOnShop ? '?keepOnShop=true' : ''}`),
  },

  shop: {
    get: () => request<ShoppingList>('GET', '/shop'),
    addDinner: (dinnerId: number) => request<ShoppingList>('POST', '/shop/dinners', { dinnerId }),
    removeDinner: (dinnerId: number) => request<ShoppingList>('DELETE', `/shop/dinners/${dinnerId}`),
    addRecipe: (recipeId: number, servings?: number) =>
      request<ShoppingList>('POST', '/shop/recipes', { recipeId, servings }),
    removeRecipe: (recipeId: number) => request<ShoppingList>('DELETE', `/shop/recipes/${recipeId}`),
    addList: (listId: number) => request<ShoppingList>('POST', '/shop/lists', { listId }),
    removeList: (listId: number) => request<ShoppingList>('DELETE', `/shop/lists/${listId}`),
    addItems: (entries: EntryInput[]) => request<ShoppingList>('POST', '/shop/items', { entries }),
    parse: (text: string, useAi: boolean) =>
      request<ParsedEntries>('POST', '/shop/parse', { text, useAi }),
    updateLine: (
      id: number,
      fields: { checked?: boolean; note?: string; amount?: { quantity: number | null; unit: string } },
    ) => request<ShoppingList>('PATCH', `/shop/lines/${id}`, fields),
    removeLine: (id: number) => request<ShoppingList>('DELETE', `/shop/lines/${id}`),
    clear: (onlyChecked: boolean) => request<ShoppingList>('POST', '/shop/clear', { onlyChecked }),
  },
};
