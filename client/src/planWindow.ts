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
 * The current plan, and moving its first and last days. The plan lives on
 * the server, so everyone in the household plans the same days. The days
 * shown start at tomorrow at the earliest — dinner tonight is already
 * decided — so a plan already under way shows only what is still to come.
 */
export function usePlanWindow() {
  const qc = useQueryClient();
  const plan = usePlan();
  const tomorrow = addDays(today(), 1);
  const data = plan.data;
  const start = data?.from ?? tomorrow;
  const end = data?.to ?? addDays(tomorrow, 6);
  /** The first day shown. */
  const from = start > tomorrow ? start : tomorrow;
  const length = daysBetween(start, end);

  const range = useMutation({
    mutationFn: (r: { from: string; to: string }) => api.plan.setRange(r.from, r.to, today()),
    onSuccess: (next) => {
      qc.setQueryData([...keys.plan, today()], next);
      void qc.invalidateQueries({ queryKey: keys.plans });
    },
  });
  const ready = !!data && !range.isPending;
  const shown = data?.days.length ?? 0;
  // The last plan's final day, when it is still running: days up to it are its own.
  const lastEarlier = data?.earlier.at(-1)?.to ?? '';

  return {
    plan,
    error: range.error,
    canAddBefore: ready && from > tomorrow && (!lastEarlier || from > addDays(lastEarlier, 1)) && length < MAX_DAYS,
    canAddAfter: ready && length < MAX_DAYS,
    canRemove: ready && shown > 1,
    addBefore: () => range.mutate({ from: addDays(from, -1), to: end }),
    // Moving the first shown day on also lets go of days already past; their
    // dinners stay in the plan's record all the same.
    removeFirst: () => range.mutate({ from: addDays(from, 1), to: end }),
    addAfter: () => range.mutate({ from: start, to: addDays(end, 1) }),
    removeLast: () => range.mutate({ from: start, to: addDays(end, -1) }),
  };
}

/** Whether planning a recipe puts its ingredients on the shopping list. */
export const useFillList = () => useStored('grocer.plan.fillList', true);
