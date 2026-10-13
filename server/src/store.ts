import { categoryOrder, isCategory } from '../../shared/categories.js';
import type {
  Dinner,
  IngredientInput,
  Item,
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
        .all<{ id: number; name: string; category: string | null; notes: string; usage: number }>(
          `SELECT i.id, i.name, i.category, i.notes,
                  (SELECT COUNT(*) FROM recipe_ingredients r WHERE r.item_id = i.id)
                + (SELECT COUNT(*) FROM staple_entries s WHERE s.item_id = i.id) AS usage
             FROM items i`,
        )
        .sort(sortByAisle);
    },

    get(id: number): Item {
      const item = items.list().find((i) => i.id === id);
      if (!item) throw new NotFoundError('No such item');
      return item;
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

  const recipes = {
    list(): RecipeSummary[] {
      return db
        .all<RecipeRow & { ingredient_count: number }>(
          `SELECT r.*, (SELECT COUNT(*) FROM recipe_ingredients i WHERE i.recipe_id = r.id) AS ingredient_count
             FROM recipes r ORDER BY r.name COLLATE NOCASE`,
        )
        .map((r) => ({
          id: r.id,
          name: r.name,
          servings: r.servings,
          tags: parseTags(r.tags),
          ingredientCount: r.ingredient_count,
          updatedAt: r.updated_at,
        }));
    },

    get(id: number): Recipe {
      const r = db.get<RecipeRow>('SELECT * FROM recipes WHERE id = ?', id);
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
    if (line) db.run('UPDATE shop_lines SET checked = 0 WHERE id = ?', lineId);
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
        note: string;
      }>(
        `SELECT l.id, l.item_id, i.name, i.category, l.checked, l.note
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

    setChecked(lineId: number, checked: boolean): ShoppingList {
      if (!db.run('UPDATE shop_lines SET checked = ? WHERE id = ?', checked ? 1 : 0, lineId).changes) {
        throw new NotFoundError('No such line');
      }
      return shop.get();
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

    clear(onlyChecked: boolean): ShoppingList {
      db.run(onlyChecked ? 'DELETE FROM shop_lines WHERE checked = 1' : 'DELETE FROM shop_lines');
      return shop.get();
    },
  };

  /* ----------------------------------------------------------- dinners */

  interface DinnerRow {
    id: number;
    title: string;
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
    /** Still to cook first, in the order planned; then what has been cooked, latest first. */
    list(): Dinner[] {
      return db
        .all<DinnerRow>(`${DINNER_SQL} ORDER BY d.cooked_at IS NOT NULL, d.cooked_at DESC, d.position, d.id`)
        .map(toDinner);
    },

    get(id: number): Dinner {
      const row = db.get<DinnerRow>(`${DINNER_SQL} WHERE d.id = ?`, id);
      if (!row) throw new NotFoundError('No such dinner');
      return toDinner(row);
    },

    /** Plan a dinner. With a recipe, its ingredients go on the shopping list unless told otherwise. */
    add(input: { title?: string; recipeId?: number | null; servings?: number; note?: string; addToShop?: boolean }): Dinner {
      const recipe = input.recipeId ? recipes.get(input.recipeId) : null;
      const title = input.title?.trim() || recipe?.name;
      if (!title) throw new ConflictError('A dinner needs a title or a recipe');
      const id = db.tx(() => {
        const pos = db.get<{ p: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM dinners')!.p;
        const newId = db.run(
          'INSERT INTO dinners (title, recipe_id, servings, note, position) VALUES (?, ?, ?, ?, ?)',
          title,
          recipe?.id ?? null,
          input.servings ?? recipe?.servings ?? 4,
          input.note?.trim() ?? '',
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
      patch: { title?: string; recipeId?: number | null; servings?: number; note?: string; cooked?: boolean },
    ): Dinner {
      const before = dinners.get(id);
      db.tx(() => {
        if (patch.recipeId !== undefined && patch.recipeId !== null) recipes.get(patch.recipeId);
        db.run(
          'UPDATE dinners SET title = ?, recipe_id = ?, servings = ?, note = ?, cooked_at = ? WHERE id = ?',
          patch.title?.trim() || before.title,
          patch.recipeId !== undefined ? patch.recipeId : before.recipeId,
          patch.servings ?? before.servings,
          patch.note ?? before.note,
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

  return { items, recipes, lists, shop, dinners };
}

export type Store = ReturnType<typeof createStore>;
