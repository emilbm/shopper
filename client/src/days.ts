/**
 * Days as the planner stores them: local calendar dates, "2026-10-15". The
 * browser decides what today is, so a dinner planned late in the evening
 * lands on the household's day, not the server's.
 */

const pad = (n: number) => String(n).padStart(2, '0');

export const toDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const today = () => toDay(new Date());

/** Noon, so no clock change can push the date over a boundary. */
const fromDay = (day: string) => new Date(`${day}T12:00:00`);

export function addDays(day: string, n: number): string {
  const d = fromDay(day);
  d.setDate(d.getDate() + n);
  return toDay(d);
}

export const isWeekend = (day: string) => [0, 6].includes(fromDay(day).getDay());

/** "Mon", "Tue"… */
export const weekday = (day: string) => fromDay(day).toLocaleDateString('en-GB', { weekday: 'short' });

/** "19 Oct" */
export const shortDate = (day: string) => fromDay(day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/** "Today", "Tomorrow", "Yesterday", or "Mon 19 Oct". */
export function dayLabel(day: string, now = today()): string {
  if (day === now) return 'Today';
  if (day === addDays(now, 1)) return 'Tomorrow';
  if (day === addDays(now, -1)) return 'Yesterday';
  return `${weekday(day)} ${shortDate(day)}`;
}
