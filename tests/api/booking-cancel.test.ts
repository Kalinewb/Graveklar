/**
 * Phase 1c — area G at the HTTP boundary: the customer cancellation route.
 *
 *   GET  /api/booking/cancel   fee preview by token, or by reference + e-mail
 *   POST /api/booking/cancel   the cancellation itself
 *
 * The two verbs have SEPARATE budgets since Q-12 — 60 per 15 minutes for the
 * read-only GET preview, 10 for the destructive POST — both accept the same two
 * identification schemes, and the preview must agree with what the POST
 * actually charges: that agreement is the invariant the customer sees.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { booking, db, ensureSchema, resetDb, seedConfigDefaults } from '../helpers/db';
import { emailMock, mockClock, stripeMock } from '../helpers/mocks';
import { STRIPE_CONFIG, settle, waitFor } from '../helpers/payments';
// Since H-5 was fixed the budget key is the last x-forwarded-for hop, so the
// identity helpers come from ../helpers/client-ip rather than the x-real-ip
// ones in ../helpers/payments.
import { freshForwardedIp as freshIp, ipHeaders } from '../helpers/client-ip';
import { call } from '../helpers/route';

vi.mock('@/lib/email', async () => (await import('../helpers/mocks')).mockEmail());
vi.mock('stripe', async () => (await import('../helpers/mocks')).mockStripe());

const PI = 'pi_test_audit1c';

const CANCEL_CONFIG: Record<string, string> = {
  ...STRIPE_CONFIG,
  cancelFreeWeeks: '0',
  cancelFreeDays: '2',
  cancelLatePercent: '50',
  cancelSameDayPercent: '100',
};

async function routes() {
  return import('@/app/api/booking/cancel/route');
}

/** A confirmed, paid booking with a live cancellation token. */
async function cancellable(overrides: Record<string, unknown> = {}) {
  const b = await booking('confirmed', {
    startDateStr: '2027-01-04',
    basePrice: 2490,
    totalPrice: 2490,
    fullyPaidAt: new Date(),
    stripePaymentIntentId: PI,
    ...overrides,
  });
  return db.booking.update({
    where: { id: b.id },
    data: {
      cancelToken: `tok-${b.id}`,
      cancelTokenExpiry: new Date(Date.now() + 30 * 24 * 3600 * 1000),
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
  await seedConfigDefaults(CANCEL_CONFIG);
  stripeMock.responses.charge = {
    id: 'ch_test_audit1c',
    object: 'charge',
    amount: 1_000_000,
    amount_refunded: 0,
    refunded: false,
    payment_intent: PI,
  };
});

// ── Identification ───────────────────────────────────────────────────────────

describe('identifying the booking', () => {
  it('previews the cancellation by token', async () => {
    const { GET } = await routes();
    const b = await cancellable();

    const res = await call(GET, {
      path: '/api/booking/cancel',
      headers: ipHeaders(),
      searchParams: { token: b.cancelToken! },
    });

    expect(res.status).toBe(200);
    expect(res.json.reference).toBe(b.reference);
    expect(res.json.status).toBe('confirmed');
    expect(res.json.cancellationFeePreview).toBe(0);
    expect(res.json.cancelFreeHours).toBe(48);
    expect(res.json.hoursUntil).toBeGreaterThan(48);
  });

  it('accepts reference + e-mail regardless of case or surrounding space', async () => {
    const { GET } = await routes();
    const b = await cancellable();

    const res = await call(GET, {
      path: '/api/booking/cancel',
      headers: ipHeaders(),
      searchParams: { ref: b.reference, email: '  TEST@Example.COM ' },
    });

    expect(res.status).toBe(200);
    expect(res.json.reference).toBe(b.reference);
  });

  it('answers 404 for a wrong token, a wrong e-mail, and an unknown reference', async () => {
    const { GET } = await routes();
    const b = await cancellable();

    const badToken = await call(GET, {
      path: '/api/booking/cancel',
      headers: ipHeaders(),
      searchParams: { token: 'not-a-token' },
    });
    const badEmail = await call(GET, {
      path: '/api/booking/cancel',
      headers: ipHeaders(),
      searchParams: { ref: b.reference, email: 'someone@else.no' },
    });
    const badRef = await call(GET, {
      path: '/api/booking/cancel',
      headers: ipHeaders(),
      searchParams: { ref: 'GK-0000-000-NOPE', email: 'test@example.com' },
    });

    expect(badToken.status).toBe(404);
    expect(badEmail.status).toBe(404);
    expect(badRef.status).toBe(404);
    // The two failures must be indistinguishable — otherwise the endpoint
    // confirms which references exist.
    expect(badEmail.json.error).toBe(badRef.json.error);
  });

  it('answers 400 when neither identification scheme is supplied', async () => {
    const { GET, POST } = await routes();

    const get = await call(GET, { path: '/api/booking/cancel', headers: ipHeaders() });
    const post = await call(POST, {
      method: 'POST',
      path: '/api/booking/cancel',
      headers: ipHeaders(),
      body: { reference: 'GK-0000-000-NOPE' },
    });

    expect(get.status).toBe(400);
    expect(post.status).toBe(400);
  });

  it('treats a token that expires exactly now as still valid, and one older as gone', async () => {
    const clock = mockClock('2026-09-06T12:00:00+02:00');
    try {
      const { GET } = await routes();
      const b = await cancellable();

      await db.booking.update({
        where: { id: b.id },
        data: { cancelTokenExpiry: new Date() },
      });
      const atExpiry = await call(GET, {
        path: '/api/booking/cancel',
        headers: ipHeaders(),
        searchParams: { token: b.cancelToken! },
      });

      await db.booking.update({
        where: { id: b.id },
        data: { cancelTokenExpiry: new Date(Date.now() - 1) },
      });
      const pastExpiry = await call(GET, {
        path: '/api/booking/cancel',
        headers: ipHeaders(),
        searchParams: { token: b.cancelToken! },
      });

      expect(atExpiry.status).toBe(200);
      expect(pastExpiry.status).toBe(410);
    } finally {
      clock.restore();
    }
  });

  it('accepts a token with no expiry at all (the guard is skipped, not failed)', async () => {
    const { GET } = await routes();
    const b = await cancellable();
    await db.booking.update({ where: { id: b.id }, data: { cancelTokenExpiry: null } });

    const res = await call(GET, {
      path: '/api/booking/cancel',
      headers: ipHeaders(),
      searchParams: { token: b.cancelToken! },
    });

    // Documented, not endorsed: `cancelTokenExpiry && …` means a null expiry
    // never expires. Minting always sets 30 days (src/lib/email.ts:517) and the
    // cleanup sweep nulls the token together with the expiry, so no live row
    // reaches this shape today.
    expect(res.status).toBe(200);
  });

  it.each(['cancelled', 'completed'] as const)('answers 410 for a %s booking', async (status) => {
    const { GET, POST } = await routes();
    const b = await cancellable();
    await db.booking.update({ where: { id: b.id }, data: { status } });

    const get = await call(GET, {
      path: '/api/booking/cancel',
      headers: ipHeaders(),
      searchParams: { token: b.cancelToken! },
    });
    const post = await call(POST, {
      method: 'POST',
      path: '/api/booking/cancel',
      headers: ipHeaders(),
      body: { token: b.cancelToken },
    });

    expect(get.status).toBe(410);
    expect(post.status).toBe(410);
    expect(stripeMock.by('refunds.create')).toHaveLength(0);
  });
});

// ── Cancelling ───────────────────────────────────────────────────────────────

describe('POST /api/booking/cancel', () => {
  it('cancels, refunds, releases the locks and mails the customer once', async () => {
    const { POST } = await routes();
    const b = await cancellable();

    const res = await call(POST, {
      method: 'POST',
      path: '/api/booking/cancel',
      headers: ipHeaders(),
      body: { token: b.cancelToken },
    });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      success: true,
      cancellationFee: 0,
      refundAmount: 2490,
      reference: b.reference,
    });
    const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.status).toBe('cancelled');
    expect(await db.bookingDateLock.count({ where: { bookingId: b.id } })).toBe(0);
    expect(stripeMock.by('refunds.create')).toHaveLength(1);
    expect(emailMock.by('sendBookingStatusEmail')).toHaveLength(1);
    expect(emailMock.by('sendBookingStatusEmail')[0].args[1]).toBe('cancelled');
    // The service's silent-expiry mail must be suppressed on this path.
    expect(emailMock.by('sendBookingExpiredEmail')).toHaveLength(0);
  });

  it('charges exactly what the preview promised', async () => {
    const clock = mockClock('2026-09-06T01:00:00+02:00'); // 47 h out → 50 %
    try {
      const { GET, POST } = await routes();
      const b = await cancellable({ startDateStr: '2026-09-08' });

      const preview = await call(GET, {
        path: '/api/booking/cancel',
        headers: ipHeaders(),
        searchParams: { token: b.cancelToken! },
      });
      const done = await call(POST, {
        method: 'POST',
        path: '/api/booking/cancel',
        headers: ipHeaders(),
        body: { token: b.cancelToken },
      });

      expect(preview.json.cancellationFeePreview).toBe(1245);
      expect(preview.json.feePercent).toBe(50);
      expect(done.json.cancellationFee).toBe(1245);
      expect(done.json.refundAmount).toBe(1245);
    } finally {
      clock.restore();
    }
  });

  it('cancels a pending booking with no fee and no refund call', async () => {
    const { POST } = await routes();
    const b = await booking('pending', { startDateStr: '2027-02-01' });
    await db.booking.update({ where: { id: b.id }, data: { cancelToken: `tok-${b.id}` } });

    const res = await call(POST, {
      method: 'POST',
      path: '/api/booking/cancel',
      headers: ipHeaders(),
      body: { token: `tok-${b.id}` },
    });

    expect(res.json.cancellationFee).toBe(0);
    expect(res.json.refundAmount).toBe(0);
    expect(stripeMock.by('refunds.create')).toHaveLength(0);
    expect(emailMock.by('sendBookingStatusEmail')).toHaveLength(1);
  });

  it('a second cancel is refused rather than refunded twice', async () => {
    const { POST } = await routes();
    const b = await cancellable();

    const first = await call(POST, {
      method: 'POST',
      path: '/api/booking/cancel',
      headers: ipHeaders(),
      body: { token: b.cancelToken },
    });
    const second = await call(POST, {
      method: 'POST',
      path: '/api/booking/cancel',
      headers: ipHeaders(),
      body: { token: b.cancelToken },
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(410);
    expect(stripeMock.by('refunds.create')).toHaveLength(1);
    expect(emailMock.by('sendBookingStatusEmail')).toHaveLength(1);
  });

  it('two simultaneous cancels refund once and mail once', async () => {
    const { POST } = await routes();
    const b = await cancellable();
    const body = { token: b.cancelToken };

    await Promise.all([
      call(POST, { method: 'POST', path: '/api/booking/cancel', headers: ipHeaders(), body }),
      call(POST, { method: 'POST', path: '/api/booking/cancel', headers: ipHeaders(), body }),
    ]);
    await settle();

    expect(emailMock.by('sendBookingStatusEmail')).toHaveLength(1);
    expect(stripeMock.by('refunds.create')).toHaveLength(1);
  });

  it('never mints a goodwill discount code — that belongs to the admin route', async () => {
    const { POST } = await routes();
    const b = await cancellable();

    await call(POST, {
      method: 'POST',
      path: '/api/booking/cancel',
      headers: ipHeaders(),
      body: { token: b.cancelToken },
    });
    await settle();

    expect(await db.repeatDiscountCode.count()).toBe(0);
    expect(emailMock.by('sendRepeatDiscountEmail')).toHaveLength(0);
  });

  it('records the customer, not an operator, as the actor', async () => {
    const { POST } = await routes();
    const b = await cancellable();

    await call(POST, {
      method: 'POST',
      path: '/api/booking/cancel',
      headers: ipHeaders(),
      body: { token: b.cancelToken },
    });
    await waitFor(
      async () => (await db.adminAuditLog.count({ where: { action: 'booking.cancelled' } })) === 1,
      { what: 'audit row' },
    );

    const row = await db.adminAuditLog.findFirstOrThrow({ where: { action: 'booking.cancelled' } });
    expect(row.actor).toBe('customer');
  });
});

// ── Throttling ───────────────────────────────────────────────────────────────

describe('rate limiting', () => {
  // FIXED Q-12: one 10-per-15-minute limiter used to sit in front of both
  // verbs, so every load of the emailed cancellation link — and every mistyped
  // reference on the ref+e-mail form — spent one of the ten attempts the
  // customer needs for the cancel BUTTON, while the free-cancellation deadline
  // kept running. The read-only preview now has its own, far more generous
  // budget; the destructive POST keeps the tight one.
  it('does not let read-only previews eat into the cancel budget', async () => {
    const { GET, POST } = await routes();
    const ip = freshIp();
    const b = await cancellable();

    for (let i = 0; i < 20; i += 1) {
      const res = await call(GET, {
        path: '/api/booking/cancel',
        headers: { 'x-forwarded-for': ip },
        searchParams: { token: b.cancelToken! },
      });
      expect(res.status, `preview #${i + 1}`).toBe(200);
    }

    // …and the cancel itself still works from the same address.
    const stillAllowed = await call(POST, {
      method: 'POST',
      path: '/api/booking/cancel',
      headers: { 'x-forwarded-for': ip },
      body: { token: b.cancelToken },
    });
    expect(stillAllowed.status).toBe(200);
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('cancelled');
  });

  it('still throttles the destructive verb at 10 per 15 minutes', async () => {
    const { POST } = await routes();
    const ip = freshIp();

    // Ten refusals (an unknown token is a 404) spend the whole budget…
    for (let i = 0; i < 10; i += 1) {
      const res = await call(POST, {
        method: 'POST',
        path: '/api/booking/cancel',
        headers: { 'x-forwarded-for': ip },
        body: { token: `finnes-ikke-${i}` },
      });
      expect(res.status, `attempt #${i + 1}`).toBe(404);
    }

    const b = await cancellable();
    const blocked = await call(POST, {
      method: 'POST',
      path: '/api/booking/cancel',
      headers: { 'x-forwarded-for': ip },
      body: { token: b.cancelToken },
    });
    expect(blocked.status).toBe(429);
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('confirmed');
  });

  it('budgets per client address, so one hammering IP cannot lock out another', async () => {
    const { GET } = await routes();
    const noisy = freshIp();
    const quiet = freshIp();
    const b = await cancellable();

    for (let i = 0; i < 61; i += 1) {
      await call(GET, {
        path: '/api/booking/cancel',
        headers: { 'x-forwarded-for': noisy },
        searchParams: { token: b.cancelToken! },
      });
    }

    const other = await call(GET, {
      path: '/api/booking/cancel',
      headers: { 'x-forwarded-for': quiet },
      searchParams: { token: b.cancelToken! },
    });

    expect(other.status).toBe(200);
  });
});
