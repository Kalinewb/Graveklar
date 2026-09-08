import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { computeDiscount } from '@/lib/discount-engine';

import {
  booking,
  campaignCode,
  db,
  ensureSchema,
  invalidateCaches,
  repeatCode,
  resetDb,
  seedConfigDefaults,
} from '../helpers/db';
import { call } from '../helpers/route';

// L2 — GET /api/check-discount-eligibility. The preview endpoint whose own
// header comment says "Gate semantics MUST match computeDiscount", so every
// case here is checked against the engine as well as against a fixed shape.
//
// FLAG F-E6: nothing in src/ calls this route any more — the booking form now
// previews through POST /api/quote. It still answers, unauthenticated, whether
// an arbitrary email address has rented before (15 req/min per IP).

let GET: typeof import('@/app/api/check-discount-eligibility/route').GET;

let ipSeq = 0;
function ip(): Record<string, string> {
  return { 'x-forwarded-for': `10.1.0.${++ipSeq}` };
}

interface EligibilityBody {
  firstTimeEligible: boolean;
  firstTimePercent: number;
  code: { valid: boolean; reason?: string; percent?: number; kind?: 'repeat' | 'campaign' };
}

async function check(params: Record<string, string>) {
  return call<EligibilityBody>(GET, {
    path: '/api/check-discount-eligibility',
    searchParams: params,
    headers: ip(),
  });
}

/** Overwrite AppConfig rows seeded by beforeEach. */
async function setApp(values: Record<string, string>): Promise<void> {
  for (const [key, value] of Object.entries(values)) {
    await db.appConfig.update({ where: { key }, data: { value } });
  }
  invalidateCaches();
}

/**
 * The documented must-match: for the same identity + code the preview endpoint
 * and the engine that actually prices the booking have to agree on WHETHER a
 * first-time discount and a code discount apply.
 */
async function gatesAgree(params: { email?: string; phone?: string; code?: string }) {
  const res = await check({
    ...(params.email ? { email: params.email } : {}),
    ...(params.phone ? { phone: params.phone } : {}),
    ...(params.code ? { code: params.code } : {}),
  });
  const engine = await computeDiscount({
    baseTotalKr: 10_000,
    email: params.email ?? '',
    phone: params.phone ?? '',
    code: params.code ?? null,
  });
  return {
    preview: res.json,
    engine,
    firstTime: [res.json.firstTimeEligible, engine.applied.some((a) => a.kind === 'first-time')],
    codeApplies: [
      res.json.code.valid,
      engine.applied.some((a) => a.kind === 'campaign' || a.kind === 'repeat'),
    ],
  };
}

beforeAll(async () => {
  await ensureSchema();
  ({ GET } = await import('@/app/api/check-discount-eligibility/route'));
});

beforeEach(async () => {
  await resetDb();
  await seedConfigDefaults();
});

describe('GET /api/check-discount-eligibility — shape', () => {
  it('answers with no parameters at all', async () => {
    const res = await check({});
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ firstTimeEligible: false, firstTimePercent: 10, code: { valid: false } });
  });

  it('an unseen email qualifies', async () => {
    const res = await check({ email: 'ny@example.com' });
    expect(res.json.firstTimeEligible).toBe(true);
    expect(res.json.firstTimePercent).toBe(10);
  });

  it('an email with a confirmed booking does not', async () => {
    await booking('confirmed', { email: 'kunde@example.com' });
    expect((await check({ email: 'kunde@example.com' })).json.firstTimeEligible).toBe(false);
  });

  it('a phone with a confirmed booking does not, across formatting', async () => {
    await booking('confirmed', { email: 'old@example.com', phone: '99011223' });
    expect((await check({ email: 'helt.ny@example.com', phone: '+47 990 11 223' })).json.firstTimeEligible)
      .toBe(false);
  });

  it('reports firstTimePercent even when the programme is switched off', async () => {
    await setApp({ enableFirstTimeDiscount: 'false' });
    const res = await check({ email: 'ny@example.com' });
    expect(res.json.firstTimeEligible).toBe(false);
    expect(res.json.firstTimePercent).toBe(10);
  });

  it('validates a campaign code and returns its own percent', async () => {
    await campaignCode({ code: 'SOMMER-2026', percent: 20 });
    const res = await check({ email: 'ny@example.com', code: ' sommer-2026 ' });
    expect(res.json.code).toEqual({ valid: true, kind: 'campaign', percent: 20 });
  });

  it('validates a repeat code and returns the configured repeat percent', async () => {
    await booking('completed', { email: 'kunde@example.com' });
    await repeatCode({ code: 'RETUR-ABCDEFGH', email: 'kunde@example.com' });
    const res = await check({ email: 'kunde@example.com', code: 'RETUR-ABCDEFGH' });
    expect(res.json.code).toEqual({ valid: true, kind: 'repeat', percent: 10 });
  });

  it('a valid repeat code reads as `inactive` when the repeat programme is off', async () => {
    await setApp({ enableRepeatDiscount: 'false' });
    await booking('completed', { email: 'kunde@example.com' });
    await repeatCode({ code: 'RETUR-ABCDEFGH', email: 'kunde@example.com' });
    const res = await check({ email: 'kunde@example.com', code: 'RETUR-ABCDEFGH' });
    expect(res.json.code).toEqual({ valid: false, reason: 'inactive' });
  });

  it('a campaign code stays valid when the repeat programme is off', async () => {
    await setApp({ enableRepeatDiscount: 'false' });
    await campaignCode({ code: 'MARKED-2026', percent: 30 });
    const res = await check({ email: 'kunde@example.com', code: 'MARKED-2026' });
    expect(res.json.code).toEqual({ valid: true, kind: 'campaign', percent: 30 });
  });

  it('surfaces each refusal reason verbatim', async () => {
    await campaignCode({ code: 'AV-KODE', isActive: false });
    await campaignCode({ code: 'OPPBRUKT', maxUses: 1, usedCount: 1 });
    await repeatCode({ code: 'RETUR-FEILMAIL', email: 'annen@example.com' });
    await repeatCode({ code: 'RETUR-UTLOPT01', email: 'k@example.com', expiresAt: new Date(Date.now() - 60_000) });

    expect((await check({ code: 'FINNES-IKKE' })).json.code).toEqual({ valid: false, reason: 'invalid' });
    expect((await check({ code: 'AV-KODE' })).json.code).toEqual({ valid: false, reason: 'inactive' });
    expect((await check({ code: 'OPPBRUKT' })).json.code).toEqual({ valid: false, reason: 'exhausted' });
    expect((await check({ code: 'RETUR-FEILMAIL', email: 'k@example.com' })).json.code).toEqual({
      valid: false,
      reason: 'mismatched-email',
    });
    expect((await check({ code: 'RETUR-UTLOPT01', email: 'k@example.com' })).json.code).toEqual({
      valid: false,
      reason: 'expired',
    });
  });
});

describe('preview ↔ engine must-match', () => {
  it('an unseen email with no code', async () => {
    const r = await gatesAgree({ email: 'ny@example.com' });
    expect(r.firstTime[0]).toBe(r.firstTime[1]);
    expect(r.codeApplies[0]).toBe(r.codeApplies[1]);
    expect(r.firstTime).toEqual([true, true]);
  });

  it('a returning email with no code', async () => {
    await booking('confirmed', { email: 'kunde@example.com', phone: '40000001' });
    const r = await gatesAgree({ email: 'kunde@example.com', phone: '40000001' });
    expect(r.firstTime).toEqual([false, false]);
    expect(r.codeApplies).toEqual([false, false]);
  });

  it('an unseen email with a valid campaign code', async () => {
    await campaignCode({ code: 'SOMMER-2026', percent: 20 });
    const r = await gatesAgree({ email: 'ny@example.com', code: 'SOMMER-2026' });
    expect(r.firstTime).toEqual([true, true]);
    expect(r.codeApplies).toEqual([true, true]);
  });

  it('a returning email with its valid repeat code', async () => {
    await booking('completed', { email: 'kunde@example.com', phone: '40000002' });
    await repeatCode({ code: 'RETUR-ABCDEFGH', email: 'kunde@example.com' });
    const r = await gatesAgree({ email: 'kunde@example.com', phone: '40000002', code: 'RETUR-ABCDEFGH' });
    expect(r.firstTime).toEqual([false, false]);
    expect(r.codeApplies).toEqual([true, true]);
  });

  it('a returning email with a repeat code while the repeat programme is off', async () => {
    await setApp({ enableRepeatDiscount: 'false' });
    await booking('completed', { email: 'kunde@example.com', phone: '40000003' });
    await repeatCode({ code: 'RETUR-ABCDEFGH', email: 'kunde@example.com' });
    const r = await gatesAgree({ email: 'kunde@example.com', phone: '40000003', code: 'RETUR-ABCDEFGH' });
    expect(r.firstTime).toEqual([false, false]);
    expect(r.codeApplies).toEqual([false, false]);
  });

  it('an unseen email with a bogus code', async () => {
    const r = await gatesAgree({ email: 'ny@example.com', code: 'FINNES-IKKE' });
    expect(r.firstTime).toEqual([true, true]);
    expect(r.codeApplies).toEqual([false, false]);
  });

  it('an unseen email with an exhausted campaign code', async () => {
    await campaignCode({ code: 'OPPBRUKT', maxUses: 2, usedCount: 2 });
    const r = await gatesAgree({ email: 'ny@example.com', code: 'OPPBRUKT' });
    expect(r.firstTime).toEqual([true, true]);
    expect(r.codeApplies).toEqual([false, false]);
  });

  it('no identity, campaign code only', async () => {
    await campaignCode({ code: 'ANONYM-KODE', percent: 5 });
    const r = await gatesAgree({ code: 'ANONYM-KODE' });
    expect(r.firstTime).toEqual([false, false]);
    expect(r.codeApplies).toEqual([true, true]);
  });

  // FIXED E-4: first-time and repeat are mutually exclusive inside
  // computeDiscount (first-time wins), but the preview endpoint reported the
  // two gates independently. A first-time customer holding a RETUR code was
  // told both applied while only one is ever charged.
  it('a first-time customer holding a repeat code: the two must not disagree', async () => {
    // FIXED E-4: the route applies the same precedence and reports the code as
    // `superseded`.
    await repeatCode({ code: 'RETUR-ABCDEFGH', email: 'ny@example.com' });
    const r = await gatesAgree({ email: 'ny@example.com', code: 'RETUR-ABCDEFGH' });
    expect(r.codeApplies[0]).toBe(r.codeApplies[1]);
  });

  it('…and the preview names the reason the repeat code does not apply (E-4)', async () => {
    await repeatCode({ code: 'RETUR-ABCDEFGH', email: 'ny@example.com' });
    const r = await gatesAgree({ email: 'ny@example.com', code: 'RETUR-ABCDEFGH' });
    expect(r.preview).toMatchObject({
      firstTimeEligible: true,
      code: { valid: false, reason: 'superseded' },
    });
    expect(r.engine.applied).toEqual([{ kind: 'first-time', percent: 10 }]);
    expect(r.engine.effectivePercent).toBe(10); // not 20
  });

  it('the preview never applies discountHardCap — callers must not sum its percents', async () => {
    // Documented divergence, flag F-E7: the endpoint returns raw per-source
    // percents. With the shipped 40 % cap, first-time 10 + campaign 50 previews
    // as 60 while the engine charges 40.
    await campaignCode({ code: 'STOR-KODE', percent: 50 });
    const r = await gatesAgree({ email: 'ny@example.com', code: 'STOR-KODE' });
    expect(r.firstTime).toEqual([true, true]);
    expect(r.codeApplies).toEqual([true, true]);
    expect(r.preview.firstTimePercent + r.preview.code.percent!).toBe(60);
    expect(r.engine.effectivePercent).toBe(40);
  });
});

describe('GET /api/check-discount-eligibility — rate limiting', () => {
  it('allows 15 requests per IP per minute and 429s the 16th with a safe body', async () => {
    const headers = { 'x-forwarded-for': '10.1.9.9' };
    for (let i = 0; i < 15; i++) {
      const res = await call(GET, {
        path: '/api/check-discount-eligibility',
        searchParams: { email: 'ny@example.com' },
        headers,
      });
      expect(res.status).toBe(200);
    }
    const limited = await call<EligibilityBody>(GET, {
      path: '/api/check-discount-eligibility',
      searchParams: { email: 'ny@example.com' },
      headers,
    });
    expect(limited.status).toBe(429);
    // A limited response must not leak eligibility.
    expect(limited.json).toEqual({ firstTimeEligible: false, code: null });
  });
});
