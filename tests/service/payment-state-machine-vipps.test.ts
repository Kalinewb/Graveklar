/**
 * Phase 1c — area F: the Vipps half of the payment state machine.
 *
 * `settleAuthorizedPayment` is the one path that turns an authorized
 * reservation into captured money and a confirmed booking, and both the
 * webhook and the browser return URL call it. Everything here drives it
 * directly (route-level coverage lives in tests/api/payment-vipps.test.ts).
 *
 * The Vipps HTTP calls are stubbed by `mockVipps`; every pure helper
 * (toMinorUnits, buildPaymentReference, the signature verifier) stays real.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { booking, db, ensureSchema, resetDb, seedConfigDefaults } from '../helpers/db';
import { emailMock, stripeMock, vippsMock } from '../helpers/mocks';
import { BOTH_PROVIDERS_CONFIG, settle, vippsPayment, waitFor } from '../helpers/payments';

vi.mock('@/lib/email', async () => (await import('../helpers/mocks')).mockEmail());
vi.mock('stripe', async () => (await import('../helpers/mocks')).mockStripe());
vi.mock('@/lib/vipps', async (orig) =>
  (await import('../helpers/mocks')).mockVipps((await orig()) as Record<string, unknown>));

const TOTAL_KR = 2490;
const TOTAL_ORE = 249_000;

/** A pending booking that already has a live Vipps reference. */
async function vippsBooking(overrides: Record<string, unknown> = {}) {
  const b = await booking('pending', { totalPrice: TOTAL_KR, basePrice: TOTAL_KR, ...overrides });
  const reference = b.reference;
  return db.booking.update({
    where: { id: b.id },
    data: { vippsReference: reference, vippsState: 'CREATED', paymentProvider: 'vipps' },
  });
}

beforeAll(async () => {
  await ensureSchema();
  // Load the mocked modules once: each mock factory resets its recorder when
  // it first runs, which would otherwise wipe a fixture set in beforeEach.
  await Promise.all([import('@/lib/stripe'), import('@/lib/vipps'), import('@/lib/email')]);
});

beforeEach(async () => {
  await resetDb();
  emailMock.reset();
  stripeMock.reset();
  vippsMock.reset();
  await seedConfigDefaults(BOTH_PROVIDERS_CONFIG);
});

// ── Starting a payment ───────────────────────────────────────────────────────

describe('createVippsPaymentForBooking', () => {
  it('burns a new reference per attempt and stamps the 60-minute window', async () => {
    const { createVippsPaymentForBooking } = await import('@/lib/vipps-payments');
    const { VIPPS_PAYMENT_WINDOW_MS } = await import('@/lib/vipps-payments');
    const b = await booking('pending', { paymentRetries: 1 });
    vippsMock.responses.createPayment = (_creds: unknown, input: { reference: string }) => ({
      reference: input.reference,
      redirectUrl: `https://vipps.test/${input.reference}`,
    });

    const before = Date.now();
    const result = await createVippsPaymentForBooking(b, 'http://localhost:3001');

    // paymentRetries = 1 → this is attempt 2 → "-r2" suffix.
    expect(result.reference).toBe(`${b.reference}-r2`);
    const call = vippsMock.by('createPayment')[0].args[1] as {
      idempotencyKey: string;
      returnUrl: string;
      amountKroner: number;
    };
    expect(call.idempotencyKey).toBe(`create-${b.id}-2`);
    expect(call.amountKroner).toBe(b.totalPrice);
    expect(call.returnUrl).toBe(
      `http://localhost:3001/api/payment/vipps/return?ref=${encodeURIComponent(result.reference)}`,
    );

    const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.vippsReference).toBe(result.reference);
    expect(after.vippsState).toBe('CREATED');
    expect(after.paymentProvider).toBe('vipps');
    expect(after.paymentDeadline!.getTime()).toBeGreaterThanOrEqual(
      before + VIPPS_PAYMENT_WINDOW_MS - 5_000,
    );
  });

  it.each([
    ['+47 400 00 000', '4740000000'],
    ['40000000', '4740000000'],
    ['+46 70 000 0000', undefined],
    ['ikke et nummer', undefined],
  ])('normalises %s to an MSISDN prefill of %s', async (phone, expected) => {
    const { createVippsPaymentForBooking } = await import('@/lib/vipps-payments');
    const b = await booking('pending', { phone });

    await createVippsPaymentForBooking(b, 'http://localhost:3001');

    expect(
      (vippsMock.by('createPayment')[0].args[1] as { phoneNumber?: string }).phoneNumber,
    ).toBe(expected);
  });

  it('charges booking.totalPrice and nothing else', async () => {
    const { createVippsPaymentForBooking } = await import('@/lib/vipps-payments');
    const b = await booking('pending', { basePrice: 2490, deliveryFee: 500, totalPrice: 2990 });

    await createVippsPaymentForBooking(b, 'http://localhost:3001');

    expect(
      (vippsMock.by('createPayment')[0].args[1] as { amountKroner: number }).amountKroner,
    ).toBe(2990);
  });
});

// ── settleAuthorizedPayment ──────────────────────────────────────────────────

describe('settleAuthorizedPayment', () => {
  it('reports an unknown reference without calling Vipps', async () => {
    const { settleAuthorizedPayment } = await import('@/lib/vipps-payments');

    expect(await settleAuthorizedPayment('GK-9999-999-NOPE')).toEqual({
      status: 'unknown_reference',
    });
    expect(vippsMock.by('getPayment')).toHaveLength(0);
    expect(vippsMock.by('capturePayment')).toHaveLength(0);
  });

  it('CREATED is still pending and never captures', async () => {
    const { settleAuthorizedPayment } = await import('@/lib/vipps-payments');
    const b = await vippsBooking();
    vippsMock.responses.getPayment = vippsPayment(b.vippsReference!, 'CREATED', {
      amount: TOTAL_ORE,
    });

    expect(await settleAuthorizedPayment(b.vippsReference!)).toEqual({
      status: 'pending',
      state: 'CREATED',
    });
    expect(vippsMock.by('capturePayment')).toHaveLength(0);
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('pending');
  });

  it.each(['ABORTED', 'EXPIRED', 'TERMINATED'])('%s is terminal and is recorded', async (state) => {
    const { settleAuthorizedPayment } = await import('@/lib/vipps-payments');
    const b = await vippsBooking();
    vippsMock.responses.getPayment = vippsPayment(b.vippsReference!, state, { amount: TOTAL_ORE });

    expect(await settleAuthorizedPayment(b.vippsReference!)).toEqual({ status: 'failed', state });
    const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.vippsState).toBe(state);
    expect(after.status).toBe('pending');
    expect(vippsMock.by('capturePayment')).toHaveLength(0);
    expect(emailMock.sent).toHaveLength(0);
  });

  it('refuses to capture when the authorized amount is not what we billed', async () => {
    const { settleAuthorizedPayment } = await import('@/lib/vipps-payments');
    const b = await vippsBooking();
    vippsMock.responses.getPayment = vippsPayment(b.vippsReference!, 'AUTHORIZED', {
      authorized: 100,
    });

    const outcome = await settleAuthorizedPayment(b.vippsReference!);

    expect(outcome).toEqual({ status: 'amount_mismatch', expectedKr: TOTAL_KR, authorizedKr: 1 });
    expect(vippsMock.by('capturePayment')).toHaveLength(0);
    const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.status).toBe('pending');
    expect(after.vippsCapturedAt).toBeNull();
    expect(emailMock.sent).toHaveLength(0);

    const audit = await db.adminAuditLog.findMany({ where: { action: 'vipps.amount_mismatch' } });
    expect(audit).toHaveLength(1);
    expect(audit[0].changes).toContain(String(TOTAL_ORE));
    expect(audit[0].changes).toContain('100');
  });

  it('captures an exact authorization with a per-booking idempotency key and confirms', async () => {
    const { settleAuthorizedPayment } = await import('@/lib/vipps-payments');
    const b = await vippsBooking();
    vippsMock.responses.getPayment = vippsPayment(b.vippsReference!, 'AUTHORIZED', {
      authorized: TOTAL_ORE,
      captured: 0,
    });

    const outcome = await settleAuthorizedPayment(b.vippsReference!, { acceptedFromIp: '1.2.3.4' });

    expect(outcome.status).toBe('confirmed');
    const capture = vippsMock.by('capturePayment')[0];
    expect(capture.args[1]).toBe(b.vippsReference);
    expect(capture.args[2]).toBe(TOTAL_KR);
    expect(capture.args[3]).toBe(`capture-${b.id}-${TOTAL_ORE}`);

    const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.status).toBe('confirmed');
    expect(after.vippsCapturedAt).not.toBeNull();
    expect(after.fullyPaidAt).not.toBeNull();
    expect(after.paymentMethod).toBe('vipps');
    expect(after.paymentDeadline).toBeNull();

    await waitFor(async () => (await db.acceptedContract.count()) === 1, { what: 'contract' });
    expect(emailMock.by('sendBookingStatusEmail')).toHaveLength(1);
    expect(emailMock.by('sendNewBookingAdminNotification')).toHaveLength(1);
  });

  // FIXED F-53: confirmBookingPaidFromStripe takes the provider as an option
  // (default 'stripe'); settleAuthorizedPayment passes 'vipps', so the
  // provider createVippsPaymentForBooking stamped survives confirmation and a
  // revenue split grouped by provider counts Vipps money as Vipps money.
  it('keeps paymentProvider = vipps after a Vipps capture confirms', async () => {
    const { settleAuthorizedPayment } = await import('@/lib/vipps-payments');
    const b = await vippsBooking();
    vippsMock.responses.getPayment = vippsPayment(b.vippsReference!, 'AUTHORIZED', {
      authorized: TOTAL_ORE,
    });

    await settleAuthorizedPayment(b.vippsReference!);

    const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.paymentProvider).toBe('vipps');
  });

  it('does not re-capture when Vipps already reports the full captured amount', async () => {
    const { settleAuthorizedPayment } = await import('@/lib/vipps-payments');
    const b = await vippsBooking();
    vippsMock.responses.getPayment = vippsPayment(b.vippsReference!, 'AUTHORIZED', {
      authorized: TOTAL_ORE,
      captured: TOTAL_ORE,
    });

    const outcome = await settleAuthorizedPayment(b.vippsReference!);

    expect(outcome.status).toBe('confirmed');
    expect(vippsMock.by('capturePayment')).toHaveLength(0);
    expect(
      (await db.booking.findUniqueOrThrow({ where: { id: b.id } })).vippsCapturedAt,
    ).not.toBeNull();
  });

  it('is a no-op on a booking that is no longer pending', async () => {
    const { settleAuthorizedPayment } = await import('@/lib/vipps-payments');
    const b = await vippsBooking();
    await db.booking.update({
      where: { id: b.id },
      data: { status: 'confirmed', fullyPaidAt: new Date(), vippsCapturedAt: new Date() },
    });
    vippsMock.responses.getPayment = vippsPayment(b.vippsReference!, 'AUTHORIZED', {
      authorized: TOTAL_ORE,
      captured: TOTAL_ORE,
    });

    const outcome = await settleAuthorizedPayment(b.vippsReference!);

    expect(outcome.status).toBe('already_handled');
    expect(emailMock.sent).toHaveLength(0);
    expect(await db.acceptedContract.count()).toBe(0);
  });

  it('two simultaneous settles confirm once, capture once, and mail once', async () => {
    const { settleAuthorizedPayment } = await import('@/lib/vipps-payments');
    const b = await vippsBooking();
    vippsMock.responses.getPayment = vippsPayment(b.vippsReference!, 'AUTHORIZED', {
      authorized: TOTAL_ORE,
      captured: 0,
    });

    await Promise.all([
      settleAuthorizedPayment(b.vippsReference!),
      settleAuthorizedPayment(b.vippsReference!),
    ]);

    await waitFor(async () => (await db.acceptedContract.count()) === 1, { what: 'contract' });
    await settle();
    expect(await db.acceptedContract.count()).toBe(1);
    expect(emailMock.by('sendBookingStatusEmail')).toHaveLength(1);
    // Both racers may reach the capture call, but they share one idempotency
    // key, so Vipps collapses them into a single money movement.
    const keys = new Set(vippsMock.by('capturePayment').map((c) => c.args[3]));
    expect(keys.size).toBe(1);
  });

  it('propagates a credentials failure rather than confirming blind', async () => {
    const { settleAuthorizedPayment } = await import('@/lib/vipps-payments');
    const b = await vippsBooking();
    await db.appConfig.update({ where: { key: 'vippsEnabled' }, data: { value: 'false' } });
    const { invalidateCaches } = await import('../helpers/db');
    invalidateCaches();

    await expect(settleAuthorizedPayment(b.vippsReference!)).rejects.toThrow();
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('pending');
  });
});

// ── Refunds ──────────────────────────────────────────────────────────────────

describe('refundVippsBooking', () => {
  it('refunds the outstanding amount with an amount-keyed idempotency key', async () => {
    const { refundVippsBooking } = await import('@/lib/vipps-payments');
    const b = await vippsBooking();
    await db.booking.update({
      where: { id: b.id },
      data: { status: 'cancelled', fullyPaidAt: new Date(), cancellationFee: 490 },
    });
    const fresh = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    vippsMock.responses.getPayment = vippsPayment(b.vippsReference!, 'AUTHORIZED', {
      authorized: TOTAL_ORE,
      captured: TOTAL_ORE,
      refunded: 0,
    });

    const result = await refundVippsBooking(fresh);

    expect(result).toEqual({ amountRefunded: 2000 });
    const refund = vippsMock.by('refundPayment')[0];
    expect(refund.args[2]).toBe(2000);
    expect(refund.args[3]).toBe(`refund-${b.id}-200000`);
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).refundAmount).toBe(2000);
  });

  it('never refunds more than Vipps actually captured', async () => {
    const { refundVippsBooking } = await import('@/lib/vipps-payments');
    const b = await vippsBooking();
    await db.booking.update({
      where: { id: b.id },
      data: { status: 'cancelled', fullyPaidAt: new Date() },
    });
    const fresh = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    vippsMock.responses.getPayment = vippsPayment(b.vippsReference!, 'AUTHORIZED', {
      authorized: TOTAL_ORE,
      captured: 100_000,
      refunded: 40_000,
    });

    expect(await refundVippsBooking(fresh)).toEqual({ amountRefunded: 600 });
    expect(vippsMock.by('refundPayment')[0].args[2]).toBe(600);
  });

  it('returns null instead of a negative refund', async () => {
    const { refundVippsBooking } = await import('@/lib/vipps-payments');
    const b = await vippsBooking();
    await db.booking.update({
      where: { id: b.id },
      data: { status: 'cancelled', fullyPaidAt: new Date(), cancellationFee: TOTAL_KR },
    });
    const fresh = await db.booking.findUniqueOrThrow({ where: { id: b.id } });

    expect(await refundVippsBooking(fresh)).toBeNull();
    expect(vippsMock.by('refundPayment')).toHaveLength(0);
  });

  it('returns null for a booking that never paid or has no Vipps reference', async () => {
    const { refundVippsBooking } = await import('@/lib/vipps-payments');
    const unpaid = await vippsBooking();
    const noRef = await booking('cancelled', { fullyPaidAt: new Date(), skipLocks: true });

    expect(await refundVippsBooking(unpaid)).toBeNull();
    expect(await refundVippsBooking(noRef)).toBeNull();
    expect(vippsMock.by('refundPayment')).toHaveLength(0);
  });
});

// ── Cancel routing ───────────────────────────────────────────────────────────

describe('cancel routes the refund to the provider that took the money', () => {
  it('prefers Vipps when a booking carries both a Vipps reference and a Stripe intent', async () => {
    const { updateBookingStatus } = await import('@/lib/booking-service');
    const b = await vippsBooking({ startDateStr: '2027-01-04' });
    await db.booking.update({
      where: { id: b.id },
      data: {
        status: 'confirmed',
        fullyPaidAt: new Date(),
        stripePaymentIntentId: 'pi_test_audit1c',
      },
    });
    vippsMock.responses.getPayment = vippsPayment(b.vippsReference!, 'AUTHORIZED', {
      authorized: TOTAL_ORE,
      captured: TOTAL_ORE,
    });

    await updateBookingStatus(b.id, 'cancelled');

    expect(vippsMock.by('refundPayment')).toHaveLength(1);
    expect(stripeMock.by('refunds.create')).toHaveLength(0);
  });

  it('uses Stripe when there is no Vipps reference', async () => {
    stripeMock.responses.charge = {
      id: 'ch_test_audit1c',
      object: 'charge',
      amount: TOTAL_ORE,
      amount_refunded: 0,
      refunded: false,
      payment_intent: 'pi_test_audit1c',
    };
    const { updateBookingStatus } = await import('@/lib/booking-service');
    const b = await booking('confirmed', {
      startDateStr: '2027-01-04',
      fullyPaidAt: new Date(),
      stripePaymentIntentId: 'pi_test_audit1c',
    });

    await updateBookingStatus(b.id, 'cancelled');

    expect(stripeMock.by('refunds.create')).toHaveLength(1);
    expect(vippsMock.by('refundPayment')).toHaveLength(0);
  });

  it('a Vipps refund failure does not roll back the cancellation', async () => {
    const { updateBookingStatus } = await import('@/lib/booking-service');
    const b = await vippsBooking({ startDateStr: '2027-01-04' });
    await db.booking.update({
      where: { id: b.id },
      data: { status: 'confirmed', fullyPaidAt: new Date() },
    });
    vippsMock.responses.getPayment = () => {
      throw new Error('Vipps is down');
    };

    const result = await updateBookingStatus(b.id, 'cancelled');

    expect(result.transitioned).toBe(true);
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('cancelled');
    expect(await db.bookingDateLock.count({ where: { bookingId: b.id } })).toBe(0);
  });
});
