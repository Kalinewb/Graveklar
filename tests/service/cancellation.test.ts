/**
 * Phase 1c — area G: cancellation fees and refunds below HTTP.
 *
 * The fee is computed in exactly one place (`updateBookingStatus`, the
 * `cancelled` branch) and the customer-facing preview in
 * `/api/booking/cancel` mirrors it. This file pins the boundaries of that
 * calculation with a frozen clock, then checks what the transition does with
 * the money: refund, locks, and the codes it must NOT mint.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { booking, db, ensureSchema, resetDb, seedConfigDefaults } from '../helpers/db';
import { emailMock, mockClock, stripeMock } from '../helpers/mocks';
import { STRIPE_CONFIG, settle, waitFor } from '../helpers/payments';

vi.mock('@/lib/email', async () => (await import('../helpers/mocks')).mockEmail());
vi.mock('stripe', async () => (await import('../helpers/mocks')).mockStripe());

const PI = 'pi_test_audit1c';

/** cancelFreeWeeks 0 + cancelFreeDays 2 → a 48-hour free window. */
const CANCEL_CONFIG: Record<string, string> = {
  ...STRIPE_CONFIG,
  cancelFreeWeeks: '0',
  cancelFreeDays: '2',
  cancelLatePercent: '50',
  cancelSameDayPercent: '100',
};

function charge(amountOre: number, refundedOre = 0) {
  return {
    id: 'ch_test_audit1c',
    object: 'charge',
    amount: amountOre,
    amount_refunded: refundedOre,
    refunded: false,
    payment_intent: PI,
  };
}

beforeAll(async () => {
  await ensureSchema();
  // Load the mocked modules once: each mock factory resets its recorder when
  // it first runs, which would otherwise wipe a fixture set in beforeEach.
  await Promise.all([import('@/lib/stripe'), import('@/lib/email')]);
});

beforeEach(async () => {
  await resetDb();
  emailMock.reset();
  stripeMock.reset();
  await seedConfigDefaults(CANCEL_CONFIG);
  stripeMock.responses.charge = charge(1_000_000);
});

// ── Fee boundaries ───────────────────────────────────────────────────────────

// Rental starts 2026-09-08 at local midnight; the free window is 48 h, so the
// cutoff falls exactly on 2026-09-06T00:00 Oslo time.
const START = '2026-09-08';

const FEE_CASES: Array<{ label: string; now: string; fee: number | null }> = [
  { label: 'an hour before the cutoff (49 h out)', now: '2026-09-05T23:00:00+02:00', fee: null },
  { label: 'exactly on the cutoff (48 h out)', now: '2026-09-06T00:00:00+02:00', fee: null },
  { label: 'an hour past the cutoff (47 h out)', now: '2026-09-06T01:00:00+02:00', fee: 1245 },
  { label: 'the day before the rental', now: '2026-09-07T12:00:00+02:00', fee: 1245 },
  { label: 'the morning the rental starts', now: '2026-09-08T08:00:00+02:00', fee: 2490 },
  { label: 'after the rental should have started', now: '2026-09-09T08:00:00+02:00', fee: 2490 },
];

describe('cancellation fee boundaries', () => {
  for (const { label, now, fee } of FEE_CASES) {
    it(`charges ${fee ?? 0} kr when cancelling ${label}`, async () => {
      const clock = mockClock(now);
      try {
        const { updateBookingStatus } = await import('@/lib/booking-service');
        const b = await booking('confirmed', {
          startDateStr: START,
          basePrice: 2490,
          totalPrice: 2490,
          fullyPaidAt: new Date(),
        });

        const result = await updateBookingStatus(b.id, 'cancelled');

        expect(result.cancellationFee).toBe(fee);
      } finally {
        clock.restore();
      }
    });
  }

  it('honours a free window expressed in weeks', async () => {
    await db.appConfig.update({ where: { key: 'cancelFreeWeeks' }, data: { value: '1' } });
    await db.appConfig.update({ where: { key: 'cancelFreeDays' }, data: { value: '0' } });
    const { invalidateCaches } = await import('../helpers/db');
    invalidateCaches();

    const clock = mockClock('2026-09-02T00:00:00+02:00'); // 144 h out < 168 h
    try {
      const { updateBookingStatus } = await import('@/lib/booking-service');
      const b = await booking('confirmed', {
        startDateStr: START,
        basePrice: 2490,
        totalPrice: 2490,
      });

      expect((await updateBookingStatus(b.id, 'cancelled')).cancellationFee).toBe(1245);
    } finally {
      clock.restore();
    }
  });

  it('computes the fee from basePrice, not from the charged total', async () => {
    const clock = mockClock('2026-09-06T01:00:00+02:00');
    try {
      const { updateBookingStatus } = await import('@/lib/booking-service');
      // 2495 kr base + 505 kr delivery. 50 % of the base rounds to 1248;
      // 50 % of the total would be 1500.
      const b = await booking('confirmed', {
        startDateStr: START,
        basePrice: 2495,
        deliveryFee: 505,
        totalPrice: 3000,
        fullyPaidAt: new Date(),
      });

      const result = await updateBookingStatus(b.id, 'cancelled');

      expect(result.cancellationFee).toBe(1248);
      expect(result.cancellationFee).not.toBe(1500);
    } finally {
      clock.restore();
    }
  });

  it('charges nothing when cancelling a booking that was never confirmed', async () => {
    const clock = mockClock('2026-09-08T08:00:00+02:00'); // same-day, would be 100 %
    try {
      const { updateBookingStatus } = await import('@/lib/booking-service');
      const b = await booking('pending', { startDateStr: START, basePrice: 2490 });

      const result = await updateBookingStatus(b.id, 'cancelled');

      expect(result.cancellationFee).toBeNull();
      expect(stripeMock.by('refunds.create')).toHaveLength(0);
    } finally {
      clock.restore();
    }
  });
});

// ── Refund arithmetic on cancel ──────────────────────────────────────────────

describe('refund on cancellation', () => {
  it('refunds the total minus the fee', async () => {
    const clock = mockClock('2026-09-06T01:00:00+02:00');
    try {
      const { updateBookingStatus } = await import('@/lib/booking-service');
      const b = await booking('confirmed', {
        startDateStr: START,
        basePrice: 2490,
        totalPrice: 2490,
        fullyPaidAt: new Date(),
        stripePaymentIntentId: PI,
      });

      await updateBookingStatus(b.id, 'cancelled');

      expect((stripeMock.by('refunds.create')[0].args[0] as { amount: number }).amount).toBe(
        124_500,
      );
      expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).refundAmount).toBe(1245);
    } finally {
      clock.restore();
    }
  });

  it('issues no refund at all when a 100 % fee swallows the total', async () => {
    const clock = mockClock('2026-09-08T08:00:00+02:00');
    try {
      const { updateBookingStatus } = await import('@/lib/booking-service');
      const b = await booking('confirmed', {
        startDateStr: START,
        basePrice: 2490,
        totalPrice: 2490,
        fullyPaidAt: new Date(),
        stripePaymentIntentId: PI,
      });

      await updateBookingStatus(b.id, 'cancelled');

      expect(stripeMock.by('refunds.create')).toHaveLength(0);
      expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).refundAmount).toBeNull();
    } finally {
      clock.restore();
    }
  });

  it('never refunds a negative amount when a fee is smaller than an earlier refund', async () => {
    const clock = mockClock('2026-09-06T01:00:00+02:00');
    try {
      const { updateBookingStatus } = await import('@/lib/booking-service');
      const b = await booking('confirmed', {
        startDateStr: START,
        basePrice: 2490,
        totalPrice: 2490,
        fullyPaidAt: new Date(),
        stripePaymentIntentId: PI,
        // The admin already refunded 2000 kr from the Stripe dashboard.
        refundAmount: 2000,
      });

      await updateBookingStatus(b.id, 'cancelled');

      // 2490 − 1245 fee − 2000 already refunded = −755 → nothing to send back.
      expect(stripeMock.by('refunds.create')).toHaveLength(0);
      expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).refundAmount).toBe(2000);
    } finally {
      clock.restore();
    }
  });

  it('releases every date lock the booking held', async () => {
    const { updateBookingStatus } = await import('@/lib/booking-service');
    const b = await booking('confirmed', { rentalType: 'week', startDateStr: '2027-01-04' });
    expect(await db.bookingDateLock.count({ where: { bookingId: b.id } })).toBeGreaterThan(1);

    await updateBookingStatus(b.id, 'cancelled');

    expect(await db.bookingDateLock.count({ where: { bookingId: b.id } })).toBe(0);
  });

  // FIXED G-51: the fee branch is gated on `previousStatus === 'confirmed'`
  // while the refund branch is gated only on `fullyPaidAt`, so cancelling a
  // COMPLETED booking — the rental happened, the machine came back — computed
  // no cancellation fee and refunded 100 %. `completed` is now terminal in the
  // lifecycle table, so the transition is refused before the refund branch is
  // ever reached and a finished rental cannot be given away.
  it('does not hand a completed rental a full refund', async () => {
    const clock = mockClock('2026-09-09T08:00:00+02:00');
    try {
      const { updateBookingStatus, BookingClientError } = await import('@/lib/booking-service');
      const b = await booking('completed', {
        startDateStr: START,
        basePrice: 2490,
        totalPrice: 2490,
        fullyPaidAt: new Date(),
        stripePaymentIntentId: PI,
      });

      await expect(updateBookingStatus(b.id, 'cancelled')).rejects.toBeInstanceOf(
        BookingClientError,
      );

      const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
      expect(after.status).toBe('completed');
      expect(after.cancellationFee).toBeNull();
      expect(stripeMock.by('refunds.create')).toHaveLength(0);
    } finally {
      clock.restore();
    }
  });
});

// ── Side effects a cancel must NOT have ──────────────────────────────────────

describe('cancellation side effects', () => {
  it('does not mint a goodwill code — that is the admin route’s job', async () => {
    const { updateBookingStatus } = await import('@/lib/booking-service');
    const b = await booking('confirmed', { startDateStr: '2027-01-04', fullyPaidAt: new Date() });

    await updateBookingStatus(b.id, 'cancelled');
    await settle();

    expect(await db.repeatDiscountCode.count()).toBe(0);
    expect(emailMock.by('sendRepeatDiscountEmail')).toHaveLength(0);
  });

  it('sends the expiry notice only for the silent pending sweep', async () => {
    const { updateBookingStatus } = await import('@/lib/booking-service');
    const expired = await booking('pending', { startDateStr: '2027-01-04' });
    const paid = await booking('confirmed', {
      startDateStr: '2027-02-01',
      fullyPaidAt: new Date(),
    });

    await updateBookingStatus(expired.id, 'cancelled');
    await updateBookingStatus(paid.id, 'cancelled');
    await settle();

    expect(emailMock.by('sendBookingExpiredEmail')).toHaveLength(1);
  });

  it('skipEmails suppresses the expiry notice for caller-owned mail', async () => {
    const { updateBookingStatus } = await import('@/lib/booking-service');
    const b = await booking('pending', { startDateStr: '2027-01-04' });

    await updateBookingStatus(b.id, 'cancelled', { skipEmails: true });
    await settle();

    expect(emailMock.sent).toHaveLength(0);
  });

  it('records the actor that asked for the cancellation', async () => {
    const { updateBookingStatus } = await import('@/lib/booking-service');
    const b = await booking('confirmed', { startDateStr: '2027-01-04' });

    await updateBookingStatus(b.id, 'cancelled', { actor: 'customer' });
    await waitFor(async () => (await db.adminAuditLog.count()) === 1, { what: 'audit row' });

    const rows = await db.adminAuditLog.findMany({ where: { action: 'booking.cancelled' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe('customer');
  });
});
