import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Dinner } from '../../../shared/types';
import { api } from '../api';
import { AddDinnerSheet } from '../components/AddDinnerSheet';
import { EmptyState, ErrorBanner, IconCart, IconCheck, IconChevron, IconPlus, Spinner, useConfirm } from '../components/ui';
import { dayLabel } from '../days';
import { useDinnerMutation, useDinners } from '../queries';

/** "Tirsdag" for something cooked this week, a date for anything older. */
function cookedWhen(iso: string): string {
  const d = new Date(iso);
  const days = (Date.now() - d.getTime()) / 86_400_000;
  return days < 6
    ? d.toLocaleDateString('da-DK', { weekday: 'long' })
    : d.toLocaleDateString('da-DK', { day: 'numeric', month: 'short' });
}

export default function CookPage() {
  const dinners = useDinners();
  const [adding, setAdding] = useState(false);
  const clearCooked = useDinnerMutation(api.dinners.clearCooked);
  const { confirm, dialog } = useConfirm();

  const toCook = dinners.data?.filter((d) => !d.cookedAt) ?? [];
  const cooked = dinners.data?.filter((d) => d.cookedAt) ?? [];

  return (
    <>
      <header className="header cook-header">
        <h1>
          This week
          {toCook.length > 0 && <span className="sub"> {toCook.length} to cook</span>}
        </h1>
        <Link className="btn btn--ghost btn--sm" to="/shop">
          <IconCart size={16} /> Shop
        </Link>
      </header>

      <main className="main main--cook">
        {dinners.isLoading && <Spinner />}
        <ErrorBanner error={dinners.error ?? clearCooked.error} />

        {dinners.data && dinners.data.length === 0 && (
          <EmptyState
            title="Nothing planned"
            hint="Plan the week's dinners when you shop, or add one here."
          />
        )}

        <div className="dinners">
          {toCook.map((d) => (
            <DinnerCard key={d.id} dinner={d} />
          ))}
        </div>

        <button className="btn btn--ghost btn--block btn--lg" style={{ marginTop: 14 }} onClick={() => setAdding(true)}>
          <IconPlus /> Add a dinner
        </button>

        {cooked.length > 0 && (
          <section>
            <div className="row row--between">
              <h2 className="section-title">Cooked</h2>
              <button
                className="btn btn--quiet btn--sm"
                onClick={async () => {
                  const ok = await confirm({
                    title: 'Clear the cooked dinners?',
                    body: 'Ready for a new week. Anything they left on the shopping list stays there.',
                    confirmLabel: `Clear ${cooked.length}`,
                  });
                  if (ok) clearCooked.mutate(undefined);
                }}
              >
                Clear
              </button>
            </div>
            <div className="card card--flush">
              {cooked.map((d) => (
                <Link key={d.id} to={`/cook/${d.id}`} className="list__row dinner-done">
                  <span className="tick tick--done">
                    <IconCheck size={14} />
                  </span>
                  <span className="grow truncate">{d.title}</span>
                  <span className="small faint">{cookedWhen(d.cookedAt!)}</span>
                </Link>
              ))}
            </div>
          </section>
        )}
      </main>

      {adding && <AddDinnerSheet onClose={() => setAdding(false)} defaultAddToShop={false} />}
      {dialog}
    </>
  );
}

function DinnerCard({ dinner }: { dinner: Dinner }) {
  return (
    <Link to={`/cook/${dinner.id}`} className="dinner-card">
      <span className="grow" style={{ minWidth: 0 }}>
        {dinner.day && <span className="dinner-card__day">{dayLabel(dinner.day)}</span>}
        <span className="dinner-card__title">{dinner.title}</span>
        <span className="dinner-card__meta">
          {dinner.recipeId ? `${dinner.servings} pers.` : 'No recipe'}
          {dinner.recipeName && dinner.recipeName !== dinner.title ? ` · ${dinner.recipeName}` : ''}
          {dinner.note ? ` · ${dinner.note}` : ''}
        </span>
      </span>
      <span className="chev">
        <IconChevron size={22} />
      </span>
    </Link>
  );
}
