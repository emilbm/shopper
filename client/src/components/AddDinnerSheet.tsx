import { useState } from 'react';
import { api } from '../api';
import { addDays, dayLabel, today } from '../days';
import { useDinnerMutation, useRecipes } from '../queries';
import { Stepper } from './EntryEditor';
import { ErrorBanner, IconCheck, Sheet, Spinner } from './ui';

/**
 * Plan a dinner: one of the recipes, or just a name ("Takeaway", "Rester").
 * A recipe's ingredients go on the shopping list too, unless unticked —
 * planning from the phone on the evening itself, they are already in the fridge.
 */
export function AddDinnerSheet({ onClose, defaultAddToShop = true }: { onClose: () => void; defaultAddToShop?: boolean }) {
  const recipes = useRecipes();
  const [mode, setMode] = useState<'recipe' | 'other'>('recipe');
  const [filter, setFilter] = useState('');
  const [chosen, setChosen] = useState<{ id: number; servings: number } | null>(null);
  const [title, setTitle] = useState('');
  const [addToShop, setAddToShop] = useState(defaultAddToShop);
  const [day, setDay] = useState('');
  const days = Array.from({ length: 9 }, (_, i) => addDays(today(), i));
  const add = useDinnerMutation(api.dinners.add);

  const shown = (recipes.data ?? []).filter((r) => r.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const ready = mode === 'recipe' ? chosen !== null : title.trim().length > 0;

  const submit = () =>
    add.mutate(
      mode === 'recipe' && chosen
        ? { recipeId: chosen.id, servings: chosen.servings, addToShop, day: day || null }
        : { title: title.trim(), addToShop: false, day: day || null },
      { onSuccess: onClose },
    );

  return (
    <Sheet title="Add a dinner" onClose={onClose}>
      <div className="stack">
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={mode === 'recipe'} className={mode === 'recipe' ? 'on' : ''} onClick={() => setMode('recipe')}>
            A recipe
          </button>
          <button role="tab" aria-selected={mode === 'other'} className={mode === 'other' ? 'on' : ''} onClick={() => setMode('other')}>
            Something else
          </button>
        </div>

        {mode === 'recipe' ? (
          <>
            {recipes.isLoading && <Spinner />}
            {recipes.data?.length === 0 && <p className="muted small">No recipes yet — add one from the Shop side.</p>}
            {(recipes.data?.length ?? 0) > 6 && (
              <input className="input" type="search" placeholder="Find a recipe" value={filter} onChange={(e) => setFilter(e.target.value)} />
            )}
            {!!recipes.data?.length && (
              <div className="card card--flush picker">
                {shown.map((r) => (
                  <button
                    key={r.id}
                    className={`list__row${chosen?.id === r.id ? ' list__row--on' : ''}`}
                    onClick={() => setChosen({ id: r.id, servings: r.servings })}
                  >
                    <span className="grow list__title">{r.name}</span>
                    {chosen?.id === r.id && <IconCheck />}
                  </button>
                ))}
              </div>
            )}
            {chosen && (
              <div className="row row--between">
                <span className="muted">Servings</span>
                <Stepper label="Servings" value={chosen.servings} onChange={(servings) => setChosen({ ...chosen, servings })} />
              </div>
            )}
            <label className={`checkline${addToShop ? ' checkline--on' : ''}`}>
              <input type="checkbox" checked={addToShop} onChange={(e) => setAddToShop(e.target.checked)} />
              <span>Put its ingredients on the shopping list</span>
            </label>
          </>
        ) : (
          <input
            className="input"
            placeholder="Takeaway, rester, grill hos naboen…"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && ready && submit()}
            autoFocus
          />
        )}

        <div className="field">
          <label htmlFor="dinner-day">Day</label>
          <select id="dinner-day" className="select" value={day} onChange={(e) => setDay(e.target.value)}>
            <option value="">No particular day</option>
            {days.map((d) => (
              <option key={d} value={d}>
                {dayLabel(d)}
              </option>
            ))}
          </select>
        </div>

        <ErrorBanner error={add.error} />
        <button className="btn btn--primary btn--block btn--lg" disabled={!ready || add.isPending} onClick={submit}>
          Add to this week
        </button>
      </div>
    </Sheet>
  );
}
