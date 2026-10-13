/**
 * Aisles, in roughly the order a Danish supermarket walks them. The shopping
 * list is grouped and sorted by this order, so the list reads front to back
 * the way the shop does.
 */
export const CATEGORIES = [
  { key: 'produce', label: 'Fruit & veg' },
  { key: 'bakery', label: 'Bread & bakery' },
  { key: 'meat', label: 'Meat & fish' },
  { key: 'dairy', label: 'Dairy, cheese & eggs' },
  { key: 'chilled', label: 'Chilled & deli' },
  { key: 'pantry', label: 'Pasta, rice & tins' },
  { key: 'baking', label: 'Baking' },
  { key: 'spices', label: 'Spices, oils & sauces' },
  { key: 'breakfast', label: 'Breakfast & spreads' },
  { key: 'frozen', label: 'Frozen' },
  { key: 'drinks', label: 'Drinks' },
  { key: 'snacks', label: 'Snacks & sweets' },
  { key: 'household', label: 'Household' },
  { key: 'personal', label: 'Personal care' },
  { key: 'other', label: 'Other' },
] as const;

export type Category = (typeof CATEGORIES)[number]['key'];

export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key) as [Category, ...Category[]];

const ORDER = new Map<string, number>(CATEGORIES.map((c, i) => [c.key, i]));
const LABELS = new Map<string, string>(CATEGORIES.map((c) => [c.key, c.label]));

export function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && ORDER.has(value);
}

/** Uncategorised items sort with "other", at the end. */
export function categoryOrder(category: string | null): number {
  return ORDER.get(category ?? 'other') ?? CATEGORIES.length;
}

export function categoryLabel(category: string | null): string {
  return LABELS.get(category ?? 'other') ?? 'Other';
}
