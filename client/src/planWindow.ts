import { useState } from 'react';
import { addDays, today } from './days';

/** Per-browser preferences, remembered in localStorage when it is there. */
export function useStored<T>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  });
  return [
    value,
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* private window: remembered for this visit only */
      }
    },
  ];
}

/** As many days as the server hands out at once. */
export const MAX_DAYS = 31;

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000) + 1;

/**
 * The days being planned: a run of dates, remembered as dates so a plan made
 * a few days before a delivery still covers the same days when opened again.
 * It never includes today — dinner tonight is already decided — so a start
 * that has passed moves up to tomorrow, keeping the end.
 */
export function usePlanWindow() {
  const tomorrow = addDays(today(), 1);
  const [stored, setStored] = useStored<{ from: string; to: string } | null>('grocer.plan.window', null);

  let from = stored?.from && stored.from > tomorrow ? stored.from : tomorrow;
  let to = stored?.to && stored.to >= from ? stored.to : addDays(from, 6);
  if (daysBetween(from, to) > MAX_DAYS) to = addDays(from, MAX_DAYS - 1);
  const count = daysBetween(from, to);

  const set = (f: string, t: string) => setStored({ from: f, to: t });

  return {
    from,
    to,
    count,
    days: Array.from({ length: count }, (_, i) => addDays(from, i)),
    canAddBefore: from > tomorrow && count < MAX_DAYS,
    canAddAfter: count < MAX_DAYS,
    canRemove: count > 1,
    addBefore: () => set(addDays(from, -1), to),
    removeFirst: () => set(addDays(from, 1), to),
    addAfter: () => set(from, addDays(to, 1)),
    removeLast: () => set(from, addDays(to, -1)),
  };
}

/** Whether planning a recipe puts its ingredients on the shopping list. */
export const useFillList = () => useStored('grocer.plan.fillList', true);
