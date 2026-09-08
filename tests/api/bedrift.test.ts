import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { db, ensureSchema, invalidateCaches, machine, resetDb, seedConfigDefaults } from '../helpers/db';
import { emailMock } from '../helpers/mocks';
import { call } from '../helpers/route';
import { waitFor } from '../helpers/payments';

// L2 — POST /api/bedrift. The B2B lead form: gated off by default (b2bEnabled
// is 'false' in APP_CONFIG_DEFAULTS — insurance requires the product NEVER
// accept a business booking unless someone has deliberately turned it on),
// honeypot, validation delegated to createQuoteRequest (unit-tested in
// tests/service/quote-request.test.ts), a 5/15-min limiter, and two
// fire-and-forget notification emails.

vi.mock('@/lib/email', async () => (await import('../helpers/mocks')).mockEmail());

let POST: typeof import('@/app/api/bedrift/route').POST;

let ipSeq = 0;
function ip(): Record<string, string> {
  return { 'x-forwarded-for': `10.2.0.${++ipSeq}` };
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    company: 'Testfirma AS',
    orgNumber: '999888777',
    contactName: 'Kari Nordmann',
    email: 'kari@testfirma.no',
    phone: '+4740000001',
    trainingConfirmed: true,
    ...overrides,
  };
}

async function post(body: unknown, headers: Record<string, string> = ip()) {
  return call(POST, { method: 'POST', path: '/api/bedrift', body, headers });
}

async function enableB2b(): Promise<void> {
  await db.appConfig.update({ where: { key: 'b2bEnabled' }, data: { value: 'true' } });
  invalidateCaches();
}

beforeAll(async () => {
  await ensureSchema();
  ({ POST } = await import('@/app/api/bedrift/route'));
});

beforeEach(async () => {
  await resetDb();
  await seedConfigDefaults();
  emailMock.reset();
});

describe('the b2bEnabled gate (P0 — insurance requires this off by default)', () => {
  it('APP_CONFIG_DEFAULTS ships b2bEnabled = false', async () => {
    const row = await db.appConfig.findUniqueOrThrow({ where: { key: 'b2bEnabled' } });
    expect(row.value).toBe('false');
  });

  it('404s on a fresh, unmodified config — a business quote cannot be filed by default', async () => {
    const res = await post(validBody());
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: 'Bedriftsutleie er ikke aktivert' });
    expect(await db.quoteRequest.count()).toBe(0);
  });

  it('404s on any value other than the exact string "true"', async () => {
    for (const value of ['1', 'yes', 'TRUE', ' true', '']) {
      await db.appConfig.update({ where: { key: 'b2bEnabled' }, data: { value } });
      invalidateCaches();
      const res = await post(validBody({ email: `x-${value}@testfirma.no` }));
      expect(res.status, `value ${JSON.stringify(value)}`).toBe(404);
    }
  });

  it('opens up once b2bEnabled is exactly "true"', async () => {
    await enableB2b();
    const res = await post(validBody());
    expect(res.status).toBe(201);
  });

  it('the 404 gate runs before the rate limiter and before parsing the body', async () => {
    // A malformed body would otherwise 400; disabled, it is 404 regardless.
    const res = await call(POST, {
      method: 'POST',
      path: '/api/bedrift',
      body: 'not json',
      headers: { ...ip(), 'content-type': 'application/json' },
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/bedrift — success', () => {
  beforeEach(enableB2b);

  it('201s with a reference and persists the quote as status ny', async () => {
    const res = await post(validBody());
    expect(res.status).toBe(201);
    expect(res.json.success).toBe(true);
    expect(res.json.reference).toMatch(/^BQ-/);

    const row = await db.quoteRequest.findUniqueOrThrow({ where: { reference: res.json.reference } });
    expect(row.status).toBe('ny');
    expect(row.company).toBe('Testfirma AS');
  });

  it('accepts an optional machine, start date and rental type', async () => {
    const m = await machine();
    const res = await post(validBody({
      machineId: m.id,
      startDate: '2027-05-03',
      rentalType: 'weekend',
    }));
    expect(res.status).toBe(201);
    const row = await db.quoteRequest.findUniqueOrThrow({ where: { reference: res.json.reference } });
    expect(row.machineId).toBe(m.id);
    expect(row.rentalType).toBe('weekend');
  });

  it('parses customDays from a string', async () => {
    const res = await post(validBody({ rentalType: 'custom', customDays: '9' }));
    const row = await db.quoteRequest.findUniqueOrThrow({ where: { reference: res.json.reference } });
    expect(row.customDays).toBe(9);
  });

  it('sends the admin notification and the customer receipt (fire-and-forget)', async () => {
    const res = await post(validBody());
    expect(res.status).toBe(201);

    await waitFor(() => emailMock.sent.length >= 2, { what: 'both quote emails' });
    expect(emailMock.by('sendNewQuoteRequestAdminNotification')).toHaveLength(1);
    expect(emailMock.by('sendQuoteRequestReceivedEmail')).toHaveLength(1);
  });
});

describe('POST /api/bedrift — honeypot', () => {
  beforeEach(enableB2b);

  it('400s when the hidden "website" field is filled in, and writes nothing', async () => {
    const res = await post(validBody({ website: 'http://spam.example' }));
    expect(res.status).toBe(400);
    expect(await db.quoteRequest.count()).toBe(0);
  });
});

describe('POST /api/bedrift — validation 400s', () => {
  beforeEach(enableB2b);

  it('400s and names the problem for each missing/invalid field', async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ company: '' }, /Firmanavn/],
      [{ orgNumber: '123' }, /Organisasjonsnummer/],
      [{ contactName: '' }, /Kontaktperson/],
      [{ email: 'not-an-email' }, /e-postadresse/],
      [{ phone: '' }, /Telefon/],
      [{ trainingConfirmed: false }, /M2/],
    ];
    for (const [patch, msg] of cases) {
      const res = await post(validBody(patch));
      expect(res.status, JSON.stringify(patch)).toBe(400);
      expect(res.json.error).toMatch(msg);
    }
    expect(await db.quoteRequest.count()).toBe(0);
  });

  it('400s on malformed JSON', async () => {
    const res = await call(POST, {
      method: 'POST',
      path: '/api/bedrift',
      body: '{ not json',
      headers: { ...ip(), 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });

  it('400s on an unknown or inactive machine', async () => {
    const inactive = await machine({ isActive: false });
    expect((await post(validBody({ machineId: 'nope' }))).status).toBe(400);
    expect((await post(validBody({ machineId: inactive.id, email: 'y@testfirma.no' }))).status).toBe(400);
    expect(await db.quoteRequest.count()).toBe(0);
  });
});

describe('POST /api/bedrift — rate limit', () => {
  beforeEach(enableB2b);

  it('allows 5 requests then 429s the 6th, from the same identity', async () => {
    const headers = ip();
    for (let i = 0; i < 5; i++) {
      const res = await post(validBody({ email: `n${i}@testfirma.no` }), headers);
      expect(res.status, `request ${i + 1}`).toBe(201);
    }
    const sixth = await post(validBody({ email: 'sixth@testfirma.no' }), headers);
    expect(sixth.status).toBe(429);
    expect(await db.quoteRequest.count()).toBe(5);
  });

  it('a different identity is not affected by another caller’s budget', async () => {
    const headers = ip();
    for (let i = 0; i < 5; i++) await post(validBody({ email: `m${i}@testfirma.no` }), headers);
    expect((await post(validBody({ email: 'other@testfirma.no' }))).status).toBe(201);
  });
});
