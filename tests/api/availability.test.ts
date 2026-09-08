/**
 * GET /api/availability — the customer calendar — against
 * `getUnavailableDateStringsForRange`, the server-side conflict check that
 * `createPendingBooking` actually enforces.
 *
 * They are two independent implementations of one question ("is this day
 * bookable?"). The parity assertion below walks every day of a month and
 * demands the same answer from both: a day the calendar offers but the service
 * refuses is a customer who fills in the form and is told "opptatt" at the end;
 * a day the calendar hides but the service would accept is a lost booking.
 *
 * `@/lib/cleanup` is mocked so the fire-and-forget sweep the route kicks off
 * cannot cancel the seeded pending bookings mid-assertion (and so the side
 * effect itself is observable).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/cleanup', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    runCleanupIfDue: vi.fn(async () => ({
      ran: true,
      cancelled: 0,
      orphanLocksReleased: 0,
      tokensSwept: 0,
      orphanUploadsRemoved: 0,
    })),
  };
});

import { booking, db, ensureSchema, machine, resetDb, seedConfigDefaults, unavailableDate } from '../helpers/db';
import { daysInMonth } from '../helpers/booking';
import { call } from '../helpers/route';
import { mockClock } from '../helpers/mocks';
import { getUnavailableDateStringsForRange } from '@/lib/booking-service';
import { runCleanupIfDue } from '@/lib/cleanup';

const NOW = '2026-09-07T09:00:00+02:00';

let clock: ReturnType<typeof mockClock>;

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDb();
  clock = mockClock(NOW);
  vi.mocked(runCleanupIfDue).mockClear();
});

afterEach(() => {
  clock.restore();
});

interface CalendarResponse {
  unavailableDates: string[];
  tentativeDates: string[];
  turnaroundDates: string[];
}

async function calendar(month: string, machineId?: string) {
  const { GET } = await import('@/app/api/availability/route');
  const res = await call<CalendarResponse>(GET, {
    path: '/api/availability',
    searchParams: { month, ...(machineId ? { machineId } : {}) },
  });
  expect(res.status).toBe(200);
  return res.json;
}

/** Every day the calendar refuses to offer: hard-blocked or "may free up". */
function notOffered(body: CalendarResponse): string[] {
  return [...new Set([...body.unavailableDates, ...body.tentativeDates])].sort();
}

/** Every day `createPendingBooking` would refuse for a one-day rental. */
async function serviceBlocked(month: string, machineId?: string): Promise<string[]> {
  const blocked: string[] = [];
  for (const day of daysInMonth(month)) {
    const conflicts = await getUnavailableDateStringsForRange([day], undefined, machineId);
    if (conflicts.length > 0) blocked.push(day);
  }
  return blocked;
}

async function expectParity(month: string, machineId?: string): Promise<string[]> {
  const body = await calendar(month, machineId);
  const fromService = await serviceBlocked(month, machineId);
  expect(notOffered(body)).toEqual(fromService);
  return fromService;
}

describe('GET /api/availability — request handling', () => {
  it('rejects anything that is not YYYY-MM', async () => {
    await seedConfigDefaults();
    const { GET } = await import('@/app/api/availability/route');

    for (const month of [undefined, '', '2026-6', '2026/10', 'oktober', '202600-10', '2026-10-01']) {
      const res = await call(GET, {
        path: '/api/availability',
        searchParams: month === undefined ? {} : { month },
      });
      expect(res.status, `month=${month}`).toBe(400);
      expect(res.json.error).toBe('Ugyldig måned. Bruk format YYYY-MM.');
    }
  });

  it('kicks off the expired-pending sweep on every query', async () => {
    await seedConfigDefaults();
    await calendar('2026-10');
    expect(vi.mocked(runCleanupIfDue)).toHaveBeenCalled();
  });

  it('answers with sorted arrays and separates tentative from blocked', async () => {
    await seedConfigDefaults();
    const m = await machine({ quantity: 1 });
    await booking('confirmed', { machineId: m.id, startDateStr: '2026-10-06', rentalType: 'day' });
    await booking('pending', {
      machineId: m.id,
      startDateStr: '2026-10-20',
      rentalType: 'day',
      paymentDeadline: new Date(Date.now() + 30 * 60 * 1000),
    });
    await unavailableDate('2026-10-28', 'Service');

    const body = await calendar('2026-10', m.id);

    expect(body.unavailableDates).toEqual([...body.unavailableDates].sort());
    expect(body.unavailableDates).toContain('2026-10-06');
    expect(body.unavailableDates).toContain('2026-10-28');
    expect(body.turnaroundDates).toEqual(['2026-10-05', '2026-10-07']);
    // The pending booking's own days are tentative, not blocked.
    expect(body.tentativeDates).toEqual(['2026-10-19', '2026-10-20', '2026-10-21']);
    expect(body.unavailableDates).not.toContain('2026-10-20');
  });
});

describe('calendar ↔ conflict-check parity', () => {
  it('agrees on a month holding confirmed, pending, expired and admin-blocked days', async () => {
    await seedConfigDefaults();
    const m = await machine({ quantity: 1 });

    await booking('confirmed', { machineId: m.id, startDateStr: '2026-10-06', rentalType: 'weekend' });
    await booking('pending', {
      machineId: m.id,
      startDateStr: '2026-10-14',
      rentalType: 'day',
      paymentDeadline: new Date(Date.now() + 30 * 60 * 1000),
    });
    await booking('pending', {
      machineId: m.id,
      startDateStr: '2026-10-22',
      rentalType: 'day',
      paymentDeadline: new Date(Date.now() - 60 * 1000), // expired, not yet swept
    });
    await unavailableDate('2026-10-28', 'Service');

    const blocked = await expectParity('2026-10', m.id);
    expect(blocked).toContain('2026-10-06');
    expect(blocked).toContain('2026-10-14');
    expect(blocked).toContain('2026-10-28');
    // The expired pending booking holds nothing.
    expect(blocked).not.toContain('2026-10-22');
  });

  it('agrees across a month boundary', async () => {
    await seedConfigDefaults();
    const m = await machine({ quantity: 1 });
    // Runs 28 Sep → 4 Oct, so both months see part of it plus a buffer day.
    await booking('confirmed', { machineId: m.id, startDateStr: '2026-09-28', rentalType: 'week' });

    const september = await expectParity('2026-09', m.id);
    const october = await expectParity('2026-10', m.id);
    expect(september).toContain('2026-09-30');
    expect(october).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']);
  });

  it('agrees through the 29th of a leap February', async () => {
    await seedConfigDefaults();
    const m = await machine({ quantity: 1 });
    await booking('confirmed', { machineId: m.id, startDateStr: '2028-02-27', rentalType: 'weekend' });
    await unavailableDate('2028-02-29', 'Skuddår');

    expect(daysInMonth('2028-02')).toHaveLength(29);
    const blocked = await expectParity('2028-02', m.id);
    expect(blocked).toContain('2028-02-29');
  });

  it('agrees with the turnaround buffers switched off', async () => {
    await seedConfigDefaults({ blockDayBeforeBooking: 'false', blockDayAfterBooking: 'false' });
    const m = await machine({ quantity: 1 });
    await booking('confirmed', { machineId: m.id, startDateStr: '2026-10-15', rentalType: 'day' });

    const blocked = await expectParity('2026-10', m.id);
    expect(blocked).toEqual(['2026-10-15']);
  });

  it('agrees with only the day-before buffer switched on', async () => {
    await seedConfigDefaults({ blockDayAfterBooking: 'false' });
    const m = await machine({ quantity: 1 });
    await booking('confirmed', { machineId: m.id, startDateStr: '2026-10-15', rentalType: 'day' });

    expect(await expectParity('2026-10', m.id)).toEqual(['2026-10-14', '2026-10-15']);
  });

  it('agrees about a pending booking whose deadline is exactly now (FIXED V-2)', async () => {
    await seedConfigDefaults({ blockDayBeforeBooking: 'false', blockDayAfterBooking: 'false' });
    const m = await machine({ quantity: 1 });
    await booking('pending', {
      machineId: m.id,
      startDateStr: '2026-10-15',
      rentalType: 'day',
      paymentDeadline: new Date(),
    });
    await booking('pending', {
      machineId: m.id,
      startDateStr: '2026-10-18',
      rentalType: 'day',
      paymentDeadline: new Date(Date.now() + 1),
    });

    // `runCleanup` owns the deadline instant: it cancels at
    // `paymentDeadline < now`, so at equality the booking is still alive and
    // still holds its BookingDateLock rows. The route and the service both
    // read it that way now, so neither offers a day the lock table holds.
    const blocked = await expectParity('2026-10', m.id);
    expect(blocked).toEqual(['2026-10-15', '2026-10-18']);
  });

  it('agrees about a 90-day rental that started before the month', async () => {
    await seedConfigDefaults();
    const m = await machine({ quantity: 1 });
    // 2026-07-05 + 89 days = 2026-10-02, the longest span validateBookingInput allows.
    await booking('confirmed', {
      machineId: m.id,
      startDateStr: '2026-07-05',
      rentalType: 'custom',
      customDays: 90,
    });

    expect(await expectParity('2026-10', m.id)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
  });

  it('agrees when no machineId is given (every machine counted together)', async () => {
    await seedConfigDefaults({ blockDayBeforeBooking: 'false', blockDayAfterBooking: 'false' });
    const a = await machine({ quantity: 1, name: 'Graver A' });
    const b = await machine({ quantity: 1, name: 'Graver B' });
    await booking('confirmed', { machineId: a.id, startDateStr: '2026-10-06', rentalType: 'day' });
    await booking('confirmed', { machineId: b.id, startDateStr: '2026-10-09', rentalType: 'day' });

    expect(await expectParity('2026-10')).toEqual(['2026-10-06', '2026-10-09']);
  });
});

describe('parity gaps', () => {
  // FIXED C-1: the calendar marked a turnaround day unavailable whenever it
  // was "still free" — the inverse of the comment above it — so on a machine
  // with quantity > 1 the buffer day was hidden from customers even though
  // createPendingBooking would happily take it. Buffer days now consume a
  // slot in the same tally as rental days, exactly as the conflict check
  // counts them.
  it('agrees about turnaround days when quantity is 2', async () => {
    await seedConfigDefaults();
    const m = await machine({ quantity: 2 });
    await booking('confirmed', { machineId: m.id, startDateStr: '2026-10-15', rentalType: 'day' });

    const body = await calendar('2026-10', m.id);
    // One booking of two slots: nothing in the month is actually full.
    expect(await serviceBlocked('2026-10', m.id)).toEqual([]);
    expect(notOffered(body)).toEqual([]);
  });

  // FIXED C-2: the calendar looked back exactly 90 days, sized for the 90-day
  // cap on `custom`, while a `week` rental could be longer — so a long rental
  // starting further back was invisible to the calendar while the conflict
  // check still blocked its days. The lookback is now widened to the longest
  // `customDays` the table actually holds.
  it('agrees about a rental longer than the 90-day lookback', async () => {
    await seedConfigDefaults();
    const m = await machine({ quantity: 1 });
    // 14 weeks from 2026-07-01 → 2026-10-06; the lookback only reaches 2026-07-03.
    await booking('confirmed', {
      machineId: m.id,
      startDateStr: '2026-07-01',
      rentalType: 'week',
      customDays: 98,
    });

    const body = await calendar('2026-10', m.id);
    expect(await serviceBlocked('2026-10', m.id)).toEqual([
      '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
    ]);
    expect(notOffered(body)).toEqual(await serviceBlocked('2026-10', m.id));
  });

  // FIXED C-3: the booking query was bounded at `startDate <= monthEnd`, so a
  // booking starting on the 1st of the NEXT month never contributed its
  // day-before buffer — the calendar offered the last day of the month and the
  // conflict check refused it. The query now reaches one day past the end.
  it('agrees about the buffer day before a booking in the next month', async () => {
    await seedConfigDefaults();
    const m = await machine({ quantity: 1 });
    await booking('confirmed', { machineId: m.id, startDateStr: '2026-11-01', rentalType: 'day' });

    const body = await calendar('2026-10', m.id);
    expect(await serviceBlocked('2026-10', m.id)).toEqual(['2026-10-31']);
    expect(notOffered(body)).toEqual(['2026-10-31']);
  });
});

describe('quantity', () => {
  it('keeps a day open in both layers while a second slot is free', async () => {
    await seedConfigDefaults({ blockDayBeforeBooking: 'false', blockDayAfterBooking: 'false' });
    const m = await machine({ quantity: 2 });
    await booking('confirmed', { machineId: m.id, startDateStr: '2026-10-15', rentalType: 'day' });

    expect(await expectParity('2026-10', m.id)).toEqual([]);

    // Second slot on the same day — `booking()` always writes slot 0, so the
    // lock rows are skipped here; availability reads Booking rows, not locks.
    await booking('confirmed', {
      machineId: m.id,
      startDateStr: '2026-10-15',
      rentalType: 'day',
      skipLocks: true,
    });
    expect(await expectParity('2026-10', m.id)).toEqual(['2026-10-15']);
  });

  it('ignores a machine filter that matches nothing', async () => {
    await seedConfigDefaults();
    const m = await machine({ quantity: 1 });
    await booking('confirmed', { machineId: m.id, startDateStr: '2026-10-15', rentalType: 'day' });

    const other = await calendar('2026-10', 'no-such-machine');
    expect(other.unavailableDates).toEqual([]);
    expect(await db.booking.count()).toBe(1);
  });
});
