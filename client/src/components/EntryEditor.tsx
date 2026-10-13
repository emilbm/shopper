import { useState } from 'react';
import { parseIngredientLine } from '../../../shared/units';
import { useItems } from '../queries';
import { DecimalInput, IconClose, IconDown, IconPlus, IconUp, Sheet } from './ui';

export interface EditableEntry {
  /** Client-side only, so rows keep their identity while being reordered. */
  key: string;
  name: string;
  quantity: number | null;
  unit: string;
  note: string;
}

let counter = 0;
export const newKey = () => `e${Date.now().toString(36)}${(counter++).toString(36)}`;

export const blankEntry = (): EditableEntry => ({ key: newKey(), name: '', quantity: null, unit: '', note: '' });

const UNIT_SUGGESTIONS = ['g', 'kg', 'ml', 'dl', 'l', 'spsk', 'tsk', 'stk', 'fed', 'dåse', 'pk', 'bundt', 'glas', 'pose', 'flaske'];

/** Datalists for item names and units, rendered once per page that edits entries. */
export function EntryDatalists() {
  const items = useItems();
  return (
    <>
      <datalist id="item-names">
        {items.data?.map((i) => <option key={i.id} value={i.name} />)}
      </datalist>
      <datalist id="unit-names">
        {UNIT_SUGGESTIONS.map((u) => (
          <option key={u} value={u} />
        ))}
      </datalist>
    </>
  );
}

interface Props {
  entries: EditableEntry[];
  onChange: (entries: EditableEntry[]) => void;
  /** Recipes have a preparation note per ingredient; staple lists do not. */
  withNotes?: boolean;
}

export function EntryEditor({ entries, onChange, withNotes = false }: Props) {
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState('');

  const update = (key: string, patch: Partial<EditableEntry>) =>
    onChange(entries.map((e) => (e.key === key ? { ...e, ...patch } : e)));

  const move = (index: number, delta: number) => {
    const next = [...entries];
    const [row] = next.splice(index, 1);
    next.splice(index + delta, 0, row!);
    onChange(next);
  };

  const addPasted = () => {
    const parsed = pasted
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => ({ key: newKey(), ...parseIngredientLine(line) }));
    // Replace a lone empty row rather than leaving it dangling above.
    const kept = entries.filter((e) => e.name.trim());
    onChange([...kept, ...parsed]);
    setPasted('');
    setPasting(false);
  };

  return (
    <div className="stack">
      <EntryDatalists />
      {entries.map((e, i) => (
        <div className="entry" key={e.key}>
          <div className="entry__main">
            <input
              className="input entry__name"
              list="item-names"
              placeholder="Item"
              value={e.name}
              autoCapitalize="sentences"
              onChange={(ev) => update(e.key, { name: ev.target.value })}
              aria-label="Item"
            />
            <DecimalInput
              className="input input--num entry__qty"
              value={e.quantity}
              onChange={(quantity) => update(e.key, { quantity })}
              placeholder="Qty"
              aria-label="Quantity"
            />
            <input
              className="input entry__unit"
              list="unit-names"
              placeholder="Unit"
              value={e.unit}
              autoCapitalize="none"
              onChange={(ev) => update(e.key, { unit: ev.target.value })}
              aria-label="Unit"
            />
          </div>
          <div className="entry__side">
            {withNotes && (
              <input
                className="input input--sm grow"
                placeholder="Note (chopped, optional…)"
                value={e.note}
                onChange={(ev) => update(e.key, { note: ev.target.value })}
                aria-label="Note"
              />
            )}
            {!withNotes && <span className="grow" />}
            <button
              type="button"
              className="btn btn--quiet btn--sm btn--icon"
              disabled={i === 0}
              onClick={() => move(i, -1)}
              aria-label="Move up"
            >
              <IconUp />
            </button>
            <button
              type="button"
              className="btn btn--quiet btn--sm btn--icon"
              disabled={i === entries.length - 1}
              onClick={() => move(i, 1)}
              aria-label="Move down"
            >
              <IconDown />
            </button>
            <button
              type="button"
              className="btn btn--quiet btn--sm btn--icon"
              onClick={() => onChange(entries.filter((x) => x.key !== e.key))}
              aria-label="Remove"
            >
              <IconClose size={18} />
            </button>
          </div>
        </div>
      ))}

      <div className="row">
        <button type="button" className="btn btn--ghost grow" onClick={() => onChange([...entries, blankEntry()])}>
          <IconPlus /> Add a row
        </button>
        <button type="button" className="btn btn--ghost" onClick={() => setPasting(true)}>
          Paste many
        </button>
      </div>

      {pasting && (
        <Sheet title="Paste a list" onClose={() => setPasting(false)}>
          <div className="stack">
            <p className="small muted" style={{ margin: 0 }}>
              One per line, as a recipe writes them: “500 g hakket oksekød”, “2 fed hvidløg, presset”.
            </p>
            <textarea
              className="textarea"
              rows={8}
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              autoFocus
            />
            <button className="btn btn--primary btn--block" disabled={!pasted.trim()} onClick={addPasted}>
              Add {pasted.split('\n').filter((l) => l.trim()).length || ''} rows
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

/** Rows ready to send: blanks dropped, names trimmed. */
export function entriesForSave(entries: EditableEntry[]) {
  return entries
    .filter((e) => e.name.trim())
    .map((e) => ({ name: e.name.trim(), quantity: e.quantity, unit: e.unit.trim(), note: e.note.trim() }));
}

interface StepperProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  label: string;
}

export function Stepper({ value, onChange, min = 1, max = 99, label }: StepperProps) {
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button type="button" className="btn btn--icon" disabled={value <= min} onClick={() => onChange(value - 1)} aria-label="Fewer">
        −
      </button>
      <span className="stepper__value num">{value}</span>
      <button type="button" className="btn btn--icon" disabled={value >= max} onClick={() => onChange(value + 1)} aria-label="More">
        +
      </button>
    </div>
  );
}
