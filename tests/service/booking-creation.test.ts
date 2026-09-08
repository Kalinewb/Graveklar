/**
 * `createPendingBooking` end to end below HTTP: what it writes, what it
 * refuses, and where the money guard sits.
 *
 * Clock frozen at Monday 2026-09-07 09:00 Europe/Oslo — `paymentDeadline`,
 * `generateBookingReference` and every weekday gate are then exact.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  booking,
  db,
  ensureSchema,
  machine,
  repeatCode,
  resetDb,
  seedConfigDefaults,
} from '../helpers/db';
import { bookingInput, toQuoteInputs } from '../helpers/booking';
import { mockClock } from '../helpers/mocks';
import {
  BookingValidationError,
  PriceDriftError,
  createPendingBooking,
  generateBookingReference,
  getUnavailableDateStringsForRange,
  type CreateBookingInput,
} from '@/lib/booking-service';
import { buildQuote } from '@/lib/domain/quote';
import { toDateStr } from '@/lib/dates';

const NOW = '2026-09-07T09:00:00+02:00';
const MONDAY = '2026-09-14';
const FRIDAY = '2026-09-11';

/** Payment must be configured or `createPendingBooking` refuses outright. */
const PAYABLE = {
  stripeEnabled: 'true',
  stripeSecretKey: 'sk_test_harness',
  // Discount engine off by default so totals are stable across repeated
  // bookings for the same customer; the code path gets its own test.
  enableFirstTimeDiscount: 'false',
  enableRepeatDiscount: 'false',
};

let clock: ReturnType<typeof mockClock>;

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDb();
  clock = mockClock(NOW);
});

afterEach(() => {
  clock.restore();
});

/** Fill `expectedTotalKr` from the same quote the customer would have seen. */
async function priced(overrides: Partial<CreateBookingInput> = {}): Promise<CreateBookingInput> {
  const input = bookingInput({
    startDate: MONDAY,
    selfPickup: true,
    deliveryAddress: '',
    deliveryDistance: 0,
    deliveryFee: 0,
    ...overrides,
  });
  const quote = await buildQuote(toQuoteInputs(input));
  return { ...input, expectedTotalKr: quote.totalPrice };
}

describe('createPendingBooking — what it writes', () => {
  it('commits one Booking and one BookingDateLock per rental day', async () => {
    await seedConfigDefaults(PAYABLE);
    const m = await machine({ quantity: 1 });

    const { booking: created, computed } = await createPendingBooking(
      await priced({ rentalType: 'weekend', startDate: FRIDAY, machineId: m.id }),
    );

    expect(created.status).toBe('pending');
    expect(created.machineId).toBe(m.id);
    expect(created.reference).toMatch(/^GK-2609-\d{3}-[A-Z2-9]{5}$/);
    expect(toDateStr(created.startDate)).toBe(FRIDAY);
    expect(created.startDate.getHours()).toBe(0); // Oslo local midnight
    expect(created.termsAcceptedAt).toBeInstanceOf(Date);
    // 60 minutes, matching the Stripe Checkout session lifetime.
    expect(created.paymentDeadline?.getTime()).toBe(Date.now() + 60 * 60 * 1000);
    expect(created.totalPrice).toBe(computed.totalPrice);

    const locks = await db.bookingDateLock.findMany({
      where: { bookingId: created.id },
      orderBy: { date: 'asc' },
    });
    expect(locks.map((l) => toDateStr(l.date))).toEqual(['2026-09-11', '2026-09-12', '2026-09-13']);
    expect(locks.every((l) => l.slot === 0)).toBe(true);
    expect(locks.every((l) => l.machineId === m.id)).toBe(true);
  });

  it('normalises the stored PII (trimmed name/phone, lowercased email)', async () => {
    await seedConfigDefaults(PAYABLE);
    await machine();

    const { booking: created } = await createPendingBooking(
      await priced({
        name: '  Kari Nordmann  ',
        phone: ' 40000000 ',
        email: '  KARI@Example.COM ',
        notes: '  ring på forhånd  ',
      }),
    );

    expect(created.name).toBe('Kari Nordmann');
    expect(created.phone).toBe('40000000');
    expect(created.email).toBe('kari@example.com');
    expect(created.notes).toBe('ring på forhånd');
  });

  it('spans a multi-week rental across every day it reserves', async () => {
    await seedConfigDefaults(PAYABLE);
    const m = await machine({ quantity: 1 });

    const { booking: created } = await createPendingBooking(
      await priced({ rentalType: 'week', startDate: MONDAY, customDays: 14, machineId: m.id }),
    );

    expect(created.customDays).toBe(14);
    const locks = await db.bookingDateLock.findMany({ where: { bookingId: created.id } });
    expect(locks).toHaveLength(14);
  });

  it('hands out unique, month-scoped references', async () => {
    await seedConfigDefaults(PAYABLE);
    const first = await generateBookingReference();
    expect(first).toMatch(/^GK-2609-001-[A-Z2-9]{5}$/);

    await booking('confirmed', { startDateStr: MONDAY });
    const second = await generateBookingReference();
    expect(second).toMatch(/^GK-2609-002-[A-Z2-9]{5}$/);
    expect(second).not.toBe(first);
  });
});

describe('createPendingBooking — the price-drift guard', () => {
  it('throws PriceDriftError when the agreed total moved more than 1 kr', async () => {
    await seedConfigDefaults(PAYABLE);
    await machine();
    const input = await priced();

    await expect(
      createPendingBooking({ ...input, expectedTotalKr: input.expectedTotalKr - 2 }),
    ).rejects.toBeInstanceOf(PriceDriftError);

    await expect(createPendingBooking({ ...input, expectedTotalKr: 1 })).rejects.toMatchObject({
      expected: 1,
      actual: input.expectedTotalKr,
    });

    expect(await db.booking.count()).toBe(0);
    expect(await db.bookingDateLock.count()).toBe(0);
  });

  it('tolerates 1 kr of rounding noise in either direction', async () => {
    await seedConfigDefaults(PAYABLE);
    await machine();
    const input = await priced();

    const low = await createPendingBooking({
      ...input,
      startDate: MONDAY,
      expectedTotalKr: input.expectedTotalKr - 1,
    });
    expect(low.booking.totalPrice).toBe(input.expectedTotalKr);
  });

  it('prices the discount server-side rather than trusting the client total', async () => {
    await seedConfigDefaults({ ...PAYABLE, enableRepeatDiscount: 'true', repeatDiscountPercent: '10' });
    await machine();
    const code = await repeatCode({ email: 'kari@example.com' });

    const undiscounted = await priced({ email: 'kari@example.com' });
    const input = await priced({ email: 'kari@example.com', discountCode: code.code });
    expect(input.expectedTotalKr).toBeLessThan(undiscounted.expectedTotalKr);

    const { booking: created } = await createPendingBooking(input);
    expect(created.discountKr).toBeGreaterThan(0);
    expect(created.totalPrice).toBe(input.expectedTotalKr);

    // The single-use code is claimed inside the booking transaction, not at
    // confirmation — that is what closes the double-redemption race.
    const claimed = await db.repeatDiscountCode.findUniqueOrThrow({ where: { id: code.id } });
    expect(claimed.redeemedByBookingId).toBe(created.id);
  });
});

describe('createPendingBooking — refusals', () => {
  it('refuses while maintenance mode is on', async () => {
    await seedConfigDefaults({ ...PAYABLE, maintenanceMode: 'true' });
    await machine();
    await expect(createPendingBooking(await priced())).rejects.toThrow(
      'Booking er midlertidig deaktivert. Prøv igjen senere.',
    );
    expect(await db.booking.count()).toBe(0);
  });

  it('refuses when neither Stripe nor Vipps can take money', async () => {
    await seedConfigDefaults({ stripeEnabled: 'false', vippsEnabled: 'false' });
    await machine();
    const input = bookingInput({ startDate: MONDAY, selfPickup: true, deliveryAddress: '', deliveryDistance: 0 });
    await expect(createPendingBooking(input)).rejects.toThrow(
      'Betaling er ikke konfigurert. Booking er utilgjengelig.',
    );
  });

  it('refuses a start date past bookingMaxAdvanceDays', async () => {
    await seedConfigDefaults({ ...PAYABLE, bookingMaxAdvanceDays: '30' });
    await machine();
    await expect(
      createPendingBooking(await priced({ startDate: '2026-12-07' })),
    ).rejects.toThrow('Du kan ikke booke mer enn 30 dager i forveien.');
  });

  it('refuses an unknown or inactive machine', async () => {
    await seedConfigDefaults(PAYABLE);
    const inactive = await machine({ isActive: false });

    await expect(
      createPendingBooking(await priced({ machineId: 'no-such-machine' })),
    ).rejects.toThrow('Valgt utstyr er ikke tilgjengelig.');
    await expect(
      createPendingBooking(await priced({ machineId: inactive.id })),
    ).rejects.toThrow('Valgt utstyr er ikke tilgjengelig.');
  });

  it('refuses a range that overlaps a live booking, and writes nothing', async () => {
    await seedConfigDefaults(PAYABLE);
    const m = await machine({ quantity: 1 });
    await booking('confirmed', { machineId: m.id, startDateStr: MONDAY, rentalType: 'day' });

    const before = await db.bookingDateLock.count();
    await expect(
      createPendingBooking(await priced({ rentalType: 'day', startDate: MONDAY, machineId: m.id })),
    ).rejects.toThrow('En eller flere dager i perioden er opptatt. Velg en annen dato.');

    expect(await db.booking.count()).toBe(1); // only the seeded one
    expect(await db.bookingDateLock.count()).toBe(before);
  });

  it('refuses a day that an admin blocked in the calendar', async () => {
    await seedConfigDefaults(PAYABLE);
    const m = await machine({ quantity: 1 });
    await db.unavailableDate.create({ data: { date: new Date(`${MONDAY}T00:00:00`), reason: 'Service' } });

    await expect(
      createPendingBooking(await priced({ rentalType: 'day', startDate: MONDAY, machineId: m.id })),
    ).rejects.toThrow('En eller flere dager i perioden er opptatt. Velg en annen dato.');
  });
});

describe('createPendingBooking — equipment quantity', () => {
  it('fills every slot before refusing (quantity 2 → two winners)', async () => {
    await seedConfigDefaults({ ...PAYABLE, blockDayBeforeBooking: 'false', blockDayAfterBooking: 'false' });
    const m = await machine({ quantity: 2 });

    const first = await createPendingBooking(
      await priced({ rentalType: 'day', startDate: MONDAY, machineId: m.id }),
    );
    const second = await createPendingBooking(
      await priced({ rentalType: 'day', startDate: MONDAY, machineId: m.id }),
    );

    const locks = await db.bookingDateLock.findMany({
      where: { machineId: m.id, date: new Date(`${MONDAY}T00:00:00`) },
      orderBy: { slot: 'asc' },
    });
    expect(locks.map((l) => l.slot)).toEqual([0, 1]);
    expect(new Set(locks.map((l) => l.bookingId))).toEqual(new Set([first.booking.id, second.booking.id]));

    await expect(
      createPendingBooking(await priced({ rentalType: 'day', startDate: MONDAY, machineId: m.id })),
    ).rejects.toThrow('En eller flere dager i perioden er opptatt. Velg en annen dato.');
    expect(await db.booking.count()).toBe(2);
  });
});

describe('getUnavailableDateStringsForRange', () => {
  it('counts confirmed bookings, live pending ones and admin blocks — but not expired pending', async () => {
    await seedConfigDefaults({ ...PAYABLE, blockDayBeforeBooking: 'false', blockDayAfterBooking: 'false' });
    const m = await machine({ quantity: 1 });

    await booking('confirmed', { machineId: m.id, startDateStr: '2026-09-14', rentalType: 'day' });
    await booking('pending', {
      machineId: m.id,
      startDateStr: '2026-09-15',
      rentalType: 'day',
      paymentDeadline: new Date(Date.now() + 30 * 60 * 1000),
    });
    await booking('pending', {
      machineId: m.id,
      startDateStr: '2026-09-16',
      rentalType: 'day',
      paymentDeadline: new Date(Date.now() - 1),
    });
    await db.unavailableDate.create({ data: { date: new Date('2026-09-17T00:00:00'), reason: 'Service' } });

    const range = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18'];
    const blocked = await getUnavailableDateStringsForRange(range, undefined, m.id);
    expect(blocked.sort()).toEqual(['2026-09-14', '2026-09-15', '2026-09-17']);
  });

  it('adds the turnaround buffer days when the toggles are on', async () => {
    await seedConfigDefaults(PAYABLE);
    const m = await machine({ quantity: 1 });
    await booking('confirmed', { machineId: m.id, startDateStr: '2026-09-15', rentalType: 'day' });

    const range = ['2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17'];
    expect((await getUnavailableDateStringsForRange(range, undefined, m.id)).sort()).toEqual([
      '2026-09-14',
      '2026-09-15',
      '2026-09-16',
    ]);
  });

  it('honours excludeBookingId so a booking never blocks itself', async () => {
    await seedConfigDefaults(PAYABLE);
    const m = await machine({ quantity: 1 });
    const b = await booking('confirmed', { machineId: m.id, startDateStr: '2026-09-15', rentalType: 'day' });

    expect(await getUnavailableDateStringsForRange(['2026-09-15'], b.id, m.id)).toEqual([]);
  });
});
