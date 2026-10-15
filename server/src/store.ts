import { categoryOrder, isCategory } from '../../shared/categories.js';
import type {
  Dinner,
  IngredientInput,
  Item,
  RememberedProduct,
  LineSource,
  Recipe,
  RecipeIngredient,
  RecipeSummary,
  ShopContributor,
  ShoppingLine,
  ShoppingList,
  SourceKind,
  StapleList,
  StapleListEntry,
  WeekPlan,
} from '../../shared/types.js';
import { forShopping, normaliseUnit, scaleAmount, sumAmounts } from '../../shared/units.js';
import type { Db } from './db.js';

export class NotFoundError extends Error {
  readonly statusCode = 404;
}

export class ConflictError extends Error {
  readonly statusCode = 409;
}

/** An ingredient as the API accepts it: by name, with an optional aisle hint. */
export interface NamedEntry extends IngredientInput {
  category?: string | null;
}

export interface RecipeInput {
  name: string;
  servings: number;
  instructions: string;
  sourceUrl: string;
  notes: string;
  tags: string[];
  ingredients: NamedEntry[];
}

export interface StapleListInput {
  name: string;
  notes: string;
  entries: Array<{ name: string; quantity: number | null; unit: string; category?: string | null }>;
}

const now = () => new Date().toISOString();

/** "2026-10-15" + 3 → "2026-10-18". Plain calendar arithmetic, in UTC so no clock change shifts it. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "  mælk   " → "Mælk". The catalogue reads better with one capitalisation. */
export function cleanName(name: string): string {
  const collapsed = name.replace(/\s+/g, ' ').trim();
  return collapsed.charAt(0).toLocaleUpperCase('da-DK') + collapsed.slice(1);
}

const sortByAisle = <T extends { category: string | null; name: string }>(a: T, b: T) =>
  categoryOrder(a.category) - categoryOrder(b.category) || a.name.localeCompare(b.name, 'da');

export function createStore(db: Db, hooks: { onItemsCreated?: () => void } = {}) {
  /* ------------------------------------------------------------ items */

  const items = {
    list(): Item[] {
      return db
        .all<{
          id: number;
          name: string;
          category: string | null;
          notes: string;
          usage: number;
          recipes: number;
          lists: number;
          nemlig_product_id: string | null;
          nemlig_product_name: string | null;
          nemlig_description: string | null;
        }>(
          `SELECT i.id, i.name, i.category, i.notes,
                  i.nemlig_product_id, i.nemlig_product_name, i.nemlig_description,
                  (SELECT COUNT(*) FROM recipe_ingredients r WHERE r.item_id = i.id)
                + (SELECT COUNT(*) FROM staple_entries s WHERE s.item_id = i.id) AS usage,
                  (SELECT COUNT(DISTINCT r.recipe_id) FROM recipe_ingredients r WHERE r.item_id = i.id) AS recipes,
                  (SELECT COUNT(DISTINCT s.list_id) FROM staple_entries s WHERE s.item_id = i.id) AS lists
             FROM items i`,
        )
        .map(({ nemlig_product_id, nemlig_product_name, nemlig_description, ...item }) => ({
          ...item,
          nemlig: nemlig_product_id
            ? { productId: nemlig_product_id, name: nemlig_product_name ?? '', description: nemlig_description ?? '' }
            : null,
        }))
        .sort(sortByAisle);
    },

    /** Remember what an item was bought as at Nemlig, or forget it with null. */
    setNemlig(id: number, product: RememberedProduct | null): void {
      const { changes } = db.run(
        'UPDATE items SET nemlig_product_id = ?, nemlig_product_name = ?, nemlig_description = ? WHERE id = ?',
        product?.productId ?? null,
        product?.name ?? null,
        product?.description ?? null,
        id,
      );
      if (!changes) throw new NotFoundError('No such item');
    },

    get(id: number): Item {
      const item = items.list().find((i) => i.id === id);
      if (!item) throw new NotFoundError('No such item');
      return item;
    },

    /** The recipes and lists an item is on, by name, for the item's page. */
    uses(id: number): { recipes: Array<{ id: number; name: string }>; lists: Array<{ id: number; name: string }> } {
      items.get(id);
      return {
        recipes: db.all(
          `SELECT DISTINCT r.id, r.name FROM recipe_ingredients ri JOIN recipes r ON r.id = ri.recipe_id
            WHERE ri.item_id = ? ORDER BY r.name COLLATE NOCASE`,
          id,
        ),
        lists: db.all(
          `SELECT DISTINCT l.id, l.name FROM staple_entries e JOIN staple_lists l ON l.id = e.list_id
            WHERE e.item_id = ? ORDER BY l.name COLLATE NOCASE`,
          id,
        ),
      };
    },

    /**
     * The item with this name, made if it does not exist yet. Names match
     * without regard to case, so "mælk" finds "Mælk". A category is only ever
     * filled in, never overwritten — someone may have chosen it by hand.
     */
    ensure(name: string, category?: string | null): number {
      const clean = cleanName(name);
      if (!clean) throw new ConflictError('An item needs a name');
      const hint = isCategory(category) ? category : null;
      const existing = db.get<{ id: number; category: string | null }>(
        'SELECT id, category FROM items WHERE name = ?',
        clean,
      );
      if (existing) {
        if (hint && !existing.category) {
          db.run('UPDATE items SET category = ? WHERE id = ?', hint, existing.id);
        }
        return existing.id;
      }
      const id = db.run('INSERT INTO items (name, category) VALUES (?, ?)', clean, hint).lastInsertRowid;
      if (!hint) hooks.onItemsCreated?.();
      return id;
    },

    update(id: number, input: { name: string; category: string | null; notes: string }): Item {
      const clean = cleanName(input.name);
      const clash = db.get<{ id: number }>('SELECT id FROM items WHERE name = ? AND id <> ?', clean, id);
      if (clash) throw new ConflictError(`"${clean}" already exists — merge into it instead`);
      const { changes } = db.run(
        'UPDATE items SET name = ?, category = ?, notes = ? WHERE id = ?',
        clean,
        isCategory(input.category) ? input.category : null,
        input.notes,
        id,
      );
      if (!changes) throw new NotFoundError('No such item');
      return items.get(id);
    },

    remove(id: number): void {
      const item = items.get(id);
      if (item.usage > 0) {
        throw new ConflictError(`"${item.name}" is used by ${item.usage} recipe or list entries`);
      }
      db.run('DELETE FROM items WHERE id = ?', id);
    },

    /** Fold a duplicate into another item: every recipe, list and line follows. */
    merge(id: number, intoId: number): Item {
      if (id === intoId) throw new ConflictError('An item cannot be merged into itself');
      items.get(id);
      items.get(intoId);
      return db.tx(() => {
        db.run('UPDATE recipe_ingredients SET item_id = ? WHERE item_id = ?', intoId, id);
        db.run('UPDATE staple_entries SET item_id = ? WHERE item_id = ?', intoId, id);
        const from = db.get<{ id: number }>('SELECT id FROM shop_lines WHERE item_id = ?', id);
        const into = db.get<{ id: number }>('SELECT id FROM shop_lines WHERE item_id = ?', intoId);
        if (from && into) {
          db.run('UPDATE shop_sources SET line_id = ? WHERE line_id = ?', into.id, from.id);
          db.run('DELETE FROM shop_lines WHERE id = ?', from.id);
        } else if (from) {
          db.run('UPDATE shop_lines SET item_id = ? WHERE id = ?', intoId, from.id);
        }
        db.run('DELETE FROM items WHERE id = ?', id);
        return items.get(intoId);
      });
    },

    uncategorised(limit = 100): Array<{ id: number; name: string }> {
      return db.all('SELECT id, name FROM items WHERE category IS NULL ORDER BY id LIMIT ?', limit);
    },

    /** Fill in aisles; an item someone has categorised meanwhile is left alone. */
    fillCategories(assignments: Array<{ id: number; category: string }>): number {
      let changed = 0;
      db.tx(() => {
        for (const a of assignments) {
          if (!isCategory(a.category)) continue;
          changed += db.run(
            'UPDATE items SET category = ? WHERE id = ? AND category IS NULL',
            a.category,
            a.id,
          ).changes;
        }
      });
      return changed;
    },

    names(limit = 500): string[] {
      return db
        .all<{ name: string }>(
          `SELECT i.name FROM items i
             LEFT JOIN recipe_ingredients r ON r.item_id = i.id
             LEFT JOIN staple_entries s ON s.item_id = i.id
            GROUP BY i.id ORDER BY COUNT(r.id) + COUNT(s.id) DESC, i.name LIMIT ?`,
          limit,
        )
        .map((r) => r.name);
    },
  };

  /* ---------------------------------------------------------- recipes */

  interface RecipeRow {
    id: number;
    name: string;
    servings: number;
    instructions: string;
    source_url: string;
    notes: string;
    tags: string;
    created_at: string;
    updated_at: string;
  }

  const parseTags = (json: string): string[] => {
    try {
      const v: unknown = JSON.parse(json);
      return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
    } catch {
      return [];
    }
  };

  const cleanTags = (tags: string[]) => [
    ...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean)),
  ];

  function writeIngredients(recipeId: number, ingredients: NamedEntry[]) {
    db.run('DELETE FROM recipe_ingredients WHERE recipe_id = ?', recipeId);
    ingredients.forEach((ing, position) => {
      const itemId = items.ensure(ing.name, ing.category);
      db.run(
        `INSERT INTO recipe_ingredients (recipe_id, item_id, position, quantity, unit, note)
         VALUES (?, ?, ?, ?, ?, ?)`,
        recipeId,
        itemId,
        position,
        ing.quantity,
        normaliseUnit(ing.unit),
        ing.note.trim(),
      );
    });
  }

  /** The picture's address carries its version, so browsers can keep it forever. */
  const imageUrl = (id: number, version: string | null) =>
    version ? `/api/recipes/${id}/image?v=${encodeURIComponent(version)}` : null;

  const recipes = {
    list(): RecipeSummary[] {
      return db
        .all<RecipeRow & { ingredient_count: number; image_at: string | null }>(
          `SELECT r.*, (SELECT COUNT(*) FROM recipe_ingredients i WHERE i.recipe_id = r.id) AS ingredient_count,
                  (SELECT updated_at FROM recipe_images p WHERE p.recipe_id = r.id) AS image_at
             FROM recipes r ORDER BY r.name COLLATE NOCASE`,
        )
        .map((r) => ({
          id: r.id,
          name: r.name,
          servings: r.servings,
          tags: parseTags(r.tags),
          ingredientCount: r.ingredient_count,
          image: imageUrl(r.id, r.image_at),
          updatedAt: r.updated_at,
        }));
    },

    image(id: number): { mime: string; data: Uint8Array } {
      const row = db.get<{ mime: string; data: Uint8Array }>('SELECT mime, data FROM recipe_images WHERE recipe_id = ?', id);
      if (!row) throw new NotFoundError('That recipe has no picture');
      return row;
    },

    setImage(id: number, image: { mime: string; data: Uint8Array; sourceUrl?: string }): Recipe {
      recipes.get(id);
      db.run(
        `INSERT INTO recipe_images (recipe_id, mime, data, source_url, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (recipe_id) DO UPDATE SET mime = excluded.mime, data = excluded.data,
           source_url = excluded.source_url, updated_at = excluded.updated_at`,
        id,
        image.mime,
        image.data,
        image.sourceUrl ?? '',
        now(),
      );
      return recipes.get(id);
    },

    removeImage(id: number): Recipe {
      db.run('DELETE FROM recipe_images WHERE recipe_id = ?', id);
      return recipes.get(id);
    },

    get(id: number): Recipe {
      const r = db.get<RecipeRow & { image_at: string | null }>(
        `SELECT r.*, (SELECT updated_at FROM recipe_images p WHERE p.recipe_id = r.id) AS image_at
           FROM recipes r WHERE r.id = ?`,
        id,
      );
      if (!r) throw new NotFoundError('No such recipe');
      const ingredients = db
        .all<{
          id: number;
          item_id: number;
          name: string;
          category: string | null;
          quantity: number | null;
          unit: string;
          note: string;
        }>(
          `SELECT ri.id, ri.item_id, i.name, i.category, ri.quantity, ri.unit, ri.note
             FROM recipe_ingredients ri JOIN items i ON i.id = ri.item_id
            WHERE ri.recipe_id = ? ORDER BY ri.position`,
          id,
        )
        .map<RecipeIngredient>((x) => ({
          id: x.id,
          itemId: x.item_id,
          name: x.name,
          category: x.category,
          quantity: x.quantity,
          unit: x.unit,
          note: x.note,
        }));
      return {
        id: r.id,
        name: r.name,
        servings: r.servings,
        instructions: r.instructions,
        sourceUrl: r.source_url,
        notes: r.notes,
        tags: parseTags(r.tags),
        ingredients,
        image: imageUrl(r.id, r.image_at),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    },

    create(input: RecipeInput): Recipe {
      const id = db.tx(() => {
        const newId = db.run(
          `INSERT INTO recipes (name, servings, instructions, source_url, notes, tags)
           VALUES (?, ?, ?, ?, ?, ?)`,
          input.name.trim(),
          input.servings,
          input.instructions,
          input.sourceUrl.trim(),
          input.notes,
          JSON.stringify(cleanTags(input.tags)),
        ).lastInsertRowid;
        writeIngredients(newId, input.ingredients);
        return newId;
      });
      return recipes.get(id);
    },

    update(id: number, input: RecipeInput): Recipe {
      db.tx(() => {
        const { changes } = db.run(
          `UPDATE recipes SET name = ?, servings = ?, instructions = ?, source_url = ?, notes = ?,
                  tags = ?, updated_at = ? WHERE id = ?`,
          input.name.trim(),
          input.servings,
          input.instructions,
          input.sourceUrl.trim(),
          input.notes,
          JSON.stringify(cleanTags(input.tags)),
          now(),
          id,
        );
        if (!changes) throw new NotFoundError('No such recipe');
        writeIngredients(id, input.ingredients);
      });
      return recipes.get(id);
    },

    remove(id: number): void {
      db.tx(() => {
        if (!db.run('DELETE FROM recipes WHERE id = ?', id).changes) {
          throw new NotFoundError('No such recipe');
        }
        // Lines it put on the shop stay — they may already be in the trolley —
        // but they no longer point at a recipe that is gone.
        db.run("UPDATE shop_sources SET ref_id = NULL WHERE kind = 'recipe' AND ref_id = ?", id);
      });
    },
  };

  /* ----------------------------------------------------- staple lists */

  const lists = {
    all(): StapleList[] {
      const heads = db.all<{ id: number; name: string; notes: string }>(
        'SELECT id, name, notes FROM staple_lists ORDER BY position, name',
      );
      const entries = db.all<{
        id: number;
        list_id: number;
        item_id: number;
        name: string;
        category: string | null;
        quantity: number | null;
        unit: string;
      }>(
        `SELECT e.id, e.list_id, e.item_id, i.name, i.category, e.quantity, e.unit
           FROM staple_entries e JOIN items i ON i.id = e.item_id ORDER BY e.list_id, e.position`,
      );
      return heads.map((h) => ({
        ...h,
        entries: entries
          .filter((e) => e.list_id === h.id)
          .map<StapleListEntry>((e) => ({
            id: e.id,
            itemId: e.item_id,
            name: e.name,
            category: e.category,
            quantity: e.quantity,
            unit: e.unit,
          })),
      }));
    },

    get(id: number): StapleList {
      const list = lists.all().find((l) => l.id === id);
      if (!list) throw new NotFoundError('No such list');
      return list;
    },

    save(id: number | null, input: StapleListInput): StapleList {
      const name = input.name.trim();
      const clash = db.get<{ id: number }>(
        'SELECT id FROM staple_lists WHERE name = ? AND id IS NOT ?',
        name,
        id,
      );
      if (clash) throw new ConflictError(`There is already a list called "${name}"`);

      const listId = db.tx(() => {
        let target = id;
        if (target === null) {
          const pos = db.get<{ p: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM staple_lists')!.p;
          target = db.run(
            'INSERT INTO staple_lists (name, notes, position) VALUES (?, ?, ?)',
            name,
            input.notes,
            pos,
          ).lastInsertRowid;
        } else if (
          !db.run('UPDATE staple_lists SET name = ?, notes = ? WHERE id = ?', name, input.notes, target).changes
        ) {
          throw new NotFoundError('No such list');
        }
        db.run('DELETE FROM staple_entries WHERE list_id = ?', target);
        input.entries.forEach((e, position) => {
          db.run(
            'INSERT INTO staple_entries (list_id, item_id, position, quantity, unit) VALUES (?, ?, ?, ?, ?)',
            target,
            items.ensure(e.name, e.category),
            position,
            e.quantity,
            normaliseUnit(e.unit),
          );
        });
        return target;
      });
      return lists.get(listId);
    },

    remove(id: number): void {
      db.tx(() => {
        if (!db.run('DELETE FROM staple_lists WHERE id = ?', id).changes) {
          throw new NotFoundError('No such list');
        }
        db.run("UPDATE shop_sources SET ref_id = NULL WHERE kind = 'list' AND ref_id = ?", id);
      });
    },
  };

  /* ------------------------------------------------------ shopping list */

  interface Contribution {
    kind: SourceKind;
    refId: number | null;
    label: string;
    quantity: number | null;
    unit: string;
  }

  /** Put an item on the list for one more reason. Something already ticked off comes back. */
  function contribute(itemId: number, c: Contribution) {
    const line = db.get<{ id: number }>('SELECT id FROM shop_lines WHERE item_id = ?', itemId);
    const lineId = line
      ? line.id
      : db.run('INSERT INTO shop_lines (item_id) VALUES (?)', itemId).lastInsertRowid;
    if (line) db.run('UPDATE shop_lines SET checked = 0, in_basket = 0 WHERE id = ?', lineId);
    db.run(
      'INSERT INTO shop_sources (line_id, kind, ref_id, label, quantity, unit) VALUES (?, ?, ?, ?, ?, ?)',
      lineId,
      c.kind,
      c.refId,
      c.label,
      c.quantity,
      normaliseUnit(c.unit),
    );
  }

  const dropEmptyLines = () =>
    db.run('DELETE FROM shop_lines WHERE id NOT IN (SELECT DISTINCT line_id FROM shop_sources)');

  const shop = {
    get(): ShoppingList {
      const rows = db.all<{
        id: number;
        item_id: number;
        name: string;
        category: string | null;
        checked: number;
        in_basket: number;
        note: string;
      }>(
        `SELECT l.id, l.item_id, i.name, i.category, l.checked, l.in_basket, l.note
           FROM shop_lines l JOIN items i ON i.id = l.item_id`,
      );
      const sources = db.all<{
        id: number;
        line_id: number;
        kind: SourceKind;
        ref_id: number | null;
        label: string;
        quantity: number | null;
        unit: string;
      }>('SELECT * FROM shop_sources ORDER BY id');

      const byLine = new Map<number, LineSource[]>();
      for (const s of sources) {
        const list = byLine.get(s.line_id) ?? [];
        list.push({ id: s.id, kind: s.kind, refId: s.ref_id, label: s.label, quantity: s.quantity, unit: s.unit });
        byLine.set(s.line_id, list);
      }

      const lines = rows
        .map<ShoppingLine>((r) => {
          const lineSources = byLine.get(r.id) ?? [];
          return {
            id: r.id,
            itemId: r.item_id,
            name: r.name,
            category: r.category,
            checked: r.checked === 1,
            inBasket: r.in_basket === 1,
            note: r.note,
            amounts: sumAmounts(lineSources),
            sources: lineSources,
          };
        })
        .sort(sortByAisle);

      const contributors = db
        .all<{ kind: ShopContributor['kind']; ref_id: number; label: string; lines: number }>(
          `SELECT kind, ref_id, MAX(label) AS label, COUNT(DISTINCT line_id) AS lines
             FROM shop_sources WHERE kind IN ('recipe', 'list', 'dinner') AND ref_id IS NOT NULL
            GROUP BY kind, ref_id ORDER BY MIN(id)`,
        )
        .map<ShopContributor>((c) => ({ kind: c.kind, refId: c.ref_id, label: c.label, lines: c.lines }));

      return { lines, contributors };
    },

    /** Every ingredient, scaled from the recipe's servings to the ones wanted. */
    addRecipe(recipeId: number, servings?: number): ShoppingList {
      const recipe = recipes.get(recipeId);
      const want = servings ?? recipe.servings;
      const factor = recipe.servings > 0 ? want / recipe.servings : 1;
      const label = want === recipe.servings ? recipe.name : `${recipe.name} (${want} pers.)`;
      db.tx(() => {
        for (const ing of recipe.ingredients) {
          const scaled = forShopping(scaleAmount({ quantity: ing.quantity, unit: ing.unit }, factor));
          contribute(ing.itemId, { kind: 'recipe', refId: recipe.id, label, ...scaled });
        }
      });
      return shop.get();
    },

    /** A dinner's recipe, scaled to the dinner's servings. A dinner without a recipe adds nothing. */
    addDinner(dinnerId: number): ShoppingList {
      const dinner = dinners.get(dinnerId);
      if (dinner.recipeId === null) return shop.get();
      const recipe = recipes.get(dinner.recipeId);
      const factor = recipe.servings > 0 ? dinner.servings / recipe.servings : 1;
      const label = dinner.servings === recipe.servings ? dinner.title : `${dinner.title} (${dinner.servings} pers.)`;
      db.tx(() => {
        for (const ing of recipe.ingredients) {
          const scaled = forShopping(scaleAmount({ quantity: ing.quantity, unit: ing.unit }, factor));
          contribute(ing.itemId, { kind: 'dinner', refId: dinner.id, label, ...scaled });
        }
      });
      return shop.get();
    },

    addList(listId: number): ShoppingList {
      const list = lists.get(listId);
      db.tx(() => {
        for (const e of list.entries) {
          contribute(e.itemId, { kind: 'list', refId: list.id, label: list.name, quantity: e.quantity, unit: e.unit });
        }
      });
      return shop.get();
    },

    addItems(entries: NamedEntry[]): ShoppingList {
      db.tx(() => {
        for (const e of entries) {
          contribute(items.ensure(e.name, e.category), {
            kind: 'manual',
            refId: null,
            label: e.note.trim() || 'Added by hand',
            quantity: e.quantity,
            unit: e.unit,
          });
        }
      });
      return shop.get();
    },

    /** Take a recipe or list back off: its amounts go, and lines only it wanted go too. */
    removeContributor(kind: ShopContributor['kind'], refId: number): ShoppingList {
      db.tx(() => {
        db.run('DELETE FROM shop_sources WHERE kind = ? AND ref_id = ?', kind, refId);
        dropEmptyLines();
      });
      return shop.get();
    },

    /**
     * Tick a line off as already in stock, or put it back to get. Either way
     * it is no longer in the Nemlig basket as far as the list knows.
     */
    setChecked(lineId: number, checked: boolean): ShoppingList {
      if (!db.run('UPDATE shop_lines SET checked = ?, in_basket = 0 WHERE id = ?', checked ? 1 : 0, lineId).changes) {
        throw new NotFoundError('No such line');
      }
      return shop.get();
    },

    /** Send to Nemlig put this line's product in the basket. */
    setInBasket(lineId: number): void {
      if (!db.run('UPDATE shop_lines SET in_basket = 1, checked = 0 WHERE id = ?', lineId).changes) {
        throw new NotFoundError('No such line');
      }
    },

    /**
     * Correct a line by hand. A new amount replaces whatever the sources added
     * up to — the person standing at the shelf knows better.
     */
    updateLine(lineId: number, input: { note?: string; amount?: { quantity: number | null; unit: string } }) {
      db.tx(() => {
        const line = db.get<{ id: number }>('SELECT id FROM shop_lines WHERE id = ?', lineId);
        if (!line) throw new NotFoundError('No such line');
        if (input.note !== undefined) db.run('UPDATE shop_lines SET note = ? WHERE id = ?', input.note, lineId);
        if (input.amount) {
          db.run('DELETE FROM shop_sources WHERE line_id = ?', lineId);
          db.run(
            "INSERT INTO shop_sources (line_id, kind, ref_id, label, quantity, unit) VALUES (?, 'manual', NULL, 'Edited', ?, ?)",
            lineId,
            input.amount.quantity,
            normaliseUnit(input.amount.unit),
          );
        }
      });
      return shop.get();
    },

    removeLine(lineId: number): ShoppingList {
      if (!db.run('DELETE FROM shop_lines WHERE id = ?', lineId).changes) {
        throw new NotFoundError('No such line');
      }
      return shop.get();
    },

    /** Clear what is done — in stock or in the basket — or everything. */
    clear(onlyDone: boolean): ShoppingList {
      db.run(onlyDone ? 'DELETE FROM shop_lines WHERE checked = 1 OR in_basket = 1' : 'DELETE FROM shop_lines');
      return shop.get();
    },
  };

  /* ----------------------------------------------------------- dinners */

  interface DinnerRow {
    id: number;
    title: string;
    day: string | null;
    recipe_id: number | null;
    recipe_name: string | null;
    servings: number;
    note: string;
    cooked_at: string | null;
    created_at: string;
    on_shop: number;
  }

  const toDinner = (r: DinnerRow): Dinner => ({
    id: r.id,
    title: r.title,
    day: r.day,
    recipeId: r.recipe_id,
    recipeName: r.recipe_name,
    servings: r.servings,
    note: r.note,
    cookedAt: r.cooked_at,
    createdAt: r.created_at,
    onShop: r.on_shop === 1,
  });

  const DINNER_SQL = `SELECT d.*, r.name AS recipe_name,
      EXISTS (SELECT 1 FROM shop_sources s WHERE s.kind = 'dinner' AND s.ref_id = d.id) AS on_shop
    FROM dinners d LEFT JOIN recipes r ON r.id = d.recipe_id`;

  const dinners = {
    /**
     * Still to cook first — those with a day in day order, then the rest in
     * the order planned — and then what has been cooked, latest first.
     */
    list(): Dinner[] {
      return db
        .all<DinnerRow>(
          `${DINNER_SQL} ORDER BY d.cooked_at IS NOT NULL, d.cooked_at DESC, d.day IS NULL, d.day, d.position, d.id`,
        )
        .map(toDinner);
    },

    get(id: number): Dinner {
      const row = db.get<DinnerRow>(`${DINNER_SQL} WHERE d.id = ?`, id);
      if (!row) throw new NotFoundError('No such dinner');
      return toDinner(row);
    },

    /** Plan a dinner. With a recipe, its ingredients go on the shopping list unless told otherwise. */
    add(input: {
      title?: string;
      recipeId?: number | null;
      servings?: number;
      note?: string;
      day?: string | null;
      addToShop?: boolean;
    }): Dinner {
      const recipe = input.recipeId ? recipes.get(input.recipeId) : null;
      const title = input.title?.trim() || recipe?.name;
      if (!title) throw new ConflictError('A dinner needs a title or a recipe');
      const id = db.tx(() => {
        const pos = db.get<{ p: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM dinners')!.p;
        const newId = db.run(
          'INSERT INTO dinners (title, recipe_id, servings, note, day, position) VALUES (?, ?, ?, ?, ?, ?)',
          title,
          recipe?.id ?? null,
          input.servings ?? recipe?.servings ?? 4,
          input.note?.trim() ?? '',
          input.day ?? null,
          pos,
        ).lastInsertRowid;
        if (input.addToShop !== false) shop.addDinner(newId);
        return newId;
      });
      return dinners.get(id);
    },

    /**
     * Change a dinner. When it is on the list and its servings or recipe
     * change, its ingredients are taken off and put back at the new amounts.
     */
    update(
      id: number,
      patch: {
        title?: string;
        recipeId?: number | null;
        servings?: number;
        note?: string;
        day?: string | null;
        cooked?: boolean;
      },
    ): Dinner {
      const before = dinners.get(id);
      db.tx(() => {
        if (patch.recipeId !== undefined && patch.recipeId !== null) recipes.get(patch.recipeId);
        db.run(
          'UPDATE dinners SET title = ?, recipe_id = ?, servings = ?, note = ?, day = ?, cooked_at = ? WHERE id = ?',
          patch.title?.trim() || before.title,
          patch.recipeId !== undefined ? patch.recipeId : before.recipeId,
          patch.servings ?? before.servings,
          patch.note ?? before.note,
          patch.day !== undefined ? patch.day : before.day,
          patch.cooked === undefined ? before.cookedAt : patch.cooked ? (before.cookedAt ?? now()) : null,
          id,
        );
        const amountsChanged =
          (patch.servings !== undefined && patch.servings !== before.servings) ||
          (patch.recipeId !== undefined && patch.recipeId !== before.recipeId);
        if (before.onShop && amountsChanged) {
          shop.removeContributor('dinner', id);
          shop.addDinner(id);
        }
      });
      return dinners.get(id);
    },

    /** Its ingredients come off the list too, unless asked to keep them. */
    remove(id: number, keepOnShop = false): void {
      dinners.get(id);
      db.tx(() => {
        if (keepOnShop) {
          db.run("UPDATE shop_sources SET ref_id = NULL WHERE kind = 'dinner' AND ref_id = ?", id);
        } else {
          shop.removeContributor('dinner', id);
        }
        db.run('DELETE FROM dinners WHERE id = ?', id);
      });
    },

    /** A new week: what has been cooked goes. Anything it left on the list stays there. */
    clearCooked(): number {
      return db.tx(() => {
        db.run(
          `UPDATE shop_sources SET ref_id = NULL
            WHERE kind = 'dinner' AND ref_id IN (SELECT id FROM dinners WHERE cooked_at IS NOT NULL)`,
        );
        return db.run('DELETE FROM dinners WHERE cooked_at IS NOT NULL').changes;
      });
    },
  };

  /* ------------------------------------------------------ week planner */

  const plan = {
    /** `days` days from `from` (YYYY-MM-DD), each with its dinners and note. */
    get(from: string, days: number): WeekPlan {
      const dates = Array.from({ length: days }, (_, i) => addDays(from, i));
      const to = dates.at(-1)!;
      const dated = db
        .all<DinnerRow>(`${DINNER_SQL} WHERE d.day BETWEEN ? AND ? ORDER BY d.position, d.id`, from, to)
        .map(toDinner);
      const notes = new Map(
        db.all<{ day: string; note: string }>('SELECT day, note FROM day_notes WHERE day BETWEEN ? AND ?', from, to).map(
          (n) => [n.day, n.note],
        ),
      );
      return {
        days: dates.map((day) => ({ day, note: notes.get(day) ?? '', dinners: dated.filter((d) => d.day === day) })),
        unscheduled: db
          .all<DinnerRow>(`${DINNER_SQL} WHERE d.day IS NULL AND d.cooked_at IS NULL ORDER BY d.position, d.id`)
          .map(toDinner),
      };
    },

    /** An empty note is no note. */
    setNote(day: string, note: string): void {
      const text = note.trim();
      if (text) {
        db.run('INSERT INTO day_notes (day, note) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET note = excluded.note', day, text);
      } else {
        db.run('DELETE FROM day_notes WHERE day = ?', day);
      }
    },
  };

  return { items, recipes, lists, shop, dinners, plan };
}

export type Store = ReturnType<typeof createStore>;
