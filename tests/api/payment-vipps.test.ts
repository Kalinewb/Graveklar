/**
 * Phase 1c — area F at the HTTP boundary: the four Vipps routes.
 *
 *   POST /api/payment/vipps/create   start a payment (5/15 min)
 *   GET  /api/payment/vipps/return   the browser comes back — flag F-4
 *   GET  /api/payment/vipps/status   the public capability probe
 *   POST /api/payment/vipps/webhook  HMAC gate + idempotency claim + states
 *
 * The webhook signatures are built with the real canonical string from
 * lib/vipps.ts, so `verifyWebhookSignature` runs unmocked; only the six
 * HTTP-speaking functions are stubbed.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { booking, db, ensureSchema, invalidateCaches, resetDb, seedConfigDefaults } from '../helpers/db';
import { emailMock, vippsMock } from '../helpers/mocks';
import {
  VIPPS_CONFIG,
  freshIp,
  postVippsWebhook,
  settle,
  vippsPayment,
  vippsWebhookBody,
  waitFor,
} from '../helpers/payments';
import { call } from '../helpers/route';

vi.mock('@/lib/email', async () => (await import('../helpers/mocks')).mockEmail());
vi.mock('stripe', async () => (await import('../helpers/mocks')).mockStripe());
vi.mock('@/lib/vipps', async (orig) =>
  (await import('../helpers/mocks')).mockVipps((await orig()) as Record<string, unknown>));

const TOTAL_KR = 2490;
const TOTAL_ORE = 249_000;

async function vippsBooking(overrides: Record<string, unknown> = {}) {
  const b = await booking('pending', { totalPrice: TOTAL_KR, basePrice: TOTAL_KR, ...overrides });
  return db.booking.update({
    where: { id: b.id },
    data: { vippsReference: b.reference, vippsState: 'CREATED', paymentProvider: 'vipps' },
  });
}

/**
 * A Vipps that behaves like the real one: once we capture, the payment starts
 * reporting a captured amount. Without this the mock would claim nothing was
 * ever captured and every replay would re-capture.
 */
function authorizedThenCaptured(reference: string, minor = TOTAL_ORE): void {
  let captured = 0;
  vippsMock.responses.getPayment = () =>
    vippsPayment(reference, 'AUTHORIZED', { authorized: minor, captured });
  vippsMock.responses.capturePayment = () => {
    captured = minor;
    return vippsPayment(reference, 'AUTHORIZED', { authorized: minor, captured });
  };
}

/**
 * A fresh rate-limit identity per call. The return route is bounded at 10 per
 * 15 minutes and its limiter map outlives a `beforeEach`, so without this the
 * whole describe block would share one bucket and later tests would start
 * seeing 429s. Both header shapes carry the same address so the tests hold
 * whichever one the route keys on.
 */
function idHeaders(ip = freshIp()): Record<string, string> {
  return { 'x-real-ip': ip, 'x-forwarded-for': ip };
}

async function returnRoute() {
  return (await import('@/app/api/payment/vipps/return/route')).GET;
}

beforeAll(async () => {
  await ensureSchema();
  // Load the mocked modules once: each mock factory resets its recorder when
  // it first runs, which would otherwise wipe a fixture set in beforeEach.
  await Promise.all([import('@/lib/vipps'), import('@/lib/stripe'), import('@/lib/email')]);
});

beforeEach(async () => {
  await resetDb();
  emailMock.reset();
  vippsMock.reset();
  await seedConfigDefaults(VIPPS_CONFIG);
});

// ── POST /api/payment/vipps/create ───────────────────────────────────────────

describe('POST /api/payment/vipps/create', () => {
  it('starts a payment for a pending booking', async () => {
    const { POST } = await import('@/app/api/payment/vipps/create/route');
    const b = await booking('pending');

    const res = await call(POST, {
      method: 'POST',
      path: '/api/payment/vipps/create',
      headers: idHeaders(),
      body: { bookingId: b.id },
    });

    expect(res.status).toBe(200);
    expect(res.json.reference).toBe(b.reference);
    expect(res.json.url).toContain('https://vipps.test/');
    const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.vippsReference).toBe(b.reference);
    expect(after.vippsState).toBe('CREATED');
  });

  it('answers 400 / 410 / 503 on the paths that must not start a payment', async () => {
    const { POST } = await import('@/app/api/payment/vipps/create/route');
    const cancelled = await booking('cancelled');

    const noId = await call(POST, {
      method: 'POST',
      path: '/api/payment/vipps/create',
      headers: idHeaders(),
      body: {},
    });
    const unknown = await call(POST, {
      method: 'POST',
      path: '/api/payment/vipps/create',
      headers: idHeaders(),
      body: { bookingId: 'nope' },
    });
    const notPending = await call(POST, {
      method: 'POST',
      path: '/api/payment/vipps/create',
      headers: idHeaders(),
      body: { bookingId: cancelled.id },
    });

    await db.appConfig.update({ where: { key: 'vippsEnabled' }, data: { value: 'false' } });
    invalidateCaches();
    const disabled = await call(POST, {
      method: 'POST',
      path: '/api/payment/vipps/create',
      headers: idHeaders(),
      body: { bookingId: cancelled.id },
    });

    expect(noId.status).toBe(400);
    expect(unknown.status).toBe(410);
    expect(notPending.status).toBe(410);
    expect(disabled.status).toBe(503);
    expect(vippsMock.by('createPayment')).toHaveLength(0);
  });

  it('throttles at 5 attempts per IP per quarter hour', async () => {
    const { POST } = await import('@/app/api/payment/vipps/create/route');
    const ip = freshIp();
    const statuses: number[] = [];

    for (let i = 0; i < 6; i += 1) {
      const res = await call(POST, {
        method: 'POST',
        path: '/api/payment/vipps/create',
        headers: idHeaders(ip),
        body: { bookingId: 'no-such-booking' },
      });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 5).every((s) => s === 410)).toBe(true);
    expect(statuses[5]).toBe(429);
  });
});

// ── GET /api/payment/vipps/return — flag F-4 ─────────────────────────────────

describe('GET /api/payment/vipps/return', () => {
  it('settles an authorized payment and redirects to success', async () => {
    const b = await vippsBooking();
    authorizedThenCaptured(b.vippsReference!);

    const res = await call(await returnRoute(), {
      path: '/api/payment/vipps/return',
      headers: idHeaders(),
      searchParams: { ref: b.vippsReference! },
    });

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('vipps=success');
    expect(res.headers.get('location')).toContain(encodeURIComponent(b.reference));
    await waitFor(async () => (await db.acceptedContract.count()) === 1, { what: 'contract' });
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('confirmed');
  });

  it('is idempotent across repeated returns: one capture, one confirmation', async () => {
    const b = await vippsBooking();
    authorizedThenCaptured(b.vippsReference!);
    const GET = await returnRoute();
    const headers = idHeaders();

    // Five, from one client: the same budget a refreshing customer spends.
    for (let i = 0; i < 5; i += 1) {
      const res = await call(GET, {
        path: '/api/payment/vipps/return',
        headers,
        searchParams: { ref: b.vippsReference! },
      });
      expect(res.headers.get('location')).toContain('vipps=success');
    }
    await settle();

    expect(vippsMock.by('capturePayment')).toHaveLength(1);
    expect(emailMock.by('sendBookingStatusEmail')).toHaveLength(1);
    expect(emailMock.by('sendNewBookingAdminNotification')).toHaveLength(1);
    expect(await db.acceptedContract.count()).toBe(1);
  });

  it('maps every non-authorized state onto a redirect instead of an error page', async () => {
    const GET = await returnRoute();
    const b = await vippsBooking();

    vippsMock.responses.getPayment = vippsPayment(b.vippsReference!, 'CREATED', {
      amount: TOTAL_ORE,
    });
    const processing = await call(GET, {
      path: '/api/payment/vipps/return',
      headers: idHeaders(),
      searchParams: { ref: b.vippsReference! },
    });

    vippsMock.responses.getPayment = vippsPayment(b.vippsReference!, 'ABORTED', {
      amount: TOTAL_ORE,
    });
    const aborted = await call(GET, {
      path: '/api/payment/vipps/return',
      headers: idHeaders(),
      searchParams: { ref: b.vippsReference! },
    });

    const missingRef = await call(GET, {
      path: '/api/payment/vipps/return',
      headers: idHeaders(),
    });
    const unknownRef = await call(GET, {
      path: '/api/payment/vipps/return',
      headers: idHeaders(),
      searchParams: { ref: 'GK-0000-000-NOPE' },
    });

    expect(processing.headers.get('location')).toContain('vipps=processing');
    expect(aborted.headers.get('location')).toContain('vipps=cancelled');
    expect(missingRef.headers.get('location')).toContain('vipps=error');
    expect(unknownRef.headers.get('location')).toContain('vipps=error');
  });

  it('refuses to capture an amount that does not match the booking', async () => {
    const b = await vippsBooking();
    vippsMock.responses.getPayment = vippsPayment(b.vippsReference!, 'AUTHORIZED', {
      authorized: 100,
    });

    const res = await call(await returnRoute(), {
      path: '/api/payment/vipps/return',
      headers: idHeaders(),
      searchParams: { ref: b.vippsReference! },
    });

    expect(res.headers.get('location')).toContain('vipps=error');
    expect(vippsMock.by('capturePayment')).toHaveLength(0);
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('pending');
    expect(
      await db.adminAuditLog.count({ where: { action: 'vipps.amount_mismatch' } }),
    ).toBeGreaterThan(0);
  });

  // DEFERRED R-8 (see docs/audit/phase1c): capture is money movement, and this
  // route performs it from an unauthenticated GET keyed only on the payment
  // reference. The Vipps idempotency key keeps the customer from being charged
  // twice, but the request itself is not safe: a prefetcher, a link scanner or
  // anyone who has seen the reference can drive a capture and a booking
  // confirmation. The equivalent Stripe return (/api/payment/stripe/callback)
  // only reads a session; it never captures.
  //
  // The fix — settle from the webhook, and have the return page ask for
  // settlement over an explicit POST — is deferred because it cannot be
  // exercised against a live Vipps in this audit. What landed instead is the
  // bound (10/15 min, asserted below) and the idempotence-in-effect the two
  // tests above pin. This stays red on purpose until R-8 is done.
  it.fails('never captures money in response to a GET', async () => {
    const b = await vippsBooking();
    authorizedThenCaptured(b.vippsReference!);

    await call(await returnRoute(), {
      path: '/api/payment/vipps/return',
      headers: idHeaders(),
      searchParams: { ref: b.vippsReference! },
    });
    await settle();

    expect(vippsMock.by('capturePayment')).toHaveLength(0);
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('pending');
  });

  // FINDING F-4 (second half, fixed): POST /api/payment/vipps/create is limited
  // to 5 requests per IP per 15 minutes, but the GET that actually captures had
  // no limiter at all, so every hit was an unbounded outbound Vipps API call.
  // It is now 10 per client per 15 minutes — well clear of a customer who
  // refreshes, and a hard stop for anything hammering a reference.
  it('throttles a client that hammers the return URL', async () => {
    const GET = await returnRoute();
    const headers = idHeaders();
    const statuses: number[] = [];

    for (let i = 0; i < 30; i += 1) {
      const res = await call(GET, {
        path: '/api/payment/vipps/return',
        headers,
        searchParams: { ref: 'GK-0000-000-NOPE' },
      });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 10).every((s) => s === 307)).toBe(true);
    expect(statuses.slice(10).every((s) => s === 429)).toBe(true);
    // A different client is unaffected — the budget is per identity.
    const other = await call(GET, {
      path: '/api/payment/vipps/return',
      headers: idHeaders(),
      searchParams: { ref: 'GK-0000-000-NOPE' },
    });
    expect(other.status).toBe(307);
  });
});

// ── GET /api/payment/vipps/status ────────────────────────────────────────────

describe('GET /api/payment/vipps/status', () => {
  it('reports enabled only when the credentials are complete', async () => {
    const { GET } = await import('@/app/api/payment/vipps/status/route');

    expect((await call(GET, { path: '/api/payment/vipps/status' })).json).toEqual({ enabled: true });

    await db.appConfig.update({ where: { key: 'vippsMsn' }, data: { value: '' } });
    invalidateCaches();
    expect((await call(GET, { path: '/api/payment/vipps/status' })).json).toEqual({
      enabled: false,
    });
  });
});

// ── POST /api/payment/vipps/webhook ──────────────────────────────────────────

describe('POST /api/payment/vipps/webhook', () => {
  it('rejects a body whose signature was made with another secret', async () => {
    const b = await vippsBooking();

    const res = await postVippsWebhook(vippsWebhookBody('AUTHORIZED', b.vippsReference!), {
      secret: 'not-the-webhook-secret',
    });

    expect(res.status).toBe(401);
    expect(await db.webhookEvent.count()).toBe(0);
    expect(vippsMock.by('getPayment')).toHaveLength(0);
  });

  it('rejects a body that was swapped after signing', async () => {
    const b = await vippsBooking();
    const real = JSON.stringify(vippsWebhookBody('AUTHORIZED', b.vippsReference!));
    const tampered = JSON.stringify(vippsWebhookBody('AUTHORIZED', 'GK-0000-000-EVIL'));

    const res = await postVippsWebhook(tampered, { signedBody: real });

    expect(res.status).toBe(401);
  });

  it('answers 503 when no webhook secret is configured', async () => {
    await db.appConfig.update({ where: { key: 'vippsWebhookSecret' }, data: { value: '' } });
    invalidateCaches();
    const b = await vippsBooking();

    const res = await postVippsWebhook(vippsWebhookBody('AUTHORIZED', b.vippsReference!));

    expect(res.status).toBe(503);
    expect(vippsMock.by('capturePayment')).toHaveLength(0);
  });

  it('answers 400 for unparseable JSON and for a body missing the required fields', async () => {
    const badJson = await postVippsWebhook('{not json');
    const missing = await postVippsWebhook({ msn: '123456' });

    expect(badJson.status).toBe(400);
    expect(missing.status).toBe(400);
    expect(await db.webhookEvent.count()).toBe(0);
  });

  it('claims each (name, pspReference) pair exactly once', async () => {
    const b = await vippsBooking();
    authorizedThenCaptured(b.vippsReference!);
    const body = vippsWebhookBody('AUTHORIZED', b.vippsReference!);

    const first = await postVippsWebhook(body);
    const second = await postVippsWebhook(body);

    expect(first.json).toEqual({ ok: true });
    expect(second.json).toEqual({ ok: true, duplicate: true });
    const claim = await db.webhookEvent.findFirstOrThrow();
    expect(claim.provider).toBe('vipps');
    expect(claim.eventId).toBe(`AUTHORIZED-psp_${b.vippsReference}`);
  });

  it('AUTHORIZED captures and confirms', async () => {
    const b = await vippsBooking();
    authorizedThenCaptured(b.vippsReference!);

    const res = await postVippsWebhook(vippsWebhookBody('AUTHORIZED', b.vippsReference!));

    expect(res.status).toBe(200);
    await waitFor(async () => (await db.acceptedContract.count()) === 1, { what: 'contract' });
    const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.status).toBe('confirmed');
    expect(after.vippsCapturedAt).not.toBeNull();
    expect(vippsMock.by('capturePayment')).toHaveLength(1);
  });

  it('AUTHORIZED with a mismatched amount answers 200 but moves no money', async () => {
    const b = await vippsBooking();
    vippsMock.responses.getPayment = vippsPayment(b.vippsReference!, 'AUTHORIZED', {
      authorized: 1,
    });

    const res = await postVippsWebhook(vippsWebhookBody('AUTHORIZED', b.vippsReference!));

    expect(res.status).toBe(200);
    expect(vippsMock.by('capturePayment')).toHaveLength(0);
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('pending');
  });

  it.each(['ABORTED', 'EXPIRED', 'TERMINATED'])(
    '%s grants one retry, then the next one cancels',
    async (state) => {
      const b = await vippsBooking();

      await postVippsWebhook(vippsWebhookBody(state, b.vippsReference!));
      const afterFirst = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
      expect(afterFirst.status).toBe('pending');
      expect(afterFirst.paymentRetries).toBe(1);
      expect(emailMock.by('sendPaymentRetryEmail')).toHaveLength(1);

      // The deadline must be the window the new Vipps link is actually good
      // for. Writing the shorter Stripe grace over it would let the cleanup
      // sweep cancel the booking while a live Vipps payment is still open.
      const { VIPPS_PAYMENT_WINDOW_MS } = await import('@/lib/vipps-payments');
      expect(afterFirst.paymentDeadline!.getTime() - Date.now()).toBeGreaterThan(
        VIPPS_PAYMENT_WINDOW_MS - 60_000,
      );

      // The retry attempt burns a new reference; the next failure arrives on it.
      await postVippsWebhook(
        vippsWebhookBody(state, afterFirst.vippsReference!, {
          pspReference: `psp_retry_${state}`,
        }),
      );
      await settle();

      const afterSecond = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
      expect(afterSecond.status).toBe('cancelled');
      expect(await db.bookingDateLock.count({ where: { bookingId: b.id } })).toBe(0);
    },
  );

  // FINDING F-54, Vipps half (fixed): handleFailedPayment used to increment
  // paymentRetries and extend paymentDeadline before checking siteUrl, so with
  // that row blank the customer's single second chance was spent on a retry
  // payment that was never created and the next failure cancelled the booking.
  // The Stripe counterpart is in tests/service/payment-sequences.test.ts.
  it('does not spend the retry budget when no retry payment can be created', async () => {
    await db.appConfig.update({ where: { key: 'siteUrl' }, data: { value: '' } });
    invalidateCaches();
    const b = await vippsBooking();
    const before = await db.booking.findUniqueOrThrow({ where: { id: b.id } });

    await postVippsWebhook(vippsWebhookBody('ABORTED', b.vippsReference!));
    await settle();

    const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(vippsMock.by('createPayment')).toHaveLength(0);
    expect(emailMock.by('sendPaymentRetryEmail')).toHaveLength(0);
    expect(after.paymentRetries).toBe(0);
    expect(after.paymentDeadline?.getTime() ?? null).toBe(before.paymentDeadline?.getTime() ?? null);
    expect(after.status).toBe('pending');
    // The state Vipps reported is still recorded — that is an observation, not
    // a spend.
    expect(after.vippsState).toBe('ABORTED');
  });

  it('ignores a failure event for a booking that is already confirmed', async () => {
    const b = await vippsBooking();
    await db.booking.update({
      where: { id: b.id },
      data: { status: 'confirmed', fullyPaidAt: new Date() },
    });

    await postVippsWebhook(vippsWebhookBody('ABORTED', b.vippsReference!));
    await settle();

    const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.status).toBe('confirmed');
    expect(after.paymentRetries).toBe(0);
    expect(emailMock.sent).toHaveLength(0);
  });

  it('CAPTURED stamps the capture timestamp exactly once', async () => {
    const b = await vippsBooking();

    await postVippsWebhook(vippsWebhookBody('CAPTURED', b.vippsReference!));
    const first = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(first.vippsCapturedAt).not.toBeNull();

    await postVippsWebhook(
      vippsWebhookBody('CAPTURED', b.vippsReference!, { pspReference: 'psp_second' }),
    );
    const second = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(second.vippsCapturedAt!.getTime()).toBe(first.vippsCapturedAt!.getTime());
  });

  it('REFUNDED widens the recorded refund but never shrinks it', async () => {
    const b = await vippsBooking();
    await db.booking.update({ where: { id: b.id }, data: { refundAmount: 1500 } });

    await postVippsWebhook(
      vippsWebhookBody('REFUNDED', b.vippsReference!, {
        amount: { currency: 'NOK', value: 200_000 },
      }),
    );
    await waitFor(
      async () => (await db.booking.findUniqueOrThrow({ where: { id: b.id } })).refundAmount === 2000,
      { what: 'refund widened' },
    );

    await postVippsWebhook(
      vippsWebhookBody('REFUNDED', b.vippsReference!, {
        pspReference: 'psp_echo',
        amount: { currency: 'NOK', value: 50_000 },
      }),
    );
    await settle();

    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).refundAmount).toBe(2000);
    expect(await db.adminAuditLog.count({ where: { action: 'vipps.refunded' } })).toBe(2);
  });

  it('CANCELLED writes an audit row and nothing else', async () => {
    const b = await vippsBooking();

    await postVippsWebhook(vippsWebhookBody('CANCELLED', b.vippsReference!));
    await waitFor(
      async () => (await db.adminAuditLog.count({ where: { action: 'vipps.cancelled' } })) === 1,
      { what: 'cancel audit row' },
    );

    const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.status).toBe('pending');
    expect(after.refundAmount).toBeNull();
  });

  it('ignores an event for a reference we have never seen', async () => {
    const res = await postVippsWebhook(vippsWebhookBody('CAPTURED', 'GK-0000-000-NOPE'));

    expect(res.status).toBe(200);
    expect(await db.adminAuditLog.count()).toBe(0);
  });
});
