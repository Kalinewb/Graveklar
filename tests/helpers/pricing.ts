/**
 * Date + config helpers for the pricing / discount audit (phase 1a).
 *
 * Pure: no `vi.mock`, no database access, no product state. Everything here
 * exists because the booking rules are weekday- and calendar-bound — a test
 * that hard-codes "2026-06-01" starts failing the day that date is in the
 * past, so every bookable date in the suite is derived from `today`.
 */
import { toDateStr } from '@/lib/dates';
import { DEFAULT_CONFIG, type ConfigValues } from '@/lib/pricing';

/** `DEFAULT_CONFIG` plus overrides — the shape every pure pricing fn takes. */
export function cfg(overrides: Record<string, number> = {}): ConfigValues {
  return { ...DEFAULT_CONFIG, ...overrides };
}

/** YYYY-MM-DD, `n` days from today in the (Oslo) local calendar. */
export function daysFromNow(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

/** ISO weekday (1 = Monday … 7 = Sunday) of a YYYY-MM-DD string. */
export function isoDowOf(dateStr: string): number {
  const dow = new Date(dateStr + 'T12:00:00').getDay();
  return dow === 0 ? 7 : dow;
}

/**
 * The first date at least `minAhead` days out whose ISO weekday is `isoDow`.
 * `checkBookable` / `validateBookingInput` pin each rental type to a weekday
 * (week → Monday, weekend → Friday, day → Mon–Thu), so tests ask for a
 * weekday rather than naming a date.
 */
export function futureDow(isoDow: number, minAhead = 14): string {
  for (let i = minAhead; i < minAhead + 7; i++) {
    const s = daysFromNow(i);
    if (isoDowOf(s) === isoDow) return s;
  }
  /* c8 ignore next */
  throw new Error(`[test] no ISO weekday ${isoDow} within a week of +${minAhead}d`);
}

export const MON = 1;
export const TUE = 2;
export const WED = 3;
export const THU = 4;
export const FRI = 5;
export const SAT = 6;
export const SUN = 7;

/** Every rental type switched on, so `custom` quotes are bookable at all. */
export const ALL_RENTAL_TYPES = 'day,weekend,week,custom';
