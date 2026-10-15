import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { methodSteps } from '../../../shared/method';
import type { Recipe } from '../../../shared/types';
import { formatAmount, scaleAmount } from '../../../shared/units';
import { api } from '../api';
import { ErrorBanner, IconBack, IconCheck, IconLink, Sheet, Spinner } from '../components/ui';
import { keys, useDinnerMutation, useRecipe, useRecipes } from '../queries';
import { useWakeLock } from '../useWakeLock';

interface Progress {
  tab: 'ingredients' | 'method';
  ingredients: number[];
  steps: number[];
}

const EMPTY: Progress = { tab: 'ingredients', ingredients: [], steps: [] };

/**
 * What has been ticked off survives the phone locking, a reload, or a glance
 * at a timer in another app. It is per phone, which is where the cooking is.
 */
function useProgress(dinnerId: number): [Progress, (p: Progress) => void] {
  const key = `grocer.cook.${dinnerId}`;
  const [progress, setProgress] = useState<Progress>(() => {
    try {
      return { ...EMPTY, ...(JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<Progress> | null) };
    } catch {
      return EMPTY;
    }
  });
  const save = (p: Progress) => {
    setProgress(p);
    try {
      localStorage.setItem(key, JSON.stringify(p));
    } catch {
      /* only a convenience */
    }
  };
  return [progress, save];
}

export default function CookDinnerPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const dinner = useQuery({ queryKey: [...keys.dinners, id], queryFn: () => api.dinners.get(id) });
  const recipe = useRecipe(dinner.data?.recipeId ?? null);
  const [progress, setProgress] = useProgress(id);
  const [linking, setLinking] = useState(false);
  const markCooked = useDinnerMutation((cooked: boolean) => api.dinners.update(id, { cooked }));

  useWakeLock(true);

  const d = dinner.data;
  const r = recipe.data;
  // Recipes are written for the household. A dinner planned at another size
  // before servings went away still cooks at the size it was bought for.
  const servings = d?.servings ?? r?.servings ?? 4;

  const toggle = (list: 'ingredients' | 'steps', value: number) => {
    const current = progress[list];
    setProgress({
      ...progress,
      [list]: current.includes(value) ? current.filter((v) => v !== value) : [...current, value],
    });
  };

  return (
    <>
      <header className="header cook-header">
        <button className="btn btn--quiet btn--icon" onClick={() => navigate('/cook')} aria-label="Back to this week">
          <IconBack />
        </button>
        <h1>{d?.title ?? 'Dinner'}</h1>
      </header>

      <main className="main main--cook main--cookbar">
        {(dinner.isLoading || recipe.isLoading) && <Spinner />}
        <ErrorBanner error={dinner.error ?? recipe.error} />

        {d && !d.recipeId && (
          <div className="stack">
            {d.note && <p className="cook-note">{d.note}</p>}
            <div className="empty" style={{ padding: '28px 8px' }}>
              <h2>No recipe for this one</h2>
              <p>Link one of your recipes to cook from it here.</p>
              <button className="btn btn--primary" onClick={() => setLinking(true)}>
                <IconLink /> Link a recipe
              </button>
            </div>
          </div>
        )}

        {d && r && (
          <CookRecipe
            recipe={r}
            note={d.note}
            servings={servings}
            progress={progress}
            onTab={(tab) => setProgress({ ...progress, tab })}
            onToggle={toggle}
          />
        )}
      </main>

      {d && (
        <footer className="cookbar">
          {d.cookedAt ? (
            <button className="btn btn--ghost btn--block btn--lg" disabled={markCooked.isPending} onClick={() => markCooked.mutate(false)}>
              <IconCheck /> Cooked — undo
            </button>
          ) : (
            <button
              className="btn btn--primary btn--block btn--lg"
              disabled={markCooked.isPending}
              onClick={() => markCooked.mutate(true, { onSuccess: () => navigate('/cook') })}
            >
              <IconCheck /> Mark as cooked
            </button>
          )}
        </footer>
      )}

      {linking && <LinkRecipeSheet dinnerId={id} onClose={() => setLinking(false)} />}
    </>
  );
}

function CookRecipe({
  recipe,
  note,
  servings,
  progress,
  onTab,
  onToggle,
}: {
  recipe: Recipe;
  note: string;
  servings: number;
  progress: Progress;
  onTab: (tab: Progress['tab']) => void;
  onToggle: (list: 'ingredients' | 'steps', value: number) => void;
}) {
  const factor = recipe.servings > 0 ? servings / recipe.servings : 1;
  const steps = methodSteps(recipe.instructions);
  const stepIndexes = steps.flatMap((s, i) => (s.kind === 'step' ? [i] : []));
  // The first step not yet done is where the cook is.
  const current = stepIndexes.find((i) => !progress.steps.includes(i));
  const gotCount = recipe.ingredients.filter((i) => progress.ingredients.includes(i.id)).length;

  return (
    <div className="stack">
      {note && <p className="cook-note">{note}</p>}

      <div className="segmented segmented--lg" role="tablist">
        <button role="tab" aria-selected={progress.tab === 'ingredients'} className={progress.tab === 'ingredients' ? 'on' : ''} onClick={() => onTab('ingredients')}>
          Ingredients <span className="faint num">{gotCount}/{recipe.ingredients.length}</span>
        </button>
        <button role="tab" aria-selected={progress.tab === 'method'} className={progress.tab === 'method' ? 'on' : ''} onClick={() => onTab('method')}>
          Method <span className="faint num">{progress.steps.filter((s) => stepIndexes.includes(s)).length}/{stepIndexes.length}</span>
        </button>
      </div>

      {progress.tab === 'ingredients' ? (
        <div className="card card--flush">
          {recipe.ingredients.map((ing) => {
            const got = progress.ingredients.includes(ing.id);
            const amount = formatAmount(scaleAmount({ quantity: ing.quantity, unit: ing.unit }, factor));
            return (
              <button key={ing.id} className={`cook-ing${got ? ' cook-ing--got' : ''}`} onClick={() => onToggle('ingredients', ing.id)}>
                <span className="tick">{got && <IconCheck size={15} />}</span>
                <span className="cook-ing__amount num">{amount}</span>
                <span className="cook-ing__name">
                  {ing.name}
                  {ing.note && <span className="muted">, {ing.note}</span>}
                </span>
              </button>
            );
          })}
          {recipe.ingredients.length === 0 && <p className="muted small" style={{ padding: 14, margin: 0 }}>No ingredients written down.</p>}
        </div>
      ) : (
        <div className="steps">
          {steps.length === 0 && <p className="muted">No method written down for this recipe.</p>}
          {steps.map((s, i) =>
            s.kind === 'heading' ? (
              <h3 key={i} className="steps__heading">
                {s.text}
              </h3>
            ) : (
              <button
                key={i}
                className={`step${progress.steps.includes(i) ? ' step--done' : ''}${i === current ? ' step--current' : ''}`}
                onClick={() => onToggle('steps', i)}
              >
                <span className="step__no num">{progress.steps.includes(i) ? <IconCheck size={16} /> : stepIndexes.indexOf(i) + 1}</span>
                <span className="step__text">{s.text}</span>
              </button>
            ),
          )}
          {recipe.notes.trim() && <p className="cook-note">{recipe.notes}</p>}
        </div>
      )}

      {recipe.sourceUrl && (
        <a className="small muted" href={recipe.sourceUrl} target="_blank" rel="noreferrer" style={{ textAlign: 'center' }}>
          Original recipe <IconLink size={13} />
        </a>
      )}
      <Link className="small faint" to={`/recipes/${recipe.id}`} style={{ textAlign: 'center' }}>
        Open in Shop to edit
      </Link>
    </div>
  );
}

function LinkRecipeSheet({ dinnerId, onClose }: { dinnerId: number; onClose: () => void }) {
  const recipes = useRecipes();
  const link = useDinnerMutation((recipeId: number) => api.dinners.update(dinnerId, { recipeId }));
  return (
    <Sheet title="Link a recipe" onClose={onClose}>
      {recipes.isLoading && <Spinner />}
      <ErrorBanner error={link.error} />
      <div className="card card--flush picker">
        {recipes.data?.map((r) => (
          <button key={r.id} className="list__row" disabled={link.isPending} onClick={() => link.mutate(r.id, { onSuccess: onClose })}>
            <span className="grow list__title">{r.name}</span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}
