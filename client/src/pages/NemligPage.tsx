import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { NemligApplyResult, NemligPlan, NemligPlanLine, NemligProduct } from '../../../shared/types';
import { api } from '../api';
import {
  ProductPicker,
  ProductThumb,
  ProgressPanel,
  progressReduce,
  progressStart,
  type ProgressState,
} from '../components/NemligParts';
import { ErrorBanner, IconBack, IconCheck, IconClose } from '../components/ui';
import { keys } from '../queries';

const kr = new Intl.NumberFormat('da-DK', { style: 'currency', currency: 'DKK' });

interface Row {
  line: NemligPlanLine;
  /** Every product on offer for this line: the proposal first, then the alternatives. */
  options: NemligProduct[];
  productId: string | null;
  quantity: number;
  include: boolean;
}

const SOURCE_LABEL: Record<NemligPlanLine['source'], string> = {
  remembered: 'Bought before',
  ai: 'AI pick',
  favourite: 'Favourite',
  first: 'First match',
  none: '',
};

function toRows(plan: NemligPlan): Row[] {
  return plan.lines.map((line) => {
    const options = [...(line.product ? [line.product] : []), ...line.alternatives];
    return {
      line,
      options,
      productId: line.product?.id ?? null,
      quantity: line.quantity,
      // Only what has a product, in stock, goes in unless chosen by hand.
      include: !!line.product && line.product.inStock,
    };
  });
}

/**
 * The shopping list, turned into a Nemlig basket. Grocer proposes a product
 * and a number of packs for every line still to get; this page is where they
 * are checked, switched or skipped before anything touches the basket.
 */
export default function NemligPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [plan, setPlan] = useState<NemligPlan | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<NemligApplyResult | null>(null);
  const [progress, setProgress] = useState<ProgressState>(progressStart);
  const onProgress = (event: Parameters<typeof progressReduce>[1]) => setProgress((st) => progressReduce(st, event));

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setProgress(progressStart);
    try {
      const p = await api.nemlig.plan(onProgress);
      setPlan(p);
      setRows(toRows(p));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const update = (lineId: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.line.lineId === lineId ? { ...r, ...patch } : r)));

  const chosen = rows.filter((r) => r.include && r.productId);
  const estimate = chosen.reduce((sum, r) => {
    const p = r.options.find((o) => o.id === r.productId);
    return sum + (p?.price ?? 0) * r.quantity;
  }, 0);

  const apply = async () => {
    setApplying(true);
    setError(null);
    setProgress(progressStart);
    try {
      const res = await api.nemlig.apply(
        chosen.map((r) => {
          const p = r.options.find((o) => o.id === r.productId)!;
          return {
            lineId: r.line.lineId,
            itemId: r.line.itemId,
            productId: p.id,
            productName: p.name,
            description: p.description ?? '',
            quantity: r.quantity,
          };
        }),
        onProgress,
      );
      setResult(res);
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.shop }),
        qc.invalidateQueries({ queryKey: keys.items }),
      ]);
    } catch (err) {
      setError(err);
    } finally {
      setApplying(false);
    }
  };

  return (
    <>
      <header className="header">
        <button className="btn btn--quiet btn--icon" onClick={() => navigate('/shop')} aria-label="Back to the list">
          <IconBack />
        </button>
        <h1>
          Send to Nemlig {plan && !result && <span className="sub">{rows.length} lines to get</span>}
        </h1>
        {!loading && !result && (
          <button className="btn btn--ghost btn--sm" onClick={() => void load()}>
            Search again
          </button>
        )}
      </header>

      <main className="main main--nemlig">
        <ErrorBanner error={error} />

        {(loading || applying) && <ProgressPanel state={progress} />}

        {result && <ResultView result={result} onDone={() => navigate('/shop')} />}

        {!loading && !applying && !result && plan && (
          <>
            {plan.warning && <div className="banner banner--warn">{plan.warning}</div>}
            {rows.length === 0 && (
              <div className="empty">
                <h2>Nothing to send</h2>
                <p>Every line on the list is already ticked off.</p>
              </div>
            )}
            <div className="nemlig-rows">
              {rows.map((r) => (
                <div key={r.line.lineId} className={`nemlig-row${r.include ? '' : ' nemlig-row--off'}`}>
                  <label className="nemlig-row__line">
                    <input
                      type="checkbox"
                      checked={r.include}
                      disabled={!r.productId}
                      onChange={(e) => update(r.line.lineId, { include: e.target.checked })}
                    />
                    <span>
                      <span className="nemlig-row__name">{r.line.name}</span>
                      {r.line.amount && <span className="muted num"> · {r.line.amount}</span>}
                    </span>
                  </label>

                  {r.options.length ? (
                    <div className="nemlig-row__product">
                      <ProductPicker
                        options={r.options}
                        value={r.productId}
                        onChange={(id) => update(r.line.lineId, { productId: id, include: true })}
                        label={`Product for ${r.line.name}`}
                      />
                    </div>
                  ) : (
                    <span className="small muted nemlig-row__product">Nothing found at Nemlig</span>
                  )}

                  <span className="mini-stepper num nemlig-row__qty" title="Packs">
                    <button onClick={() => update(r.line.lineId, { quantity: Math.max(1, r.quantity - 1) })} aria-label="Fewer">
                      −
                    </button>
                    {r.quantity}
                    <button onClick={() => update(r.line.lineId, { quantity: Math.min(50, r.quantity + 1) })} aria-label="More">
                      +
                    </button>
                  </span>

                  <span className="tiny faint nemlig-row__why">
                    {SOURCE_LABEL[r.line.source] && <span className="chip">{SOURCE_LABEL[r.line.source]}</span>} {r.line.reason}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </main>

      {!loading && !applying && !result && rows.length > 0 && (
        <footer className="nemligbar">
          <span className="small muted">
            {chosen.length} products · about <strong className="num">{kr.format(estimate)}</strong>
          </span>
          <button className="btn btn--primary btn--lg" disabled={!chosen.length || applying} onClick={() => void apply()}>
            {applying ? 'Filling the basket…' : `Fill Nemlig basket (${chosen.length})`}
          </button>
        </footer>
      )}
    </>
  );
}

function ResultView({ result, onDone }: { result: NemligApplyResult; onDone: () => void }) {
  const failed = result.results.filter((r) => !r.ok);
  return (
    <div className="stack">
      <div className={`banner ${failed.length ? 'banner--warn' : 'banner--info'}`}>
        {failed.length
          ? `${result.results.length - failed.length} of ${result.results.length} products went in. The rest are still on the list.`
          : 'Everything went in, and those lines now show as in the Nemlig basket on the list.'}{' '}
        Nothing is ordered yet: choose a delivery time and check out at Nemlig.
      </div>
      <div className="card card--flush">
        {result.results.map((r) => (
          <div key={r.productId} className="list__row list__row--compact">
            <span className={`tick${r.ok ? ' tick--done' : ''}`}>{r.ok ? <IconCheck size={14} /> : <IconClose size={14} />}</span>
            <ProductThumb id={r.productId} size={36} />
            <span className="grow">
              {r.name}
              {!r.ok && <span className="small" style={{ color: 'var(--danger-text)', display: 'block' }}>{r.error}</span>}
            </span>
            <span className="small muted num">
              {r.ok && r.previous > 0 && r.previous === r.quantity ? `already ${r.quantity}` : `× ${r.quantity}`}
            </span>
          </div>
        ))}
      </div>
      {result.basketTotal !== null && (
        <p className="muted" style={{ margin: 0 }}>
          The basket now comes to <strong className="num">{kr.format(result.basketTotal)}</strong>.
        </p>
      )}
      <div className="row">
        <a className="btn btn--primary" href="https://www.nemlig.com/" target="_blank" rel="noreferrer">
          Open Nemlig
        </a>
        <button className="btn btn--ghost" onClick={onDone}>
          Back to the list
        </button>
      </div>
    </div>
  );
}
