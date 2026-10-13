import type { Amount } from './units';

/** Anything that can go on a shopping list: an ingredient, a product, a thing. */
export interface Item {
  id: number;
  name: string;
  /** Null until someone, or the AI, has put it in an aisle. */
  category: string | null;
  notes: string;
  /** How many recipes and lists use it — an item in use cannot be deleted. */
  usage: number;
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
  checked: boolean;
  note: string;
  /** The sources added up: one amount per kind of unit. */
  amounts: Amount[];
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
 * One of this week's dinners. Not a calendar: just what is planned, in the
 * order it was planned, until it is cooked.
 */
export interface Dinner {
  id: number;
  title: string;
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

export interface Meta {
  version: string;
  builtAt: string | null;
  ai: { enabled: boolean; model: string | null };
  errorReporting: boolean;
}
