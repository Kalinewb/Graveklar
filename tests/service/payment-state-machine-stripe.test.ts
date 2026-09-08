/**
 * Phase 1c — area F: the Stripe half of the booking payment state machine.
 *
 * `updateBookingStatus` is the single transition authority, so this file
 * exercises it directly: every legal transition and its side effects, every
 * illegal one, every repeat (must be a no-op), and two transitions racing.
 * Refund arithmetic and Stripe idempotency keys live here too, since
 * `refundBookingPayment` is reached only through a cancel transition.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { booking, db, ensureSchema, resetDb, seedConfigDefaults } from '../helpers/db';
import { emailMock, mockClock, stripeMock } from '../helpers/mocks';
import { STRIPE_CONFIG, settle, waitFor } from '../helpers/payments';
import type { BookingStatus } from '@/lib/booking-service';

vi.mock('@/lib/email', async () => (await import('../helpers/mocks')).mockEmail());
vi.mock('stripe', async () => (await import('../helpers/mocks')).mockStripe());

const PI = 'pi_test_audit1c';

/** Options the webhook/callback confirm path passes. */
const CONFIRM_OPTS = {
  fullyPaid: true,
  stripePaymentIntentId: PI,
  paymentMethod: 'card',
  paymentProvider: 'stripe',
} as const;

/** A charge big enough to cover the default 2490 kr booking. */
function chargeOf(amountOre: number, refundedOre = 0) {
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
  await seedConfigDefaults(STRIPE_CONFIG);
  stripeMock.responses.charge = chargeOf(249_000);
});

// ── Legal transitions ────────────────────────────────────────────────────────

describe('legal transitions', () => {
  it('pending → confirmed clears the deadline, freezes the contract and mails once', async () => {
    const { updateBookingStatus } = await import('@/lib/booking-service');
    const b = await booking('pending', { paymentDeadline: new Date(Date.now() + 3_600_000) });

    const result = await updateBookingStatus(b.id, 'confirmed', CONFIRM_OPTS);

    expect(result.transitioned).toBe(true);
    expect(result.previousStatus).toBe('pending');
    expect(result.status).toBe('confirmed');
    expect(result.paymentDeadline).toBeNull();
    expect(result.fullyPaidAt).not.toBeNull();
    expect(result.stripePaymentIntentId).toBe(PI);
    expect(result.paymentProvider).toBe('stripe');

    await waitFor(async () => (await db.acceptedContract.count()) === 1, {
      what: 'contract freeze',
    });
    expect(emailMock.by('sendBookingStatusEmail')).toHaveLength(1);
    expect(emailMock.by('sendBookingStatusEmail')[0].args[1]).toBe('confirmed');
    expect(emailMock.by('sendNewBookingAdminNotification')).toHaveLength(1);
  });

  it('pending → cancelled releases the date locks, charges no fee and mails the expiry notice', async () => {
    const { updateBookingStatus } = await import('@/lib/booking-service');
    const b = await booking('pending');
    expect(await db.bookingDateLock.count({ where: { bookingId: b.id } })).toBeGreaterThan(0);

    const result = await updateBookingStatus(b.id, 'cancelled');

    expect(result.transitioned).toBe(true);
    expect(result.cancellationFee).toBeNull();
    expect(await db.bookingDateLock.count({ where: { bookingId: b.id } })).toBe(0);
    expect(emailMock.by('sendBookingExpiredEmail')).toHaveLength(1);
    // Nothing was paid, so no refund may be attempted.
    expect(stripeMock.by('refunds.create')).toHaveLength(0);
  });

  it('confirmed → cancelled computes the fee and refunds the remainder', async () => {
    const clock = mockClock('2026-09-06T00:00:00+02:00');
    try {
      const { updateBookingStatus } = await import('@/lib/booking-service');
      // 47 h out with a 48 h free window → the 50 % late fee applies.
      const b = await booking('confirmed', {
        startDateStr: '2026-09-08',
        basePrice: 2490,
        totalPrice: 2490,
        fullyPaidAt: new Date(),
        stripePaymentIntentId: PI,
      });
      clock.set('2026-09-06T01:00:00+02:00');

      const result = await updateBookingStatus(b.id, 'cancelled');

      expect(result.transitioned).toBe(true);
      expect(result.cancellationFee).toBe(1245);
      const refunds = stripeMock.by('refunds.create');
      expect(refunds).toHaveLength(1);
      expect((refunds[0].args[0] as { amount: number }).amount).toBe(124_500);
      expect((refunds[0].args[1] as { idempotencyKey: string }).idempotencyKey).toBe(
        `refund-${b.id}-124500`,
      );
      const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
      expect(after.refundAmount).toBe(1245);
      expect(after.stripeRefundId).toBe('re_test_harness');
      expect(await db.bookingDateLock.count({ where: { bookingId: b.id } })).toBe(0);
    } finally {
      clock.restore();
    }
  });

  it('confirmed → completed issues a repeat code and a review request', async () => {
    const { updateBookingStatus } = await import('@/lib/booking-service');
    const b = await booking('confirmed', { fullyPaidAt: new Date() });

    const result = await updateBookingStatus(b.id, 'completed');

    expect(result.transitioned).toBe(true);
    await waitFor(async () => (await db.review.count()) === 1, { what: 'review request' });
    expect(await db.repeatDiscountCode.count({ where: { issuedForBookingId: b.id } })).toBe(1);
    expect(emailMock.by('sendRepeatDiscountEmail')).toHaveLength(1);
    expect(emailMock.by('sendReviewRequestEmail')).toHaveLength(1);
  });

  it('writes one audit row per transition and none for a same-status write', async () => {
    const { updateBookingStatus } = await import('@/lib/booking-service');
    const b = await booking('pending');

    await updateBookingStatus(b.id, 'confirmed', CONFIRM_OPTS);
    await waitFor(async () => (await db.adminAuditLog.count()) >= 1, { what: 'audit row' });
    const first = await db.adminAuditLog.count();

    // Same status again, with something new to stamp → an update, not a
    // transition.
    await updateBookingStatus(b.id, 'confirmed', { adminNote: 'edited' });
    await settle();
    expect(await db.adminAuditLog.count()).toBe(first);
  });
});

// ── Illegal transitions ──────────────────────────────────────────────────────

const ILLEGAL: Array<{ from: BookingStatus; to: BookingStatus }> = [
  { from: 'pending', to: 'completed' },
  { from: 'confirmed', to: 'pending' },
  { from: 'cancelled', to: 'pending' },
  { from: 'cancelled', to: 'confirmed' },
  { from: 'cancelled', to: 'completed' },
  { from: 'completed', to: 'pending' },
  { from: 'completed', to: 'confirmed' },
];

describe('illegal transitions', () => {
  // FIXED F-51: updateBookingStatus now consults an explicit legal-transition
  // table (pending→confirmed, pending→cancelled, confirmed→cancelled,
  // confirmed→completed) before it touches anything. `cancelled` and
  // `completed` are terminal; everything outside the table is refused with a
  // BookingClientError, which the admin PATCH route answers as a 400.
  it('rejects every transition that is not part of the lifecycle', async () => {
    const { updateBookingStatus, BookingClientError } = await import('@/lib/booking-service');
    const performed: string[] = [];

    for (const { from, to } of ILLEGAL) {
      const b = await booking(from, { skipLocks: true });
      await expect(updateBookingStatus(b.id, to)).rejects.toBeInstanceOf(BookingClientError);
      const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
      if (after.status !== from) performed.push(`${from} → ${to}`);
    }

    expect(performed).toEqual([]);
  });

  // FIXED F-51 (consequence): cancelling deletes the BookingDateLock rows, so
  // the walk back to confirmed would leave a confirmed booking holding none of
  // its dates. `cancelled` is terminal, so that state is unreachable.
  it('never leaves a confirmed booking without its date locks', async () => {
    const { updateBookingStatus, BookingClientError } = await import('@/lib/booking-service');
    const b = await booking('confirmed', { fullyPaidAt: new Date() });

    await updateBookingStatus(b.id, 'cancelled');
    await expect(updateBookingStatus(b.id, 'confirmed')).rejects.toBeInstanceOf(BookingClientError);

    const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.status).toBe('cancelled');
    expect(await db.bookingDateLock.count({ where: { bookingId: b.id } })).toBe(0);
  });

  it('refuses to refund a booking that never paid', async () => {
    const { refundBookingPayment } = await import('@/lib/stripe');
    const b = await booking('pending', { stripePaymentIntentId: PI });

    expect(await refundBookingPayment({ ...b, fullyPaidAt: null })).toBeNull();
    expect(stripeMock.by('refunds.create')).toHaveLength(0);
  });

  it('refuses to confirm a cancelled booking through the payment confirm path', async () => {
    const { confirmBookingPaidFromStripe } = await import('@/lib/booking-service');
    const b = await booking('cancelled');

    expect(await confirmBookingPaidFromStripe({ bookingId: b.id })).toBeNull();
    const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.status).toBe('cancelled');
    expect(after.fullyPaidAt).toBeNull();
    expect(emailMock.sent).toHaveLength(0);
    expect(await db.acceptedContract.count()).toBe(0);
  });

  it('reports a missing booking as a client error instead of creating one', async () => {
    const { updateBookingStatus, BookingClientError } = await import('@/lib/booking-service');
    await expect(updateBookingStatus('does-not-exist', 'confirmed')).rejects.toBeInstanceOf(
      BookingClientError,
    );
    expect(await db.booking.count()).toBe(0);
  });
});

// ── Repeated transitions ─────────────────────────────────────────────────────

describe('repeated transitions are no-ops', () => {
  it('a second confirm neither transitions nor re-sends the confirmation', async () => {
    const { updateBookingStatus } = await import('@/lib/booking-service');
    const b = await booking('pending');

    const first = await updateBookingStatus(b.id, 'confirmed', CONFIRM_OPTS);
    await waitFor(async () => (await db.acceptedContract.count()) === 1, { what: 'contract' });
    const second = await updateBookingStatus(b.id, 'confirmed', CONFIRM_OPTS);
    await settle();

    expect(first.transitioned).toBe(true);
    expect(second.transitioned).toBe(false);
    expect(await db.acceptedContract.count()).toBe(1);
    expect(emailMock.by('sendBookingStatusEmail')).toHaveLength(1);
    expect(emailMock.by('sendNewBookingAdminNotification')).toHaveLength(1);
  });

  it('the pure idempotency short-circuit does not touch the row at all', async () => {
    const { updateBookingStatus } = await import('@/lib/booking-service');
    const b = await booking('confirmed', { fullyPaidAt: new Date() });
    const before = await db.booking.findUniqueOrThrow({ where: { id: b.id } });

    const result = await updateBookingStatus(b.id, 'confirmed');

    expect(result.transitioned).toBe(false);
    const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.fullyPaidAt?.getTime()).toBe(before.fullyPaidAt?.getTime());
  });

  it('a second cancel does not recompute the fee or issue a second refund', async () => {
    const clock = mockClock('2026-09-06T01:00:00+02:00');
    try {
      const { updateBookingStatus } = await import('@/lib/booking-service');
      const b = await booking('confirmed', {
        startDateStr: '2026-09-08',
        fullyPaidAt: new Date(),
        stripePaymentIntentId: PI,
      });

      await updateBookingStatus(b.id, 'cancelled');
      const afterFirst = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
      const second = await updateBookingStatus(b.id, 'cancelled');

      expect(second.transitioned).toBe(false);
      expect(stripeMock.by('refunds.create')).toHaveLength(1);
      const afterSecond = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
      expect(afterSecond.refundAmount).toBe(afterFirst.refundAmount);
      expect(afterSecond.cancellationFee).toBe(afterFirst.cancellationFee);
    } finally {
      clock.restore();
    }
  });

  it('a second complete does not issue a second repeat code', async () => {
    const { updateBookingStatus } = await import('@/lib/booking-service');
    const b = await booking('confirmed', { fullyPaidAt: new Date() });

    await updateBookingStatus(b.id, 'completed');
    await waitFor(async () => (await db.repeatDiscountCode.count()) === 1, { what: 'repeat code' });
    const second = await updateBookingStatus(b.id, 'completed');
    await settle();

    expect(second.transitioned).toBe(false);
    expect(await db.repeatDiscountCode.count()).toBe(1);
    expect(await db.review.count()).toBe(1);
  });
});

// ── Racing transitions ───────────────────────────────────────────────────────

describe('racing transitions', () => {
  it('two simultaneous confirms produce exactly one winner, one contract, one email', async () => {
    const { confirmBookingPaidFromStripe } = await import('@/lib/booking-service');
    const b = await booking('pending');

    await Promise.all([
      confirmBookingPaidFromStripe({ bookingId: b.id, stripePaymentIntentId: PI }),
      confirmBookingPaidFromStripe({ bookingId: b.id, stripePaymentIntentId: PI }),
    ]);

    await waitFor(async () => (await db.acceptedContract.count()) === 1, { what: 'contract' });
    await settle();
    expect(await db.acceptedContract.count()).toBe(1);
    expect(emailMock.by('sendBookingStatusEmail')).toHaveLength(1);
    expect(emailMock.by('sendNewBookingAdminNotification')).toHaveLength(1);
  });

  it('exactly one of two simultaneous updateBookingStatus calls reports transitioned', async () => {
    const { updateBookingStatus } = await import('@/lib/booking-service');
    const b = await booking('pending');

    const results = await Promise.all([
      updateBookingStatus(b.id, 'confirmed', CONFIRM_OPTS),
      updateBookingStatus(b.id, 'confirmed', CONFIRM_OPTS),
    ]);

    expect(results.filter((r) => r.transitioned)).toHaveLength(1);
    expect(results.every((r) => r.status === 'confirmed')).toBe(true);
  });

  // FIXED F-52: the return is gated on `transitioned`, not on the row's
  // status, so only the caller that performed the pending → confirmed
  // transition gets the booking back. The loser sees the documented `null`
  // and treats the payment as already handled.
  it('confirmBookingPaidFromStripe hands null to the loser of a confirm race', async () => {
    const { confirmBookingPaidFromStripe } = await import('@/lib/booking-service');
    const b = await booking('pending');

    const results = await Promise.all([
      confirmBookingPaidFromStripe({ bookingId: b.id, stripePaymentIntentId: PI }),
      confirmBookingPaidFromStripe({ bookingId: b.id, stripePaymentIntentId: PI }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('a confirm racing a cancel leaves the booking in exactly one of the two states', async () => {
    const { updateBookingStatus } = await import('@/lib/booking-service');
    const b = await booking('pending');

    const [confirmed, cancelled] = await Promise.all([
      updateBookingStatus(b.id, 'confirmed', CONFIRM_OPTS),
      updateBookingStatus(b.id, 'cancelled'),
    ]);

    const winners = [confirmed, cancelled].filter((r) => r.transitioned);
    expect(winners).toHaveLength(1);
    const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.status).toBe(winners[0].status);
  });
});

// ── Refund arithmetic + Stripe idempotency ───────────────────────────────────

describe('refundBookingPayment', () => {
  it('refunds the full amount when no fee applies', async () => {
    const { refundBookingPayment } = await import('@/lib/stripe');
    const b = await booking('cancelled', {
      fullyPaidAt: new Date(),
      stripePaymentIntentId: PI,
      totalPrice: 2490,
    });

    const result = await refundBookingPayment(b);

    expect(result).toEqual({ refundId: 're_test_harness', amountRefunded: 2490 });
    expect(
      (stripeMock.by('refunds.create')[0].args[1] as { idempotencyKey: string }).idempotencyKey,
    ).toBe(`refund-${b.id}-249000`);
  });

  it('never refunds more than the charge still has left', async () => {
    stripeMock.responses.charge = chargeOf(100_000, 20_000);
    const { refundBookingPayment } = await import('@/lib/stripe');
    const b = await booking('cancelled', {
      fullyPaidAt: new Date(),
      stripePaymentIntentId: PI,
      totalPrice: 2490,
    });

    const result = await refundBookingPayment(b);

    expect(result?.amountRefunded).toBe(800); // 100 000 − 20 000 øre
    expect((stripeMock.by('refunds.create')[0].args[0] as { amount: number }).amount).toBe(80_000);
  });

  it('returns null instead of a negative refund when the fee swallows the total', async () => {
    const { refundBookingPayment } = await import('@/lib/stripe');
    const b = await booking('cancelled', {
      fullyPaidAt: new Date(),
      stripePaymentIntentId: PI,
      totalPrice: 2490,
      cancellationFee: 2490,
    });

    expect(await refundBookingPayment(b)).toBeNull();
    expect(stripeMock.by('refunds.create')).toHaveLength(0);
  });

  it('returns null once everything has already gone back', async () => {
    const { refundBookingPayment } = await import('@/lib/stripe');
    const b = await booking('cancelled', {
      fullyPaidAt: new Date(),
      stripePaymentIntentId: PI,
      totalPrice: 2490,
      refundAmount: 2490,
    });

    expect(await refundBookingPayment(b)).toBeNull();
    expect(stripeMock.by('refunds.create')).toHaveLength(0);
  });

  it('keys the idempotency on the amount: same amount reuses it, a new amount does not', async () => {
    const { refundBookingPayment } = await import('@/lib/stripe');
    const b = await booking('cancelled', {
      fullyPaidAt: new Date(),
      stripePaymentIntentId: PI,
      totalPrice: 2490,
      refundAmount: 1000,
    });

    // A retry of the same outstanding top-up (our DB write never landed).
    await refundBookingPayment({ ...b, refundAmount: 1000 });
    await refundBookingPayment({ ...b, refundAmount: 1000 });
    // Later, a different outstanding amount (an admin refunded 500 kr more
    // from the dashboard in between).
    await refundBookingPayment({ ...b, refundAmount: 1500 });

    const keys = stripeMock
      .by('refunds.create')
      .map((c) => (c.args[1] as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toEqual([
      `refund-${b.id}-149000`,
      `refund-${b.id}-149000`,
      `refund-${b.id}-99000`,
    ]);
  });

  it('does not refund a payment intent that never succeeded', async () => {
    stripeMock.responses.paymentIntent = { id: PI, object: 'payment_intent', status: 'requires_payment_method' };
    const { refundBookingPayment } = await import('@/lib/stripe');
    const b = await booking('cancelled', { fullyPaidAt: new Date(), stripePaymentIntentId: PI });

    expect(await refundBookingPayment(b)).toBeNull();
    expect(stripeMock.by('refunds.create')).toHaveLength(0);
  });

  it('does not refund an already fully refunded charge', async () => {
    stripeMock.responses.charge = { ...chargeOf(249_000, 249_000), refunded: true };
    const { refundBookingPayment } = await import('@/lib/stripe');
    const b = await booking('cancelled', { fullyPaidAt: new Date(), stripePaymentIntentId: PI });

    expect(await refundBookingPayment(b)).toBeNull();
    expect(stripeMock.by('refunds.create')).toHaveLength(0);
  });
});
