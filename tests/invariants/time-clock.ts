/**
 * Named instants for the temporal boundary suite (area V).
 *
 * Every constant is an *absolute* instant written with an explicit UTC offset,
 * so it means the same thing no matter how it is parsed. The offset is the one
 * Europe/Oslo actually had at that moment: +01:00 (CET) in winter, +02:00
 * (CEST) in summer. `tests/setup.ts` pins `TZ=Europe/Oslo`, so a `Date` built
 * from any of these renders in Oslo local time.
 *
 * The pairs are deliberately one millisecond apart — that is the resolution
 * every deadline in this codebase is compared at (`<`, `<=`, `>`), and it is
 * the only width at which an inclusive/exclusive mistake is visible.
 *
 * Not a `*.test.ts` file, so vitest does not collect it.
 */
import { mockClock } from '../helpers/mocks';

// ── Local midnight, midsummer (CEST, +02:00) ─────────────────────────────────
// 2026-06-15T00:00+02:00 is 2026-06-14T22:00Z: the Oslo calendar date and the
// UTC calendar date disagree for the first two hours of every summer day.
export const MIDNIGHT_DATE = '2026-06-15';
export const MIDNIGHT_PREV_DATE = '2026-06-14';
export const BEFORE_MIDNIGHT = '2026-06-14T23:59:59.999+02:00';
export const AT_MIDNIGHT = '2026-06-15T00:00:00.000+02:00';
export const AFTER_MIDNIGHT = '2026-06-15T00:00:00.001+02:00';

// The same edge in winter (CET, +01:00) — the UTC date still lags by one.
export const WINTER_MIDNIGHT_DATE = '2026-01-15';
export const BEFORE_WINTER_MIDNIGHT = '2026-01-14T23:59:59.999+01:00';
export const AT_WINTER_MIDNIGHT = '2026-01-15T00:00:00.000+01:00';
export const AFTER_WINTER_MIDNIGHT = '2026-01-15T00:00:00.001+01:00';

// ── DST forward: 2026-03-29, a 23-hour day ───────────────────────────────────
// 02:00 local never happens; the clock jumps 01:59:59.999+01:00 → 03:00+02:00.
// The two instants below are exactly 1 ms apart.
export const DST_FORWARD_DATE = '2026-03-29';
export const DST_FORWARD_PREV_DATE = '2026-03-28';
export const DST_FORWARD_NEXT_DATE = '2026-03-30';
export const BEFORE_DST_FORWARD = '2026-03-29T01:59:59.999+01:00';
export const AFTER_DST_FORWARD = '2026-03-29T03:00:00.000+02:00';
/** Local midnight of the short day — it exists (the jump is at 02:00). */
export const DST_FORWARD_MIDNIGHT = '2026-03-29T00:00:00.000+01:00';
export const DST_FORWARD_DAY_END = '2026-03-29T23:59:59.999+02:00';

// ── DST backward: 2026-10-25, a 25-hour day ──────────────────────────────────
// 02:00–02:59 local happens twice. FIRST is the last millisecond of the CEST
// pass, SECOND is the first millisecond of the CET repeat — 1 ms apart.
export const DST_BACK_DATE = '2026-10-25';
export const DST_BACK_PREV_DATE = '2026-10-24';
export const DST_BACK_NEXT_DATE = '2026-10-26';
export const DST_BACK_FIRST_PASS = '2026-10-25T02:59:59.999+02:00';
export const DST_BACK_SECOND_PASS = '2026-10-25T02:00:00.000+01:00';
export const DST_BACK_MIDNIGHT = '2026-10-25T00:00:00.000+02:00';
export const DST_BACK_DAY_END = '2026-10-25T23:59:59.999+01:00';

// ── Month end ────────────────────────────────────────────────────────────────
export const MONTH_END_DATE = '2026-06-30';
export const NEXT_MONTH_DATE = '2026-07-01';
export const BEFORE_MONTH_END = '2026-06-30T23:59:59.998+02:00';
export const AT_MONTH_END = '2026-06-30T23:59:59.999+02:00';
export const AFTER_MONTH_END = '2026-07-01T00:00:00.000+02:00';

// ── Leap day ─────────────────────────────────────────────────────────────────
export const LEAP_DAY_DATE = '2028-02-29';
export const LEAP_DAY_EVE_DATE = '2028-02-28';
export const LEAP_DAY_NEXT_DATE = '2028-03-01';
export const BEFORE_LEAP_DAY = '2028-02-28T23:59:59.999+01:00';
export const AT_LEAP_DAY = '2028-02-29T00:00:00.000+01:00';
export const LEAP_DAY_NOON = '2028-02-29T12:00:00.000+01:00';
export const AFTER_LEAP_DAY = '2028-02-29T23:59:59.999+01:00';

// ── Year end ─────────────────────────────────────────────────────────────────
export const YEAR_END_DATE = '2026-12-31';
export const NEXT_YEAR_DATE = '2027-01-01';
export const BEFORE_YEAR_END = '2026-12-31T23:59:59.998+01:00';
export const AT_YEAR_END = '2026-12-31T23:59:59.999+01:00';
export const AFTER_YEAR_END = '2027-01-01T00:00:00.000+01:00';

/** Table-driven fixture: every named edge, as (label, instant) pairs. */
export const NAMED_INSTANTS: ReadonlyArray<readonly [string, string]> = [
  ['midsummer midnight − 1 ms', BEFORE_MIDNIGHT],
  ['midsummer midnight', AT_MIDNIGHT],
  ['midsummer midnight + 1 ms', AFTER_MIDNIGHT],
  ['midwinter midnight − 1 ms', BEFORE_WINTER_MIDNIGHT],
  ['midwinter midnight', AT_WINTER_MIDNIGHT],
  ['midwinter midnight + 1 ms', AFTER_WINTER_MIDNIGHT],
  ['DST forward − 1 ms', BEFORE_DST_FORWARD],
  ['DST forward + 0 ms', AFTER_DST_FORWARD],
  ['DST back, first pass', DST_BACK_FIRST_PASS],
  ['DST back, second pass', DST_BACK_SECOND_PASS],
  ['month end − 1 ms', BEFORE_MONTH_END],
  ['month end', AT_MONTH_END],
  ['month end + 1 ms', AFTER_MONTH_END],
  ['leap day eve', BEFORE_LEAP_DAY],
  ['leap day', AT_LEAP_DAY],
  ['year end', AT_YEAR_END],
  ['year end + 1 ms', AFTER_YEAR_END],
] as const;

// ── Oracles ──────────────────────────────────────────────────────────────────
//
// Deliberately NOT `@/lib/dates` — a test that checks the product's date
// formatting with the product's own formatter proves nothing. `Intl` is the
// independent source of truth for what Oslo's calendar says.

const OSLO_YMD = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Oslo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The Oslo calendar date (YYYY-MM-DD) of an instant, per ICU. */
export function osloDateStr(d: Date | number | string): string {
  const date = d instanceof Date ? d : new Date(d);
  return OSLO_YMD.format(date);
}

/** The UTC calendar date of an instant — i.e. what `toISOString().split('T')[0]` yields. */
export function utcDateStr(d: Date | number | string): string {
  const date = d instanceof Date ? d : new Date(d);
  return date.toISOString().slice(0, 10);
}

const OSLO_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Oslo',
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Oslo's UTC offset in minutes at an instant (+60 in winter, +120 in summer). */
export function osloOffsetMinutes(d: Date | number | string): number {
  const date = d instanceof Date ? d : new Date(d);
  const parts = OSLO_PARTS.formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const wallAsUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  const instantToSecond = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((wallAsUtc - instantToSecond) / 60_000);
}

/** The next Oslo calendar date after `dateStr`, computed without product code. */
export function nextOsloDate(dateStr: string): string {
  return osloDateStr(new Date(`${dateStr}T12:00:00Z`).getTime() + 24 * 3600_000);
}

/**
 * Milliseconds between local midnight of `dateStr` and local midnight of the
 * following day: 23 h on the spring-forward day, 25 h on the autumn one.
 * Oslo never shifts at midnight, so the naive local-midnight construction is
 * exact for every date this suite uses.
 */
export function osloDayLengthMs(dateStr: string): number {
  const start = new Date(`${dateStr}T00:00:00`).getTime();
  const end = new Date(`${nextOsloDate(dateStr)}T00:00:00`).getTime();
  return end - start;
}

// ── Clock wrapper ────────────────────────────────────────────────────────────

/**
 * Freeze the clock at `iso`, run `fn`, restore. Only `Date` is faked (see
 * `mockClock`), so Prisma's SQLITE_BUSY backoff still runs on real timers.
 *
 * ```ts
 * await at(AT_MIDNIGHT, async () => {
 *   expect(todayStr()).toBe(MIDNIGHT_DATE);
 * });
 * ```
 */
export async function at<T>(iso: string, fn: () => T | Promise<T>): Promise<T> {
  const clock = mockClock(iso);
  try {
    return await fn();
  } finally {
    clock.restore();
  }
}

/** `at()` for the three probes around one edge: −1 unit, the edge, +1 unit. */
export async function atEach<T>(
  instants: readonly string[],
  fn: (iso: string) => T | Promise<T>,
): Promise<T[]> {
  const out: T[] = [];
  for (const iso of instants) {
    out.push(await at(iso, () => fn(iso)));
  }
  return out;
}

/** An instant `ms` milliseconds away from a named one, as an ISO string. */
export function shift(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}
