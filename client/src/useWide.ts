import { useSyncExternalStore } from 'react';

/** Where the laptop layout starts. Keep in step with the media queries in app.css. */
const QUERY = '(min-width: 900px)';

const media = typeof window !== 'undefined' ? window.matchMedia(QUERY) : null;

const subscribe = (onChange: () => void) => {
  media?.addEventListener('change', onChange);
  return () => media?.removeEventListener('change', onChange);
};

/**
 * True on a laptop-sized window. Most of the difference is CSS; this is for
 * the few places where the wide layout shows something different — a panel
 * beside the list instead of a sheet over it.
 */
export function useWide(): boolean {
  return useSyncExternalStore(subscribe, () => media?.matches ?? true);
}
