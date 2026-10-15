import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import type { Dinner, PlanDay, RecipeSummary } from '../../../shared/types';
import { api } from '../api';
import { ErrorBanner, IconCart, IconCheck, IconClose, IconMinus, IconPlus, IconPot, Spinner, useConfirm } from '../components/ui';
import { dayLabel, isWeekend, shortDate, today, weekday } from '../days';
import { useFillList, usePlanWindow, useStored } from '../planWindow';
import { keys, useDinnerMutation, usePlan, useRecipes } from '../queries';

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
 * The coming days, from tomorrow on, to decide what is for dinner on each. A day
 * holds dinners — a recipe, or just "Takeaway" — and a note for anything else
 * worth knowing ("football, eat early"). Planning a recipe puts its
 * ingredients on the shopping list, as everywhere else.
 */
export default function PlanPage() {
  const now = today();
  const range = usePlanWindow();
  const [fillList, setFillList] = useFillList();
  const [showRecipes, setShowRecipes] = useStored('grocer.plan.recipes', true);
  const plan = usePlan(range.from, range.count);
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

  /** The dinner on a day, if any: a day has at most one. */
  const dinnerOn = (day: string) => plan.data?.days.find((d) => d.day === day)?.dinners[0];

  /**
   * Drop handlers for a day, or for the "no day yet" tray when `day` is null.
   * A dinner dropped on a day that has one swaps places with it; a recipe can
   * only go on a free day.
   */
  const dropTarget = (day: string | null): DropProps => {
    const key = day ?? 'none';
    return {
      onDragOver: (e: DragEvent) => {
        const types = e.dataTransfer.types;
        if (!types.includes(DINNER) && !(types.includes(RECIPE) && day && !dinnerOn(day))) return;
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
        if (dinnerId) {
          const all = [...(plan.data?.days.flatMap((d) => d.dinners) ?? []), ...unscheduled];
          const from = all.find((d) => d.id === dinnerId)?.day ?? null;
          const there = day ? dinnerOn(day) : undefined;
          if (from === day) return;
          move.mutate({ id: dinnerId, day });
          if (there) move.mutate({ id: there.id, day: from });
        } else if (recipeId && day && !dinnerOn(day)) {
          add.mutate({ recipeId, day, addToShop: fillList });
        }
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
              {planned} of {range.count} days planned
            </span>
          )}
        </h1>
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
            <div className="row plan-more plan-more--top">
              {range.canAddBefore && (
                <button className="btn btn--ghost btn--sm" onClick={range.addBefore}>
                  <IconPlus size={16} /> Add a day before
                </button>
              )}
              {range.canRemove && (
                <button className="btn btn--quiet btn--sm" onClick={range.removeFirst}>
                  <IconMinus size={16} /> Remove the first day
                </button>
              )}
            </div>
          )}
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
              <button className="btn btn--ghost btn--sm" disabled={!range.canAddAfter} onClick={range.addAfter}>
                <IconPlus size={16} /> Add a day
              </button>
              {range.canRemove && (
                <button className="btn btn--quiet btn--sm" onClick={range.removeLast}>
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

  const submit = (value = text.trim()) => {
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
      className={`plan-day${isWeekend(day.day) ? ' plan-day--weekend' : ''}`}
      {...dropProps}
    >
      <h2 className="plan-day__head">
        <span className="plan-day__weekday">{weekday(day.day)}</span>
        <span className="plan-day__date">{shortDate(day.day)}</span>
      </h2>

      <div className="plan-day__body">
        <div className="plan-day__dinners">
          {day.dinners.map((d) => (
            <DinnerCard key={d.id} dinner={d} onDragStart={onDragStart} />
          ))}
        </div>

        {day.dinners.length === 0 && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <input
              className="input input--sm"
              list="plan-recipes"
              placeholder="What’s for dinner?"
              value={text}
              onChange={(e) => {
                const value = e.target.value;
                setText(value);
                // Picked from the suggestions rather than typed: plan it straight away.
                const native = e.nativeEvent as Event & { inputType?: string };
                const picked = !native.inputType || native.inputType === 'insertReplacementText';
                if (picked && recipes.some((r) => r.name === value)) submit(value);
              }}
              aria-label={`Dinner on ${dayLabel(day.day, now)}`}
              disabled={add.isPending}
            />
          </form>
        )}
        <ErrorBanner error={add.error} />
      </div>

      <NoteField day={day.day} note={day.note} label={dayLabel(day.day, now)} />
    </section>
  );
}

function DinnerCard({ dinner: d, onDragStart }: { dinner: Dinner; onDragStart: () => void }) {
  const { confirm, dialog } = useConfirm();
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
      <ErrorBanner error={remove.error ?? putOn.error} />
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
