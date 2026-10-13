import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { CATEGORIES, categoryLabel } from '../../../shared/categories';
import type { Item } from '../../../shared/types';
import { api } from '../api';
import { EmptyState, ErrorBanner, IconChevron, IconSparkle, IconTrash, Sheet, Spinner } from '../components/ui';
import { keys, useAiEnabled, useItems } from '../queries';

/**
 * The catalogue every recipe, list and shopping line points into. Mostly it
 * fills itself; this page is for tidying — fixing an aisle, merging
 * "Hvidløg" into "Hvidløgsfed" — rather than for typing items in.
 */
export default function ItemsPage() {
  const items = useItems();
  const aiEnabled = useAiEnabled();
  const qc = useQueryClient();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Item | null>(null);
  const [sorting, setSorting] = useState(false);
  const [sortResult, setSortResult] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const uncategorised = items.data?.filter((i) => !i.category).length ?? 0;

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, Item[]>();
    for (const item of items.data ?? []) {
      if (q && !item.name.toLowerCase().includes(q)) continue;
      const key = item.category ?? 'other';
      map.set(key, [...(map.get(key) ?? []), item]);
    }
    return [...map.entries()];
  }, [items.data, query]);

  const sortWithAi = async () => {
    setSorting(true);
    setError(null);
    setSortResult(null);
    try {
      const { categorised } = await api.items.categorise();
      setSortResult(categorised ? `Sorted ${categorised} items into aisles.` : 'Nothing could be sorted this time.');
      await qc.invalidateQueries({ queryKey: keys.items });
      await qc.invalidateQueries({ queryKey: keys.shop });
    } catch (err) {
      setError(err);
    } finally {
      setSorting(false);
    }
  };

  return (
    <>
      <header className="header">
        <h1>
          Items {items.data && <span className="sub">{items.data.length}</span>}
        </h1>
      </header>
      <main className="main">
        {items.isLoading && <Spinner />}
        <ErrorBanner error={items.error ?? error} />
        {items.data?.length === 0 && (
          <EmptyState title="No items yet" hint="Items appear here as you add recipes, lists and shopping." />
        )}
        {!!items.data?.length && (
          <div className="stack">
            <input className="input" type="search" placeholder="Find an item" value={query} onChange={(e) => setQuery(e.target.value)} />
            {aiEnabled && uncategorised > 0 && (
              <button className="btn btn--ai btn--block" disabled={sorting} onClick={() => void sortWithAi()}>
                <IconSparkle /> {sorting ? 'Sorting…' : `Sort ${uncategorised} unsorted into aisles`}
              </button>
            )}
            {sortResult && <div className="banner banner--info">{sortResult}</div>}
          </div>
        )}
        <div className="item-columns">
        {groups.map(([category, rows]) => (
          <section key={category}>
            <h2 className="section-title">{categoryLabel(category)}</h2>
            <div className="card card--flush">
              {rows.map((item) => (
                <button key={item.id} className="list__row list__row--compact" onClick={() => setEditing(item)}>
                  <span className="grow">
                    {item.name}
                    {!item.category && <span className="faint small"> · unsorted</span>}
                  </span>
                  {item.usage > 0 && <span className="small faint">{item.usage}×</span>}
                  <span className="chev">
                    <IconChevron />
                  </span>
                </button>
              ))}
            </div>
          </section>
        ))}
        </div>
      </main>
      {editing && <ItemSheet item={editing} all={items.data ?? []} onClose={() => setEditing(null)} />}
    </>
  );
}

function ItemSheet({ item, all, onClose }: { item: Item; all: Item[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(item.name);
  const [category, setCategory] = useState<string>(item.category ?? '');
  const [notes, setNotes] = useState(item.notes);
  const [mergeInto, setMergeInto] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      // Names and aisles show on every page.
      await qc.invalidateQueries();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const others = all.filter((i) => i.id !== item.id).sort((a, b) => a.name.localeCompare(b.name, 'da'));

  return (
    <Sheet title={item.name} onClose={onClose}>
      <div className="stack">
        <div className="field">
          <label htmlFor="i-name">Name</label>
          <input id="i-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="i-cat">Aisle</label>
          <select id="i-cat" className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Unsorted</option>
            {CATEGORIES.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="i-notes">Notes</label>
          <input id="i-notes" className="input" placeholder="Brand, size…" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <ErrorBanner error={error} />
        <button
          className="btn btn--primary btn--block"
          disabled={busy || !name.trim()}
          onClick={() => void run(() => api.items.update(item.id, { name, category: category || null, notes }))}
        >
          Save
        </button>

        {item.nemlig && (
          <>
            <h2 className="section-title">At Nemlig</h2>
            <div className="row">
              <span className="grow small">
                Bought as <strong>{item.nemlig.name}</strong>
                {item.nemlig.description && <span className="muted"> · {item.nemlig.description}</span>}
              </span>
              <button
                className="btn btn--sm"
                disabled={busy}
                onClick={() => void run(() => api.items.forgetNemlig(item.id))}
                title="The next Send to Nemlig searches for this item afresh"
              >
                Forget
              </button>
            </div>
          </>
        )}

        <h2 className="section-title">Duplicate?</h2>
        <div className="row">
          <select className="select grow" value={mergeInto} onChange={(e) => setMergeInto(e.target.value)} aria-label="Merge into">
            <option value="">Merge into…</option>
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <button
            className="btn"
            disabled={!mergeInto || busy}
            onClick={() => void run(() => api.items.merge(item.id, Number(mergeInto)))}
          >
            Merge
          </button>
        </div>
        <p className="small faint" style={{ margin: 0 }}>
          Every recipe, list and shopping line using “{item.name}” moves to the other item, and this one goes.
        </p>

        <button
          className="btn btn--danger btn--block"
          disabled={busy || item.usage > 0}
          onClick={() => void run(() => api.items.remove(item.id))}
        >
          <IconTrash /> {item.usage > 0 ? `Used ${item.usage}× — merge it instead` : 'Delete item'}
        </button>
      </div>
    </Sheet>
  );
}
