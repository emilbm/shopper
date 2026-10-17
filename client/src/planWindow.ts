import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from './api';
import { addDays, today } from './days';
import { keys, usePlan } from './queries';

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

/** As many days as a plan can have. */
export const MAX_DAYS = 31;

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000) + 1;

/**
 * The plans, and moving the open plan's first and last days. Plans live on
 * the server, so everyone in the household plans the same days.
 *
 * The open plan is either the period being planned (\`next\`, from tomorrow
 * at the earliest) or, mid-week before the next is started, the one being
 * eaten (\`now\`). A plan under way can grow or shrink at its end, but not
 * lose today or the days before it: those dinners happened.
 */
export function usePlanWindow() {
  const qc = useQueryClient();
  const plan = usePlan();
  const day = today();
  const tomorrow = addDays(day, 1);
  const data = plan.data;
  const start = data?.current.from ?? tomorrow;
  const end = data?.current.to ?? addDays(tomorrow, 6);
  const underWay = !!data?.now?.current;
  /** The open plan's first day on screen. */
  const from = underWay || start > tomorrow ? start : tomorrow;
  const length = daysBetween(start, end);
  const shown = (underWay ? data?.now?.days.length : data?.next?.days.length) ?? 0;
  // A plan being eaten while the next is planned: the next starts after it.
  const lastNow = data?.now && !data.now.current ? data.now.to : '';

  const range = useMutation({
    mutationFn: (r: { from: string; to: string }) => api.plan.setRange(r.from, r.to, today()),
    onSuccess: (next) => {
      qc.setQueryData([...keys.plan, today()], next);
      void qc.invalidateQueries({ queryKey: keys.plans });
    },
  });
  const ready = !!data && !range.isPending;

  return {
    plan,
    error: range.error,
    canAddBefore:
      ready && !underWay && from > tomorrow && (!lastNow || from > addDays(lastNow, 1)) && length < MAX_DAYS,
    canRemoveFirst: ready && !underWay && shown > 1,
    canAddAfter: ready && length < MAX_DAYS,
    canRemoveLast: ready && (underWay ? end > day : shown > 1),
    addBefore: () => range.mutate({ from: addDays(from, -1), to: end }),
    removeFirst: () => range.mutate({ from: addDays(from, 1), to: end }),
    addAfter: () => range.mutate({ from: start, to: addDays(end, 1) }),
    removeLast: () => range.mutate({ from: start, to: addDays(end, -1) }),
  };
}

/** Whether planning a recipe puts its ingredients on the shopping list. */
export const useFillList = () => useStored('grocer.plan.fillList', true);
