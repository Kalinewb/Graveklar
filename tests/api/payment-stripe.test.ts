/**
 * Phase 1c — area F at the HTTP boundary: the five Stripe routes.
 *
 *   POST /api/payment/stripe/create    session minting + reuse + 410 contract
 *   GET  /api/payment/stripe/callback  browser return, always a redirect
 *   GET  /api/payment/stripe/cancel    the redirect-only cancel_url (flag F-3)
 *   GET  /api/payment/stripe/status    the public capability probe
 *   POST /api/payment/stripe/webhook   signature gate + idempotency claim
 *
 * Flag F-5 (a spoofed X-Forwarded-Host reaching a Stripe redirect URL through
 * POST /api/tilbud/[token]) is asserted at the end of this file, because the
 * thing under test is the Stripe URL the offer route builds.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { booking, db, ensureSchema, machine, resetDb, seedConfigDefaults } from '../helpers/db';
import { emailMock, stripeMock } from '../helpers/mocks';
import {
  STRIPE_CONFIG,
  buildStripeEvent,
  checkoutSession,
  freshIp,
  postStripeEnvelope,
  settle,
  waitFor,
} from '../helpers/payments';
import { call, type RouteHandler } from '../helpers/route';

vi.mock('@/lib/email', async () => (await import('../helpers/mocks')).mockEmail());
vi.mock('stripe', async () => (await import('../helpers/mocks')).mockStripe());

/**
 * A fresh rate-limit identity per call, in both header shapes, so these tests
 * hold whether a limited route keys on `x-real-ip` or on the last
 * `X-Forwarded-For` hop (`clientIdentity`). The shared `ipHeaders()` helper
 * sets only the former, which collapses every caller into one bucket under
 * the latter.
 */
function idHeaders(ip = freshIp()): Record<string, string> {
  return { 'x-real-ip': ip, 'x-forwarded-for': ip };
}

async function createRoute() {
  return (await import('@/app/api/payment/stripe/create/route')).POST;
}
async function callbackRoute() {
  return (await import('@/app/api/payment/stripe/callback/route')).GET;
}
async function cancelRoute() {
  return (await import('@/app/api/payment/stripe/cancel/route')).GET;
}

/**
 * The offer route takes a typed `{ token }` param, which `call()`'s generic
 * RouteHandler signature cannot express — hence the cast.
 */
async function tilbudRoute(): Promise<RouteHandler> {
  const { POST } = await import('@/app/api/tilbud/[token]/route');
  return POST as unknown as RouteHandler;
}

/** The params object the fake client recorded for `sessions.create`. */
function lastSessionParams(): Record<string, any> {
  const calls = stripeMock.by('checkout.sessions.create');
  return calls[calls.length - 1].args[0] as Record<string, any>;
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

// ── POST /api/payment/stripe/create ──────────────────────────────────────────

describe('POST /api/payment/stripe/create', () => {
  it('mints a session for a pending booking and stamps it on the row', async () => {
    const b = await booking('pending');
    stripeMock.responses.checkoutSession = {
      id: 'cs_live_1',
      object: 'checkout.session',
      status: 'open',
      url: 'https://checkout.stripe.test/c/cs_live_1',
    };

    const res = await call(await createRoute(), {
      method: 'POST',
      path: '/api/payment/stripe/create',
      headers: idHeaders(),
      body: { bookingId: b.id },
    });

    expect(res.status).toBe(200);
    expect(res.json.url).toBe('https://checkout.stripe.test/c/cs_live_1');
    const params = lastSessionParams();
    expect(params.metadata.bookingId).toBe(b.id);
    // The same bag must also land on the PaymentIntent: Checkout does not
    // copy session metadata across, and the `payment_intent.payment_failed`
    // handler resolves the booking from PI metadata alone. Without this the
    // handler silently no-ops on every real card decline.
    expect(params.payment_intent_data.metadata.bookingId).toBe(b.id);
    expect(params.line_items[0].price_data.unit_amount).toBe(b.totalPrice * 100);
    expect(params.success_url).toContain('http://localhost:3001/api/payment/stripe/callback');
    expect(params.cancel_url).toContain('http://localhost:3001/api/payment/stripe/cancel');

    const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.stripeSessionId).toBe('cs_live_1');
    expect(after.paymentDeadline!.getTime()).toBeGreaterThan(Date.now());
  });

  it('reuses a live session instead of opening a second one', async () => {
    const b = await booking('pending');
    const first = await call(await createRoute(), {
      method: 'POST',
      path: '/api/payment/stripe/create',
      headers: idHeaders(),
      body: { bookingId: b.id },
    });
    const second = await call(await createRoute(), {
      method: 'POST',
      path: '/api/payment/stripe/create',
      headers: idHeaders(),
      body: { bookingId: b.id },
    });

    expect(first.json.reused).toBeUndefined();
    expect(second.json.reused).toBe(true);
    expect(second.json.url).toBe(first.json.url);
    expect(stripeMock.by('checkout.sessions.create')).toHaveLength(1);
  });

  it('answers 400 without a bookingId and 410 for anything not pending', async () => {
    const confirmed = await booking('confirmed');
    const POST = await createRoute();

    const noId = await call(POST, {
      method: 'POST',
      path: '/api/payment/stripe/create',
      headers: idHeaders(),
      body: {},
    });
    const unknown = await call(POST, {
      method: 'POST',
      path: '/api/payment/stripe/create',
      headers: idHeaders(),
      body: { bookingId: 'nope' },
    });
    const notPending = await call(POST, {
      method: 'POST',
      path: '/api/payment/stripe/create',
      headers: idHeaders(),
      body: { bookingId: confirmed.id },
    });

    expect(noId.status).toBe(400);
    expect(unknown.status).toBe(410);
    expect(notPending.status).toBe(410);
    expect(stripeMock.by('checkout.sessions.create')).toHaveLength(0);
  });

  it('answers 503 when Stripe is switched off', async () => {
    await db.appConfig.update({ where: { key: 'stripeEnabled' }, data: { value: 'false' } });
    const b = await booking('pending');

    const res = await call(await createRoute(), {
      method: 'POST',
      path: '/api/payment/stripe/create',
      headers: idHeaders(),
      body: { bookingId: b.id },
    });

    expect(res.status).toBe(503);
    expect(stripeMock.by('checkout.sessions.create')).toHaveLength(0);
  });

  it('builds the return URLs from the request origin, never from X-Forwarded-Host', async () => {
    await db.appConfig.update({ where: { key: 'siteUrl' }, data: { value: '' } });
    const b = await booking('pending');

    await call(await createRoute(), {
      method: 'POST',
      path: '/api/payment/stripe/create',
      headers: {
        ...idHeaders(),
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https',
        origin: 'https://evil.example',
      },
      body: { bookingId: b.id },
    });

    const params = lastSessionParams();
    expect(params.success_url).not.toContain('evil.example');
    expect(params.cancel_url).not.toContain('evil.example');
    expect(params.success_url).toContain('http://localhost:3001');
  });

  it('throttles at 30 attempts per IP per quarter hour', async () => {
    const ip = freshIp();
    const POST = await createRoute();
    const statuses: number[] = [];
    for (let i = 0; i < 31; i += 1) {
      const res = await call(POST, {
        method: 'POST',
        path: '/api/payment/stripe/create',
        headers: idHeaders(ip),
        body: { bookingId: 'no-such-booking' },
      });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 30).every((s) => s === 410)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});

// ── GET /api/payment/stripe/callback ─────────────────────────────────────────

describe('GET /api/payment/stripe/callback', () => {
  it('confirms the booking and redirects with the reference on success', async () => {
    const b = await booking('pending');
    stripeMock.responses.checkoutSession = checkoutSession(b.id);

    const res = await call(await callbackRoute(), {
      path: '/api/payment/stripe/callback',
      searchParams: { session_id: 'cs_test_audit1c', bid: b.id },
    });

    expect(res.status).toBe(307);
    const location = res.headers.get('location')!;
    expect(location).toContain('stripe=success');
    expect(location).toContain(encodeURIComponent(b.reference));
    await waitFor(async () => (await db.acceptedContract.count()) === 1, { what: 'contract' });
    const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.status).toBe('confirmed');
    expect(after.stripePaymentIntentId).toBe('pi_test_audit1c');
  });

  it('refuses a session whose metadata names a different booking', async () => {
    const mine = await booking('pending');
    const other = await booking('pending', { startDateStr: '2027-03-01' });
    stripeMock.responses.checkoutSession = checkoutSession(other.id);

    const res = await call(await callbackRoute(), {
      path: '/api/payment/stripe/callback',
      searchParams: { session_id: 'cs_test_audit1c', bid: mine.id },
    });

    expect(res.headers.get('location')).toContain('stripe=error');
    expect((await db.booking.findUniqueOrThrow({ where: { id: mine.id } })).status).toBe('pending');
    expect((await db.booking.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('pending');
    expect(emailMock.sent).toHaveLength(0);
  });

  it('does not confirm a session that has not been paid', async () => {
    const b = await booking('pending');
    stripeMock.responses.checkoutSession = checkoutSession(b.id, { payment_status: 'unpaid' });

    const res = await call(await callbackRoute(), {
      path: '/api/payment/stripe/callback',
      searchParams: { session_id: 'cs_test_audit1c', bid: b.id },
    });

    expect(res.headers.get('location')).toContain('stripe=cancelled');
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('pending');
  });

  it('redirects rather than erroring when the query string is incomplete', async () => {
    const GET = await callbackRoute();
    const noSession = await call(GET, {
      path: '/api/payment/stripe/callback',
      searchParams: { bid: 'x' },
    });
    const noBooking = await call(GET, {
      path: '/api/payment/stripe/callback',
      searchParams: { session_id: 'cs_1' },
    });

    expect(noSession.status).toBe(307);
    expect(noSession.headers.get('location')).toContain('stripe=error');
    expect(noBooking.headers.get('location')).toContain('stripe=error');
  });

  it('redirects with an error instead of throwing when Stripe is unreachable', async () => {
    await db.appConfig.update({ where: { key: 'stripeSecretKey' }, data: { value: '' } });
    const b = await booking('pending');

    const res = await call(await callbackRoute(), {
      path: '/api/payment/stripe/callback',
      searchParams: { session_id: 'cs_1', bid: b.id },
    });

    expect(res.headers.get('location')).toContain('stripe=error');
  });
});

// ── GET /api/payment/stripe/cancel — flag F-3 ────────────────────────────────

describe('GET /api/payment/stripe/cancel', () => {
  it('sends the customer home with the reference the retry UI needs', async () => {
    const b = await booking('pending');

    const res = await call(await cancelRoute(), {
      path: '/api/payment/stripe/cancel',
      headers: idHeaders(),
      searchParams: { bid: b.id },
    });

    expect(res.status).toBe(307);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('stripe=cancelled');
    expect(location).toContain(`ref=${encodeURIComponent(b.reference)}`);
  });

  it('redirects to the error state when the booking id resolves to nothing', async () => {
    const GET = await cancelRoute();

    const missing = await call(GET, {
      path: '/api/payment/stripe/cancel',
      headers: idHeaders(),
    });
    const unknown = await call(GET, {
      path: '/api/payment/stripe/cancel',
      headers: idHeaders(),
      searchParams: { bid: 'no-such-booking' },
    });

    expect(missing.headers.get('location')).toContain('stripe=error');
    expect(unknown.headers.get('location')).toContain('stripe=error');
    expect(stripeMock.by('checkout.sessions.create')).toHaveLength(0);
    expect(emailMock.sent).toHaveLength(0);
  });

  it('leaves a confirmed booking completely alone', async () => {
    const b = await booking('confirmed', { fullyPaidAt: new Date() });

    await call(await cancelRoute(), {
      path: '/api/payment/stripe/cancel',
      headers: idHeaders(),
      searchParams: { bid: b.id },
    });
    await settle();

    expect(stripeMock.by('checkout.sessions.create')).toHaveLength(0);
    expect(emailMock.sent).toHaveLength(0);
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).paymentRetries).toBe(0);
  });

  // FINDING F-3 (fixed): this is a GET, and a GET must be safe. It used to open
  // a *new Stripe Checkout session*, increment paymentRetries, re-stamp
  // paymentDeadline and send two e-mails — so a browser prefetch, a link
  // scanner or an antivirus proxy following the cancel_url burned the
  // customer's only second chance and the next expiry cancelled the booking.
  // The route is now redirect-only; the retry is something the customer asks
  // for by clicking "Prøv igjen" (POST /api/payment/stripe/create), and the
  // retry e-mail still arrives from the webhook's checkout.session.expired
  // branch.
  it('never initiates a financial side effect from a GET', async () => {
    const b = await booking('pending');

    await call(await cancelRoute(), {
      path: '/api/payment/stripe/cancel',
      headers: idHeaders(),
      searchParams: { bid: b.id },
    });
    await settle();

    expect(stripeMock.by('checkout.sessions.create')).toHaveLength(0);
    expect(emailMock.sent).toHaveLength(0);
    const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.paymentRetries).toBe(0);
    expect(after.stripeSessionId).toBeNull();
  });

  // FINDING F-3 (second half): the route had no rate limiter while every other
  // money-touching route did — create is 30/15 min, vipps/create 5/15 min,
  // booking/cancel 10/15 min. A limiter is moot now that the handler is a
  // lookup and a redirect: what needed bounding was the session minting and the
  // mail sending, and neither exists any more. What replaces the throttling
  // assertion is the property that made it necessary — repeated hits must be
  // indistinguishable from one hit.
  it('changes nothing at all, however many times it is hit', async () => {
    const b = await booking('pending');
    const before = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    const GET = await cancelRoute();
    const headers = idHeaders();

    for (let i = 0; i < 5; i += 1) {
      const res = await call(GET, {
        path: '/api/payment/stripe/cancel',
        headers,
        searchParams: { bid: b.id },
      });
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toContain('stripe=cancelled');
    }
    await settle();

    expect(stripeMock.by('checkout.sessions.create')).toHaveLength(0);
    expect(emailMock.sent).toHaveLength(0);
    const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(after.paymentRetries).toBe(0);
    expect(after.status).toBe('pending');
    expect(after.paymentDeadline?.getTime() ?? null).toBe(before.paymentDeadline?.getTime() ?? null);
    expect(after.stripeSessionId).toBe(before.stripeSessionId);
  });
});

// ── GET /api/payment/stripe/status ───────────────────────────────────────────

describe('GET /api/payment/stripe/status', () => {
  it('reports the configured state and leaks nothing else', async () => {
    const { GET } = await import('@/app/api/payment/stripe/status/route');

    const on = await call(GET, { path: '/api/payment/stripe/status' });
    expect(on.json).toEqual({ enabled: true });

    await db.appConfig.update({ where: { key: 'stripeSecretKey' }, data: { value: '   ' } });
    const off = await call(GET, { path: '/api/payment/stripe/status' });
    expect(off.json).toEqual({ enabled: false });
  });
});

// ── POST /api/payment/stripe/webhook ─────────────────────────────────────────

describe('POST /api/payment/stripe/webhook', () => {
  it('rejects a payload signed with the wrong secret', async () => {
    const b = await booking('pending');
    const envelope = buildStripeEvent('checkout.session.completed', checkoutSession(b.id));

    const res = await postStripeEnvelope(envelope, { secret: 'whsec_attacker' });

    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'Invalid signature' });
    expect(await db.webhookEvent.count()).toBe(0);
  });

  it('rejects everything when no webhook secret is configured', async () => {
    await db.appConfig.update({ where: { key: 'stripeWebhookSecret' }, data: { value: '' } });
    const b = await booking('pending');

    const res = await postStripeEnvelope(
      buildStripeEvent('checkout.session.completed', checkoutSession(b.id)),
    );

    expect(res.status).toBe(400);
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('pending');
  });

  it('claims each event id exactly once', async () => {
    const b = await booking('pending');
    const envelope = buildStripeEvent('checkout.session.completed', checkoutSession(b.id));

    const first = await postStripeEnvelope(envelope);
    const second = await postStripeEnvelope(envelope);

    expect(first.json).toEqual({ ok: true });
    expect(second.json).toEqual({ ok: true, duplicate: true });
    expect(await db.webhookEvent.count()).toBe(1);
    const claim = await db.webhookEvent.findFirstOrThrow();
    expect(claim.provider).toBe('stripe');
    expect(claim.eventId).toBe(envelope.id);
  });
});

// ── Flag F-5: POST /api/tilbud/[token] and the forwarded host ────────────────

describe('POST /api/tilbud/[token] (flag F-5)', () => {
  async function offer() {
    const m = await machine();
    return db.quoteRequest.create({
      data: {
        reference: `TB-${Date.now().toString(36)}`,
        company: 'Testfirma AS',
        orgNumber: '999888777',
        contactName: 'Kari Nordmann',
        email: 'kari@testfirma.no',
        phone: '+4740000001',
        machineId: m.id,
        startDate: new Date('2027-01-04T00:00:00+01:00'),
        rentalType: 'day',
        trainingConfirmed: true,
        status: 'tilbud_sendt',
        offerAmount: 5000,
        paymentMode: 'card',
        acceptToken: `tok_${Date.now().toString(36)}`,
        acceptTokenExpiry: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        offerValidUntil: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    });
  }

  it('uses the configured siteUrl when one is set', async () => {
    const quote = await offer();

    const res = await call(await tilbudRoute(), {
      method: 'POST',
      path: `/api/tilbud/${quote.acceptToken}`,
      params: { token: quote.acceptToken! },
      headers: { ...idHeaders(), 'x-forwarded-host': 'evil.example' },
      body: { action: 'accept' },
    });

    expect(res.status).toBe(200);
    expect(lastSessionParams().success_url).toContain('http://localhost:3001');
  });

  // FIXED F-5: resolveOrigin() in src/app/api/tilbud/[token]/route.ts now
  // resolves the configured siteUrl, else request.nextUrl.origin — the same
  // rule POST /api/payment/stripe/create uses. The forwardable headers
  // (X-Forwarded-Host / Origin) are never consulted.
  it('never lets a spoofed X-Forwarded-Host reach the Stripe redirect URL', async () => {
    await db.appConfig.update({ where: { key: 'siteUrl' }, data: { value: '' } });
    const quote = await offer();

    await call(await tilbudRoute(), {
      method: 'POST',
      path: `/api/tilbud/${quote.acceptToken}`,
      params: { token: quote.acceptToken! },
      headers: {
        ...idHeaders(),
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https',
      },
      body: { action: 'accept' },
    });

    const params = lastSessionParams();
    expect(params.success_url).not.toContain('evil.example');
    expect(params.cancel_url).not.toContain('evil.example');
  });
});
