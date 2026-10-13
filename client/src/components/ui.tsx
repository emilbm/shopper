import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/* ------------------------------------------------------------------ icons */

type IconProps = { size?: number };

const svgProps = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

export const IconHome = ({ size = 22 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.5V21h14V9.5" />
  </svg>
);

export const IconList = ({ size = 22 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
  </svg>
);

export const IconChevron = ({ size = 18 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="m9 5 7 7-7 7" />
  </svg>
);

export const IconPot = ({ size = 22 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="M4 10h16v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" />
    <path d="M2 10h2M20 10h2M9 7c0-1 1-1.5 1-2.5M14 7c0-1 1-1.5 1-2.5" />
  </svg>
);

export const IconBack =({ size = 20 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="m15 5-7 7 7 7" />
  </svg>
);

export const IconPlus =({ size = 20 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const IconTrash = ({ size = 18 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
  </svg>
);

export const IconUp = ({ size = 18 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="m6 14 6-6 6 6" />
  </svg>
);

export const IconDown = ({ size = 18 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="m6 10 6 6 6-6" />
  </svg>
);

export const IconClose = ({ size = 20 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const IconCheck = ({ size = 18 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="m5 13 4 4 10-10" />
  </svg>
);

export const IconEdit = ({ size = 18 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="M4 20h4l10-10-4-4L4 16v4Z" />
    <path d="m14 6 4 4" />
  </svg>
);

export const IconCart = ({ size = 22 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="M3 4h2l2.4 11.2a1.5 1.5 0 0 0 1.5 1.2h8.7a1.5 1.5 0 0 0 1.5-1.1L21 8H6.2" />
    <circle cx="9.5" cy="20" r="1.2" />
    <circle cx="17" cy="20" r="1.2" />
  </svg>
);

export const IconBook = ({ size = 22 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z" />
    <path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z" />
  </svg>
);

export const IconTag = ({ size = 22 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="M3 12V4h8l10 10-8 8z" />
    <circle cx="7.5" cy="8.5" r="1.2" />
  </svg>
);

export const IconSparkle = ({ size = 18 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
    <path d="M19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z" />
  </svg>
);

export const IconMinus = ({ size = 20 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="M5 12h14" />
  </svg>
);

export const IconLink = ({ size = 18 }: IconProps) => (
  <svg {...svgProps(size)}>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </svg>
);

/* ------------------------------------------------------------------ sheet */

interface SheetProps {
  title?: string;
  onClose: () => void;
  children: ReactNode;
  /** Raise above another sheet, for a confirmation opened from inside one. */
  onTop?: boolean;
}

/** A bottom sheet — reachable with a thumb, unlike a centred dialog. */
export function Sheet({ title, onClose, children, onTop = false }: SheetProps) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  return (
    <div
      className={`sheet-backdrop${onTop ? ' sheet-backdrop--top' : ''}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet" ref={panel} role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet__grip" />
        {title && <h2>{title}</h2>}
        {children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ small pieces */

export function Spinner() {
  return <div className="spinner" aria-label="Loading" />;
}

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <div className="banner banner--error" role="alert">
      {message}
    </div>
  );
}

interface EmptyStateProps {
  title: string;
  hint: string;
  action?: ReactNode;
}

export function EmptyState({ title, hint, action }: EmptyStateProps) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      <p>{hint}</p>
      {action}
    </div>
  );
}

/* ------------------------------------------------------- decimal input */

/** Reads "2,5" as well as "2.5". Returns null for anything that isn't a number. */
export function parseDecimal(text: string): number | null {
  const normalised = text.replace(',', '.').trim();
  if (normalised === '') return null;
  const value = Number(normalised);
  return Number.isFinite(value) ? value : null;
}

interface DecimalInputProps {
  value: number | null;
  onChange: (value: number | null) => void;
  id?: string;
  className?: string;
  placeholder?: string;
  min?: number;
  'aria-label'?: string;
}

/**
 * A number field that accepts a comma.
 *
 * `<input type="number">` silently rejects "2,5", and a Danish iPhone's number
 * pad offers a comma and no full stop — so the decimal separator was simply
 * unreachable. A text input with `inputMode="decimal"` gets the same keypad and
 * lets us do the parsing ourselves.
 *
 * The typed text is kept as typed while the field has focus, so "2," survives
 * long enough to become "2,5".
 */
export function DecimalInput({ value, onChange, className, ...rest }: DecimalInputProps) {
  const [text, setText] = useState(() => (value === null ? '' : String(value).replace('.', ',')));
  const [editing, setEditing] = useState(false);

  // Follow the value when something else changes it, but never mid-keystroke.
  useEffect(() => {
    if (!editing) setText(value === null ? '' : String(value).replace('.', ','));
  }, [value, editing]);

  return (
    <input
      {...rest}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      className={className}
      value={text}
      onFocus={() => setEditing(true)}
      onBlur={() => {
        setEditing(false);
        // Settle the display on the parsed value: "2," becomes "2".
        setText(value === null ? '' : String(value).replace('.', ','));
      }}
      onChange={(e) => {
        const next = e.target.value;
        // Digits and one separator; a negative amount means nothing here.
        if (!/^[0-9]*[.,]?[0-9]*$/.test(next)) return;
        setText(next);
        onChange(parseDecimal(next));
      }}
    />
  );
}

/* ----------------------------------------------------------- confirming */

export interface ConfirmRequest {
  title: string;
  body?: string;
  confirmLabel?: string;
  danger?: boolean;
}

/**
 * Asks the question in the page rather than through `window.confirm`, which some
 * browsers suppress outright — when they do, the native dialog silently returns
 * false and the button appears to do nothing at all.
 */
export function useConfirm(): {
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  dialog: ReactNode;
} {
  const [pending, setPending] = useState<ConfirmRequest | null>(null);
  const resolver = useRef<((answer: boolean) => void) | null>(null);

  const confirm = useCallback((request: ConfirmRequest) => {
    // Asking again supersedes an unanswered question; settle it so nothing
    // is left awaiting a promise that can no longer be resolved.
    resolver.current?.(false);
    setPending(request);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const answer = useCallback((value: boolean) => {
    setPending(null);
    resolver.current?.(value);
    resolver.current = null;
  }, []);

  const dialog = pending ? (
    <Sheet title={pending.title} onClose={() => answer(false)} onTop>
      <div className="stack">
        {pending.body && (
          <p className="small muted" style={{ margin: 0 }}>
            {pending.body}
          </p>
        )}
        <button
          className={`btn btn--block btn--lg ${pending.danger ? 'btn--danger' : 'btn--primary'}`}
          onClick={() => answer(true)}
          autoFocus
        >
          {pending.confirmLabel ?? 'Confirm'}
        </button>
        <button className="btn btn--ghost btn--block" onClick={() => answer(false)}>
          Cancel
        </button>
      </div>
    </Sheet>
  ) : null;

  return { confirm, dialog };
}
