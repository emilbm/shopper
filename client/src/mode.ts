/**
 * The app has two doors: Shop (planning, at the laptop) and Cook (at the
 * stove, on a phone). Opening the bare address goes through whichever door
 * this device used last, so the phone propped by the hob opens on Cook and the
 * laptop on Shop, without either having to be told.
 */

export type Mode = 'shop' | 'cook';

const KEY = 'grocer.mode';

export function lastMode(): Mode | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'shop' || v === 'cook' ? v : null;
  } catch {
    return null; // Private mode or blocked storage: fall back to the screen size.
  }
}

export function rememberMode(mode: Mode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* only a convenience */
  }
}
