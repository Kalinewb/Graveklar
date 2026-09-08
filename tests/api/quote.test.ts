import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '@/lib/pricing';

import { campaignCode, ensureSchema, machine, resetDb, seedConfigDefaults } from '../helpers/db';
import { call } from '../helpers/route';
import { MON, SAT, futureDow } from '../helpers/pricing';

// L2 — POST /api/quote. The customer-facing pricing endpoint: input
// validation, the rate limiter, and the exact response shape the booking form
// renders verbatim.

const DAY_KR = DEFAULT_CONFIG.weekdayHourly * DEFAULT_CONFIG.dayIncludedHours;

let POST: typeof import('@/app/api/quote/route').POST;

/** Each test gets its own client IP so the 60/min limiter stays local to it. */
let ipSeq = 0;
function ip(): Record<string, string> {
  return { 'x-forwarded-for': `10.0.0.${++ipSeq}` };
}

async function quote(body: unknown, headers: Record<string, string> = ip()) {
  return call(POST, { method: 'POST', path: '/api/quote', body, headers });
}

beforeAll(async () => {
  await ensureSchema();
  ({ POST } = await import('@/app/api/quote/route'));
});

beforeEach(async () => {
  await resetDb();
  await seedConfigDefaults();
});

describe('POST /api/quote — request validation', () => {
  it('400s on a body that is not JSON', async () => {
    const res = await call(POST, {
      method: 'POST',
      path: '/api/quote',
      body: 'not json at all',
      headers: { ...ip(), 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'Invalid JSON' });
  });

  it('400s on an empty body', async () => {
    const res = await call(POST, { method: 'POST', path: '/api/quote', headers: ip() });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'Invalid JSON' });
  });

  it('400s on a missing or unknown rentalType', async () => {
    for (const rentalType of [undefined, null, '', 'monthly', 'DAY', 42, { day: true }]) {
      const res = await quote({ rentalType, startDate: futureDow(MON, 21) });
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: 'Ugyldig rentalType' });
    }
  });

  it('400s on a startDate that is not strictly YYYY-MM-DD', async () => {
    for (const startDate of [undefined, '', '2026-1-5', '05.01.2026', 'tomorrow', 20260105]) {
      const res = await quote({ rentalType: 'day', startDate });
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: 'Ugyldig startDate' });
    }
  });

  it('accepts a syntactically valid but nonsense date and lets the gate refuse it', async () => {
    // The regex is shape-only; 2026-02-30 parses as 2026-03-02 downstream.
    const res = await quote({ rentalType: 'day', startDate: '2026-02-30', selfPickup: true });
    expect(res.status).toBe(200);
    expect(res.json.bookable).toBe(false);
  });
});

describe('POST /api/quote — response', () => {
  it('prices a self-pickup day rental and returns the full quote envelope', async () => {
    const res = await quote({ rentalType: 'day', startDate: futureDow(MON, 21), selfPickup: true });
    expect(res.status).toBe(200);
    expect(res.json.basePrice).toBe(DAY_KR);
    expect(res.json.totalPrice).toBe(DAY_KR);
    expect(res.json.bookable).toBe(true);
    expect(res.json.blockedReason).toBeNull();
  });

  it('the response key set is stable — the booking form renders it verbatim', async () => {
    const res = await quote({ rentalType: 'day', startDate: futureDow(MON, 21), selfPickup: true });
    expect(Object.keys(res.json).sort()).toMatchInlineSnapshot(`
      [
        "basePrice",
        "blockedReason",
        "bookable",
        "cappedByCeiling",
        "deliveryFee",
        "discountKr",
        "discountLabel",
        "discountLines",
        "extraHours",
        "extraHoursCost",
        "generatedAt",
        "includedHours",
        "inputs",
        "mvaBreakdown",
        "subtotal",
        "totalHours",
        "totalPrice",
        "warnings",
      ]
    `);
    expect(Object.keys(res.json.mvaBreakdown).sort()).toEqual([
      'exMva',
      'inclMva',
      'mvaAmt',
      'mvaRate',
    ]);
  });

  it('returns a priced but unbookable quote instead of an error', async () => {
    const res = await quote({ rentalType: 'day', startDate: futureDow(SAT, 21), selfPickup: true });
    expect(res.status).toBe(200);
    expect(res.json.bookable).toBe(false);
    expect(res.json.blockedReason).toBe('Denne datoen er ikke tilgjengelig for dagsleie.');
    expect(res.json.warnings).toContainEqual({
      code: 'not-bookable',
      message: 'Denne datoen er ikke tilgjengelig for dagsleie.',
    });
    expect(res.json.totalPrice).toBe(DAY_KR);
  });

  it('carries an unknown machineId through to the not-available gate', async () => {
    const res = await quote({
      rentalType: 'day',
      startDate: futureDow(MON, 21),
      selfPickup: true,
      machineId: 'nope',
    });
    expect(res.json.blockedReason).toBe('Valgt utstyr er ikke tilgjengelig.');
  });

  it('applies a machine price override', async () => {
    const m = await machine({ dayPrice: 4000 });
    const res = await quote({
      rentalType: 'day',
      startDate: futureDow(MON, 21),
      selfPickup: true,
      machineId: m.id,
    });
    expect(res.json.basePrice).toBe(4000);
  });
});

describe('POST /api/quote — input coercion', () => {
  it('clamps extraHours to the 0…720 window', async () => {
    const base = { rentalType: 'day', startDate: futureDow(MON, 21), selfPickup: true };
    const rate = DEFAULT_CONFIG.preOrderHourRate;

    expect((await quote({ ...base, extraHours: 100_000 })).json.extraHours).toBe(720);
    expect((await quote({ ...base, extraHours: 720 })).json.extraHoursCost).toBe(720 * rate);
    expect((await quote({ ...base, extraHours: -5 })).json.extraHours).toBe(0);
    expect((await quote({ ...base, extraHours: '3' })).json.extraHours).toBe(3);
    expect((await quote({ ...base, extraHours: 2.9 })).json.extraHours).toBe(2);
    expect((await quote({ ...base, extraHours: 'abc' })).json.extraHours).toBe(0);
    expect((await quote({ ...base })).json.extraHours).toBe(0);
  });

  it('treats a blank or whitespace-only code as no code at all', async () => {
    const base = { rentalType: 'day', startDate: futureDow(MON, 21), selfPickup: true, email: 'ny@example.com' };
    const blank = await quote({ ...base, code: '   ' });
    expect(blank.json.inputs.code).toBeNull();
    expect(blank.json.warnings).toEqual([]);
  });

  it('trims a supplied code before validating it', async () => {
    const c = await campaignCode({ code: 'SOMMER-2026', percent: 20 });
    const res = await quote({
      rentalType: 'day',
      startDate: futureDow(MON, 21),
      selfPickup: true,
      code: '  sommer-2026  ',
    });
    expect(res.json.discountLines).toContainEqual(
      expect.objectContaining({ kind: 'campaign', percent: 20, codeId: c.id }),
    );
  });

  it('a non-numeric deliveryFee is dropped rather than turning the totals into null (FIXED A-2)', async () => {
    const res = await quote({
      rentalType: 'day',
      startDate: futureDow(MON, 21),
      selfPickup: false,
      deliveryDistance: 10,
      deliveryFee: 'gratis',
    });
    expect(res.status).toBe(200);
    expect(res.json.deliveryFee).toBe(0);
    expect(res.json.subtotal).toBe(DAY_KR);
    expect(res.json.totalPrice).toBe(DAY_KR);
  });

  it('selfPickup is coerced with Boolean(), so any truthy value zeroes the fee', async () => {
    const res = await quote({
      rentalType: 'day',
      startDate: futureDow(MON, 21),
      selfPickup: 'no',
      deliveryFee: 900,
    });
    expect(res.json.deliveryFee).toBe(0);
  });
});

describe('POST /api/quote — rate limiting', () => {
  it('allows 60 requests per IP per minute and 429s the 61st', async () => {
    const headers = { 'x-forwarded-for': '10.9.9.9' };
    const body = { rentalType: 'nope' }; // 400s without touching the database
    for (let i = 0; i < 60; i++) {
      const res = await call(POST, { method: 'POST', path: '/api/quote', body, headers });
      expect(res.status).toBe(400);
    }
    const limited = await call(POST, { method: 'POST', path: '/api/quote', body, headers });
    expect(limited.status).toBe(429);
    expect(limited.json).toEqual({ error: 'For mange forespørsler. Prøv igjen om litt.' });
  });

  it('the budget is per IP — a different address is unaffected', async () => {
    const res = await call(POST, {
      method: 'POST',
      path: '/api/quote',
      body: { rentalType: 'day', startDate: futureDow(MON, 21), selfPickup: true },
      headers: { 'x-forwarded-for': '10.9.9.10' },
    });
    expect(res.status).toBe(200);
  });

  // Rewritten for FIXED H-5: the budget key is the LAST x-forwarded-for hop
  // (the element a proxy appends, or the socket peer Next fills in), not the
  // first — the first is whatever the client claimed. See src/lib/client-ip.ts.
  it('keys on the LAST x-forwarded-for hop, so rewriting the head changes nothing', async () => {
    const headers = { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' };
    const body = { rentalType: 'nope' };
    for (let i = 0; i < 60; i++) {
      await call(POST, { method: 'POST', path: '/api/quote', body, headers });
    }
    const limited = await call(POST, { method: 'POST', path: '/api/quote', body, headers });
    expect(limited.status).toBe(429);

    // A different claimed first hop lands in the same, exhausted bucket.
    const spoofed = await call(POST, {
      method: 'POST',
      path: '/api/quote',
      body,
      headers: { 'x-forwarded-for': '198.51.100.4, 10.0.0.1' },
    });
    expect(spoofed.status).toBe(429);

    // A different last hop is a genuinely different client.
    const other = await call(POST, {
      method: 'POST',
      path: '/api/quote',
      body,
      headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.2' },
    });
    expect(other.status).toBe(400);
  });

  it('ignores x-real-ip, so rotating it does not defeat the budget', async () => {
    // FIXED H-5. With no x-forwarded-for the identity falls to `unknown` for
    // every one of these, so the 61st is refused however the header varies.
    const body = { rentalType: 'nope' };
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) {
      const res = await call(POST, {
        method: 'POST', path: '/api/quote', body,
        headers: { 'x-real-ip': `192.0.2.${i}` },
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 60).every((s) => s === 400)).toBe(true);
    expect(statuses[60]).toBe(429);
  });
});
