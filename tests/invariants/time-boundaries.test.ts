/**
 * L3i — area V: every deadline in this product, probed one unit before its
 * edge, at the edge, and one unit after.
 *
 * A deadline is a comparison operator. `<` and `<=` differ by one millisecond,
 * and one millisecond is the difference between a booking being swept and
 * surviving, between a free cancellation and a 50 % fee, between a token that
 * opens and one that 410s. None of those operators is documented anywhere but
 * in the expression itself, so each one is pinned here at exactly the width it
 * is wrong at.
 *
 * Named instants live in `./time-clock.ts`; `at(iso, fn)` freezes the clock
 * around a probe and restores it.
 *
 * Already pinned elsewhere, referenced rather than repeated:
 *   · delivery-quote token, 6 h, valid at −1 ms and refused at +1 ms —
 *     `tests/api/delivery.test.ts` (phase 1b).
 *   · renter session, 4 h, inclusive of the boundary instant —
 *     `tests/lib/renter-session.test.ts`.
 *   · admin session, 7 d — `tests/lib/admin-auth-session.test.ts`.
 *   · TOTP 30 s step, no tolerance window — `tests/lib/totp.test.ts`.
 *   · cancel token 30 d as the /api/booking/cancel route reads it, and the
 *     cancellation fee table at hour granularity — phase 1c.
 *   · `paymentDeadline === now` as /api/availability and
 *     `getUnavailableDateStringsForRange` read it — phase 1b.
 * The probes below are the ones those files do not make.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, utimes, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  booking,
  campaignCode,
  db,
  machine,
  repeatCode,
  resetDb,
  seedConfigDefaults,
} from '../helpers/db';
import { bookingInput, toQuoteInputs } from '../helpers/booking';
import { expectNoOrphanLocks } from '../helpers/invariants';
import { TEST_DB_FILE } from '../setup';
import type { RouteHandler } from '../helpers/route';
import {
  AT_MIDNIGHT,
  AFTER_MIDNIGHT,
  AT_MONTH_END,
  AFTER_MONTH_END,
  BEFORE_MIDNIGHT,
  BEFORE_MONTH_END,
  MIDNIGHT_DATE,
  MIDNIGHT_PREV_DATE,
  at,
} from './time-clock';
import { dateToDbMidnight } from '@/lib/availability';
import { updateBookingStatus, generateBookingReference } from '@/lib/booking-service';
import { buildQuote } from '@/lib/domain/quote';
import { validateRepeatCode } from '@/lib/discount-engine';

vi.mock('@/lib/email', async () => (await import('../helpers/mocks')).mockEmail());
vi.mock('@/lib/stripe', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  // Cancelling a confirmed, paid booking would otherwise reach the refund
  // helper; the fee is what this file is about, not the refund.
  return { ...actual, refundBookingPayment: vi.fn(async () => null) };
});

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

// ── V.1 · paymentDeadline, as the cleanup sweep reads it ────────────────────

describe('runCleanup — paymentDeadline expiry', () => {
  /** One pending booking whose deadline sits `offsetMs` from the probe instant. */
  async function pendingWithDeadline(nowIso: string, offsetMs: number) {
    const m = await machine();
    return booking('pending', {
      machineId: m.id,
      startDateStr: '2026-07-20',
      paymentDeadline: new Date(Date.parse(nowIso) + offsetMs),
    });
  }

  async function sweep(nowIso: string): Promise<string> {
    return at(nowIso, async () => {
      const { runCleanup } = await import('@/lib/cleanup');
      await runCleanup();
      const rows = await db.booking.findMany();
      return rows[0].status;
    });
  }

  it('cancels a booking whose deadline passed by one millisecond', async () => {
    await seedConfigDefaults(PAYABLE);
    await pendingWithDeadline(AT_MIDNIGHT, -1);
    expect(await sweep(AT_MIDNIGHT)).toBe('cancelled');
  });

  // The sweep OWNS the deadline instant (see V-2 below): a booking is expired
  // strictly after its `paymentDeadline`, and the calendar and the conflict
  // check both read it that way now.
  it('keeps a booking whose deadline is exactly now — the sweep is strictly `<`', async () => {
    await seedConfigDefaults(PAYABLE);
    await pendingWithDeadline(AT_MIDNIGHT, 0);
    expect(await sweep(AT_MIDNIGHT)).toBe('pending');
  });

  it('keeps a booking one millisecond before its deadline', async () => {
    await seedConfigDefaults(PAYABLE);
    await pendingWithDeadline(AT_MIDNIGHT, 1);
    expect(await sweep(AT_MIDNIGHT)).toBe('pending');
  });

  it('releases the date locks when it does cancel', async () => {
    await seedConfigDefaults(PAYABLE);
    await pendingWithDeadline(AT_MIDNIGHT, -1);
    await sweep(AT_MIDNIGHT);
    expect(await db.bookingDateLock.count()).toBe(0);
    await expectNoOrphanLocks();
  });

  it('falls back to createdAt + 60 min for a booking with no deadline at all', async () => {
    await seedConfigDefaults(PAYABLE);
    const hour = 60 * 60 * 1000;
    const m = await machine();
    // Exactly 60 minutes old: `createdAt < staleCutoff` is strict, so it stays.
    await booking('pending', {
      machineId: m.id,
      startDateStr: '2026-07-20',
      paymentDeadline: null,
      createdAt: new Date(Date.parse(AT_MIDNIGHT) - hour),
    });
    expect(await sweep(AT_MIDNIGHT)).toBe('pending');

    await db.booking.updateMany({
      data: { createdAt: new Date(Date.parse(AT_MIDNIGHT) - hour - 1) },
    });
    expect(await sweep(AT_MIDNIGHT)).toBe('cancelled');
  });

  // FIXED V-2: at `paymentDeadline === now` the calendar had already released
  // the day (both /api/availability and getUnavailableDateStringsForRange read
  // `<= now` as expired) while the sweep's strict `<` had not yet cancelled the
  // booking, so its BookingDateLock rows still held the slot: the day was
  // offered as free and the submit refused with "opptatt".
  //
  // `runCleanup` now owns the instant — a booking is expired strictly AFTER
  // its deadline — and both readers were moved onto that side of it. The wider
  // gap between an expiry and the next sweep (throttled to once a minute, and
  // traffic-driven) is inherent to the lazy sweep and is not what this pins.
  it('an expired pending booking never leaves the calendar and the lock table disagreeing', async () => {
    await seedConfigDefaults(PAYABLE);
    const m = await machine({ quantity: 1 });
    const start = '2026-07-20';
    await booking('pending', {
      machineId: m.id,
      startDateStr: start,
      paymentDeadline: new Date(Date.parse(AT_MIDNIGHT)),
    });

    await at(AT_MIDNIGHT, async () => {
      const { getUnavailableDateStringsForRange } = await import('@/lib/booking-service');
      const conflicts = await getUnavailableDateStringsForRange([start], undefined, m.id);
      const heldSlots = await db.bookingDateLock.count({
        where: { machineId: m.id, date: dateToDbMidnight(start) },
      });
      // Either the day is a conflict, or the slot is free. Never "free but held".
      expect(conflicts.length === 0 && heldSlots > 0).toBe(false);
    });
  });
});

// ── V.2 · the cancellation free window and the same-day fee ─────────────────

describe('updateBookingStatus — cancellation fee boundaries', () => {
  const START = '2026-06-15'; // Oslo local midnight
  const FEE_CONFIG = {
    ...PAYABLE,
    cancelFreeWeeks: '0',
    cancelFreeDays: '2', // 48 hours
    cancelLatePercent: '50',
    cancelSameDayPercent: '100',
  };

  /** Cancel a confirmed 2 490 kr booking at `nowIso`; return the fee written. */
  async function feeAt(nowIso: string): Promise<number | null> {
    await resetDb();
    await seedConfigDefaults(FEE_CONFIG);
    const m = await machine();
    const b = await booking('confirmed', {
      machineId: m.id,
      startDateStr: START,
      basePrice: 2490,
      totalPrice: 2490,
      fullyPaidAt: new Date('2026-06-01T10:00:00+02:00'),
    });
    return at(nowIso, async () => {
      const updated = await updateBookingStatus(b.id, 'cancelled');
      return updated.cancellationFee;
    });
  }

  // 48 h before Oslo midnight on the 15th is Oslo midnight on the 13th.
  it('is free one millisecond before the free-window cutoff', async () => {
    expect(await feeAt('2026-06-12T23:59:59.999+02:00')).toBeNull();
  });

  it('is free exactly at the cutoff — `hoursUntil < free` is strict', async () => {
    expect(await feeAt('2026-06-13T00:00:00.000+02:00')).toBeNull();
  });

  it('charges the late fee one millisecond after the cutoff', async () => {
    expect(await feeAt('2026-06-13T00:00:00.001+02:00')).toBe(1245);
  });

  it('still charges only the late fee at the last millisecond of the day before', async () => {
    expect(await feeAt(`${MIDNIGHT_PREV_DATE}T23:59:59.999+02:00`)).toBe(1245);
  });

  it('charges the full same-day fee from local midnight of the start day', async () => {
    expect(await feeAt(`${MIDNIGHT_DATE}T00:00:00.000+02:00`)).toBe(2490);
  });

  it('is still the full fee one millisecond into the start day', async () => {
    expect(await feeAt(`${MIDNIGHT_DATE}T00:00:00.001+02:00`)).toBe(2490);
  });

  it('uses the Oslo day, not the UTC day, to decide "today"', async () => {
    // 2026-06-15T00:30+02:00 is still 2026-06-14 in UTC. A UTC-based
    // `todayMidnight` would call this "the day before" and charge 50 %.
    expect(await feeAt('2026-06-15T00:30:00.000+02:00')).toBe(2490);
    expect(await feeAt('2026-06-14T23:30:00.000+02:00')).toBe(1245);
  });
});

// ── V.3 · the booking horizon, at the day edges ─────────────────────────────

describe('minBookingDaysAhead — the earliest bookable day flips at Oslo midnight', () => {
  async function reasonAt(nowIso: string, startDate: string): Promise<string | null> {
    return at(nowIso, async () => {
      const quote = await buildQuote(
        toQuoteInputs(bookingInput({ startDate, selfPickup: true, deliveryDistance: 0, deliveryFee: 0 })),
      );
      return quote.blockedReason;
    });
  }

  beforeEach(async () => {
    await seedConfigDefaults({
      ...PAYABLE,
      minBookingDaysAhead: '2',
      dayAllowedDays: '1,2,3,4,5,6,7',
      bookingMaxAdvanceDays: '365',
    });
  });

  it('at 23:59:59.999 the earliest day is today + 2', async () => {
    expect(await reasonAt(BEFORE_MIDNIGHT, '2026-06-16')).toBeNull();
    expect(await reasonAt(BEFORE_MIDNIGHT, '2026-06-15')).toMatch(/minst 2 dager/);
  });

  it('at exactly local midnight the window has moved one whole day', async () => {
    expect(await reasonAt(AT_MIDNIGHT, '2026-06-17')).toBeNull();
    expect(await reasonAt(AT_MIDNIGHT, '2026-06-16')).toMatch(/minst 2 dager/);
  });

  it('one millisecond past midnight behaves like midnight, not like the day before', async () => {
    expect(await reasonAt(AFTER_MIDNIGHT, '2026-06-17')).toBeNull();
    expect(await reasonAt(AFTER_MIDNIGHT, '2026-06-16')).toMatch(/minst 2 dager/);
  });
});

describe('bookingMaxAdvanceDays — the far edge of the horizon', () => {
  async function reasonAt(nowIso: string, startDate: string): Promise<string | null> {
    return at(nowIso, async () => {
      const quote = await buildQuote(
        toQuoteInputs(bookingInput({ startDate, selfPickup: true, deliveryDistance: 0, deliveryFee: 0 })),
      );
      return quote.blockedReason;
    });
  }

  beforeEach(async () => {
    await seedConfigDefaults({
      ...PAYABLE,
      minBookingDaysAhead: '0',
      dayAllowedDays: '1,2,3,4,5,6,7',
      bookingMaxAdvanceDays: '30',
    });
  });

  it('accepts exactly N calendar days ahead and refuses N + 1, inside one DST regime', async () => {
    // 2026-06-15 → 2026-07-15 is 30 days with no transition in between.
    expect(await reasonAt(AT_MIDNIGHT, '2026-07-15')).toBeNull();
    expect(await reasonAt(AT_MIDNIGHT, '2026-07-16')).toMatch(/mer enn 30 dager/);
  });

  it('holds at every hour of the day, not just at midnight', async () => {
    expect(await reasonAt('2026-06-15T23:59:59.999+02:00', '2026-07-15')).toBeNull();
    expect(await reasonAt('2026-06-15T23:59:59.999+02:00', '2026-07-16')).toMatch(/mer enn 30/);
  });

  // FIXED V-3: the horizon was measured in fixed 86 400 000 ms units
  // (`(start − now) / 86_400_000 > maxAdvanceDays`), but a calendar day is not
  // always 86 400 000 ms. A window containing the October fall-back is 25 hours
  // long on that day, so a start date exactly `bookingMaxAdvanceDays` *calendar*
  // days out measures 30.0417 and is refused. Same code, same defect, in
  // `checkBookable` (quote.ts:164) and `createPendingBooking`
  // (booking-service.ts:439) — so the preview and the submit agree with each
  // other and both refuse a date the setting says is bookable.
  it('accepts exactly N calendar days ahead across the autumn transition too', async () => {
    // 2026-10-10 → 2026-11-09 is exactly 30 calendar days, and 2026-10-25 (a
    // 25-hour day) is inside the window.
    expect(await reasonAt('2026-10-10T00:00:00.000+02:00', '2026-11-09')).toBeNull();
  });

  it('holds across the spring transition as well — 30 calendar days either way', async () => {
    // 2026-03-15 → 2026-04-14 is 30 calendar days across a 23-hour day. The old
    // arithmetic measured 29.96 and let it through by accident; `calendarDaysUntil`
    // measures 30 and lets it through on purpose.
    expect(await reasonAt('2026-03-15T00:00:00.000+01:00', '2026-04-14')).toBeNull();
    expect(await reasonAt('2026-03-15T00:00:00.000+01:00', '2026-04-15')).toMatch(/mer enn 30/);
  });
});

// ── V.4 · code and token lifetimes ──────────────────────────────────────────

describe('discount code expiry — `expiresAt < now`', () => {
  beforeEach(async () => {
    await seedConfigDefaults({ ...PAYABLE, enableRepeatDiscount: 'true', repeatDiscountPercent: '10' });
  });

  async function repeatOkAt(nowIso: string, offsetMs: number): Promise<boolean> {
    await db.repeatDiscountCode.deleteMany({});
    await repeatCode({
      code: 'RETUR-EXPIRY1',
      email: 'test@example.com',
      expiresAt: new Date(Date.parse(nowIso) + offsetMs),
    });
    return at(nowIso, async () => {
      const result = await validateRepeatCode('RETUR-EXPIRY1', 'test@example.com');
      return result.ok;
    });
  }

  it('accepts a repeat code one millisecond before it expires', async () => {
    expect(await repeatOkAt(AT_MIDNIGHT, 1)).toBe(true);
  });

  it('accepts a repeat code expiring exactly now — the comparison is strict', async () => {
    expect(await repeatOkAt(AT_MIDNIGHT, 0)).toBe(true);
  });

  it('refuses a repeat code that expired one millisecond ago', async () => {
    expect(await repeatOkAt(AT_MIDNIGHT, -1)).toBe(false);
  });

  it('honours the documented 365-day window exactly', async () => {
    const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
    // Issued at Oslo midsummer midnight, so the window closes 365×24 h later —
    // one hour before the same wall-clock time, because the intervening year
    // contains one more fall-back than spring-forward for this span.
    await db.repeatDiscountCode.deleteMany({});
    await repeatCode({
      code: 'RETUR-YEAR1',
      email: 'test@example.com',
      expiresAt: new Date(Date.parse(AT_MIDNIGHT) + YEAR_MS),
    });
    const last = await at(new Date(Date.parse(AT_MIDNIGHT) + YEAR_MS).toISOString(), () =>
      validateRepeatCode('RETUR-YEAR1', 'test@example.com'),
    );
    const past = await at(new Date(Date.parse(AT_MIDNIGHT) + YEAR_MS + 1).toISOString(), () =>
      validateRepeatCode('RETUR-YEAR1', 'test@example.com'),
    );
    expect(last.ok).toBe(true);
    expect(past.ok).toBe(false);
    expect(past.ok === false && past.reason).toBe('expired');
  });

  it('applies the same three probes to a campaign code', async () => {
    const probe = async (offsetMs: number) => {
      await db.campaignDiscountCode.deleteMany({});
      await campaignCode({
        code: 'SOMMER-EXP',
        expiresAt: new Date(Date.parse(AT_MIDNIGHT) + offsetMs),
      });
      return at(AT_MIDNIGHT, () => validateRepeatCode('SOMMER-EXP', 'test@example.com'));
    };
    expect((await probe(1)).ok).toBe(true);
    expect((await probe(0)).ok).toBe(true);
    expect((await probe(-1)).ok).toBe(false);
  });
});

describe('cancel-token sweep — `cancelTokenExpiry < now`', () => {
  // Phase 1c pinned the *reading* side (POST /api/booking/cancel: valid at
  // exactly now, 410 one millisecond later). This is the writing side: the
  // sweep that nulls the token must not run one millisecond early, or a live
  // cancel link dies while the route would still have honoured it.
  async function sweptAt(offsetMs: number): Promise<boolean> {
    await resetDb();
    await seedConfigDefaults(PAYABLE);
    const m = await machine();
    await booking('confirmed', {
      machineId: m.id,
      startDateStr: '2026-07-20',
      cancelToken: 'live-token',
      cancelTokenExpiry: new Date(Date.parse(AT_MIDNIGHT) + offsetMs),
    });
    return at(AT_MIDNIGHT, async () => {
      const { runCleanup } = await import('@/lib/cleanup');
      await runCleanup();
      const row = await db.booking.findFirstOrThrow();
      return row.cancelToken === null;
    });
  }

  it('keeps a token expiring one millisecond from now', async () => {
    expect(await sweptAt(1)).toBe(false);
  });

  it('keeps a token expiring exactly now — matching what the cancel route still accepts', async () => {
    expect(await sweptAt(0)).toBe(false);
  });

  it('clears a token that expired one millisecond ago', async () => {
    expect(await sweptAt(-1)).toBe(true);
  });
});

describe('orphan upload sweep — the 24-hour grace period', () => {
  const uploadDir = path.join(path.dirname(TEST_DB_FILE), 'uploads');
  const DAY_MS = 24 * 60 * 60 * 1000;

  afterEach(async () => {
    await rm(uploadDir, { recursive: true, force: true });
  });

  /** Drop one unreferenced file with the given age and sweep. */
  async function survivesWithAge(ageMs: number): Promise<boolean> {
    await rm(uploadDir, { recursive: true, force: true });
    await mkdir(uploadDir, { recursive: true });
    const file = path.join(uploadDir, 'orphan.jpg');
    await writeFile(file, 'not-a-real-jpeg');

    const now = Date.parse(AT_MIDNIGHT);
    const mtime = new Date(now - ageMs);
    await utimes(file, mtime, mtime);

    return at(AT_MIDNIGHT, async () => {
      const { cleanupOrphanUploads } = await import('@/lib/cleanup');
      await cleanupOrphanUploads();
      return (await readdir(uploadDir)).includes('orphan.jpg');
    });
  }

  it('keeps a file one millisecond younger than the grace period', async () => {
    expect(await survivesWithAge(DAY_MS - 1)).toBe(true);
  });

  it('deletes a file exactly 24 hours old — the guard is `age < grace`', async () => {
    expect(await survivesWithAge(DAY_MS)).toBe(false);
  });

  it('deletes a file one millisecond older', async () => {
    expect(await survivesWithAge(DAY_MS + 1)).toBe(false);
  });

  it('never deletes a file a booking still references, however old', async () => {
    await rm(uploadDir, { recursive: true, force: true });
    await mkdir(uploadDir, { recursive: true });
    await writeFile(path.join(uploadDir, 'kept.jpg'), 'x');
    const old = new Date(Date.parse(AT_MIDNIGHT) - 30 * DAY_MS);
    await utimes(path.join(uploadDir, 'kept.jpg'), old, old);

    const m = await machine();
    await booking('confirmed', {
      machineId: m.id,
      startDateStr: '2026-07-20',
      checklistData: JSON.stringify({ photo: ['/api/uploads/kept.jpg'] }),
    });

    await at(AT_MIDNIGHT, async () => {
      const { cleanupOrphanUploads } = await import('@/lib/cleanup');
      const removed = await cleanupOrphanUploads();
      expect(removed).toBe(0);
    });
    expect(await readdir(uploadDir)).toContain('kept.jpg');
  });
});

describe('offer validity — POST /api/tilbud/[token]', () => {
  async function acceptAt(nowIso: string, offsets: { token: number; offer: number }) {
    await resetDb();
    await seedConfigDefaults(PAYABLE);
    const m = await machine();
    const q = await db.quoteRequest.create({
      data: {
        reference: 'FT-2606-EXP',
        company: 'Test AS',
        orgNumber: '999999999',
        contactName: 'Test',
        email: 'firma@example.com',
        phone: '+4740000000',
        machineId: m.id,
        startDate: dateToDbMidnight('2026-07-20'),
        rentalType: 'day',
        status: 'tilbud_sendt',
        offerAmount: 5000,
        paymentMode: 'invoice',
        acceptToken: 'offer-token',
        acceptTokenExpiry: new Date(Date.parse(nowIso) + offsets.token),
        offerValidUntil: new Date(Date.parse(nowIso) + offsets.offer),
      },
    });
    const { POST } = await import('@/app/api/tilbud/[token]/route');
    const { call } = await import('../helpers/route');
    const res = await at(nowIso, () =>
      call(POST as unknown as RouteHandler, {
        method: 'POST',
        path: '/api/tilbud/offer-token',
        params: { token: 'offer-token' },
        body: { action: 'accept' },
      }),
    );
    const after = await db.quoteRequest.findUniqueOrThrow({ where: { id: q.id } });
    return { status: res.status, quoteStatus: after.status };
  }

  it('accepts an offer whose token and validity are one millisecond in the future', async () => {
    const r = await acceptAt(AT_MIDNIGHT, { token: 1, offer: 1 });
    expect(r.status).toBe(200);
    expect(r.quoteStatus).toBe('konvertert');
  });

  it('accepts an offer expiring exactly now — both comparisons are strict', async () => {
    const r = await acceptAt(AT_MIDNIGHT, { token: 0, offer: 0 });
    expect(r.status).toBe(200);
    expect(r.quoteStatus).toBe('konvertert');
  });

  it('410s and marks the offer utlopt one millisecond later', async () => {
    const r = await acceptAt(AT_MIDNIGHT, { token: -1, offer: -1 });
    expect(r.status).toBe(410);
    expect(r.quoteStatus).toBe('utlopt');
  });

  it('either half expiring alone is enough to close the offer', async () => {
    expect((await acceptAt(AT_MIDNIGHT, { token: -1, offer: 60_000 })).status).toBe(410);
    expect((await acceptAt(AT_MIDNIGHT, { token: 60_000, offer: -1 })).status).toBe(410);
  });
});

// ── V.5 · month end ─────────────────────────────────────────────────────────

describe('generateBookingReference — the month window', () => {
  it('numbers sequentially within a month', async () => {
    // `createdAt` is set explicitly: Prisma's `@default(now())` is evaluated by
    // the query engine against the real system clock, which `mockClock` (JS
    // `Date` only) does not reach.
    await seedConfigDefaults(PAYABLE);
    const m = await machine();
    await at('2026-06-15T10:00:00+02:00', async () => {
      expect(await generateBookingReference()).toMatch(/^GK-2606-001-/);
      await booking('pending', {
        machineId: m.id,
        startDateStr: '2026-07-20',
        createdAt: new Date('2026-06-15T10:00:00+02:00'),
      });
      expect(await generateBookingReference()).toMatch(/^GK-2606-002-/);
    });
  });

  it('rolls the prefix over at the month boundary', async () => {
    await seedConfigDefaults(PAYABLE);
    await at(AT_MONTH_END, async () => {
      expect(await generateBookingReference()).toMatch(/^GK-2606-/);
    });
    await at(AFTER_MONTH_END, async () => {
      expect(await generateBookingReference()).toMatch(/^GK-2607-001-/);
    });
  });

  // FIXED V-4: the month window was
  // `new Date(y, m + 1, 0, 23, 59, 59)` — 23:59:59.**000**, not .999. A booking
  // created in the last 999 ms of a month fell outside `lte: monthEnd`, so it
  // was not counted, and the next booking of that same month reused its
  // sequence number. The window is now half-open — `lt: nextMonthStart` — which
  // has no such edge.
  it('counts a booking created in the last millisecond of the month', async () => {
    await seedConfigDefaults(PAYABLE);
    const m = await machine();
    await at(BEFORE_MONTH_END, async () => {
      await booking('pending', {
        machineId: m.id,
        startDateStr: '2026-07-20',
        createdAt: new Date(AT_MONTH_END),
      });
    });
    await at(AT_MONTH_END, async () => {
      expect(await generateBookingReference()).toMatch(/^GK-2606-002-/);
    });
  });
});
