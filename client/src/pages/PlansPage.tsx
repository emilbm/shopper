import { Link, useNavigate } from 'react-router-dom';
import type { Dinner, PlanSummary } from '../../../shared/types';
import { EmptyState, ErrorBanner, IconBack, IconCheck, IconPot, Spinner } from '../components/ui';
import { shortDate, weekday } from '../days';
import { usePlanHistory } from '../queries';

/**
 * Every plan, newest first: what was planned on which day, and so — near
 * enough — what the household ate. The record a later "suggest a week" will
 * read to bring back what has not been had in a while.
 */
export default function PlansPage() {
  const navigate = useNavigate();
  const plans = usePlanHistory();

  return (
    <>
      <header className="header">
        <button className="btn btn--quiet btn--icon" onClick={() => navigate('/plan')} aria-label="Back to the plan">
          <IconBack />
        </button>
        <h1>
          Past plans {plans.data && <span className="sub">{plans.data.length}</span>}
        </h1>
      </header>
      <main className="main main--narrow">
        {plans.isLoading && <Spinner />}
        <ErrorBanner error={plans.error} />
        {plans.data?.length === 0 && <EmptyState title="No plans yet" hint="Plans appear here as you make them." />}
        <div className="stack">
          {plans.data?.map((p) => <PlanCard key={p.id} plan={p} />)}
        </div>
      </main>
    </>
  );
}

function PlanCard({ plan }: { plan: PlanSummary }) {
  const count = plan.days.reduce((n, d) => n + d.dinners.length, 0) + plan.unscheduled.length;
  return (
    <section className="card past-plan">
      <div className="row row--between past-plan__head">
        <h2 className="past-plan__title">
          {shortDate(plan.from)} – {shortDate(plan.to)}
          {plan.current && (
            <Link className="tag tag--nemlig" to="/plan">
              Current
            </Link>
          )}
        </h2>
        <span className="small faint">
          {count} {count === 1 ? 'dinner' : 'dinners'}
        </span>
      </div>
      {plan.days.length === 0 && plan.unscheduled.length === 0 && (
        <p className="small faint" style={{ margin: 0 }}>
          Nothing was planned.
        </p>
      )}
      {plan.days.map((d) => (
        <div key={d.day} className="past-plan__day">
          <span className="past-plan__date">
            {weekday(d.day)} <span className="faint">{shortDate(d.day)}</span>
          </span>
          <span className="grow">
            {d.dinners.map((x) => (
              <DinnerName key={x.id} dinner={x} />
            ))}
            {d.note && <span className="small faint past-plan__note">{d.note}</span>}
          </span>
        </div>
      ))}
      {plan.unscheduled.length > 0 && (
        <div className="past-plan__day">
          <span className="past-plan__date faint">No day</span>
          <span className="grow">
            {plan.unscheduled.map((x) => (
              <DinnerName key={x.id} dinner={x} />
            ))}
          </span>
        </div>
      )}
    </section>
  );
}

function DinnerName({ dinner: d }: { dinner: Dinner }) {
  return (
    <span className="past-plan__dinner">
      {d.cookedAt ? <IconCheck size={13} /> : <IconPot size={13} />}
      {d.recipeId ? <Link to={`/recipes/${d.recipeId}`}>{d.title}</Link> : d.title}
    </span>
  );
}
