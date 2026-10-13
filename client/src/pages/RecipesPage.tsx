import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState, ErrorBanner, IconChevron, IconPlus, IconSparkle, Spinner } from '../components/ui';
import { useAiEnabled, useRecipes } from '../queries';

export default function RecipesPage() {
  const recipes = useRecipes();
  const aiEnabled = useAiEnabled();
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | null>(null);

  const tags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of recipes.data ?? []) for (const t of r.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  }, [recipes.data]);

  const shown = (recipes.data ?? []).filter(
    (r) => r.name.toLowerCase().includes(query.trim().toLowerCase()) && (!tag || r.tags.includes(tag)),
  );

  return (
    <>
      <header className="header">
        <h1>Recipes</h1>
        <Link className="btn btn--ghost btn--sm" to="/recipes/import">
          {aiEnabled && <IconSparkle size={15} />} Import
        </Link>
        <Link className="btn btn--primary btn--sm" to="/recipes/new">
          <IconPlus size={16} /> New
        </Link>
      </header>
      <main className="main">
        {recipes.isLoading && <Spinner />}
        <ErrorBanner error={recipes.error} />
        {recipes.data?.length === 0 && (
          <EmptyState
            title="No recipes yet"
            hint="Type one in, or import it from a web page or pasted text."
            action={
              <Link className="btn btn--primary" to="/recipes/import">
                Import a recipe
              </Link>
            }
          />
        )}
        {!!recipes.data?.length && (
          <div className="stack">
            <input className="input" type="search" placeholder="Find a recipe" value={query} onChange={(e) => setQuery(e.target.value)} />
            {tags.length > 0 && (
              <div className="row row--wrap">
                {tags.map((t) => (
                  <button key={t} className={`chip chip--button${tag === t ? ' chip--accent' : ''}`} onClick={() => setTag(tag === t ? null : t)}>
                    {t}
                  </button>
                ))}
              </div>
            )}
            <div className="card card--flush recipe-grid">
              {shown.map((r) => (
                <Link key={r.id} to={`/recipes/${r.id}`} className="list__row">
                  <span className="grow">
                    <span className="list__title">{r.name}</span>
                    <span className="small muted" style={{ display: 'block' }}>
                      {r.servings} servings · {r.ingredientCount} ingredients
                      {r.tags.length ? ` · ${r.tags.join(', ')}` : ''}
                    </span>
                  </span>
                  <span className="chev">
                    <IconChevron />
                  </span>
                </Link>
              ))}
              {shown.length === 0 && <p className="muted small" style={{ padding: 14, margin: 0 }}>Nothing matches.</p>}
            </div>
          </div>
        )}
      </main>
    </>
  );
}
