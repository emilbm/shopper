import { useEffect, useRef } from 'react';

/** Typing into a field must never trigger a keyboard shortcut. */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}

/**
 * Ctrl+S (⌘S) saves the form instead of offering to save the web page.
 * The latest `save` is always the one called, without re-binding the listener.
 */
export function useSaveShortcut(save: () => void, enabled = true): void {
  const latest = useRef(save);
  latest.current = save;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        latest.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [enabled]);
}
