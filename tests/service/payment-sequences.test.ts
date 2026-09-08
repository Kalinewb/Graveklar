/**
 * Phase 1c — area F: named end-to-end payment sequences.
 *
 * Everything here goes through the real route handlers with real Stripe
 * signatures (`signedEvent` — the mocked package still verifies the HMAC), so
 * the webhook's idempotency claim, its release-on-error, and the retry budget
 * are exercised the way Stripe would exercise them: out of order, twice, and
 * after a failure.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { booking, db, ensureSchema, resetDb, seedConfigDefaults } from '../helpers/db';
import { emailMock, stripeMock } from '../helpers/mocks';
import {
  STRIPE_CONFIG,
  buildStripeEvent,
  checkoutSession,
  postStripeEnvelope,
  postStripeEvent,
  settle,
  waitFor,
} from '../helpers/payments';

vi.mock('@/lib/email', async () => (await import('../helpers/mocks')).mockEmail());
vi.mock('stripe', async () => (await import('../helpers/mocks')).mockStripe());

const PI = 'pi_test_audit1c';

/** GET /api/payment/stripe/callback the way Stripe's success_url would. */
async function callback(bookingId: string, sessionId = 'cs_test_audit1c') {
  const { call } = await import('../helpers/route');
  const { GET } = await import('@/app/api/payment/stripe/callback/route');
  return call(GET, {
    path: '/api/payment/stripe/callback',
    searchParams: { session_id: sessionId, bid: bookingId },
  });
}

/**
 * Make the next `checkout.sessions.create` blow up, once. The mocked client
 * reads `stripeMock.responses.checkoutSession` to build its reply, so a
 * one-shot throwing getter is the least invasive way to model a Stripe outage
 * in the middle of a webhook handler.
 */
function failNextSessionCreate(): void {
  const value = stripeMock.responses.checkoutSession;
  let thrown = false;
  Object.defineProperty(stripeMock.responses, 'checkoutSession', {
    configurable: true,
    get() {
      if (thrown) return value;
      thrown = true;
      throw new Error('[test] simulated Stripe outage');
    },
  });
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
});

// ── Out-of-order deliveries ──────────────────────────────────────────────────

describe('completed → expired', () => {
  it('a late expiry after a successful payment changes nothing', async () => {
    const b = await booking('pending');

    const first = await postStripeEvent('checkout.session.completed', checkoutSession(b.id));
    expect(first.res.status).toBe(200);
    await waitFor(async () => (await db.acceptedContract.count()) === 1, { what: 'contract' });

    const second = await postStripeEvent('checkout.session.expired', checkoutSession(b.id));
    await settle();

    expect(second.res.status).toBe(200);
    const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.status).toBe('confirmed');
    expect(after.paymentRetries).toBe(0);
    expect(after.paymentDeadline).toBeNull();
    expect(emailMock.by('sendPaymentRetryEmail')).toHaveLength(0);
    expect(emailMock.by('sendBookingStatusEmail')).toHaveLength(1);
    expect(await db.acceptedContract.count()).toBe(1);
  });
});

describe('expired → completed', () => {
  it('a payment that lands after the retry was granted still confirms', async () => {
    const b = await booking('pending');

    await postStripeEvent('checkout.session.expired', checkoutSession(b.id));
    const afterExpiry = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(afterExpiry.status).toBe('pending');
    expect(afterExpiry.paymentRetries).toBe(1);
    expect(emailMock.by('sendPaymentRetryEmail')).toHaveLength(1);

    const late = await postStripeEvent('checkout.session.completed', checkoutSession(b.id));
    expect(late.res.status).toBe(200);

    await waitFor(async () => (await db.acceptedContract.count()) === 1, { what: 'contract' });
    const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.status).toBe('confirmed');
    expect(after.fullyPaidAt).not.toBeNull();
    expect(emailMock.by('sendBookingStatusEmail')).toHaveLength(1);
  });
});

describe('completed → callback → duplicate completed', () => {
  it('confirms once no matter how many times the same news arrives', async () => {
    const b = await booking('pending');
    stripeMock.responses.checkoutSession = checkoutSession(b.id);

    const { envelope } = await postStripeEvent('checkout.session.completed', checkoutSession(b.id));
    const browserReturn = await callback(b.id);
    const replay = await postStripeEnvelope(envelope);

    expect(browserReturn.status).toBe(307);
    expect(browserReturn.headers.get('location')).toContain('stripe=success');
    expect(replay.status).toBe(200);
    expect(replay.json).toEqual({ ok: true, duplicate: true });

    await waitFor(async () => (await db.acceptedContract.count()) === 1, { what: 'contract' });
    await settle();
    expect(await db.acceptedContract.count()).toBe(1);
    expect(emailMock.by('sendBookingStatusEmail')).toHaveLength(1);
    expect(emailMock.by('sendNewBookingAdminNotification')).toHaveLength(1);
    expect(await db.webhookEvent.count()).toBe(1);
  });
});

// ── The retry budget ─────────────────────────────────────────────────────────

describe('expired → retry → expired → cancelled', () => {
  it('spends MAX_PAYMENT_RETRIES once and then cancels', async () => {
    const { MAX_PAYMENT_RETRIES } = await import('@/lib/stripe');
    expect(MAX_PAYMENT_RETRIES).toBe(1);
    const b = await booking('pending');

    await postStripeEvent('checkout.session.expired', checkoutSession(b.id));
    const afterFirst = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(afterFirst.status).toBe('pending');
    expect(afterFirst.paymentRetries).toBe(1);

    await postStripeEvent('checkout.session.expired', checkoutSession(b.id));
    await settle();

    const afterSecond = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(afterSecond.status).toBe('cancelled');
    expect(await db.bookingDateLock.count({ where: { bookingId: b.id } })).toBe(0);
    expect(emailMock.by('sendPaymentRetryEmail')).toHaveLength(1);
    expect(emailMock.by('sendBookingExpiredEmail')).toHaveLength(1);
  });

  // Since F-3, the cancel_url is a redirect and nothing else, so the customer
  // closing Checkout no longer spends anything: the budget belongs to the
  // webhook alone, and the abandoned session's expiry is what grants the one
  // retry. (Before F-3 this same sequence cancelled the booking outright,
  // because the redirect had already spent the only second chance.)
  it('the cancel-callback spends nothing from the webhook budget', async () => {
    const { call } = await import('../helpers/route');
    const { GET } = await import('@/app/api/payment/stripe/cancel/route');
    const b = await booking('pending');

    // Customer closes Checkout → cancel_url → back to the site, untouched.
    await call(GET, { path: '/api/payment/stripe/cancel', searchParams: { bid: b.id } });
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).paymentRetries).toBe(0);

    // The abandoned session then expires: the budget is still there, so this
    // is the retry rather than the cancellation.
    await postStripeEvent('checkout.session.expired', checkoutSession(b.id));
    await settle();

    const afterFirst = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(afterFirst.status).toBe('pending');
    expect(afterFirst.paymentRetries).toBe(1);
    expect(emailMock.by('sendPaymentRetryEmail')).toHaveLength(1);

    // …and the second expiry is the one that cancels.
    await postStripeEvent('checkout.session.expired', checkoutSession(b.id));
    await settle();

    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('cancelled');
  });

  // FINDING F-54 (fixed): the expiry branch used to increment paymentRetries
  // and extend paymentDeadline before it knew whether a retry link could
  // actually be built — with siteUrl unset it never called
  // createCheckoutSession at all and only logged a warning, so the customer's
  // single second chance was spent on a retry that was never sent and the next
  // expiry cancelled the booking. The link is now built first and the budget
  // is only spent once there is something to send. The Vipps webhook had the
  // same shape; its counterpart lives in tests/api/payment-vipps.test.ts.
  it('does not spend the retry budget when no retry link can be sent', async () => {
    const { invalidateCaches } = await import('../helpers/db');
    await db.appConfig.update({ where: { key: 'siteUrl' }, data: { value: '' } });
    invalidateCaches();
    const b = await booking('pending');
    const before = await db.booking.findUniqueOrThrow({ where: { id: b.id } });

    await postStripeEvent('checkout.session.expired', checkoutSession(b.id));
    await settle();

    const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(emailMock.by('sendPaymentRetryEmail')).toHaveLength(0);
    expect(after.paymentRetries).toBe(0);
    // The deadline is part of the same budget: extending it for a retry the
    // customer never received would hold the dates hostage for another window.
    expect(after.paymentDeadline?.getTime() ?? null).toBe(before.paymentDeadline?.getTime() ?? null);
    expect(after.status).toBe('pending');
  });

  it('an async payment failure follows the same budget as an expiry', async () => {
    const b = await booking('pending', { paymentRetries: 1 });

    await postStripeEvent('checkout.session.async_payment_failed', checkoutSession(b.id));
    await settle();

    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('cancelled');
  });

  it('an unpaid completed session is not treated as payment', async () => {
    const b = await booking('pending');

    await postStripeEvent(
      'checkout.session.completed',
      checkoutSession(b.id, { payment_status: 'unpaid' }),
    );
    await settle();

    const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.status).toBe('pending');
    expect(after.fullyPaidAt).toBeNull();
    expect(emailMock.sent).toHaveLength(0);

    // …and the later async settlement is what confirms it.
    await postStripeEvent(
      'checkout.session.async_payment_succeeded',
      checkoutSession(b.id, { payment_status: 'paid' }),
    );
    await waitFor(async () => (await db.acceptedContract.count()) === 1, { what: 'contract' });
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('confirmed');
  });
});

// ── Refund echoes ────────────────────────────────────────────────────────────

describe('refunded → charge.refunded replay', () => {
  it('short-circuits when the booking already reflects the refund', async () => {
    const b = await booking('cancelled', {
      stripePaymentIntentId: PI,
      refundAmount: 1245,
      stripeRefundId: 're_first',
      fullyPaidAt: new Date(),
    });
    const before = await db.booking.findUniqueOrThrow({ where: { id: b.id } });

    await postStripeEvent('charge.refunded', {
      id: 'ch_1',
      object: 'charge',
      payment_intent: PI,
      amount_refunded: 124_500,
      refunds: { data: [{ id: 're_first' }] },
    });
    await settle();

    const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(await db.adminAuditLog.count({ where: { action: 'booking.refunded_externally' } })).toBe(
      0,
    );
  });

  it('records a dashboard-issued top-up refund cumulatively', async () => {
    const b = await booking('cancelled', {
      stripePaymentIntentId: PI,
      refundAmount: 1245,
      stripeRefundId: 're_first',
      fullyPaidAt: new Date(),
    });

    await postStripeEvent('charge.refunded', {
      id: 'ch_1',
      object: 'charge',
      payment_intent: PI,
      amount_refunded: 249_000,
      refunds: { data: [{ id: 're_second' }] },
    });
    await waitFor(
      async () =>
        (await db.adminAuditLog.count({ where: { action: 'booking.refunded_externally' } })) === 1,
      { what: 'refund audit row' },
    );

    const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.refundAmount).toBe(2490);
    expect(after.stripeRefundId).toBe('re_second');
  });

  it('logs a dispute without mutating the booking', async () => {
    const b = await booking('confirmed', { stripePaymentIntentId: PI, fullyPaidAt: new Date() });
    const before = await db.booking.findUniqueOrThrow({ where: { id: b.id } });

    await postStripeEvent('charge.dispute.created', {
      id: 'dp_1',
      object: 'dispute',
      charge: 'ch_1',
      payment_intent: PI,
      amount: 249_000,
      reason: 'fraudulent',
    });
    await waitFor(
      async () => (await db.adminAuditLog.count({ where: { action: 'stripe.dispute_created' } })) === 1,
      { what: 'dispute audit row' },
    );

    const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.status).toBe('confirmed');
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it('logs a synchronous card failure without touching the booking', async () => {
    const b = await booking('pending');

    await postStripeEvent('payment_intent.payment_failed', {
      id: PI,
      object: 'payment_intent',
      metadata: { bookingId: b.id },
      last_payment_error: { code: 'card_declined', message: 'Your card was declined.' },
    });
    await waitFor(
      async () => (await db.adminAuditLog.count({ where: { action: 'stripe.payment_failed' } })) === 1,
      { what: 'failure audit row' },
    );

    const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.status).toBe('pending');
    expect(after.paymentRetries).toBe(0);
  });
});

// ── Idempotency claim lifecycle ──────────────────────────────────────────────

describe('claim release and replay', () => {
  it('releases the claim when the handler throws, and the replay does the work once', async () => {
    const b = await booking('pending');
    failNextSessionCreate();

    const envelope = buildStripeEvent('checkout.session.expired', checkoutSession(b.id));
    const failed = await postStripeEnvelope(envelope);

    expect(failed.status).toBe(500);
    expect(await db.webhookEvent.count()).toBe(0);
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).paymentRetries).toBe(0);

    const replay = await postStripeEnvelope(envelope);
    await settle();

    expect(replay.status).toBe(200);
    expect(await db.webhookEvent.count()).toBe(1);
    const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.paymentRetries).toBe(1);
    expect(emailMock.by('sendPaymentRetryEmail')).toHaveLength(1);
  });

  it('a replay after the claim was released post-confirmation does not confirm twice', async () => {
    const b = await booking('pending');
    const { envelope } = await postStripeEvent('checkout.session.completed', checkoutSession(b.id));
    await waitFor(async () => (await db.acceptedContract.count()) === 1, { what: 'contract' });

    // Exactly what the error path does: drop the claim so the provider's
    // retry replays the event.
    await db.webhookEvent.deleteMany({});
    const replay = await postStripeEnvelope(envelope);
    await settle();

    expect(replay.status).toBe(200);
    expect(replay.json).toEqual({ ok: true });
    expect(await db.acceptedContract.count()).toBe(1);
    expect(emailMock.by('sendBookingStatusEmail')).toHaveLength(1);
    expect(emailMock.by('sendNewBookingAdminNotification')).toHaveLength(1);
  });

  it('rejects an unsigned or wrongly signed payload before claiming anything', async () => {
    const b = await booking('pending');
    const envelope = buildStripeEvent('checkout.session.completed', checkoutSession(b.id));

    const wrongSecret = await postStripeEnvelope(envelope, { secret: 'whsec_not_ours' });
    const noSignature = await postStripeEnvelope(envelope, { signature: '' });

    expect(wrongSecret.status).toBe(400);
    expect(noSignature.status).toBe(400);
    expect(await db.webhookEvent.count()).toBe(0);
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('pending');
  });

  it('claims and ignores an event type it does not handle', async () => {
    const { res } = await postStripeEvent('invoice.paid', { id: 'in_1', object: 'invoice' });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    expect(await db.webhookEvent.count()).toBe(1);
  });

  it('ignores a session that carries no bookingId', async () => {
    const { res } = await postStripeEvent('checkout.session.completed', {
      id: 'cs_orphan',
      object: 'checkout.session',
      payment_status: 'paid',
      metadata: {},
    });

    expect(res.status).toBe(200);
    expect(emailMock.sent).toHaveLength(0);
  });
});
