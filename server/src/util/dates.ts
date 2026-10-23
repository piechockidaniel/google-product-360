/** Helpers for the `YYYY-MM-DD` day strings used by all metric tables. */

export function isoDay(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return isoDay(d);
}

/** Every day of the inclusive range `[from, to]`. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Splits `[from, to]` into consecutive inclusive chunks of at most `size` days. */
export function chunkRange(from: string, to: string, size: number): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  let start = from;
  while (start <= to) {
    const end = addDays(start, size - 1);
    out.push({ from: start, to: end < to ? end : to });
    start = addDays(end, 1);
  }
  return out;
}

/** Accepts `"2025-01-31"` or the protobuf `google.type.Date` shape `{ year, month, day }`. */
export function parseReportDate(value: unknown): string | null {
  if (typeof value === 'string') return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
  if (value && typeof value === 'object') {
    const v = value as { year?: number | string; month?: number | string; day?: number | string };
    if (v.year && v.month && v.day) return `${String(v.year).padStart(4, '0')}-${String(v.month).padStart(2, '0')}-${String(v.day).padStart(2, '0')}`;
  }
  return null;
}

/** ISO week Monday for a day – used for weekly roll-ups. */
export function weekStart(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return isoDay(d);
}
