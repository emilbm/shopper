import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { formatAmount, scaleAmount } from '../../../shared/units';
import { api } from '../api';
import { Stepper } from '../components/EntryEditor';
import { ErrorBanner, IconBack, IconEdit, IconLink, IconPot, Spinner } from '../components/ui';
import { useDinnerMutation, useDinners, useRecipe } from '../queries';

export default function RecipePage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const recipe = useRecipe(id);
  const dinners = useDinners();
  const [servings, setServings] = useState<number | null>(null);
  const add = useDinnerMutation((n: number) => api.dinners.add({ recipeId: id, servings: n }));

  useEffect(() => {
    if (recipe.data && servings === null) setServings(recipe.data.servings);
  }, [recipe.data, servings]);

  const r = recipe.data;
  const want = servings ?? r?.servings ?? 1;
  const factor = r && r.servings > 0 ? want / r.servings : 1;
  const planned = dinners.data?.some((d) => d.recipeId === id && !d.cookedAt);

  return (
    <>
      <header className="header">
        <button className="btn btn--quiet btn--icon" onClick={() => navigate('/recipes')} aria-label="Back">
          <IconBack />
        </button>
        <h1>{r?.name ?? 'Recipe'}</h1>
        {r && (
          <Link className="btn btn--ghost btn--sm" to={`/recipes/${id}/edit`}>
            <IconEdit size={16} /> Edit
          </Link>
        )}
      </header>
      <main className="main">
        {recipe.isLoading && <Spinner />}
        <ErrorBanner error={recipe.error} />
        {r && (
          <div className="recipe-layout">
            <div className="stack recipe-layout__side">
            {(r.tags.length > 0 || r.sourceUrl) && (
              <div className="row row--wrap">
                {r.tags.map((t) => (
                  <span key={t} className="chip">
                    {t}
                  </span>
                ))}
                {r.sourceUrl && (
                  <a className="chip" href={r.sourceUrl} target="_blank" rel="noreferrer">
                    <IconLink size={13} /> {hostOf(r.sourceUrl)}
                  </a>
                )}
              </div>
            )}

            <div className="card stack">
              <div className="row row--between">
                <span className="muted">Servings</span>
                <Stepper label="Servings" value={want} onChange={setServings} />
              </div>
              <button
                className="btn btn--primary btn--block btn--lg"
                disabled={add.isPending}
                onClick={() => add.mutate(want)}
              >
                <IconPot size={20} /> {add.isSuccess ? 'Planned — plan it again?' : 'Plan for this week'}
              </button>
              {planned && !add.isSuccess && (
                <p className="small faint" style={{ margin: 0 }}>
                  Already planned this week. Planning it again puts a second batch on the list.
                </p>
              )}
              <ErrorBanner error={add.error} />
            </div>

            <h2 className="section-title">Ingredients</h2>
            <ul className="ingredients card">
              {r.ingredients.map((ing) => {
                const amount = formatAmount(scaleAmount({ quantity: ing.quantity, unit: ing.unit }, factor));
                return (
                  <li key={ing.id}>
                    <span className="ingredients__amount num">{amount}</span>
                    <span>
                      {ing.name}
                      {ing.note && <span className="muted">, {ing.note}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
            </div>

            <div className="stack recipe-layout__main">
            {r.instructions.trim() && (
              <>
                <h2 className="section-title">Method</h2>
                <div className="card method">{r.instructions}</div>
              </>
            )}
            {r.notes.trim() && (
              <>
                <h2 className="section-title">Notes</h2>
                <div className="card method">{r.notes}</div>
              </>
            )}
            {!r.instructions.trim() && !r.notes.trim() && (
              <p className="muted small">No method written down. <Link to={`/recipes/${id}/edit`}>Add one</Link>.</p>
            )}
            </div>
          </div>
        )}
      </main>
    </>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'source';
  }
}
