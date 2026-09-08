/**
 * L3i — area V, the daylight-saving half.
 *
 * Europe/Oslo has two days a year that are not 24 hours long: 2026-03-29 (23 h,
 * 02:00 never happens) and 2026-10-25 (25 h, 02:00–02:59 happens twice). Every
 * piece of logic in this product that "adds a day" or "counts hours" behaves
 * differently on those two days, and the difference is invisible on every other
 * day of the year.
 *
 * The distinction this file keeps making:
 *   · **calendar arithmetic** — `addDays`/`setDate` via `@/lib/dates`, which is
 *     noon-anchored and therefore DST-proof. A 7-day rental is 7 dates.
 *   · **elapsed-millisecond arithmetic** — `Date.now() + N * 86_400_000`, which
 *     is exact as an interval and one hour off as a wall-clock day.
 * Both are correct for something. Using one where the other belongs is where
 * findings V-3 and V-5 come from.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { booking, db, machine, resetDb, seedConfigDefaults } from '../helpers/db';
import { expectNoOrphanLocks } from '../helpers/invariants';
import { TEST_TOTP_SECRET, totpCodeFor, totpStep } from '../helpers/auth';
import {
  AFTER_DST_FORWARD,
  AFTER_MIDNIGHT,
  AT_MIDNIGHT,
  AT_WINTER_MIDNIGHT,
  BEFORE_DST_FORWARD,
  BEFORE_MIDNIGHT,
  BEFORE_WINTER_MIDNIGHT,
  DST_BACK_DATE,
  DST_BACK_FIRST_PASS,
  DST_BACK_MIDNIGHT,
  DST_BACK_SECOND_PASS,
  DST_FORWARD_DATE,
  DST_FORWARD_MIDNIGHT,
  DST_FORWARD_PREV_DATE,
  MIDNIGHT_DATE,
  MIDNIGHT_PREV_DATE,
  WINTER_MIDNIGHT_DATE,
  at,
  nextOsloDate,
  osloDateStr,
  osloDayLengthMs,
  osloOffsetMinutes,
  utcDateStr,
} from './time-clock';
import { addDays, parseDateStr, toDateStr, todayStr } from '@/lib/dates';
import {
  dateToDbMidnight,
  dbDateToStr,
  getRentalDateRange,
  rentalDayCount,
} from '@/lib/availability';
import { computeIntervalInfo } from '@/lib/renter-checklist';
import { updateBookingStatus } from '@/lib/booking-service';
import { signDeliveryQuoteToken, verifyDeliveryQuoteToken } from '@/lib/delivery-quote-token';
import {
  createRenterSessionToken,
  verifyRenterSessionToken,
} from '@/lib/renter-checklist-session';
import { createSessionToken, verifySessionToken } from '@/lib/admin-auth';
import { verifyTotpCodeAgainst } from '@/lib/totp';

vi.mock('@/lib/email', async () => (await import('../helpers/mocks')).mockEmail());
vi.mock('@/lib/stripe', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, refundBookingPayment: vi.fn(async () => null) };
});

const HOUR = 3600_000;
const DAY = 24 * HOUR;

const PAYABLE = {
  stripeEnabled: 'true',
  stripeSecretKey: 'sk_test_harness',
  enableFirstTimeDiscount: 'false',
  enableRepeatDiscount: 'false',
};

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await resetDb();
  await expectNoOrphanLocks();
});

// ── The fixture itself ──────────────────────────────────────────────────────

describe('the named instants really are what they claim', () => {
  it('brackets the spring-forward jump by exactly one millisecond', () => {
    expect(Date.parse(AFTER_DST_FORWARD) - Date.parse(BEFORE_DST_FORWARD)).toBe(1);
    expect(osloOffsetMinutes(BEFORE_DST_FORWARD)).toBe(60);
    expect(osloOffsetMinutes(AFTER_DST_FORWARD)).toBe(120);
    expect(osloDayLengthMs(DST_FORWARD_DATE)).toBe(23 * HOUR);
  });

  it('brackets the autumn repeat by exactly one millisecond', () => {
    expect(Date.parse(DST_BACK_SECOND_PASS) - Date.parse(DST_BACK_FIRST_PASS)).toBe(1);
    expect(osloOffsetMinutes(DST_BACK_FIRST_PASS)).toBe(120);
    expect(osloOffsetMinutes(DST_BACK_SECOND_PASS)).toBe(60);
    expect(osloDayLengthMs(DST_BACK_DATE)).toBe(25 * HOUR);
    // Both passes land on the same Oslo calendar day.
    expect(osloDateStr(DST_BACK_FIRST_PASS)).toBe(DST_BACK_DATE);
    expect(osloDateStr(DST_BACK_SECOND_PASS)).toBe(DST_BACK_DATE);
  });

  it('every other day in the fixture is exactly 24 hours', () => {
    for (const day of [MIDNIGHT_DATE, WINTER_MIDNIGHT_DATE, '2026-06-30', '2028-02-29']) {
      expect(osloDayLengthMs(day), day).toBe(DAY);
    }
  });
});

// ── Oslo date vs UTC date ───────────────────────────────────────────────────

describe('the Oslo calendar date and the UTC calendar date disagree after midnight', () => {
  it('summer: the first two hours of every Oslo day are still "yesterday" in UTC', () => {
    expect(osloDateStr(BEFORE_MIDNIGHT)).toBe(MIDNIGHT_PREV_DATE);
    expect(utcDateStr(BEFORE_MIDNIGHT)).toBe(MIDNIGHT_PREV_DATE);

    expect(osloDateStr(AT_MIDNIGHT)).toBe(MIDNIGHT_DATE);
    expect(utcDateStr(AT_MIDNIGHT)).toBe(MIDNIGHT_PREV_DATE); // ← the whole point
    expect(osloDateStr(AFTER_MIDNIGHT)).toBe(MIDNIGHT_DATE);
    expect(utcDateStr(AFTER_MIDNIGHT)).toBe(MIDNIGHT_PREV_DATE);
  });

  it('winter: one hour instead of two, same defect', () => {
    expect(osloDateStr(BEFORE_WINTER_MIDNIGHT)).toBe('2026-01-14');
    expect(osloDateStr(AT_WINTER_MIDNIGHT)).toBe(WINTER_MIDNIGHT_DATE);
    expect(utcDateStr(AT_WINTER_MIDNIGHT)).toBe('2026-01-14');
  });

  it('`todayStr()` follows the Oslo calendar on both sides of midnight', async () => {
    expect(await at(BEFORE_MIDNIGHT, () => todayStr())).toBe(MIDNIGHT_PREV_DATE);
    expect(await at(AT_MIDNIGHT, () => todayStr())).toBe(MIDNIGHT_DATE);
    expect(await at(AFTER_MIDNIGHT, () => todayStr())).toBe(MIDNIGHT_DATE);
    // …and at the same three instants a UTC-derived "today" would be wrong.
    expect(await at(AT_MIDNIGHT, () => utcDateStr(new Date()))).toBe(MIDNIGHT_PREV_DATE);
  });

  it('`toDateStr` and `dbDateToStr` agree with ICU on both DST days', () => {
    for (const iso of [
      DST_FORWARD_MIDNIGHT,
      BEFORE_DST_FORWARD,
      AFTER_DST_FORWARD,
      DST_BACK_MIDNIGHT,
      DST_BACK_FIRST_PASS,
      DST_BACK_SECOND_PASS,
    ]) {
      const d = new Date(iso);
      expect(toDateStr(d), iso).toBe(osloDateStr(d));
      expect(dbDateToStr(d), iso).toBe(osloDateStr(d));
    }
  });
});

// ── Calendar arithmetic across the transitions ──────────────────────────────

describe('getRentalDateRange / rentalDayCount are calendar arithmetic, not hours', () => {
  it('a 7-day rental spanning the 23-hour day still has 7 distinct dates', () => {
    const range = getRentalDateRange(DST_FORWARD_PREV_DATE, 'week');
    expect(range).toEqual([
      '2026-03-28',
      '2026-03-29',
      '2026-03-30',
      '2026-03-31',
      '2026-04-01',
      '2026-04-02',
      '2026-04-03',
    ]);
    expect(new Set(range).size).toBe(7);
    expect(rentalDayCount('week')).toBe(7);
  });

  it('a 7-day rental spanning the 25-hour day still has 7 distinct dates', () => {
    const range = getRentalDateRange('2026-10-24', 'week');
    expect(range).toEqual([
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
    ]);
    expect(new Set(range).size).toBe(7);
  });

  it('a weekend starting the day before either transition is still three days', () => {
    expect(getRentalDateRange('2026-03-27', 'weekend')).toEqual([
      '2026-03-27',
      '2026-03-28',
      '2026-03-29',
    ]);
    expect(getRentalDateRange('2026-10-23', 'weekend')).toEqual([
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
    ]);
  });

  it('a multi-week rental crossing both transitions has one date per calendar day', () => {
    // 2026-03-23 + 8 weeks = 56 days, one spring-forward inside.
    const range = getRentalDateRange('2026-03-23', 'week', 56);
    expect(range).toHaveLength(56);
    expect(new Set(range).size).toBe(56);
    expect(range[range.length - 1]).toBe('2026-05-17');
  });

  it('addDays steps one calendar day at every awkward edge', () => {
    const edges: Array<[string, string]> = [
      ['2026-03-28', '2026-03-29'], // into the 23-hour day
      ['2026-03-29', '2026-03-30'], // out of it
      ['2026-10-24', '2026-10-25'], // into the 25-hour day
      ['2026-10-25', '2026-10-26'], // out of it
      ['2026-06-30', '2026-07-01'], // month end
      ['2026-12-31', '2027-01-01'], // year end
      ['2028-02-28', '2028-02-29'], // leap day
      ['2028-02-29', '2028-03-01'],
    ];
    for (const [from, to] of edges) {
      expect(addDays(from, 1), from).toBe(to);
      expect(addDays(to, -1), to).toBe(from);
      expect(nextOsloDate(from), from).toBe(to);
    }
  });

  it('parseDateStr anchors at noon, which is why none of the above drifts', () => {
    for (const day of [DST_FORWARD_DATE, DST_BACK_DATE, '2028-02-29']) {
      expect(parseDateStr(day).getHours(), day).toBe(12);
      expect(toDateStr(parseDateStr(day)), day).toBe(day);
    }
  });

  it('dateToDbMidnight round-trips on both transition days', () => {
    for (const day of [DST_FORWARD_DATE, DST_BACK_DATE, MIDNIGHT_DATE, '2028-02-29']) {
      expect(dbDateToStr(dateToDbMidnight(day)), day).toBe(day);
      expect(dateToDbMidnight(day).getHours(), day).toBe(0);
    }
  });
});

// ── The availability calendar on the two odd days ───────────────────────────

describe('/api/availability across the transitions and at local midnight', () => {
  async function monthFor(month: string, machineId: string, nowIso: string) {
    const { GET } = await import('@/app/api/availability/route');
    const { call } = await import('../helpers/route');
    return at(nowIso, async () => {
      const res = await call(GET, {
        method: 'GET',
        path: '/api/availability',
        searchParams: { month, machineId },
      });
      return res.json as {
        unavailableDates: string[];
        tentativeDates: string[];
        turnaroundDates: string[];
      };
    });
  }

  it('blocks the 23-hour day itself, not the day either side of it', async () => {
    await seedConfigDefaults({ ...PAYABLE, blockDayBeforeBooking: 'false', blockDayAfterBooking: 'false' });
    const m = await machine({ quantity: 1 });
    await booking('confirmed', { machineId: m.id, startDateStr: DST_FORWARD_DATE });

    const body = await monthFor('2026-03', m.id, '2026-03-01T12:00:00+01:00');
    expect(body.unavailableDates).toEqual([DST_FORWARD_DATE]);
  });

  it('blocks the 25-hour day itself, not the day either side of it', async () => {
    await seedConfigDefaults({ ...PAYABLE, blockDayBeforeBooking: 'false', blockDayAfterBooking: 'false' });
    const m = await machine({ quantity: 1 });
    await booking('confirmed', { machineId: m.id, startDateStr: DST_BACK_DATE });

    const body = await monthFor('2026-10', m.id, '2026-10-01T12:00:00+02:00');
    expect(body.unavailableDates).toEqual([DST_BACK_DATE]);
  });

  it('marks a week spanning the spring transition as exactly seven blocked days', async () => {
    await seedConfigDefaults({ ...PAYABLE, blockDayBeforeBooking: 'false', blockDayAfterBooking: 'false' });
    const m = await machine({ quantity: 1 });
    await booking('confirmed', {
      machineId: m.id,
      startDateStr: '2026-03-27',
      rentalType: 'week',
    });

    const body = await monthFor('2026-03', m.id, '2026-03-01T12:00:00+01:00');
    expect(body.unavailableDates).toEqual([
      '2026-03-27',
      '2026-03-28',
      '2026-03-29',
      '2026-03-30',
      '2026-03-31',
    ]);
  });

  it('a pending booking is tentative on the Oslo day, not the UTC one, at local midnight', async () => {
    await seedConfigDefaults({ ...PAYABLE, blockDayBeforeBooking: 'false', blockDayAfterBooking: 'false' });
    const m = await machine({ quantity: 1 });
    await booking('pending', {
      machineId: m.id,
      startDateStr: MIDNIGHT_DATE,
      paymentDeadline: new Date(Date.parse(AT_MIDNIGHT) + HOUR),
    });

    const body = await monthFor('2026-06', m.id, AT_MIDNIGHT);
    expect(body.tentativeDates).toEqual([MIDNIGHT_DATE]);
    expect(body.tentativeDates).not.toContain(MIDNIGHT_PREV_DATE);
  });
});

// ── The reminder cron on a 23-hour and a 25-hour day ────────────────────────

describe('cron/reminders — "tomorrow" on days that are not 24 hours long', () => {
  async function remindedAt(nowIso: string, startDateStr: string): Promise<number> {
    await resetDb();
    await seedConfigDefaults(PAYABLE);
    const m = await machine();
    await booking('confirmed', { machineId: m.id, startDateStr, reminderSentAt: null });

    const { GET } = await import('@/app/api/cron/reminders/route');
    const { call, cronBearer } = await import('../helpers/route');
    return at(nowIso, async () => {
      const res = await call(GET, {
        method: 'GET',
        path: '/api/cron/reminders',
        headers: { authorization: cronBearer() },
      });
      return (res.json as { sent: number }).sent;
    });
  }

  it('reminds the day before the 23-hour day', async () => {
    expect(await remindedAt('2026-03-28T09:00:00+01:00', DST_FORWARD_DATE)).toBe(1);
  });

  it('reminds from inside the 23-hour day, after the jump', async () => {
    expect(await remindedAt('2026-03-29T09:00:00+02:00', '2026-03-30')).toBe(1);
  });

  it('reminds the day before the 25-hour day', async () => {
    expect(await remindedAt('2026-10-24T09:00:00+02:00', DST_BACK_DATE)).toBe(1);
  });

  it('reminds from inside the 25-hour day, in the repeated hour', async () => {
    expect(await remindedAt(DST_BACK_SECOND_PASS, '2026-10-26')).toBe(1);
  });

  it('does not remind for today, or for the day after tomorrow', async () => {
    expect(await remindedAt('2026-03-28T09:00:00+01:00', '2026-03-28')).toBe(0);
    expect(await remindedAt('2026-03-28T09:00:00+01:00', '2026-03-30')).toBe(0);
  });

  it('flips "tomorrow" at Oslo local midnight, not at 22:00', async () => {
    expect(await remindedAt(BEFORE_MIDNIGHT, MIDNIGHT_DATE)).toBe(1);
    expect(await remindedAt(AT_MIDNIGHT, MIDNIGHT_DATE)).toBe(0);
    expect(await remindedAt(AT_MIDNIGHT, '2026-06-16')).toBe(1);
    expect(await remindedAt(AFTER_MIDNIGHT, '2026-06-16')).toBe(1);
  });
});

// ── Renter checklist intervals ──────────────────────────────────────────────

describe('computeIntervalInfo — daily keys are calendar days', () => {
  const bookingRow = {
    startDate: dateToDbMidnight('2026-06-14'),
    rentalType: 'week',
    customDays: null,
  };
  const daily = { intervalMode: 'daily', intervalHours: null };

  it('the daily key flips at Oslo local midnight, to the millisecond', async () => {
    const before = await at(BEFORE_MIDNIGHT, () => computeIntervalInfo(daily, bookingRow));
    const edge = await at(AT_MIDNIGHT, () => computeIntervalInfo(daily, bookingRow));
    const after = await at(AFTER_MIDNIGHT, () => computeIntervalInfo(daily, bookingRow));

    expect(before.key).toBe(`day-${MIDNIGHT_PREV_DATE}`);
    expect(edge.key).toBe(`day-${MIDNIGHT_DATE}`);
    expect(after.key).toBe(`day-${MIDNIGHT_DATE}`);
    // …and the day number the renter is shown moves with it.
    expect(before.slotIndex).toBe(1);
    expect(edge.slotIndex).toBe(2);
  });

  it('produces one key per calendar day across the 23-hour day', async () => {
    const row = { startDate: dateToDbMidnight('2026-03-28'), rentalType: 'week', customDays: null };
    const keys: string[] = [];
    for (const day of ['2026-03-28', '2026-03-29', '2026-03-30']) {
      keys.push((await at(`${day}T12:00:00`, () => computeIntervalInfo(daily, row))).key);
    }
    expect(keys).toEqual(['day-2026-03-28', 'day-2026-03-29', 'day-2026-03-30']);
    expect(new Set(keys).size).toBe(3);
  });

  it('produces one key per calendar day across the 25-hour day, including the repeated hour', async () => {
    const row = { startDate: dateToDbMidnight('2026-10-24'), rentalType: 'week', customDays: null };
    const first = await at(DST_BACK_FIRST_PASS, () => computeIntervalInfo(daily, row));
    const second = await at(DST_BACK_SECOND_PASS, () => computeIntervalInfo(daily, row));
    // 02:59 CEST and 02:00 CET are the same calendar day, so the same key —
    // which is what stops the renter being asked twice in the repeated hour.
    expect(first.key).toBe('day-2026-10-25');
    expect(second.key).toBe('day-2026-10-25');
  });
});

describe('computeIntervalInfo — `hours` mode measures elapsed hours, not wall clock', () => {
  const row = { startDate: dateToDbMidnight('2026-03-28'), rentalType: 'week', customDays: null };
  const every24h = { intervalMode: 'hours', intervalHours: 24 };

  it('anchors at 07:00 local on the start day', async () => {
    expect((await at('2026-03-28T07:00:00+01:00', () => computeIntervalInfo(every24h, row))).key).toBe('h0');
    expect((await at('2026-03-28T06:59:59.999+01:00', () => computeIntervalInfo(every24h, row))).key).toBe('h0');
  });

  it('rolls over 24 *elapsed* hours later — 08:00 local, because the day was 23 h long', async () => {
    // Documented, not filed: the mode is "every N hours" and an elapsed-hours
    // interval is the right meaning for a machine check. The consequence worth
    // knowing is that the wall-clock time of the check shifts by an hour twice
    // a year.
    const at0700 = await at('2026-03-29T07:00:00+02:00', () => computeIntervalInfo(every24h, row));
    const at0759 = await at('2026-03-29T07:59:59.999+02:00', () => computeIntervalInfo(every24h, row));
    const at0800 = await at('2026-03-29T08:00:00+02:00', () => computeIntervalInfo(every24h, row));

    expect(at0700.key).toBe('h0'); // 23 elapsed hours
    expect(at0759.key).toBe('h0');
    expect(at0800.key).toBe('h1'); // 24 elapsed hours
    expect(at0800.label).toBe('Kontroll 2 (hver 24 t)');
  });

  it('never produces a duplicate key inside the repeated autumn hour', async () => {
    // Anchored on 2026-10-24 07:00 CEST, so both 02:30s on the 25th are past
    // the rental start and produce a real elapsed-hour slot.
    const octRow = { startDate: dateToDbMidnight('2026-10-24'), rentalType: 'week', customDays: null };
    const every1h = { intervalMode: 'hours', intervalHours: 1 };
    const first = await at('2026-10-25T02:30:00+02:00', () => computeIntervalInfo(every1h, octRow));
    const second = await at('2026-10-25T02:30:00+01:00', () => computeIntervalInfo(every1h, octRow));
    // The two 02:30s are an hour apart in real time, so they are different
    // slots — the renter is asked once per elapsed hour, as configured, and the
    // repeated hour cannot collide with the submission already stored.
    expect(first.key).toBe('h19');
    expect(second.key).toBe('h20');
  });
});

// ── Token lifetimes are epoch arithmetic, so DST cannot touch them ──────────

describe('signed-token lifetimes are DST-immune', () => {
  it('the delivery quote token still lasts exactly 6 h across the spring-forward', async () => {
    const quote = { address: 'Testveien 1, 8000 Bodø', distance: 12.5, fee: 0 };
    const token = await at(BEFORE_DST_FORWARD, () => signDeliveryQuoteToken(quote));
    const sixHours = 6 * HOUR;

    const justInside = new Date(Date.parse(BEFORE_DST_FORWARD) + sixHours).toISOString();
    const justOutside = new Date(Date.parse(BEFORE_DST_FORWARD) + sixHours + 1).toISOString();
    expect(await at(justInside, () => verifyDeliveryQuoteToken(token, quote))).toBe(true);
    expect(await at(justOutside, () => verifyDeliveryQuoteToken(token, quote))).toBe(false);
    // Wall-clock: minted at 01:59:59.999 CET, dies at 08:59:59.999 CEST — seven
    // wall-clock hours later, six real ones.
    expect(osloOffsetMinutes(justInside)).toBe(120);
  });

  it('the renter session still lasts exactly 4 h across the autumn fall-back', async () => {
    const token = await at(DST_BACK_FIRST_PASS, () => createRenterSessionToken('bk-1', '40000000'));
    const fourHours = 4 * HOUR;
    const inside = new Date(Date.parse(DST_BACK_FIRST_PASS) + fourHours).toISOString();
    const outside = new Date(Date.parse(DST_BACK_FIRST_PASS) + fourHours + 1).toISOString();
    expect(await at(inside, () => verifyRenterSessionToken(token))).not.toBeNull();
    expect(await at(outside, () => verifyRenterSessionToken(token))).toBeNull();
  });

  it('the admin session still lasts exactly 7 d across a transition', async () => {
    const token = await at('2026-03-26T12:00:00+01:00', () => createSessionToken());
    const sevenDays = 7 * DAY;
    const base = Date.parse('2026-03-26T12:00:00+01:00');
    expect(await at(new Date(base + sevenDays).toISOString(), () => verifySessionToken(token))).toBe(true);
    expect(await at(new Date(base + sevenDays + 1).toISOString(), () => verifySessionToken(token))).toBe(false);
    // The expiry lands at 13:00 local, not 12:00 — 7 × 24 h, not 7 calendar days.
    expect(osloDateStr(base + sevenDays)).toBe('2026-04-02');
    expect(osloOffsetMinutes(base + sevenDays)).toBe(120);
  });

  it('the TOTP 30-second step follows epoch time, not the wall clock', async () => {
    // No enrolment anywhere: verifyTotpCodeAgainst takes the secret directly.
    // 03:00:05 CEST is one millisecond-scale hop past the spring-forward jump,
    // and comfortably inside one 30-second step (01:00:00–01:00:29 UTC).
    const inStep = '2026-03-29T03:00:05.000+02:00';
    const sameStep = '2026-03-29T03:00:25.000+02:00';
    const nextStep = '2026-03-29T03:00:35.000+02:00';

    const code = await at(inStep, () => totpCodeFor(TEST_TOTP_SECRET));
    expect(await at(inStep, () => verifyTotpCodeAgainst(TEST_TOTP_SECRET, code))).toBe(true);
    expect(await at(sameStep, () => verifyTotpCodeAgainst(TEST_TOTP_SECRET, code))).toBe(true);
    expect(await at(nextStep, () => verifyTotpCodeAgainst(TEST_TOTP_SECRET, code))).toBe(false);

    // Across the jump itself the wall clock moves an hour and epoch time moves
    // one millisecond — and the step index moves by exactly one, because that
    // millisecond happens to cross a 30-second boundary. The hour is irrelevant.
    expect(totpStep(Date.parse(AFTER_DST_FORWARD)) - totpStep(Date.parse(BEFORE_DST_FORWARD))).toBe(1);
  });
});

// ── The cancellation window is hours, but the label says days ───────────────

describe('cancellation free window across a transition', () => {
  const FEE_CONFIG = {
    ...PAYABLE,
    cancelFreeWeeks: '0',
    cancelFreeDays: '2',
    cancelLatePercent: '50',
    cancelSameDayPercent: '100',
  };

  async function feeAt(startDateStr: string, nowIso: string): Promise<number | null> {
    await resetDb();
    await seedConfigDefaults(FEE_CONFIG);
    const m = await machine();
    const b = await booking('confirmed', {
      machineId: m.id,
      startDateStr,
      basePrice: 2490,
      totalPrice: 2490,
      fullyPaidAt: new Date('2026-01-01T10:00:00+01:00'),
    });
    return at(nowIso, async () => (await updateBookingStatus(b.id, 'cancelled')).cancellationFee);
  }

  it('is free two whole calendar days before a rental with no transition in between', async () => {
    expect(await feeAt('2026-06-15', '2026-06-13T00:00:00+02:00')).toBeNull();
  });

  // FIXED V-5: `getCancelFreeHours` turned the admin's "2 dager" into a fixed
  // 48 hours and `hoursUntil` is real elapsed hours, so when the 23-hour spring
  // day sat inside the window "two days before" was only 47 elapsed hours and
  // the customer was charged the 50 % late fee at a wall-clock moment the
  // policy label ("Gratis avbestilling inntil 2 dager før") called free.
  // `evaluateCancellationPolicy` now anchors the cutoff at local midnight of
  // the start day minus the window in CALENDAR days, so the promise holds in
  // both DST directions.
  it('is free two whole calendar days before a rental across the spring transition', async () => {
    // 2026-03-30 00:00 CEST minus two *calendar* days is 2026-03-28 00:00 CET,
    // which is only 47 elapsed hours because 2026-03-29 is 23 h long.
    expect(await feeAt('2026-03-30', '2026-03-28T00:00:00+01:00')).toBeNull();
  });

  it('and the autumn window is exactly two calendar days too, not 49 hours', async () => {
    // 2026-10-24 00:00 CEST → 2026-10-26 00:00 CET is 49 ELAPSED hours, which
    // used to make a cancellation half an hour past the cutoff still free.
    // The cutoff is 2026-10-24 00:00 local either way now.
    expect(await feeAt('2026-10-26', '2026-10-23T23:30:00+02:00')).toBeNull();
    expect(await feeAt('2026-10-26', '2026-10-24T00:30:00+02:00')).toBe(1245);
  });

  it('the same-day rule uses the calendar day, so it is unaffected by either transition', async () => {
    expect(await feeAt(DST_FORWARD_DATE, `${DST_FORWARD_DATE}T00:00:00+01:00`)).toBe(2490);
    expect(await feeAt(DST_FORWARD_DATE, `${DST_FORWARD_DATE}T23:59:59.999+02:00`)).toBe(2490);
    expect(await feeAt(DST_BACK_DATE, DST_BACK_FIRST_PASS)).toBe(2490);
    expect(await feeAt(DST_BACK_DATE, DST_BACK_SECOND_PASS)).toBe(2490);
  });
});

// ── The date-lock table on the odd days ─────────────────────────────────────

describe('BookingDateLock rows land on the right calendar day', () => {
  it('a week spanning either transition produces seven distinct lock dates', async () => {
    await seedConfigDefaults(PAYABLE);
    const m = await machine({ quantity: 1 });
    const b = await booking('confirmed', {
      machineId: m.id,
      startDateStr: '2026-03-27',
      rentalType: 'week',
    });
    const locks = await db.bookingDateLock.findMany({
      where: { bookingId: b.id },
      orderBy: { date: 'asc' },
    });
    expect(locks.map((l) => dbDateToStr(l.date))).toEqual([
      '2026-03-27',
      '2026-03-28',
      '2026-03-29',
      '2026-03-30',
      '2026-03-31',
      '2026-04-01',
      '2026-04-02',
    ]);
    expect(new Set(locks.map((l) => l.date.getTime())).size).toBe(7);

    await db.bookingDateLock.deleteMany({});
    await db.booking.deleteMany({});
  });
});
