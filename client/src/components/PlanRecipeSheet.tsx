import { Link } from 'react-router-dom';
import { api } from '../api';
import { dayLabel } from '../days';
import { useFillList, usePlanWindow } from '../planWindow';
import { useDinnerMutation, usePlan } from '../queries';
import { ErrorBanner, IconPot, Sheet, Spinner } from './ui';

/**
 * Plan a recipe onto one of the planner's days. The dinner is what puts its
 * ingredients on the shopping list, so the list follows the plan.
 */
export function PlanRecipeSheet({
  recipeId,
  name,
  servings,
  onClose,
  onPlanned,
}: {
  recipeId: number;
  name: string;
  servings: number;
  onClose: () => void;
  onPlanned: (day: string) => void;
}) {
  const range = usePlanWindow();
  const plan = usePlan(range.from, range.count);
  const [fillList, setFillList] = useFillList();
  const add = useDinnerMutation((day: string) => api.dinners.add({ recipeId, servings, day, addToShop: fillList }));

  return (
    <Sheet title={`Plan ${name}`} onClose={onClose}>
      <div className="stack">
        {plan.isLoading && <Spinner />}
        <ErrorBanner error={plan.error ?? add.error} />
        {plan.data && (
          <div className="card card--flush">
            {plan.data.days.map((d) => (
              <button
                key={d.day}
                className="list__row day-pick"
                // One dinner a day: a day that has one is shown, not offered.
                disabled={add.isPending || d.dinners.length > 0}
                onClick={() => add.mutate(d.day, { onSuccess: () => onPlanned(d.day) })}
              >
                <span className="day-pick__day">{dayLabel(d.day)}</span>
                <span className="grow small muted truncate">
                  {d.dinners.length ? (
                    d.dinners.map((x) => x.title).join(', ')
                  ) : (
                    <span className="faint">Nothing planned</span>
                  )}
                  {d.note && <span className="faint"> · {d.note}</span>}
                </span>
                {d.dinners.length === 0 && <IconPot size={16} />}
              </button>
            ))}
          </div>
        )}
        <label className={`checkline${fillList ? ' checkline--on' : ''}`}>
          <input type="checkbox" checked={fillList} onChange={(e) => setFillList(e.target.checked)} />
          <span>Put its ingredients on the shopping list ({servings} servings)</span>
        </label>
        <p className="small faint" style={{ margin: 0 }}>
          These are the days in your <Link to="/plan">week plan</Link>. To change a planned day or add more days, go there.
        </p>
      </div>
    </Sheet>
  );
}
