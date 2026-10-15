import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import type { Dinner, PlanDay, RecipeSummary } from '../../../shared/types';
import { api } from '../api';
import { ErrorBanner, IconCart, IconCheck, IconChevron, IconClose, IconMinus, IconPlus, IconPot, Spinner, useConfirm } from '../components/ui';
import { addDays, dayLabel, isWeekend, shortDate, today, weekday } from '../days';
import { keys, useDinnerMutation, usePlan, useRecipes } from '../queries';

/** As many days as the server hands out at once. */
const MAX_DAYS = 31;

/** Per-browser preferences: how many days to show, and whether planning fills the list. */
function useStored<T>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  });
  return [
    value,
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* private window: remembered for this visit only */
      }
    },
  ];
}

/** What a drop target spreads onto its element. */
interface DropProps {
  onDragOver: (e: DragEvent) => void;
  onDragLeave: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
  'data-over': true | undefined;
}

const DINNER = 'application/x-grocer-dinner';
const RECIPE = 'application/x-grocer-recipe';

/**
 * The coming days side by side, to decide what is for dinner on each. A day
 * holds dinners — a recipe, or just "Takeaway" — and a note for anything else
 * worth knowing ("football, eat early"). Planning a recipe puts its
 * ingredients on the shopping list, as everywhere else.
 */
export default function PlanPage() {
  const now = today();
  const [span, setSpan] = useStored('grocer.plan.days', 7);
  const [fillList, setFillList] = useStored('grocer.plan.fillList', true);
  const [showRecipes, setShowRecipes] = useStored('grocer.plan.recipes', true);
  const [offset, setOffset] = useState(0);
  const from = addDays(now, offset);
  const plan = usePlan(from, span);
  const recipes = useRecipes();
  const [over, setOver] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const add = useDinnerMutation(api.dinners.add);
  const move = useDinnerMutation((a: { id: number; day: string | null }) => api.dinners.update(a.id, { day: a.day }));

  useEffect(() => {
    const end = () => {
      setDragging(false);
      setOver(null);
    };
    document.addEventListener('dragend', end);
    document.addEventListener('drop', end);
    return () => {
      document.removeEventListener('dragend', end);
      document.removeEventListener('drop', end);
    };
  }, []);

  /** Drop handlers for a day, or for the "no day yet" tray when `day` is null. */
  const dropTarget = (day: string | null): DropProps => {
    const key = day ?? 'none';
    return {
      onDragOver: (e: DragEvent) => {
        if (![DINNER, RECIPE].some((t) => e.dataTransfer.types.includes(t))) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = e.dataTransfer.types.includes(DINNER) ? 'move' : 'copy';
        if (over !== key) setOver(key);
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === key ? null : o));
      },
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        setOver(null);
        const dinnerId = Number(e.dataTransfer.getData(DINNER));
        const recipeId = Number(e.dataTransfer.getData(RECIPE));
        if (dinnerId) move.mutate({ id: dinnerId, day });
        else if (recipeId) add.mutate({ recipeId, day, addToShop: fillList });
      },
      'data-over': over === key || undefined,
    };
  };

  const unscheduled = plan.data?.unscheduled ?? [];
  const planned = plan.data?.days.reduce((n, d) => n + d.dinners.length, 0) ?? 0;

  return (
    <>
      <header className="header plan-header">
        <h1>
          Week plan{' '}
          {plan.data && (
            <span className="sub">
              {planned} of {span} days planned
            </span>
          )}
        </h1>
        <div className="row plan-nav">
          <button className="btn btn--quiet btn--sm btn--icon" onClick={() => setOffset(offset - 1)} aria-label="One day earlier">
            <span className="flip">
              <IconChevron />
            </span>
          </button>
          <button className="btn btn--ghost btn--sm" disabled={offset === 0} onClick={() => setOffset(0)}>
            Today
          </button>
          <button className="btn btn--quiet btn--sm btn--icon" onClick={() => setOffset(offset + 1)} aria-label="One day later">
            <IconChevron />
          </button>
        </div>
        <button className="btn btn--ghost btn--sm plan-header__shelf" aria-pressed={showRecipes} onClick={() => setShowRecipes(!showRecipes)}>
          {showRecipes ? 'Hide recipes' : 'Show recipes'}
        </button>
      </header>

      <main className={`main plan${showRecipes ? ' plan--with-recipes' : ''}`}>
        <div className="plan__main">
          <div className="row row--wrap plan__bar">
            <label className={`checkline checkline--inline${fillList ? ' checkline--on' : ''}`}>
              <input type="checkbox" checked={fillList} onChange={(e) => setFillList(e.target.checked)} />
              <span>Planning a recipe puts its ingredients on the shopping list</span>
            </label>
            <Link className="btn btn--ghost btn--sm" to="/shop">
              <IconCart size={16} /> Shopping list
            </Link>
          </div>

          {plan.isLoading && <Spinner />}
          <ErrorBanner error={plan.error ?? add.error ?? move.error} />

          {(unscheduled.length > 0 || dragging) && (
            <section className="plan-tray" {...dropTarget(null)}>
              <h2 className="section-title">No day yet</h2>
              <div className="plan-tray__list">
                {unscheduled.map((d) => (
                  <DinnerChip key={d.id} dinner={d} onDragStart={() => setDragging(true)} />
                ))}
                {unscheduled.length === 0 && <p className="small faint" style={{ margin: 0 }}>Drop here to take a dinner off its day.</p>}
              </div>
            </section>
          )}

          <datalist id="plan-recipes">
            {recipes.data?.map((r) => <option key={r.id} value={r.name} />)}
          </datalist>

          {plan.data && (
            <div className="plan-days">
              {plan.data.days.map((d) => (
                <DayColumn
                  key={d.day}
                  day={d}
                  now={now}
                  recipes={recipes.data ?? []}
                  fillList={fillList}
                  dropProps={dropTarget(d.day)}
                  onDragStart={() => setDragging(true)}
                />
              ))}
            </div>
          )}
          {plan.data && (
            <div className="row plan-more">
              <button className="btn btn--ghost btn--sm" disabled={span >= MAX_DAYS} onClick={() => setSpan(Math.min(MAX_DAYS, span + 1))}>
                <IconPlus size={16} /> Add a day
              </button>
              {span > 1 && (
                <button className="btn btn--quiet btn--sm" onClick={() => setSpan(span - 1)}>
                  <IconMinus size={16} /> Remove the last day
                </button>
              )}
            </div>
          )}
          <p className="tiny faint" style={{ margin: '10px 2px 0' }}>
            Type a recipe’s name in a day — or anything else, like “Takeaway”. Drag dinners between days
            {showRecipes ? ', and recipes from the right onto a day' : ''}.
          </p>
        </div>

        {showRecipes && (
          <aside className="plan__recipes">
            <RecipeShelf recipes={recipes.data ?? []} onDragStart={() => setDragging(true)} />
          </aside>
        )}
      </main>
    </>
  );
}

function DayColumn({
  day,
  now,
  recipes,
  fillList,
  dropProps,
  onDragStart,
}: {
  day: PlanDay;
  now: string;
  recipes: RecipeSummary[];
  fillList: boolean;
  dropProps: DropProps;
  onDragStart: () => void;
}) {
  const [text, setText] = useState('');
  const add = useDinnerMutation(api.dinners.add);
  const past = day.day < now;

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    const recipe = recipes.find((r) => r.name.toLowerCase() === value.toLowerCase());
    add.mutate(
      recipe
        ? { recipeId: recipe.id, day: day.day, addToShop: fillList }
        : { title: value, day: day.day, addToShop: false },
      { onSuccess: () => setText('') },
    );
  };

  return (
    <section
      className={`plan-day${day.day === now ? ' plan-day--today' : ''}${isWeekend(day.day) ? ' plan-day--weekend' : ''}${past ? ' plan-day--past' : ''}`}
      {...dropProps}
    >
      <h2 className="plan-day__head">
        <span className="plan-day__weekday">{day.day === now ? 'Today' : weekday(day.day)}</span>
        <span className="plan-day__date">{shortDate(day.day)}</span>
      </h2>

      <div className="plan-day__body">
        <div className="plan-day__dinners">
          {day.dinners.map((d) => (
            <DinnerCard key={d.id} dinner={d} onDragStart={onDragStart} />
          ))}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            className="input input--sm"
            list="plan-recipes"
            placeholder={day.dinners.length ? 'Add another…' : 'What’s for dinner?'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label={`Dinner on ${dayLabel(day.day, now)}`}
            disabled={add.isPending}
          />
        </form>
        <ErrorBanner error={add.error} />
      </div>

      <NoteField day={day.day} note={day.note} label={dayLabel(day.day, now)} />
    </section>
  );
}

function DinnerCard({ dinner: d, onDragStart }: { dinner: Dinner; onDragStart: () => void }) {
  const { confirm, dialog } = useConfirm();
  const update = useDinnerMutation((servings: number) => api.dinners.update(d.id, { servings }));
  const remove = useDinnerMutation(() => api.dinners.remove(d.id));
  const putOn = useDinnerMutation(() => api.shop.addDinner(d.id));

  const drop = async () => {
    const ok =
      !d.onShop ||
      (await confirm({
        title: `Remove “${d.title}”?`,
        body: 'Its ingredients come off the shopping list too.',
        confirmLabel: 'Remove dinner',
      }));
    if (ok) remove.mutate(undefined);
  };

  return (
    <div
      className={`plan-dinner${d.cookedAt ? ' plan-dinner--cooked' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DINNER, String(d.id));
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
    >
      <div className="row plan-dinner__top">
        {d.cookedAt ? <IconCheck size={14} /> : <IconPot size={14} />}
        <span className="grow plan-dinner__title">
          {d.recipeId ? (
            <Link className="panel__link" to={`/recipes/${d.recipeId}`} draggable={false}>
              {d.title}
            </Link>
          ) : (
            d.title
          )}
        </span>
        <button className="btn btn--quiet btn--icon plan-dinner__remove" onClick={() => void drop()} aria-label={`Remove ${d.title}`}>
          <IconClose size={14} />
        </button>
      </div>
      {d.recipeId !== null && !d.cookedAt && (
        <div className="row plan-dinner__meta">
          <span className="mini-stepper num" title="Servings — the list follows">
            <button onClick={() => update.mutate(Math.max(1, d.servings - 1))} aria-label="Fewer servings">
              −
            </button>
            {d.servings}
            <button onClick={() => update.mutate(Math.min(99, d.servings + 1))} aria-label="More servings">
              +
            </button>
          </span>
          {d.onShop ? (
            <span className="tiny faint">on the list</span>
          ) : (
            <button className="linkish tiny" disabled={putOn.isPending} onClick={() => putOn.mutate(undefined)}>
              put it on the list
            </button>
          )}
        </div>
      )}
      {d.cookedAt && <span className="tiny faint">cooked</span>}
      <ErrorBanner error={update.error ?? remove.error ?? putOn.error} />
      {dialog}
    </div>
  );
}

function DinnerChip({ dinner: d, onDragStart }: { dinner: Dinner; onDragStart: () => void }) {
  return (
    <span
      className="chip plan-chip"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DINNER, String(d.id));
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      title="Drag onto a day"
    >
      <IconPot size={13} /> {d.title}
    </span>
  );
}

/** A day's note, saved when you leave the field. */
function NoteField({ day, note, label }: { day: string; note: string; label: string }) {
  const qc = useQueryClient();
  const [value, setValue] = useState(note);
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // A refetch must not overwrite what is being typed.
  useEffect(() => {
    if (!focused) setValue(note);
  }, [note, focused]);

  const save = async () => {
    setFocused(false);
    if (value.trim() === note.trim()) return;
    try {
      setError(null);
      await api.plan.setNote(day, value);
      await qc.invalidateQueries({ queryKey: keys.plan });
    } catch (err) {
      setError(err);
    }
  };

  return (
    <>
      <textarea
        className={`plan-note${value.trim() ? ' plan-note--set' : ''}`}
        placeholder="Note…"
        rows={value.split('\n').length > 1 ? 3 : 1}
        value={value}
        onFocus={() => setFocused(true)}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setValue(note);
            e.currentTarget.blur();
          }
        }}
        aria-label={`Note for ${label}`}
      />
      <ErrorBanner error={error} />
    </>
  );
}

function RecipeShelf({ recipes, onDragStart }: { recipes: RecipeSummary[]; onDragStart: () => void }) {
  const [filter, setFilter] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const q = filter.trim().toLowerCase();
  const tags = [...new Set(recipes.flatMap((r) => r.tags))].sort();
  const shown = recipes.filter((r) => r.name.toLowerCase().includes(q) && (!tag || r.tags.includes(tag)));

  return (
    <section className="panel plan-shelf">
      <h2 className="panel__title">Recipes</h2>
      <input className="input input--sm" type="search" placeholder="Find a recipe" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {tags.length > 1 && (
        <select className="select select--sm" value={tag ?? ''} onChange={(e) => setTag(e.target.value || null)} aria-label="Only this tag">
          <option value="">All tags</option>
          {tags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      )}
      <div className="plan-shelf__list">
        {shown.map((r) => (
          <div
            key={r.id}
            className="plan-shelf__row"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(RECIPE, String(r.id));
              e.dataTransfer.effectAllowed = 'copy';
              onDragStart();
            }}
            title="Drag onto a day"
          >
            <span className="plan-shelf__pic">
              {r.image ? <img src={r.image} alt="" loading="lazy" draggable={false} /> : <IconPot size={16} />}
            </span>
            <span className="grow truncate">{r.name}</span>
          </div>
        ))}
        {shown.length === 0 && <p className="small faint">Nothing matches.</p>}
      </div>
    </section>
  );
}
