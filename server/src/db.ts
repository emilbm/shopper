import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

/**
 * Storage is a single SQLite file. A household's recipes and lists come to
 * kilobytes, so a file on a mounted volume is the right size of tool, and
 * Node's built-in driver means no native module to compile.
 */

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface Db {
  all<T>(sql: string, ...params: SQLInputValue[]): T[];
  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined;
  run(sql: string, ...params: SQLInputValue[]): RunResult;
  /** Run `fn` inside a transaction, rolling back if it throws. Nests safely. */
  tx<T>(fn: () => T): T;
  close(): void;
}

/**
 * Migrations are applied in order and tracked by `user_version`, so an existing
 * volume upgrades in place on restart. Only ever append to this list.
 */
const MIGRATIONS: string[] = [
  // 1 — initial schema
  `
  CREATE TABLE items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
    category   TEXT,
    notes      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE recipes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    servings     INTEGER NOT NULL DEFAULT 4,
    instructions TEXT NOT NULL DEFAULT '',
    source_url   TEXT NOT NULL DEFAULT '',
    notes        TEXT NOT NULL DEFAULT '',
    tags         TEXT NOT NULL DEFAULT '[]',
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- An item in a recipe cannot be deleted out from under it.
  CREATE TABLE recipe_ingredients (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    item_id   INTEGER NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    position  INTEGER NOT NULL,
    quantity  REAL,
    unit      TEXT NOT NULL DEFAULT '',
    note      TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX idx_recipe_ingredients_recipe ON recipe_ingredients(recipe_id, position);
  CREATE INDEX idx_recipe_ingredients_item ON recipe_ingredients(item_id);

  CREATE TABLE staple_lists (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT NOT NULL COLLATE NOCASE UNIQUE,
    notes    TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE staple_entries (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id  INTEGER NOT NULL REFERENCES staple_lists(id) ON DELETE CASCADE,
    item_id  INTEGER NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    position INTEGER NOT NULL,
    quantity REAL,
    unit     TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX idx_staple_entries_list ON staple_entries(list_id, position);
  CREATE INDEX idx_staple_entries_item ON staple_entries(item_id);

  -- The shopping list: one line per item, however many reasons it is there.
  CREATE TABLE shop_lines (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id    INTEGER NOT NULL UNIQUE REFERENCES items(id) ON DELETE CASCADE,
    checked    INTEGER NOT NULL DEFAULT 0,
    note       TEXT NOT NULL DEFAULT '',
    added_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Each reason a line is there. Taking a recipe back off the list removes its
  -- sources, and a line left with none goes with them.
  CREATE TABLE shop_sources (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    line_id  INTEGER NOT NULL REFERENCES shop_lines(id) ON DELETE CASCADE,
    kind     TEXT NOT NULL CHECK (kind IN ('recipe', 'list', 'manual')),
    ref_id   INTEGER,
    label    TEXT NOT NULL DEFAULT '',
    quantity REAL,
    unit     TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX idx_shop_sources_line ON shop_sources(line_id);
  CREATE INDEX idx_shop_sources_ref ON shop_sources(kind, ref_id);
  `,

  // 2 — this week's dinners, and dinners as a reason something is on the list
  `
  CREATE TABLE dinners (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    -- A dinner can be "Takeaway"; and deleting a recipe keeps the dinner.
    recipe_id  INTEGER REFERENCES recipes(id) ON DELETE SET NULL,
    servings   INTEGER NOT NULL DEFAULT 4,
    note       TEXT NOT NULL DEFAULT '',
    position   INTEGER NOT NULL DEFAULT 0,
    cooked_at  TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX idx_dinners_recipe ON dinners(recipe_id);

  -- SQLite cannot widen a CHECK constraint in place, so the table is rebuilt.
  CREATE TABLE shop_sources_v2 (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    line_id  INTEGER NOT NULL REFERENCES shop_lines(id) ON DELETE CASCADE,
    kind     TEXT NOT NULL CHECK (kind IN ('recipe', 'list', 'manual', 'dinner')),
    ref_id   INTEGER,
    label    TEXT NOT NULL DEFAULT '',
    quantity REAL,
    unit     TEXT NOT NULL DEFAULT ''
  );
  INSERT INTO shop_sources_v2 SELECT id, line_id, kind, ref_id, label, quantity, unit FROM shop_sources;
  DROP TABLE shop_sources;
  ALTER TABLE shop_sources_v2 RENAME TO shop_sources;
  CREATE INDEX idx_shop_sources_line ON shop_sources(line_id);
  CREATE INDEX idx_shop_sources_ref ON shop_sources(kind, ref_id);
  `,
];

export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  // Prepared statements are cached; the same handful of queries runs over and over.
  const cache = new Map<string, StatementSync>();
  const stmt = (sql: string): StatementSync => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };

  let depth = 0;

  const api: Db = {
    // The driver hands back `Record<string, SQLOutputValue>`; callers know
    // their own row shapes, so the cast lives here rather than at every call.
    all: <T>(sql: string, ...params: SQLInputValue[]) => stmt(sql).all(...params) as unknown as T[],
    get: <T>(sql: string, ...params: SQLInputValue[]) =>
      stmt(sql).get(...params) as unknown as T | undefined,
    run: (sql, ...params) => {
      const r = stmt(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    tx: <T>(fn: () => T): T => {
      if (depth > 0) return fn();
      depth += 1;
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        depth -= 1;
      }
    },
    close: () => db.close(),
  };

  const { user_version: current } = api.get<{ user_version: number }>('PRAGMA user_version')!;
  for (let v = current; v < MIGRATIONS.length; v += 1) {
    api.tx(() => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }

  return api;
}
