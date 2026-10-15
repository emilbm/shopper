import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ShoppingList } from '../../shared/types';
import { api } from './api';

export const keys = {
  meta: ['meta'] as const,
  shop: ['shop'] as const,
  items: ['items'] as const,
  recipes: ['recipes'] as const,
  recipe: (id: number) => ['recipes', id] as const,
  lists: ['lists'] as const,
  dinners: ['dinners'] as const,
  plan: ['plan'] as const,
};

export const useMeta = () => useQuery({ queryKey: keys.meta, queryFn: api.meta, staleTime: Infinity });

/** Whether the AI features should be offered at all. */
export const useAiEnabled = () => useMeta().data?.ai.enabled ?? false;
export const useNemligEnabled = () => useMeta().data?.nemlig.enabled ?? false;

export const useShop = () => useQuery({ queryKey: keys.shop, queryFn: api.shop.get });
export const useItems = () => useQuery({ queryKey: keys.items, queryFn: api.items.list });
export const useRecipes = () => useQuery({ queryKey: keys.recipes, queryFn: api.recipes.list });
export const useRecipe = (id: number | null) =>
  useQuery({
    queryKey: keys.recipe(id ?? 0),
    queryFn: () => api.recipes.get(id!),
    enabled: id !== null,
  });
export const useLists = () => useQuery({ queryKey: keys.lists, queryFn: api.lists.list });
export const useDinners = () => useQuery({ queryKey: keys.dinners, queryFn: api.dinners.list });
export const usePlan = (from: string, days: number) =>
  useQuery({
    queryKey: [...keys.plan, from, days],
    queryFn: () => api.plan.get(from, days),
    // Adding a day keeps the days already shown on screen while the longer plan loads.
    placeholderData: (previous) => previous,
  });

/**
 * Dinner changes ripple into the shopping list (planning one adds its
 * ingredients, a new servings count re-scales them), so both are refreshed.
 */
export function useDinnerMutation<A, R>(fn: (arg: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.dinners }),
        qc.invalidateQueries({ queryKey: keys.plan }),
        qc.invalidateQueries({ queryKey: keys.shop }),
        qc.invalidateQueries({ queryKey: keys.items }),
      ]),
  });
}

/**
 * Every shopping-list call answers with the whole list, so the cache is set
 * from the reply rather than refetched — a tick shows at once, even on a
 * slow connection in the back of a shop.
 */
export function useShopMutation<A>(fn: (arg: A) => Promise<ShoppingList>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (list) => {
      qc.setQueryData(keys.shop, list);
      // Adding by name can create items; taking a dinner off changes its "on the list".
      void qc.invalidateQueries({ queryKey: keys.items });
      void qc.invalidateQueries({ queryKey: keys.dinners });
      void qc.invalidateQueries({ queryKey: keys.plan });
    },
  });
}
