/**
 * L3i — area U.3: when a write fails half way through, nothing survives.
 *
 * Both booking-creating paths (`createPendingBooking` and
 * `convertQuoteToBooking`) commit a Booking row and its `BookingDateLock` rows
 * inside one interactive transaction, and `createPendingBooking` claims the
 * single-use repeat code inside the same one. The failure modes below are all
 * reachable in production: a machine whose `quantity` has been set to 0, a
 * stranded lock from a deleted booking (there is no foreign key — see
 * `db-cascades.test.ts`), and a repeat code claimed by a concurrent checkout.
 *
 * The invariant asserted after every one of them is the same: no Booking row,
 * no new lock, no repeat-code claim, no CampaignRedemption. A partially
 * committed booking is worse than a refused one — it holds calendar days for a
 * customer who was told the booking failed.
 *
 * The file ends on the suite-wide orphan-lock check.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  campaignCode,
  db,
  machine,
  repeatCode,
  resetDb,
  seedConfigDefaults,
} from '../helpers/db';
import { bookingInput, toQuoteInputs } from '../helpers/booking';
import { mockClock } from '../helpers/mocks';
import { expectNoOrphanLocks } from '../helpers/invariants';
import {
  BookingValidationError,
  createPendingBooking,
  type CreateBookingInput,
} from '@/lib/booking-service';
import { convertQuoteToBooking } from '@/lib/quote-request';
import { buildQuote } from '@/lib/domain/quote';
import { dateToDbMidnight } from '@/lib/availability';

vi.mock('@/lib/email', async () => (await import('../helpers/mocks')).mockEmail());

const NOW = '2026-09-07T09:00:00+02:00';
const MONDAY = '2026-09-14';
const OTHER_MONDAY = '2026-09-21';

const PAYABLE = {
  stripeEnabled: 'true',
  stripeSecretKey: 'sk_test_harness',
  enableFirstTimeDiscount: 'false',
  enableRepeatDiscount: 'false',
};

let clock: ReturnType<typeof mockClock>;

beforeEach(async () => {
  await resetDb();
  clock = mockClock(NOW);
});

afterEach(() => {
  clock.restore();
});

afterAll(async () => {
  await resetDb();
  await expectNoOrphanLocks();
});

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

/** Everything a half-committed booking would have left behind. */
async function residue() {
  return {
    bookings: await db.booking.count(),
    locks: await db.bookingDateLock.count(),
    campaignRedemptions: await db.campaignRedemption.count(),
    claimedRepeatCodes: await db.repeatDiscountCode.count({
      where: { OR: [{ redeemedByBookingId: { not: null } }, { redeemedAt: { not: null } }] },
    }),
    contracts: await db.acceptedContract.count(),
  };
}

describe('createPendingBooking rolls the whole transaction back', () => {
  it('leaves nothing behind when the machine has no capacity (quantity 0)', async () => {
    await seedConfigDefaults(PAYABLE);
    const m = await machine({ quantity: 0 });

    await expect(createPendingBooking(await priced({ machineId: m.id }))).rejects.toBeInstanceOf(
      BookingValidationError,
    );

    expect(await residue()).toEqual({
      bookings: 0,
      locks: 0,
      campaignRedemptions: 0,
      claimedRepeatCodes: 0,
      contracts: 0,
    });
  });

  it('leaves nothing behind when a stranded lock already holds the only slot', async () => {
    // A lock whose booking was deleted is invisible to the pre-flight
    // conflict check (that reads Booking rows), so this failure happens
    // *inside* the transaction, after `tx.booking.create` has already run.
    await seedConfigDefaults(PAYABLE);
    const m = await machine({ quantity: 1 });
    await db.bookingDateLock.create({
      data: {
        bookingId: 'deleted-booking-id',
        machineId: m.id,
        date: dateToDbMidnight(MONDAY),
        slot: 0,
      },
    });

    await expect(createPendingBooking(await priced({ machineId: m.id }))).rejects.toThrow(
      /opptatt/i,
    );

    expect(await db.booking.count()).toBe(0);
    // Only the planted lock remains — no half-written lock for the refused booking.
    const locks = await db.bookingDateLock.findMany();
    expect(locks).toHaveLength(1);
    expect(locks[0].bookingId).toBe('deleted-booking-id');

    await db.bookingDateLock.deleteMany({});
  });

  it('does not claim the repeat code when the transaction later fails', async () => {
    await seedConfigDefaults({
      ...PAYABLE,
      enableRepeatDiscount: 'true',
      repeatDiscountPercent: '10',
      discountHardCap: '30',
    });
    const m = await machine({ quantity: 1 });
    const code = await repeatCode({ code: 'RETUR-ROLLBK1', email: 'parity@example.com' });
    await db.bookingDateLock.create({
      data: {
        bookingId: 'deleted-booking-id',
        machineId: m.id,
        date: dateToDbMidnight(MONDAY),
        slot: 0,
      },
    });

    await expect(
      createPendingBooking(await priced({ machineId: m.id, discountCode: code.code })),
    ).rejects.toThrow(/opptatt/i);

    const after = await db.repeatDiscountCode.findUniqueOrThrow({ where: { id: code.id } });
    expect(after.redeemedByBookingId).toBeNull();
    expect(after.redeemedAt).toBeNull();
    expect(await db.booking.count()).toBe(0);

    await db.bookingDateLock.deleteMany({});
  });

  it('claims a repeat code at most once when two checkouts race for it', async () => {
    // The claim is an atomic `updateMany … where redeemedByBookingId: null`
    // inside the transaction. The loser throws after its Booking row and its
    // locks were already written, so this is the one path that exercises a
    // rollback of a *fully built* booking.
    await seedConfigDefaults({
      ...PAYABLE,
      enableRepeatDiscount: 'true',
      repeatDiscountPercent: '10',
      discountHardCap: '30',
    });
    const m = await machine({ quantity: 1 });
    const code = await repeatCode({ code: 'RETUR-RACE001', email: 'parity@example.com' });

    // Different dates, so the two attempts cannot collide on a lock — the
    // only thing they contend for is the code.
    const [a, b] = await Promise.all([
      priced({ machineId: m.id, startDate: MONDAY, discountCode: code.code }),
      priced({ machineId: m.id, startDate: OTHER_MONDAY, discountCode: code.code }),
    ]);
    const results = await Promise.allSettled([createPendingBooking(a), createPendingBooking(b)]);

    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as Error).message).toBe('Rabattkoden er allerede brukt.');

    // The loser built a Booking row and a lock inside its transaction before
    // the claim refused it. Neither survives.
    const bookings = await db.booking.findMany();
    expect(bookings).toHaveLength(1);
    expect(await db.bookingDateLock.count()).toBe(1);
    expect(await db.bookingDateLock.count({ where: { bookingId: bookings[0].id } })).toBe(1);

    const claimed = await db.repeatDiscountCode.findUniqueOrThrow({ where: { id: code.id } });
    expect(claimed.redeemedByBookingId).toBe(bookings[0].id);
    expect(claimed.redeemedAt).not.toBeNull();
    expect(bookings[0].discountKr).toBeGreaterThan(0);
    await expectNoOrphanLocks();

    await db.bookingDateLock.deleteMany({});
    await db.booking.deleteMany({});
  });

  it('writes nothing at all when the price drifted (the guard runs before the transaction)', async () => {
    await seedConfigDefaults(PAYABLE);
    const m = await machine({ quantity: 1 });
    const input = await priced({ machineId: m.id });

    await expect(
      createPendingBooking({ ...input, expectedTotalKr: input.expectedTotalKr - 500 }),
    ).rejects.toThrow(/Pris endret seg/);

    expect(await residue()).toEqual({
      bookings: 0,
      locks: 0,
      campaignRedemptions: 0,
      claimedRepeatCodes: 0,
      contracts: 0,
    });
  });

  it('does not spend a campaign code when the booking never commits', async () => {
    // Campaign redemption is deliberately *outside* the transaction, so the
    // thing to prove is that it is never reached on the failure path.
    await seedConfigDefaults(PAYABLE);
    const m = await machine({ quantity: 0 });
    const code = await campaignCode({ code: 'SOMMER-ROLL', percent: 10 });

    await expect(
      createPendingBooking(await priced({ machineId: m.id, discountCode: code.code })),
    ).rejects.toBeInstanceOf(BookingValidationError);

    const after = await db.campaignDiscountCode.findUniqueOrThrow({ where: { id: code.id } });
    expect(after.usedCount).toBe(0);
    expect(await db.campaignRedemption.count()).toBe(0);
  });
});

describe('convertQuoteToBooking rolls the whole transaction back', () => {
  async function quoteRow(machineId: string, startDate: string) {
    return db.quoteRequest.create({
      data: {
        reference: 'FT-2609-001',
        company: 'Test AS',
        orgNumber: '999999999',
        contactName: 'Test Testesen',
        email: 'firma@example.com',
        phone: '+4740000000',
        machineId,
        startDate: dateToDbMidnight(startDate),
        rentalType: 'day',
        status: 'tilbud_sendt',
        offerAmount: 5000,
        paymentMode: 'invoice',
      },
      include: { machine: true },
    });
  }

  it('leaves no Booking and no lock when the slot is already held', async () => {
    await seedConfigDefaults(PAYABLE);
    const m = await machine({ quantity: 1 });
    const q = await quoteRow(m.id, MONDAY);

    // There is no pre-flight conflict check on this path, so the throw lands
    // squarely inside the transaction — after `tx.booking.create`.
    await db.bookingDateLock.create({
      data: {
        bookingId: 'deleted-booking-id',
        machineId: m.id,
        date: dateToDbMidnight(MONDAY),
        slot: 0,
      },
    });

    await expect(convertQuoteToBooking(q)).rejects.toThrow(/Ingen ledig kapasitet/);

    expect(await db.booking.count()).toBe(0);
    expect(await db.bookingDateLock.count()).toBe(1);
    const after = await db.quoteRequest.findUniqueOrThrow({ where: { id: q.id } });
    expect(after.convertedBookingId).toBeNull();
    expect(after.status).toBe('tilbud_sendt');

    await db.bookingDateLock.deleteMany({});
  });

  it('commits the booking and its locks together on the happy path', async () => {
    await seedConfigDefaults(PAYABLE);
    const m = await machine({ quantity: 1 });
    const q = await quoteRow(m.id, MONDAY);

    const created = await convertQuoteToBooking(q);

    expect(created.status).toBe('pending');
    expect(created.customerType).toBe('business');
    expect(await db.bookingDateLock.count({ where: { bookingId: created.id } })).toBe(1);
    const after = await db.quoteRequest.findUniqueOrThrow({ where: { id: q.id } });
    expect(after.convertedBookingId).toBe(created.id);
    expect(after.status).toBe('akseptert');
    await expectNoOrphanLocks();
  });
});
