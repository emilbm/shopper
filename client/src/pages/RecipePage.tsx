import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { formatAmount, scaleAmount } from '../../../shared/units';
import { Stepper } from '../components/EntryEditor';
import { PlanRecipeSheet } from '../components/PlanRecipeSheet';
import { ErrorBanner, IconBack, IconEdit, IconLink, IconPot, Spinner } from '../components/ui';
import { dayLabel } from '../days';
import { useDinners, useRecipe } from '../queries';

export default function RecipePage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const recipe = useRecipe(id);
  const dinners = useDinners();
  const [servings, setServings] = useState<number | null>(null);
  const [choosingDay, setChoosingDay] = useState(false);

  useEffect(() => {
    if (recipe.data && servings === null) setServings(recipe.data.servings);
  }, [recipe.data, servings]);

  const r = recipe.data;
  const want = servings ?? r?.servings ?? 1;
  const factor = r && r.servings > 0 ? want / r.servings : 1;
  const planned = dinners.data?.filter((d) => d.recipeId === id && !d.cookedAt) ?? [];

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
            {r.image ? (
              <img className="recipe-hero" src={r.image} alt={r.name} />
            ) : (
              <Link className="recipe-hero recipe-hero--empty" to={`/recipes/${id}/edit`}>
                <IconPot size={22} /> Add a picture
              </Link>
            )}
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
              <button className="btn btn--primary btn--block btn--lg" onClick={() => setChoosingDay(true)}>
                <IconPot size={20} /> {planned.length ? 'Plan it on another day…' : 'Plan it on a day…'}
              </button>
              {planned.length > 0 && (
                <p className="small muted" style={{ margin: 0 }}>
                  Planned for{' '}
                  {planned.map((d) => (d.day ? dayLabel(d.day) : 'this week, no day yet')).join(', ')}.{' '}
                  <Link to="/plan">Week plan</Link>
                </p>
              )}
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
      {choosingDay && r && (
        <PlanRecipeSheet
          recipeId={r.id}
          name={r.name}
          servings={want}
          onClose={() => setChoosingDay(false)}
          onPlanned={() => setChoosingDay(false)}
        />
      )}
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
