import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { categoryLabel } from '../../../shared/categories';
import type { Dinner, ShopContributor, ShoppingLine } from '../../../shared/types';
import { formatAmount, formatAmounts } from '../../../shared/units';
import { api, type EntryInput } from '../api';
import { AddDinnerSheet } from '../components/AddDinnerSheet';
import { EntryDatalists } from '../components/EntryEditor';
import {
  DecimalInput,
  EmptyState,
  ErrorBanner,
  IconBook,
  IconCheck,
  IconCart,
  IconClose,
  IconList,
  IconPot,
  IconSparkle,
  IconTrash,
  Sheet,
  Spinner,
  useConfirm,
} from '../components/ui';
import { dayLabel } from '../days';
import { isTyping } from '../keys';
import {
  keys,
  useAiEnabled,
  useNemligEnabled,
  useDinnerMutation,
  useDinners,
  useLists,
  useRecipes,
  useShop,
  useShopMutation,
} from '../queries';
import { useWide } from '../useWide';

/** When this browser last asked Nemlig whether the basket was ordered. */
let lastOrderCheck = 0;

/**
 * Finish the shop by itself: while anything on the list is in the Nemlig
 * basket, look — when the list is opened, and again when it is come back
 * to, at most once a minute — whether that basket has been ordered. If it
 * has, the server clears what was done, and this says so.
 */
function useOrderCheck(hasBasket: boolean, onFinished: (cleared: number) => void) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!hasBasket) return;
    let live = true;
    const check = async () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastOrderCheck < 60_000) return;
      lastOrderCheck = Date.now();
      try {
        const res = await api.shop.checkOrder();
        if (!live || !res.ordered) return;
        qc.setQueryData(keys.shop, res.shop);
        onFinished(res.cleared);
      } catch {
        /* Nemlig or the server out of reach: the next look will do */
      }
    };
    void check();
    document.addEventListener('visibilitychange', check);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', check);
    };
  }, [hasBasket, qc, onFinished]);
}

export default function ShopPage() {
  const shop = useShop();
  const [finished, setFinished] = useState<number | null>(null);
  useOrderCheck(
    !!shop.data?.lines.some((l) => l.inBasket),
    useCallback((cleared: number) => setFinished(cleared), []),
  );
  const aiEnabled = useAiEnabled();
  const nemligEnabled = useNemligEnabled();
  const { confirm, dialog } = useConfirm();
  const wide = useWide();
  const quickAdd = useRef<HTMLInputElement>(null);

  // '/' jumps to the add field from anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !isTyping(e.target)) {
        e.preventDefault();
        quickAdd.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const [text, setText] = useState('');
  const [preview, setPreview] = useState<{ entries: EntryInput[]; warning?: string } | null>(null);
  const [picker, setPicker] = useState<'recipe' | 'list' | null>(null);
  const [editing, setEditing] = useState<ShoppingLine | null>(null);

  const addItems = useShopMutation(api.shop.addItems);
  // A line that is done either way — in stock or in the basket — goes back to get.
  const toggle = useShopMutation((line: ShoppingLine) =>
    api.shop.updateLine(line.id, { checked: !(line.checked || line.inBasket) }),
  );
  const removeRecipe = useShopMutation(api.shop.removeRecipe);
  const removeList = useShopMutation(api.shop.removeList);
  const removeDinner = useShopMutation(api.shop.removeDinner);
  const clear = useShopMutation(api.shop.clear);

  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<unknown>(null);

  /** Plain typing goes straight on the list; the AI button reads it first and asks. */
  const submit = async (useAi: boolean) => {
    const value = text.trim();
    if (!value) return;
    setParseError(null);
    setParsing(true);
    try {
      const parsed = await api.shop.parse(value, useAi);
      if (useAi || parsed.warning) {
        setPreview({ entries: parsed.entries, warning: parsed.warning });
      } else {
        await addItems.mutateAsync(parsed.entries);
      }
      setText('');
    } catch (err) {
      setParseError(err);
    } finally {
      setParsing(false);
    }
  };

  const lines = shop.data?.lines ?? [];
  const open = lines.filter((l) => !l.checked && !l.inBasket);
  const inBasket = lines.filter((l) => l.inBasket);
  const inStock = lines.filter((l) => l.checked);
  const done = [...inBasket, ...inStock];

  const groups = useMemo(() => {
    const map = new Map<string, ShoppingLine[]>();
    for (const line of open) {
      const key = line.category ?? 'other';
      map.set(key, [...(map.get(key) ?? []), line]);
    }
    return [...map.entries()];
  }, [open]);

  const takeOff = async (c: ShopContributor) => {
    const ok = await confirm({
      title: `Take “${c.label}” off the list?`,
      body: 'Its amounts are subtracted, and lines only it needed are removed.',
      confirmLabel: 'Take it off',
    });
    if (ok) ({ recipe: removeRecipe, list: removeList, dinner: removeDinner })[c.kind].mutate(c.refId);
  };

  const emptyAll = async () => {
    if (await confirm({ title: 'Empty the whole list?', confirmLabel: 'Empty it', danger: true })) {
      clear.mutate(false);
    }
  };

  return (
    <>
      <header className="header">
        <h1>
          Shopping{' '}
          {lines.length > 0 && (
            <span className="sub">
              {[
                `${open.length} to get`,
                inBasket.length && `${inBasket.length} in the Nemlig basket`,
                inStock.length && `${inStock.length} in stock`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          )}
        </h1>
        {nemligEnabled && open.length > 0 && (
          <Link className="btn btn--primary btn--sm" to="/shop/nemlig">
            <IconCart size={16} /> Send to Nemlig
          </Link>
        )}
        {wide && done.length > 0 && (
          <button className="btn btn--ghost btn--sm" onClick={() => clear.mutate(true)}>
            Clear {done.length} done
          </button>
        )}
        {wide && lines.length > 0 && (
          <button className="btn btn--quiet btn--sm" onClick={() => void emptyAll()}>
            Empty the list
          </button>
        )}
      </header>

      <main className="main shop">
        <div className="shop__list">
          {finished !== null && (
            <div className="banner banner--info row row--between" style={{ marginBottom: 12 }}>
              <span>
                Your Nemlig order has gone through, so the {finished} {finished === 1 ? 'line' : 'lines'} in the basket or
                already in stock came off the list.
                {lines.length > 0 && ' What was still to get is still here.'}
              </span>
              <button className="btn btn--quiet btn--sm btn--icon" onClick={() => setFinished(null)} aria-label="Dismiss">
                <IconClose size={16} />
              </button>
            </div>
          )}
          <EntryDatalists />
          <form
            className="quickadd"
            onSubmit={(e) => {
              e.preventDefault();
              void submit(false);
            }}
          >
            <input
              ref={quickAdd}
              className="input grow"
              list="item-names"
              placeholder={aiEnabled ? 'Add “mælk, 2 kg mel” or “noget til tacos”' : 'Add “mælk, 2 kg mel”'}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // Ctrl+Enter is the AI's turn; plain Enter adds as typed.
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && aiEnabled) {
                  e.preventDefault();
                  void submit(true);
                } else if (e.key === 'Escape') {
                  setText('');
                  e.currentTarget.blur();
                }
              }}
              enterKeyHint="done"
              aria-label="Add to the list"
              aria-keyshortcuts="/"
            />
            <button className="btn btn--primary" type="submit" disabled={!text.trim() || parsing}>
              Add
            </button>
            {aiEnabled && (
              <button
                className="btn btn--ai"
                type="button"
                disabled={!text.trim() || parsing}
                onClick={() => void submit(true)}
                aria-label="Let the AI read it"
                title="Let the AI read it — it can expand a dish into its ingredients (Ctrl+Enter)"
              >
                {parsing ? <span className="spinner spinner--inline" /> : <IconSparkle />}
                {wide && <span>Ask AI</span>}
              </button>
            )}
          </form>
          {wide && (
            <p className="tiny faint" style={{ margin: '6px 2px 0' }}>
              <kbd>/</kbd> to start typing · <kbd>Enter</kbd> adds as written
              {aiEnabled && (
                <>
                  {' '}
                  · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> lets the AI read it
                </>
              )}
            </p>
          )}
          <ErrorBanner error={parseError ?? addItems.error} />

          {!wide && (
            <>
              <div className="row" style={{ marginTop: 10 }}>
                <button className="btn btn--ghost grow" onClick={() => setPicker('recipe')}>
                  <IconPot size={18} /> Add a dinner
                </button>
                <button className="btn btn--ghost grow" onClick={() => setPicker('list')}>
                  <IconList size={18} /> Add a list
                </button>
              </div>
              {shop.data && shop.data.contributors.length > 0 && (
                <div className="contributors">
                  {shop.data.contributors.map((c) => (
                    <span className="chip chip--removable" key={`${c.kind}${c.refId}`}>
                      <ContributorIcon kind={c.kind} size={13} />
                      {c.label}
                      <button aria-label={`Take ${c.label} off the list`} onClick={() => void takeOff(c)}>
                        <IconClose size={14} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </>
          )}

          {shop.isLoading && <Spinner />}
          <ErrorBanner error={shop.error ?? toggle.error} />

          {shop.data && lines.length === 0 && (
            <EmptyState
              title="Nothing to buy"
              hint={wide ? 'Type above, or add a recipe or a list from the panel on the right.' : 'Type above, or add a recipe or one of your lists.'}
            />
          )}

          <div className="aisles">
            {groups.map(([category, rows]) => (
              <section key={category} className="aisle">
                <h2 className="section-title">{categoryLabel(category)}</h2>
                <div className="card card--flush">
                  {rows.map((line) => (
                    <LineRow key={line.id} line={line} onToggle={() => toggle.mutate(line)} onEdit={() => setEditing(line)} />
                  ))}
                </div>
              </section>
            ))}
          </div>

          {inBasket.length > 0 && (
            <section>
              <div className="row row--between">
                <h2 className="section-title">In the Nemlig basket</h2>
                {!wide && (
                  <button className="btn btn--quiet btn--sm" onClick={() => clear.mutate(true)}>
                    Clear {done.length} done
                  </button>
                )}
              </div>
              <div className="card card--flush basket">
                {inBasket.map((line) => (
                  <LineRow key={line.id} line={line} onToggle={() => toggle.mutate(line)} onEdit={() => setEditing(line)} />
                ))}
              </div>
            </section>
          )}

          {inStock.length > 0 && (
            <section>
              <div className="row row--between">
                <h2 className="section-title">Already in stock</h2>
                {!wide && inBasket.length === 0 && (
                  <button className="btn btn--quiet btn--sm" onClick={() => clear.mutate(true)}>
                    Clear {done.length} done
                  </button>
                )}
              </div>
              <div className="card card--flush basket">
                {inStock.map((line) => (
                  <LineRow key={line.id} line={line} onToggle={() => toggle.mutate(line)} onEdit={() => setEditing(line)} />
                ))}
              </div>
            </section>
          )}

          {!wide && lines.length > 0 && (
            <button className="btn btn--quiet btn--block" style={{ marginTop: 24 }} onClick={() => void emptyAll()}>
              Empty the list
            </button>
          )}
        </div>

        {wide && (
          <aside className="shop__side">
            <ShopPanel contributors={shop.data?.contributors ?? []} onTakeOff={(c) => void takeOff(c)} />
          </aside>
        )}
      </main>

      {preview && (
        <PreviewSheet
          entries={preview.entries}
          warning={preview.warning}
          onClose={() => setPreview(null)}
          onAdd={async (entries) => {
            await addItems.mutateAsync(entries);
            setPreview(null);
          }}
        />
      )}
      {picker === 'recipe' && <AddDinnerSheet onClose={() => setPicker(null)} />}
      {picker === 'list' && <ListPicker onClose={() => setPicker(null)} />}
      {editing && <LineSheet line={editing} onClose={() => setEditing(null)} />}
      {dialog}
    </>
  );
}

function LineRow({ line, onToggle, onEdit }: { line: ShoppingLine; onToggle: () => void; onEdit: () => void }) {
  const amount = formatAmounts(line.amounts);
  const reasons = [...new Set(line.sources.filter((s) => s.kind !== 'manual').map((s) => s.label))];
  const done = line.checked || line.inBasket;
  return (
    <div className={`line${done ? ' line--done' : ''}`}>
      <button
        className="line__tick"
        onClick={onToggle}
        aria-label={done ? `Put ${line.name} back on the list` : `${line.name} is already in stock`}
        title={done ? 'Put it back on the list' : 'Already in stock — tick it off'}
      >
        <span className="tick">
          {line.inBasket ? <IconCart size={14} /> : line.checked && <IconCheck size={16} />}
        </span>
      </button>
      <button className="line__body" onClick={onEdit}>
        <span className="line__name">
          {line.name}
          {amount && <span className="line__amount num"> · {amount}</span>}
        </span>
        {(reasons.length > 0 || line.note) && (
          <span className="line__meta truncate">{[line.note, reasons.join(', ')].filter(Boolean).join(' — ')}</span>
        )}
      </button>
    </div>
  );
}

function PreviewSheet({
  entries: initial,
  warning,
  onClose,
  onAdd,
}: {
  entries: EntryInput[];
  warning?: string;
  onClose: () => void;
  onAdd: (entries: EntryInput[]) => Promise<void>;
}) {
  const [picked, setPicked] = useState(() => initial.map(() => true));
  const [busy, setBusy] = useState(false);
  const chosen = initial.filter((_, i) => picked[i]);
  return (
    <Sheet title="Add these?" onClose={onClose}>
      <div className="stack">
        {warning && <div className="banner banner--warn">The AI could not help this time, so this is a plain reading. ({warning})</div>}
        {initial.map((e, i) => (
          <label key={i} className={`checkline${picked[i] ? ' checkline--on' : ''}`}>
            <input
              type="checkbox"
              checked={picked[i]}
              onChange={() => setPicked(picked.map((p, j) => (j === i ? !p : p)))}
            />
            <span className="grow">
              {e.name}
              {e.quantity !== null || e.unit ? (
                <span className="muted num"> · {formatAmount({ quantity: e.quantity, unit: e.unit })}</span>
              ) : null}
              {e.note && <span className="faint small"> — {e.note}</span>}
            </span>
          </label>
        ))}
        <button
          className="btn btn--primary btn--block btn--lg"
          disabled={!chosen.length || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onAdd(chosen);
            } finally {
              setBusy(false);
            }
          }}
        >
          Add {chosen.length} to the list
        </button>
      </div>
    </Sheet>
  );
}

function ListPicker({ onClose }: { onClose: () => void }) {
  const lists = useLists();
  const add = useShopMutation(api.shop.addList);
  return (
    <Sheet title="Add a list" onClose={onClose}>
      {lists.isLoading && <Spinner />}
      {lists.data?.length === 0 && (
        <EmptyState title="No lists yet" hint="Make one for the things you always buy." action={<Link className="btn btn--primary" to="/lists/new">New list</Link>} />
      )}
      <ErrorBanner error={add.error} />
      {!!lists.data?.length && (
        <div className="card card--flush">
          {lists.data.map((l) => (
            <button
              key={l.id}
              className="list__row"
              disabled={add.isPending}
              onClick={() => add.mutate(l.id, { onSuccess: onClose })}
            >
              <span className="grow">
                <span className="list__title">{l.name}</span>
                <span className="small muted truncate" style={{ display: 'block' }}>
                  {l.entries.map((e) => e.name).join(', ') || 'Empty'}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </Sheet>
  );
}

function LineSheet({ line, onClose }: { line: ShoppingLine; onClose: () => void }) {
  // Edit as one amount; with mixed units, the first is the one offered.
  const first = line.amounts[0] ?? { quantity: null, unit: '' };
  const [quantity, setQuantity] = useState<number | null>(first.quantity);
  const [unit, setUnit] = useState(first.unit);
  const [note, setNote] = useState(line.note);
  const update = useShopMutation(
    (fields: Parameters<typeof api.shop.updateLine>[1]) => api.shop.updateLine(line.id, fields),
  );
  const remove = useShopMutation(() => api.shop.removeLine(line.id));
  const amountChanged = quantity !== first.quantity || unit !== first.unit;

  return (
    <Sheet title={line.name} onClose={onClose}>
      <div className="stack">
        {line.sources.length > 0 && (
          <div className="sources">
            {line.sources.map((s) => (
              <div key={s.id} className="row row--between small">
                <span className="muted">{s.label}</span>
                <span className="num">{formatAmount({ quantity: s.quantity, unit: s.unit })}</span>
              </div>
            ))}
            {line.edited && (
              <div className="row row--between small">
                <span className="muted">Corrected by hand to</span>
                <span className="num">{formatAmounts(line.amounts)}</span>
              </div>
            )}
          </div>
        )}
        <div className="row">
          <div className="field grow">
            <label htmlFor="line-qty">Amount</label>
            <DecimalInput id="line-qty" className="input input--num" value={quantity} onChange={setQuantity} />
          </div>
          <div className="field" style={{ width: 110 }}>
            <label htmlFor="line-unit">Unit</label>
            <input id="line-unit" className="input" list="unit-names" value={unit} onChange={(e) => setUnit(e.target.value)} />
          </div>
        </div>
        {amountChanged && line.sources.length > 1 && (
          <p className="small faint" style={{ margin: 0 }}>
            The new amount stands in for what the recipes and lists asked for. They stay linked: taking one off
            the list goes back to adding up the rest.
          </p>
        )}
        <div className="field">
          <label htmlFor="line-note">Note</label>
          <input id="line-note" className="input" value={note} placeholder="Brand, size, “the organic one”…" onChange={(e) => setNote(e.target.value)} />
        </div>
        <ErrorBanner error={update.error ?? remove.error} />
        <button
          className="btn btn--primary btn--block"
          disabled={update.isPending}
          onClick={() =>
            update.mutate(
              { note, ...(amountChanged ? { amount: { quantity, unit } } : {}) },
              { onSuccess: onClose },
            )
          }
        >
          Save
        </button>
        <button className="btn btn--danger btn--block" onClick={() => remove.mutate(undefined, { onSuccess: onClose })}>
          <IconTrash /> Remove from the list
        </button>
      </div>
    </Sheet>
  );
}


function ContributorIcon({ kind, size }: { kind: ShopContributor['kind']; size: number }) {
  if (kind === 'dinner') return <IconPot size={size} />;
  if (kind === 'recipe') return <IconBook size={size} />;
  return <IconList size={size} />;
}

/**
 * The laptop layout's right-hand column: the week's dinners, then every
 * recipe and list ready to add in one click — no sheet to open first.
 * Planning a recipe here makes it a dinner, which puts its ingredients on.
 */
function ShopPanel({
  contributors,
  onTakeOff,
}: {
  contributors: ShopContributor[];
  onTakeOff: (c: ShopContributor) => void;
}) {
  const recipes = useRecipes();
  const lists = useLists();
  const dinners = useDinners();
  const { confirm, dialog } = useConfirm();
  const [filter, setFilter] = useState('');
  const [other, setOther] = useState('');
  const plan = useDinnerMutation(api.dinners.add);
  const removeDinner = useDinnerMutation((id: number) => api.dinners.remove(id));
  const addList = useShopMutation(api.shop.addList);
  const putOn = useShopMutation(api.shop.addDinner);

  const planned = dinners.data?.filter((d) => !d.cookedAt) ?? [];
  const cookedCount = (dinners.data?.length ?? 0) - planned.length;
  const plannedRecipe = (id: number) => planned.some((d) => d.recipeId === id);
  const listOnShop = (id: number) => contributors.some((c) => c.kind === 'list' && c.refId === id);
  // Dinners have their own section; this one is for whatever else put lines on the list.
  const others = contributors.filter((c) => c.kind !== 'dinner');
  const shown = (recipes.data ?? []).filter((r) => r.name.toLowerCase().includes(filter.trim().toLowerCase()));

  const remove = async (d: Dinner) => {
    const ok =
      !d.onShop ||
      (await confirm({
        title: `Remove “${d.title}”?`,
        body: 'Its ingredients come off the shopping list too.',
        confirmLabel: 'Remove dinner',
      }));
    if (ok) removeDinner.mutate(d.id);
  };

  return (
    <div className="stack">
      <section className="panel">
        <div className="row row--between">
          <h2 className="panel__title">This week’s dinners</h2>
          <Link className="tiny" to="/plan">
            Week plan
          </Link>
        </div>
        {planned.length === 0 && (
          <p className="small muted" style={{ margin: '2px 0 4px' }}>
            Nothing planned. Plan a recipe below.
          </p>
        )}
        {planned.map((d) => (
          <div key={d.id} className="panel__row">
            <IconPot size={15} />
            <span className="grow" style={{ minWidth: 0 }}>
              <span className="truncate" style={{ display: 'block' }}>
                {d.recipeId ? (
                  <Link className="panel__link" to={`/recipes/${d.recipeId}`}>
                    {d.title}
                  </Link>
                ) : (
                  d.title
                )}
              </span>
              {(d.day || !d.recipeId) && (
                <span className="tiny faint" style={{ display: 'block' }}>
                  {[d.day && dayLabel(d.day), !d.recipeId && 'No recipe'].filter(Boolean).join(' · ')}
                </span>
              )}
              {d.recipeId !== null && !d.onShop && (
                <button className="linkish tiny" disabled={putOn.isPending} onClick={() => putOn.mutate(d.id)}>
                  Not on the list — put it on
                </button>
              )}
            </span>
            <button className="btn btn--quiet btn--sm btn--icon" onClick={() => void remove(d)} title={`Remove ${d.title}`}>
              <IconClose size={16} />
            </button>
          </div>
        ))}
        <form
          className="row"
          style={{ marginTop: 4 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (other.trim()) plan.mutate({ title: other.trim(), addToShop: false }, { onSuccess: () => setOther('') });
          }}
        >
          <input
            className="input input--sm grow"
            placeholder="Something else: takeaway, rester…"
            value={other}
            onChange={(e) => setOther(e.target.value)}
          />
          <button className="btn btn--sm" disabled={!other.trim() || plan.isPending}>
            Add
          </button>
        </form>
        {cookedCount > 0 && (
          <p className="tiny faint" style={{ margin: 0 }}>
            {cookedCount} cooked — clear them from the Cook view.
          </p>
        )}
        <ErrorBanner error={plan.error ?? removeDinner.error ?? putOn.error} />
      </section>

      {others.length > 0 && (
        <section className="panel">
          <h2 className="panel__title">Also on the list</h2>
          {others.map((c) => (
            <div key={`${c.kind}${c.refId}`} className="panel__row">
              <ContributorIcon kind={c.kind} size={15} />
              <span className="grow truncate">{c.label}</span>
              <span className="tiny faint">{c.lines} lines</span>
              <button className="btn btn--quiet btn--sm btn--icon" onClick={() => onTakeOff(c)} title={`Take ${c.label} off the list`}>
                <IconClose size={16} />
              </button>
            </div>
          ))}
        </section>
      )}

      <section className="panel">
        <div className="row row--between">
          <h2 className="panel__title">Recipes</h2>
          <Link className="tiny" to="/recipes/new">
            New
          </Link>
        </div>
        {(recipes.data?.length ?? 0) > 6 && (
          <input className="input input--sm" type="search" placeholder="Find a recipe" value={filter} onChange={(e) => setFilter(e.target.value)} />
        )}
        {recipes.data?.length === 0 && <p className="small muted">No recipes yet.</p>}
        <div className="panel__scroll">
          {shown.map((r) => (
              <div key={r.id} className="panel__row">
                <Link to={`/recipes/${r.id}`} className="grow truncate panel__link">
                  {r.name}
                  {plannedRecipe(r.id) && <span className="tiny faint"> · planned</span>}
                </Link>
                <button
                  className="btn btn--sm"
                  disabled={plan.isPending}
                  onClick={() => plan.mutate({ recipeId: r.id })}
                  title={`Plan ${r.name} this week, and put its ingredients on the list`}
                >
                  Plan
                </button>
              </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="row row--between">
          <h2 className="panel__title">Lists</h2>
          <Link className="tiny" to="/lists/new">
            New
          </Link>
        </div>
        {lists.data?.length === 0 && <p className="small muted">No lists yet.</p>}
        {lists.data?.map((l) => (
          <div key={l.id} className="panel__row">
            <span className="grow" style={{ minWidth: 0 }}>
              <span className="truncate" style={{ display: 'block' }}>
                {l.name}
                {listOnShop(l.id) && <span className="tiny faint"> · on list</span>}
              </span>
              <span className="tiny faint truncate" style={{ display: 'block' }}>
                {l.entries.map((e) => e.name).join(', ') || 'Empty'}
              </span>
            </span>
            <button className="btn btn--sm" disabled={addList.isPending || !l.entries.length} onClick={() => addList.mutate(l.id)}>
              Add
            </button>
          </div>
        ))}
        <ErrorBanner error={addList.error} />
      </section>
      {dialog}
    </div>
  );
}
