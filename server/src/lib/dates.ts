/**
 * Calendar-date helpers. Policy dates are plain 'YYYY-MM-DD' strings; all
 * arithmetic happens on UTC midnights so DST and server timezone never matter.
 */
export type IsoDate = string; // 'YYYY-MM-DD'

const DAY_MS = 86_400_000;

function toUtc(date: IsoDate): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid ISO date: ${date}`);
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtc(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The calendar date of an instant as seen in a given IANA timezone. */
export function dateInTimeZone(instant: Date, timeZone: string): IsoDate {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Whole calendar days from a to b (positive when b is later). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((toUtc(b) - toUtc(a)) / DAY_MS);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return fromUtc(toUtc(date) + days * DAY_MS);
}

/** Adds calendar months, clamping to the last day of the target month (Jan 31 + 1 → Feb 28/29). */
export function addMonths(date: IsoDate, months: number): IsoDate {
  const [y, m, d] = date.split('-').map(Number);
  const targetMonthIndex = m - 1 + months;
  const lastDay = new Date(Date.UTC(y, targetMonthIndex + 1, 0)).getUTCDate();
  return fromUtc(Date.UTC(y, targetMonthIndex, Math.min(d, lastDay)));
}

/** Whole months elapsed from a to b (anniversary-based). */
export function monthsBetween(a: IsoDate, b: IsoDate): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  let months = (by - ay) * 12 + (bm - am);
  if (bd < ad) months -= 1;
  return months;
}

/** Weekdays (Mon–Fri) after `from` up to and including `to`. No holiday calendar. */
export function businessDaysBetween(from: IsoDate, to: IsoDate): number {
  if (toUtc(to) <= toUtc(from)) return 0;
  let count = 0;
  for (let ms = toUtc(from) + DAY_MS; ms <= toUtc(to); ms += DAY_MS) {
    const dow = new Date(ms).getUTCDay();
    if (dow !== 0 && dow !== 6) count += 1;
  }
  return count;
}

export const isOnOrBefore = (a: IsoDate, b: IsoDate) => toUtc(a) <= toUtc(b);
