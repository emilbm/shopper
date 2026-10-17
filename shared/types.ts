import type { Amount } from './units';

/** Anything that can go on a shopping list: an ingredient, a product, a thing. */
export interface Item {
  id: number;
  name: string;
  /** Null until someone, or the AI, has put it in an aisle. */
  category: string | null;
  notes: string;
  /** How many recipe and list entries use it — an item in use cannot be deleted. */
  usage: number;
  /** How many recipes it is an ingredient of. */
  recipes: number;
  /** How many of the set lists it is on. */
  lists: number;
  /** The Nemlig product it was last bought as, if any. */
  nemlig: RememberedProduct | null;
}

export interface RememberedProduct {
  productId: string;
  name: string;
  /** Pack size as Nemlig writes it ("1 kg / Valsemøllen"), when it said. */
  description: string;
}

export interface IngredientInput {
  name: string;
  quantity: number | null;
  unit: string;
  note: string;
}

export interface RecipeIngredient extends IngredientInput {
  id: number;
  itemId: number;
  category: string | null;
}

export interface RecipeSummary {
  id: number;
  name: string;
  servings: number;
  tags: string[];
  ingredientCount: number;
  /** Address of its picture, or null when it has none. */
  image: string | null;
  updatedAt: string;
}

export interface Recipe {
  id: number;
  name: string;
  servings: number;
  instructions: string;
  sourceUrl: string;
  notes: string;
  tags: string[];
  ingredients: RecipeIngredient[];
  /** Address of its picture, or null when it has none. */
  image: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What an import produces: a recipe not yet saved, for review in the editor. */
export interface RecipeDraft {
  name: string;
  servings: number;
  instructions: string;
  sourceUrl: string;
  tags: string[];
  /** With the AI's guess at each item's aisle, used only for items not seen before. */
  ingredients: Array<IngredientInput & { category?: string | null }>;
  /** How the draft was made, so the editor can say how much to trust it. */
  via: 'ai' | 'structured-data' | 'heuristic';
  /** The page's picture of the dish, fetched and kept when the recipe is saved. */
  imageUrl?: string;
}

export interface StapleListEntry {
  id: number;
  itemId: number;
  name: string;
  category: string | null;
  quantity: number | null;
  unit: string;
}

/** A set list — "the usual weekly", "breakfast stuff" — added to the shop in one go. */
export interface StapleList {
  id: number;
  name: string;
  notes: string;
  entries: StapleListEntry[];
}

export type SourceKind = 'recipe' | 'list' | 'manual' | 'dinner';

/** Why a line is on the shopping list, and how much that reason asked for. */
export interface LineSource {
  id: number;
  kind: SourceKind;
  refId: number | null;
  label: string;
  quantity: number | null;
  unit: string;
}

export interface ShoppingLine {
  id: number;
  itemId: number;
  name: string;
  category: string | null;
  /** Ticked off: already in stock, so not to buy. */
  checked: boolean;
  /** Put in the Nemlig basket by Send to Nemlig. */
  inBasket: boolean;
  note: string;
  /**
   * The sources added up: one amount per kind of unit. When corrected by hand,
   * the correction stands in for the sources it covered.
   */
  amounts: Amount[];
  /** Whether the amount was corrected by hand. */
  edited: boolean;
  sources: LineSource[];
}

/** A dinner, recipe or list that has put something on the current shop. */
export interface ShopContributor {
  kind: 'recipe' | 'list' | 'dinner';
  refId: number;
  label: string;
  lines: number;
}

export interface ShoppingList {
  lines: ShoppingLine[];
  contributors: ShopContributor[];
}

/**
 * A planned dinner. It has a day once it is put on the week planner; without
 * one it is simply planned for "this week", in the order it was added.
 */
export interface Dinner {
  id: number;
  title: string;
  /** A local date, YYYY-MM-DD, or null when it has no day yet. */
  day: string | null;
  /** The plan it belongs to. */
  planId: number | null;
  /** Null for a dinner without one ('Takeaway'), or whose recipe was deleted. */
  recipeId: number | null;
  recipeName: string | null;
  servings: number;
  note: string;
  cookedAt: string | null;
  createdAt: string;
  /** Whether its ingredients are on the current shopping list. */
  onShop: boolean;
}

/** One day of the week planner. */
export interface PlanDay {
  day: string;
  note: string;
  dinners: Dinner[];
}

/** The current plan, as the planner shows it. */
/** One plan's days, as the planner shows them. */
export interface PlanPeriod {
  id: number;
  /** The plan's own first and last day. */
  from: string;
  to: string;
  days: PlanDay[];
  /** Whether this is the open plan, whose days can still be added and removed. */
  current: boolean;
}

/**
 * The planner's two parts: the plan being eaten now, and the one being
 * planned next. Often one plan is both — mid-week, before the next period is
 * started — and then `next` is null.
 */
export interface WeekPlan {
  /** The plan today falls in, with every one of its days: past ones too, to see and correct what was eaten. */
  now: PlanPeriod | null;
  /** The open plan when it starts after today, from tomorrow on: the period being planned. */
  next: PlanPeriod | null;
  /** The open plan, whichever part it is in. */
  current: { id: number; from: string; to: string };
  /** The open plan's dinners that have no day yet. */
  unscheduled: Dinner[];
  /** The open plan is over and nothing covers today: time to start the next. */
  ended: boolean;
}

/** A plan in the history: the days that had a dinner or a note. */
export interface PlanSummary {
  id: number;
  from: string;
  to: string;
  current: boolean;
  closedAt: string | null;
  days: PlanDay[];
  /** Dinners it had that never got a day. */
  unscheduled: Dinner[];
}

/* ------------------------------------------------------------- Nemlig */

/** A Nemlig product as the Nemlig MCP describes it. */
export interface NemligProduct {
  id: string;
  name: string;
  price: number;
  inStock: boolean;
  deliverable: boolean;
  labels: string[];
  description?: string;
  brand?: string;
  offer?: { description: string; minQuantity?: number; offerPrice?: number };
  /** One of the account's frequently bought products. */
  favourite?: boolean;
}

/** One shopping line, and the product and number of packs proposed for it. */
export interface NemligPlanLine {
  lineId: number;
  itemId: number;
  name: string;
  /** What the list asks for, as shown on it ("1,5 kg"). */
  amount: string;
  product: NemligProduct | null;
  quantity: number;
  /** How the proposal was made, so the review can say how far to trust it. */
  source: 'remembered' | 'ai' | 'favourite' | 'first' | 'none';
  reason: string;
  /** Other products the search found, to switch to. */
  alternatives: NemligProduct[];
}

/**
 * How far Send to Nemlig has got, streamed while it works: every line
 * searched, the model choosing, and every product going into the basket.
 */
export type NemligProgress =
  | { type: 'searching'; total: number; names: string[] }
  | { type: 'searched'; name: string; found: number; done: number; total: number }
  | { type: 'choosing'; count: number }
  | { type: 'filling'; total: number; names: string[] }
  | { type: 'filled'; name: string; ok: boolean; done: number; total: number };

export interface NemligPlan {
  lines: NemligPlanLine[];
  /** Set when the model could not help and the proposals are plain guesses. */
  warning?: string;
}

export interface NemligApplyEntry {
  lineId: number;
  itemId: number;
  productId: string;
  productName: string;
  description: string;
  quantity: number;
}

export interface NemligApplyResult {
  results: Array<{
    productId: string;
    name: string;
    /** What the basket holds now. */
    quantity: number;
    /** What it held before, when that was already something. */
    previous: number;
    ok: boolean;
    error?: string;
  }>;
  basketTotal: number | null;
}

export interface Meta {
  version: string;
  builtAt: string | null;
  ai: { enabled: boolean; model: string | null };
  nemlig: { enabled: boolean };
  errorReporting: boolean;
}
