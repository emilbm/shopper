import { Link } from 'react-router-dom';
import { formatAmount } from '../../../shared/units';
import { api } from '../api';
import { EmptyState, ErrorBanner, IconCart, IconEdit, IconPlus, Spinner } from '../components/ui';
import { useLists, useShop, useShopMutation } from '../queries';

export default function ListsPage() {
  const lists = useLists();
  const shop = useShop();
  const add = useShopMutation(api.shop.addList);

  const onShop = (id: number) => shop.data?.contributors.some((c) => c.kind === 'list' && c.refId === id) ?? false;

  return (
    <>
      <header className="header">
        <h1>Lists</h1>
        <Link className="btn btn--primary btn--sm" to="/lists/new">
          <IconPlus size={16} /> New
        </Link>
      </header>
      <main className="main">
        {lists.isLoading && <Spinner />}
        <ErrorBanner error={lists.error ?? add.error} />
        {lists.data?.length === 0 && (
          <EmptyState
            title="No lists yet"
            hint="A list is a set of things you buy together — the weekly staples, breakfast, the cleaning cupboard — added to the shop in one tap."
            action={
              <Link className="btn btn--primary" to="/lists/new">
                Make a list
              </Link>
            }
          />
        )}
        <div className="cards-grid">
        {lists.data?.map((l) => (
          <div className="card stack" key={l.id}>
            <div className="row">
              <h2 className="grow" style={{ fontSize: '1.05rem' }}>
                {l.name}
              </h2>
              <Link className="btn btn--quiet btn--sm btn--icon" to={`/lists/${l.id}`} aria-label={`Edit ${l.name}`}>
                <IconEdit />
              </Link>
            </div>
            {l.notes && <p className="small muted" style={{ margin: 0 }}>{l.notes}</p>}
            <p className="small" style={{ margin: 0 }}>
              {l.entries.length
                ? l.entries
                    .map((e) => {
                      const amount = formatAmount({ quantity: e.quantity, unit: e.unit });
                      return amount ? `${e.name} (${amount})` : e.name;
                    })
                    .join(', ')
                : 'Empty'}
            </p>
            <button
              className="btn btn--primary btn--block"
              disabled={!l.entries.length || add.isPending}
              onClick={() => add.mutate(l.id)}
            >
              <IconCart size={18} /> {onShop(l.id) ? 'On the list — add again' : `Add ${l.entries.length} to the shop`}
            </button>
          </div>
        ))}
        </div>
      </main>
    </>
  );
}
