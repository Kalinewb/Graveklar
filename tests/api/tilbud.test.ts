import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { db, ensureSchema, machine, resetDb, seedConfigDefaults } from '../helpers/db';
import { emailMock, stripeMock } from '../helpers/mocks';
import { STRIPE_CONFIG, freshIp } from '../helpers/payments';
import { call, type RouteHandler } from '../helpers/route';

// L2 — POST /api/tilbud/[token]. The customer-facing accept/decline page for
// a B2B offer. Flag F-5 (Stripe redirect built from a spoofed
// X-Forwarded-Host) is fixed as of commit 3b9cc42 and covered in depth by
// tests/api/payment-stripe.test.ts; this file re-asserts the fixed shape
// briefly and otherwise focuses on the accept/decline state machine that is
// this route's own responsibility.

vi.mock('@/lib/email', async () => (await import('../helpers/mocks')).mockEmail());
vi.mock('stripe', async () => (await import('../helpers/mocks')).mockStripe());

let POST: RouteHandler;

function idHeaders(): Record<string, string> {
  const ip = freshIp();
  return { 'x-forwarded-for': ip };
}

async function offer(overrides: Record<string, unknown> = {}) {
  const m = overrides.machineId ? null : await machine();
  return db.quoteRequest.create({
    data: {
      reference: `BQ-TEST-${Math.random().toString(36).slice(2, 8)}`,
      company: 'Testfirma AS',
      orgNumber: '999888777',
      contactName: 'Kari Nordmann',
      email: 'kari@testfirma.no',
      phone: '+4740000001',
      machineId: m?.id ?? null,
      startDate: new Date('2027-06-07T00:00:00+02:00'),
      rentalType: 'day',
      trainingConfirmed: true,
      status: 'tilbud_sendt',
      offerAmount: 5000,
      paymentMode: 'card',
      acceptToken: `tok_${Math.random().toString(36).slice(2, 10)}`,
      acceptTokenExpiry: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      offerValidUntil: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      ...overrides,
    },
  });
}

async function accept(token: string, body: Record<string, unknown> = { action: 'accept' }) {
  return call(POST, {
    method: 'POST',
    path: `/api/tilbud/${token}`,
    params: { token },
    headers: idHeaders(),
    body,
  });
}

beforeAll(async () => {
  await ensureSchema();
  ({ POST } = (await import('@/app/api/tilbud/[token]/route')) as unknown as { POST: RouteHandler });
});

beforeEach(async () => {
  await resetDb();
  await seedConfigDefaults();
  emailMock.reset();
  stripeMock.reset();
});

describe('unknown / no-op paths', () => {
  it('404s on a token that does not exist', async () => {
    const res = await accept('does-not-exist');
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: 'Tilbudet finnes ikke' });
  });

  it('a body that fails to parse as JSON defaults to "accept"', async () => {
    const q = await offer({ paymentMode: 'invoice' });
    const res = await call(POST, {
      method: 'POST',
      path: `/api/tilbud/${q.acceptToken}`,
      params: { token: q.acceptToken! },
      headers: { ...idHeaders(), 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(200);
    expect(res.json.mode).toBe('invoice');
  });
});

describe('decline', () => {
  it('moves a tilbud_sendt offer to avslatt', async () => {
    const q = await offer();
    const res = await accept(q.acceptToken!, { action: 'decline' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ success: true, status: 'avslatt', changed: true });
    const row = await db.quoteRequest.findUniqueOrThrow({ where: { id: q.id } });
    expect(row.status).toBe('avslatt');
  });

  // FIXED M-2: the decline branch only writes `status: 'avslatt'` when the row
  // is currently `tilbud_sendt`, but it used to return
  // `{ success: true, status: 'avslatt' }` UNCONDITIONALLY — even when the
  // guard skipped the write. A customer (or a replayed/cached request)
  // declining an offer that is 'ny', 'konvertert', 'akseptert', 'utlopt' or
  // 'trukket' was told the offer is now declined while the stored status never
  // changed. The response now reports the row's real status plus `changed`.
  it('the response only claims avslatt when the write actually happened', async () => {
    const q = await offer({ status: 'konvertert' });
    const res = await accept(q.acceptToken!, { action: 'decline' });
    const row = await db.quoteRequest.findUniqueOrThrow({ where: { id: q.id } });
    // Correct behaviour: either the response reflects the row's real status,
    // or declining a non-tilbud_sendt offer is refused outright. Either way
    // the response and the database must never disagree.
    expect(res.json.status).toBe(row.status);
  });

  // Rewritten for FIXED M-2: every non-tilbud_sendt status echoes itself and
  // says nothing was written.
  it('reports changed:false and the stored status for every non-active offer', async () => {
    for (const status of ['ny', 'konvertert', 'akseptert', 'utlopt', 'trukket', 'avslatt']) {
      const q = await offer({ status });
      const res = await accept(q.acceptToken!, { action: 'decline' });
      expect({ status, json: res.json }).toEqual({ status, json: { success: true, status, changed: false } });
      const row = await db.quoteRequest.findUniqueOrThrow({ where: { id: q.id } });
      expect(row.status).toBe(status);
    }
  });
});

describe('accept — not active / expired', () => {
  it('409s when the status is not tilbud_sendt and it has not been converted', async () => {
    for (const status of ['ny', 'akseptert', 'avslatt', 'utlopt', 'trukket']) {
      const q = await offer({ status, email: `${status}@testfirma.no` });
      const res = await accept(q.acceptToken!);
      expect(res.status, status).toBe(409);
    }
  });

  it('at exactly "now" the offer is NOT yet expired (strictly-less-than)', async () => {
    const { mockClock } = await import('../helpers/mocks');
    const clock = mockClock('2027-01-01T12:00:00.000Z');
    try {
      const q = await offer({
        paymentMode: 'invoice',
        acceptTokenExpiry: new Date('2027-01-01T12:00:00.000Z'),
      });
      const res = await accept(q.acceptToken!);
      expect(res.status).toBe(200);
    } finally {
      clock.restore();
    }
  });

  it('one millisecond later, the same expiry 410s and marks utlopt', async () => {
    const { mockClock } = await import('../helpers/mocks');
    const clock = mockClock('2027-01-01T12:00:00.001Z');
    try {
      const q = await offer({
        paymentMode: 'invoice',
        acceptTokenExpiry: new Date('2027-01-01T12:00:00.000Z'),
      });
      const res = await accept(q.acceptToken!);
      expect(res.status).toBe(410);
      expect(res.json).toEqual({ error: 'Tilbudet er utløpt' });
      const row = await db.quoteRequest.findUniqueOrThrow({ where: { id: q.id } });
      expect(row.status).toBe('utlopt');
    } finally {
      clock.restore();
    }
  });

  it('410s on offerValidUntil the same way, independent of acceptTokenExpiry', async () => {
    const { mockClock } = await import('../helpers/mocks');
    const clock = mockClock('2027-01-01T12:00:00.000Z');
    try {
      const q = await offer({
        acceptTokenExpiry: new Date('2028-01-01T00:00:00.000Z'),
        offerValidUntil: new Date('2027-01-01T11:59:59.999Z'),
      });
      const res = await accept(q.acceptToken!);
      expect(res.status).toBe(410);
    } finally {
      clock.restore();
    }
  });
});

describe('accept — invoice mode', () => {
  it('confirms the booking without touching Stripe, and moves the quote to konvertert', async () => {
    const q = await offer({ paymentMode: 'invoice' });
    const res = await accept(q.acceptToken!);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ success: true, mode: 'invoice' });
    expect(res.json.reference).toMatch(/^GK/); // real booking reference, not the quote's BQ one

    const row = await db.quoteRequest.findUniqueOrThrow({ where: { id: q.id } });
    expect(row.status).toBe('konvertert');
    expect(row.convertedBookingId).toBeTruthy();

    const booking = await db.booking.findUniqueOrThrow({ where: { id: row.convertedBookingId! } });
    expect(booking.status).toBe('confirmed');
    expect(booking.customerType).toBe('business');
    expect(stripeMock.calls).toHaveLength(0);
  });

  it('is idempotent: accepting again returns alreadyAccepted without a second booking', async () => {
    const q = await offer({ paymentMode: 'invoice' });
    const first = await accept(q.acceptToken!);
    const second = await accept(q.acceptToken!);
    expect(second.status).toBe(200);
    expect(second.json).toEqual({ success: true, mode: 'invoice', alreadyAccepted: true });
    expect(await db.booking.count({ where: { customerType: 'business' } })).toBe(1);
    expect(first.json.reference).toBeTruthy();
  });
});

describe('accept — card mode', () => {
  beforeEach(async () => {
    for (const [key, value] of Object.entries(STRIPE_CONFIG)) {
      await db.appConfig.upsert({
        where: { key },
        create: { key, value, label: key, group: 'stripe', type: 'text', isPublic: false, sortOrder: 999 },
        update: { value },
      });
    }
    const { invalidateCaches } = await import('../helpers/db');
    invalidateCaches();
  });

  it('creates a booking (still pending) and returns the Stripe Checkout url', async () => {
    const q = await offer({ paymentMode: 'card' });
    const res = await accept(q.acceptToken!);
    expect(res.status).toBe(200);
    expect(res.json.mode).toBe('card');
    expect(res.json.url).toBe('https://checkout.stripe.test/c/cs_test_harness');

    const row = await db.quoteRequest.findUniqueOrThrow({ where: { id: q.id } });
    expect(row.convertedBookingId).toBeTruthy();
    // Card mode never itself moves the quote off 'akseptert' (see FINDING
    // M-1 in tests/service/quote-request.test.ts) — status is whatever
    // convertQuoteToBooking left it at.
    expect(row.status).toBe('akseptert');

    const booking = await db.booking.findUniqueOrThrow({ where: { id: row.convertedBookingId! } });
    expect(booking.status).toBe('pending');
  });

  it('builds the Checkout redirect from siteUrl, never from a forwarded host (FIXED F-5)', async () => {
    const q = await offer({ paymentMode: 'card' });
    const res = await call(POST, {
      method: 'POST',
      path: `/api/tilbud/${q.acceptToken}`,
      params: { token: q.acceptToken! },
      headers: { ...idHeaders(), 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' },
      body: { action: 'accept' },
    });
    expect(res.status).toBe(200);
    const created = stripeMock.by('checkout.sessions.create');
    expect(created).toHaveLength(1);
    const params = created[0].args[0] as { success_url: string; cancel_url: string };
    expect(params.success_url).toContain(STRIPE_CONFIG.siteUrl);
    expect(params.success_url).not.toContain('evil.example');
    expect(params.cancel_url).not.toContain('evil.example');
  });

  it('is idempotent: accepting again re-resolves the Checkout url instead of converting twice', async () => {
    const q = await offer({ paymentMode: 'card' });
    await accept(q.acceptToken!);
    stripeMock.responses.checkoutSession = {
      ...stripeMock.responses.checkoutSession,
      id: 'cs_test_harness', // getLiveCheckoutSessionUrl retrieves the stamped session
    };
    const second = await accept(q.acceptToken!);
    expect(second.status).toBe(200);
    expect(second.json.alreadyAccepted).toBe(true);
    expect(await db.booking.count({ where: { customerType: 'business' } })).toBe(1);
  });

  it('503s when Stripe is disabled', async () => {
    await db.appConfig.update({ where: { key: 'stripeEnabled' }, data: { value: 'false' } });
    const { invalidateCaches } = await import('../helpers/db');
    invalidateCaches();

    const q = await offer({ paymentMode: 'card' });
    const res = await accept(q.acceptToken!);
    expect(res.status).toBe(503);
    expect(res.json.error).toMatch(/Kortbetaling/);
    // The booking WAS created (convertQuoteToBooking ran); only the payment
    // hand-off failed. The quote is left convertedBookingId-idempotent for a
    // retry once Stripe is switched back on.
    const row = await db.quoteRequest.findUniqueOrThrow({ where: { id: q.id } });
    expect(row.convertedBookingId).toBeTruthy();
  });
});

describe('rate limit', () => {
  it('10 requests per identity per 15 minutes, then 429', async () => {
    const headers = idHeaders();
    const q = await offer({ paymentMode: 'invoice' });
    for (let i = 0; i < 10; i++) {
      const res = await call(POST, {
        method: 'POST',
        path: `/api/tilbud/${q.acceptToken}`,
        params: { token: q.acceptToken! },
        headers,
        body: { action: 'decline' },
      });
      expect(res.status, `request ${i + 1}`).not.toBe(429);
    }
    const eleventh = await call(POST, {
      method: 'POST',
      path: `/api/tilbud/${q.acceptToken}`,
      params: { token: q.acceptToken! },
      headers,
      body: { action: 'decline' },
    });
    expect(eleventh.status).toBe(429);
  });
});
