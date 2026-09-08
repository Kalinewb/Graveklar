/**
 * The double-booking guard, under genuine simultaneity.
 *
 * `scripts/test-concurrency.ts` proves this against the live database; this is
 * the same experiment on a throwaway `freshDb()` file so it can run in CI.
 * `createPendingBooking` reaches the database through the `@/lib/db`
 * singleton, so the singleton is swapped for a proxy (helpers/booking.ts) that
 * points at the isolated client for the duration of each test.
 *
 * The invariant: N simultaneous attempts on the same machine/date leave
 * exactly `quantity` bookings, exactly one lock per machine/date/slot, no
 * orphan locks, and every loser fails with a clean Norwegian message.
 */
import type { PrismaClient } from '@prisma/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  const { installDbProxy } = await import('../helpers/booking');
  return { ...actual, db: installDbProxy(actual.db as PrismaClient) };
});

import {
  ensureSchema,
  freshDb,
  machine,
  resetDb,
  seedConfigDefaults,
  type FreshDb,
} from '../helpers/db';
import { bookingInput, resetDbClient, toQuoteInputs, selectDbClient } from '../helpers/booking';
import { mockClock } from '../helpers/mocks';
import { createPendingBooking, type CreateBookingInput } from '@/lib/booking-service';
import { buildQuote } from '@/lib/domain/quote';
import { getRentalDateRange } from '@/lib/availability';

const NOW = '2026-09-07T09:00:00+02:00';
const FRIDAY = '2026-09-11'; // weekendStartDay = 5
const ATTEMPTS = 12;

const PAYABLE = {
  stripeEnabled: 'true',
  stripeSecretKey: 'sk_test_harness',
  enableFirstTimeDiscount: 'false',
  enableRepeatDiscount: 'false',
};

let clock: ReturnType<typeof mockClock>;
let fresh: FreshDb | null = null;

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  resetDbClient();
  await resetDb();
  clock = mockClock(NOW);
});

afterEach(async () => {
  resetDbClient();
  clock.restore();
  if (fresh) {
    await fresh.dispose();
    fresh = null;
  }
});

/** An isolated database, seeded and wired up as the active `db`. */
async function isolated(quantity: number): Promise<{ machineId: string; input: CreateBookingInput }> {
  fresh = await freshDb();
  // Production applies WAL in src/lib/db.ts; match it so the contention this
  // test measures is the same contention the server sees.
  await fresh.client.$queryRawUnsafe('PRAGMA journal_mode = WAL');
  selectDbClient(fresh.client);

  await seedConfigDefaults(PAYABLE, fresh.client);
  const m = await machine({ quantity }, fresh.client);

  const base = bookingInput({
    rentalType: 'weekend',
    startDate: FRIDAY,
    machineId: m.id,
    selfPickup: true,
    deliveryAddress: '',
    deliveryDistance: 0,
    deliveryFee: 0,
    email: 'race@example.com',
  });
  const quote = await buildQuote(toQuoteInputs(base));
  return { machineId: m.id, input: { ...base, expectedTotalKr: quote.totalPrice } };
}

interface RaceResult {
  wins: number;
  losses: number;
  messages: string[];
}

async function race(input: CreateBookingInput, attempts = ATTEMPTS): Promise<RaceResult> {
  const settled = await Promise.allSettled(
    Array.from({ length: attempts }, () => createPendingBooking(input)),
  );
  return {
    wins: settled.filter((r) => r.status === 'fulfilled').length,
    losses: settled.filter((r) => r.status === 'rejected').length,
    messages: settled
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => (r.reason as Error)?.message ?? String(r.reason)),
  };
}

/** Every lock row for the machine, plus the bookings that own them. */
async function lockTruth(client: PrismaClient, machineId: string) {
  const bookings = await client.booking.findMany({ select: { id: true, status: true } });
  const locks = await client.bookingDateLock.findMany({ where: { machineId } });
  const bookingIds = new Set(bookings.map((b) => b.id));
  return {
    bookings,
    locks,
    orphanLocks: locks.filter((l) => !bookingIds.has(l.bookingId)),
    slotKeys: locks.map((l) => `${l.date.toISOString()}#${l.slot}`),
  };
}

describe('simultaneous booking attempts on one slot', () => {
  it(`lets exactly one of ${ATTEMPTS} win when quantity = 1`, async () => {
    const { machineId, input } = await isolated(1);

    const result = await race(input);

    expect(result.wins).toBe(1);
    expect(result.losses).toBe(ATTEMPTS - 1);
    // Every loser must fail on the slot, not on an unhandled Prisma error.
    for (const message of result.messages) {
      expect(message, `unexpected rejection: ${message}`).toMatch(/opptatt/i);
    }

    const truth = await lockTruth(fresh!.client, machineId);
    const days = getRentalDateRange(FRIDAY, 'weekend');
    expect(truth.bookings).toHaveLength(1);
    expect(truth.locks).toHaveLength(days.length);
    expect(truth.orphanLocks).toEqual([]);
    expect(new Set(truth.slotKeys).size).toBe(truth.slotKeys.length); // no duplicate machine/date/slot
    expect(truth.locks.every((l) => l.bookingId === truth.bookings[0].id)).toBe(true);
    // A rolled-back attempt must take its Booking row with it — a row with no
    // locks would hold no dates while still looking like a sale.
    for (const b of truth.bookings) {
      expect(truth.locks.filter((l) => l.bookingId === b.id).length).toBeGreaterThan(0);
    }
  }, 60_000);

  it(`lets exactly two of ${ATTEMPTS} win when quantity = 2`, async () => {
    const { machineId, input } = await isolated(2);

    const result = await race(input);

    expect(result.wins).toBe(2);
    expect(result.losses).toBe(ATTEMPTS - 2);
    for (const message of result.messages) {
      expect(message, `unexpected rejection: ${message}`).toMatch(/opptatt/i);
    }

    const truth = await lockTruth(fresh!.client, machineId);
    const days = getRentalDateRange(FRIDAY, 'weekend');
    expect(truth.bookings).toHaveLength(2);
    expect(truth.locks).toHaveLength(days.length * 2);
    expect(truth.orphanLocks).toEqual([]);
    expect(new Set(truth.slotKeys).size).toBe(truth.slotKeys.length);
    // Slots are filled from 0 upwards, one booking per slot per day.
    expect(new Set(truth.locks.map((l) => l.slot))).toEqual(new Set([0, 1]));
    for (const b of truth.bookings) {
      expect(truth.locks.filter((l) => l.bookingId === b.id).length).toBe(days.length);
    }
  }, 60_000);
});
