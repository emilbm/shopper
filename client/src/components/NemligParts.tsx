import { useEffect, useRef, useState } from 'react';
import type { NemligProduct, NemligProgress } from '../../../shared/types';
import { IconCart, IconCheck, IconChevron, IconClose } from './ui';

const kr = new Intl.NumberFormat('da-DK', { style: 'currency', currency: 'DKK' });

/** Nemlig's own picture of a product, by id, square and at twice the size shown for sharp screens. */
const imageOf = (id: string, size: number) =>
  `https://product-images.nemlig.io/${encodeURIComponent(id)}.webp?w=${size * 2}&ratio=1`;

/** A product's picture; a product Nemlig has none for shows a plain cart instead. */
export function ProductThumb({ id, size = 44 }: { id: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [id]);
  return (
    <span className="product-thumb" style={{ width: size, height: size }}>
      {failed ? (
        <IconCart size={Math.round(size / 2.2)} />
      ) : (
        <img src={imageOf(id, size)} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
      )}
    </span>
  );
}

function ProductLine({ product: p }: { product: NemligProduct }) {
  return (
    <span className="product-line">
      <ProductThumb id={p.id} />
      <span className="product-line__text">
        <span className="product-line__name">
          {p.favourite && <span title="One of your favourites">★ </span>}
          {p.name}
        </span>
        <span className="product-line__meta">
          {[p.description, p.price ? kr.format(p.price) : null].filter(Boolean).join(' · ')}
          {p.offer && <span className="product-line__offer"> · {p.offer.description}</span>}
          {!p.inStock && <span className="product-line__out"> · out of stock</span>}
        </span>
      </span>
    </span>
  );
}

/**
 * The product for a line, chosen from what the search found — with pictures,
 * which a plain dropdown cannot show.
 */
export function ProductPicker({
  options,
  value,
  onChange,
  label,
}: {
  options: NemligProduct[];
  value: string | null;
  onChange: (id: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.id === value);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  return (
    <div className="picker-pop" ref={box}>
      <button
        type="button"
        className="picker-pop__current"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen(!open)}
      >
        {current ? <ProductLine product={current} /> : <span className="muted">Pick a product…</span>}
        {options.length > 1 && (
          <span className="picker-pop__more">
            {options.length - (current ? 1 : 0)} other{options.length - (current ? 1 : 0) === 1 ? '' : 's'}
            <span className="picker-pop__chev">
              <IconChevron size={16} />
            </span>
          </span>
        )}
      </button>
      {open && (
        <div className="picker-pop__menu" role="listbox" aria-label={label}>
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              role="option"
              aria-selected={o.id === value}
              className={`picker-pop__option${o.id === value ? ' picker-pop__option--on' : ''}`}
              onClick={() => {
                onChange(o.id);
                setOpen(false);
              }}
            >
              <ProductLine product={o} />
              {o.id === value && <IconCheck size={16} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- progress */

interface ProgressItem {
  name: string;
  state: 'waiting' | 'done' | 'failed';
  detail?: string;
}

export interface ProgressState {
  stage: 'starting' | 'searching' | 'choosing' | 'filling';
  done: number;
  total: number;
  items: ProgressItem[];
  choosing?: number;
}

export const progressStart: ProgressState = { stage: 'starting', done: 0, total: 0, items: [] };

/** Fold one streamed progress event into what the page shows. */
export function progressReduce(state: ProgressState, event: NemligProgress): ProgressState {
  const mark = (name: string, item: Partial<ProgressItem>) => {
    // The first waiting item of that name: two lines can share one.
    const i = state.items.findIndex((x) => x.name === name && x.state === 'waiting');
    return i < 0 ? state.items : state.items.map((x, j) => (j === i ? { ...x, ...item } : x));
  };
  switch (event.type) {
    case 'searching':
    case 'filling':
      return {
        stage: event.type,
        done: 0,
        total: event.total,
        items: event.names.map((name) => ({ name, state: 'waiting' })),
      };
    case 'searched':
      return {
        ...state,
        done: event.done,
        items: mark(event.name, {
          state: event.found ? 'done' : 'failed',
          detail: event.found ? `${event.found} found` : 'nothing found',
        }),
      };
    case 'choosing':
      return { ...state, stage: 'choosing', choosing: event.count };
    case 'filled':
      return { ...state, done: event.done, items: mark(event.name, { state: event.ok ? 'done' : 'failed' }) };
  }
}

const HEADLINE: Record<ProgressState['stage'], (s: ProgressState) => string> = {
  starting: () => 'Connecting to Nemlig…',
  searching: (s) => `Searching Nemlig — ${s.done} of ${s.total}`,
  choosing: (s) => `The AI is choosing the products for ${s.choosing} ${s.choosing === 1 ? 'line' : 'lines'}…`,
  filling: (s) => `Filling the basket — ${s.done} of ${s.total}`,
};

/** A bar for how far along, and every line as it is dealt with. */
export function ProgressPanel({ state }: { state: ProgressState }) {
  const fraction =
    state.stage === 'choosing' ? 1 : state.total ? state.done / state.total : 0;
  return (
    <div className="nemlig-progress" role="status" aria-live="polite">
      <p className="nemlig-progress__headline">{HEADLINE[state.stage](state)}</p>
      <div
        className={`progress${state.stage === 'starting' ? ' progress--waiting' : state.stage === 'choosing' ? ' progress--sheen' : ''}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={state.total || 1}
        aria-valuenow={state.done}
      >
        <span className="progress__fill" style={{ width: `${Math.round(fraction * 100)}%` }} />
      </div>
      {state.items.length > 0 && (
        <ul className="nemlig-progress__items">
          {state.items.map((item, i) => (
            <li key={`${item.name}-${i}`} className={`nemlig-progress__item nemlig-progress__item--${item.state}`}>
              <span className="nemlig-progress__mark">
                {item.state === 'done' ? (
                  <IconCheck size={14} />
                ) : item.state === 'failed' ? (
                  <IconClose size={14} />
                ) : (
                  <span className="nemlig-progress__dot" />
                )}
              </span>
              <span className="grow truncate">{item.name}</span>
              {item.detail && <span className="tiny faint">{item.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
