import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// createPendingBooking pulls in the email module; nothing here may send mail.
vi.mock('@/lib/email', async () => (await import('../helpers/mocks')).mockEmail());

import {
  BookingValidationError,
  PriceDriftError,
  createPendingBooking,
  type CreateBookingInput,
} from '@/lib/booking-service';
import {
  computeDiscount,
  isFirstTimeEligible,
  issueRepeatCode,
  redeemCampaignCode,
  redeemCode,
  validateRepeatCode,
} from '@/lib/discount-engine';

import {
  booking,
  campaignCode,
  db,
  ensureSchema,
  invalidateCaches,
  machine,
  repeatCode,
  resetDb,
  seedConfigDefaults,
} from '../helpers/db';
import { emailMock, mockClock } from '../helpers/mocks';
import { MON, futureDow } from '../helpers/pricing';

// L3 — the discount engine end to end against the scratch database. It is the
// sole authority for what a customer is charged less than list price, so every
// gate, boundary and race here is money.

const BASE = 10_000; // round base total keeps the percentages readable

/** Overwrite AppConfig rows seeded by beforeEach. */
async function setApp(values: Record<string, string>): Promise<void> {
  for (const [key, value] of Object.entries(values)) {
    await db.appConfig.update({ where: { key }, data: { value } });
  }
  invalidateCaches();
}

let clock: ReturnType<typeof mockClock> | null = null;

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDb();
  await seedConfigDefaults();
  emailMock.reset();
});

afterEach(() => {
  clock?.restore();
  clock = null;
});

// ── isFirstTimeEligible ──────────────────────────────────────────────────────

describe('isFirstTimeEligible', () => {
  it('is false without any identifier', async () => {
    expect(await isFirstTimeEligible('', '')).toBe(false);
    expect(await isFirstTimeEligible('   ', '  ')).toBe(false);
  });

  it('is true for an email and a phone the system has never seen', async () => {
    expect(await isFirstTimeEligible('ny@example.com', '')).toBe(true);
    expect(await isFirstTimeEligible('', '99011223')).toBe(true);
  });

  it('a confirmed booking on the same email disqualifies', async () => {
    await booking('confirmed', { email: 'kunde@example.com', phone: '40000001' });
    expect(await isFirstTimeEligible('kunde@example.com', '99999999')).toBe(false);
  });

  it('email matching is case- and whitespace-insensitive on the query side', async () => {
    await booking('confirmed', { email: 'kunde@example.com' });
    expect(await isFirstTimeEligible('  KUNDE@Example.COM ', '')).toBe(false);
  });

  it('a completed booking disqualifies too', async () => {
    await booking('completed', { email: 'kunde@example.com' });
    expect(await isFirstTimeEligible('kunde@example.com', '')).toBe(false);
  });

  it('pending and cancelled bookings do NOT disqualify', async () => {
    await booking('pending', { email: 'a@example.com', startDateStr: '2027-03-01' });
    await booking('cancelled', { email: 'b@example.com', startDateStr: '2027-04-01' });
    expect(await isFirstTimeEligible('a@example.com', '')).toBe(true);
    expect(await isFirstTimeEligible('b@example.com', '')).toBe(true);
  });

  it('matches on phone alone, across cosmetic formatting', async () => {
    await booking('confirmed', { email: 'old@example.com', phone: '99011223' });
    for (const typed of ['99011223', '+47 990 11 223', '(0047) 99011223', '47 99011223']) {
      expect(await isFirstTimeEligible('brand.new@example.com', typed)).toBe(false);
    }
  });

  it('a different phone with the same shape still qualifies', async () => {
    await booking('confirmed', { email: 'old@example.com', phone: '99011223' });
    expect(await isFirstTimeEligible('brand.new@example.com', '99011224')).toBe(true);
  });

  it('excludeBookingId lets a booking ignore itself', async () => {
    const b = await booking('confirmed', { email: 'kunde@example.com', phone: '99011223' });
    expect(await isFirstTimeEligible('kunde@example.com', '99011223')).toBe(false);
    expect(await isFirstTimeEligible('kunde@example.com', '99011223', b.id)).toBe(true);
  });

  // FIXED E-1: the email branch compared with plain equality against the
  // stored column. Writes are lowercased today, but any row that predates that
  // (or is written by an admin tool) was invisible to the email check, so the
  // customer re-qualified for the first-time discount.
  it('a stored mixed-case email must still disqualify', async () => {
    // FIXED E-1: the indexed equality is a fast path only; the paged pass
    // behind it normalises both columns in JS.
    await booking('confirmed', { email: 'Kunde@Example.COM', phone: '40000001' });
    expect(await isFirstTimeEligible('kunde@example.com', '99011223')).toBe(false);
  });

  // FIXED E-2: the phone-only fallback read `take: 1000`, unordered, so on a
  // database with more than 1000 confirmed/completed bookings a returning
  // customer whose row fell outside the window qualified as first-time again.
  it('the phone check must not be bounded to the first 1000 bookings', async () => {
    // FIXED E-2: the pass is cursor-paged by id, so it is complete at any
    // table size.
    const m = await machine();
    const filler = Array.from({ length: 1000 }, (_, i) => ({
      reference: `GK-FILL-${String(i).padStart(5, '0')}`,
      name: 'Filler',
      phone: `4${String(1_000_000 + i)}`,
      email: `filler${i}@example.com`,
      deliveryAddress: 'Testveien 1',
      rentalType: 'day',
      startDate: new Date('2027-01-01T00:00:00'),
      deliveryDistance: 0,
      deliveryFee: 0,
      basePrice: 1,
      totalPrice: 1,
      status: 'confirmed',
      machineId: m.id,
    }));
    await db.booking.createMany({ data: filler });
    await booking('confirmed', {
      email: 'returkunde@example.com',
      phone: '99011223',
      machineId: m.id,
      skipLocks: true,
      startDateStr: '2027-02-01',
    });

    expect(await isFirstTimeEligible('helt.ny@example.com', '99011223')).toBe(false);
  }, 30_000);
});

// ── validateRepeatCode ───────────────────────────────────────────────────────

describe('validateRepeatCode — campaign codes', () => {
  it('accepts a code regardless of case and surrounding whitespace', async () => {
    const c = await campaignCode({ code: 'SOMMER-2026', percent: 20 });
    for (const typed of ['SOMMER-2026', 'sommer-2026', '  Sommer-2026  ']) {
      expect(await validateRepeatCode(typed, 'x@example.com')).toEqual({
        ok: true,
        kind: 'campaign',
        codeId: c.id,
        percent: 20,
      });
    }
  });

  it('an empty or whitespace-only code is invalid', async () => {
    expect(await validateRepeatCode('', 'x@example.com')).toEqual({ ok: false, reason: 'invalid' });
    expect(await validateRepeatCode('   ', 'x@example.com')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('a lowercase code stored directly in the table can never be redeemed', async () => {
    // Documented, not a defect: /api/admin/discount-codes uppercases on write,
    // and lookup uppercases the typed value, so the table only ever holds
    // uppercase codes. Recorded so a future seeding tool does not trip on it.
    await campaignCode({ code: 'sommer-2026' });
    expect(await validateRepeatCode('sommer-2026', 'x@example.com')).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('is not email-bound', async () => {
    const c = await campaignCode({ code: 'APENT-FOR-ALLE' });
    const r = await validateRepeatCode('APENT-FOR-ALLE', 'anyone@example.com');
    expect(r).toMatchObject({ ok: true, kind: 'campaign', codeId: c.id });
  });

  it('an inactive code reports `inactive`', async () => {
    await campaignCode({ code: 'AV-KODE', isActive: false });
    expect(await validateRepeatCode('AV-KODE', '')).toEqual({ ok: false, reason: 'inactive' });
  });

  it('maxUses is a strict ceiling: usedCount === maxUses is exhausted', async () => {
    await campaignCode({ code: 'TO-BRUK', maxUses: 2, usedCount: 1 });
    expect(await validateRepeatCode('TO-BRUK', '')).toMatchObject({ ok: true });

    await db.campaignDiscountCode.update({ where: { code: 'TO-BRUK' }, data: { usedCount: 2 } });
    expect(await validateRepeatCode('TO-BRUK', '')).toEqual({ ok: false, reason: 'exhausted' });
  });

  it('maxUses null means unlimited', async () => {
    await campaignCode({ code: 'UENDELIG', maxUses: null, usedCount: 9999 });
    expect(await validateRepeatCode('UENDELIG', '')).toMatchObject({ ok: true });
  });

  it('expiry is exclusive: expiresAt exactly now is still valid, one ms earlier is not', async () => {
    clock = mockClock('2026-09-06T12:00:00+02:00');
    const now = new Date();
    await campaignCode({ code: 'AKKURAT-NA', expiresAt: new Date(now.getTime()) });
    expect(await validateRepeatCode('AKKURAT-NA', '')).toMatchObject({ ok: true });

    await campaignCode({ code: 'ETT-MS-SIDEN', expiresAt: new Date(now.getTime() - 1) });
    expect(await validateRepeatCode('ETT-MS-SIDEN', '')).toEqual({ ok: false, reason: 'expired' });

    await campaignCode({ code: 'ETT-MS-IGJEN', expiresAt: new Date(now.getTime() + 1) });
    expect(await validateRepeatCode('ETT-MS-IGJEN', '')).toMatchObject({ ok: true });
  });

  it('inactive is reported before expired when both apply', async () => {
    clock = mockClock('2026-09-06T12:00:00+02:00');
    await campaignCode({
      code: 'AV-OG-UTLOPT',
      isActive: false,
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect(await validateRepeatCode('AV-OG-UTLOPT', '')).toEqual({ ok: false, reason: 'inactive' });
  });
});

describe('validateRepeatCode — single-use RETUR codes', () => {
  it('accepts an unredeemed code for its bound email, case-insensitively', async () => {
    const r = await repeatCode({ code: 'RETUR-ABCDEFGH', email: 'kunde@example.com' });
    expect(await validateRepeatCode(' retur-abcdefgh ', '  Kunde@Example.COM ')).toEqual({
      ok: true,
      kind: 'repeat',
      codeId: r.id,
    });
  });

  it('rejects a different email', async () => {
    await repeatCode({ code: 'RETUR-ABCDEFGH', email: 'kunde@example.com' });
    expect(await validateRepeatCode('RETUR-ABCDEFGH', 'annen@example.com')).toEqual({
      ok: false,
      reason: 'mismatched-email',
    });
  });

  it('rejects an unknown code', async () => {
    expect(await validateRepeatCode('RETUR-NOTHERE', 'x@example.com')).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('a redeemedByBookingId marks it used', async () => {
    const b = await booking('confirmed');
    await repeatCode({ code: 'RETUR-USED0001', email: 'kunde@example.com', redeemedByBookingId: b.id });
    expect(await validateRepeatCode('RETUR-USED0001', 'kunde@example.com')).toEqual({
      ok: false,
      reason: 'redeemed',
    });
  });

  it('a stamped redeemedAt alone still marks it used (SetNull cascade survivor)', async () => {
    await repeatCode({ code: 'RETUR-USED0002', email: 'kunde@example.com', redeemedAt: new Date() });
    expect(await validateRepeatCode('RETUR-USED0002', 'kunde@example.com')).toEqual({
      ok: false,
      reason: 'redeemed',
    });
  });

  it('redeemed is reported before expired and before the email check', async () => {
    clock = mockClock('2026-09-06T12:00:00+02:00');
    await repeatCode({
      code: 'RETUR-USED0003',
      email: 'kunde@example.com',
      redeemedAt: new Date(),
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect(await validateRepeatCode('RETUR-USED0003', 'feil@example.com')).toEqual({
      ok: false,
      reason: 'redeemed',
    });
  });

  it('expiry is exclusive here too', async () => {
    clock = mockClock('2026-09-06T12:00:00+02:00');
    const now = Date.now();
    await repeatCode({ code: 'RETUR-NOW00001', email: 'k@example.com', expiresAt: new Date(now) });
    expect(await validateRepeatCode('RETUR-NOW00001', 'k@example.com')).toMatchObject({ ok: true });

    await repeatCode({ code: 'RETUR-OLD00001', email: 'k@example.com', expiresAt: new Date(now - 1) });
    expect(await validateRepeatCode('RETUR-OLD00001', 'k@example.com')).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('a campaign code wins the lookup when both tables hold the same value', async () => {
    const c = await campaignCode({ code: 'DOBBEL-KODE', percent: 25 });
    await repeatCode({ code: 'DOBBEL-KODE', email: 'kunde@example.com' });
    expect(await validateRepeatCode('DOBBEL-KODE', 'kunde@example.com')).toEqual({
      ok: true,
      kind: 'campaign',
      codeId: c.id,
      percent: 25,
    });
  });
});

// ── computeDiscount ──────────────────────────────────────────────────────────

describe('computeDiscount', () => {
  it('applies the first-time percent to a new identity', async () => {
    const r = await computeDiscount({ baseTotalKr: BASE, email: 'ny@example.com', phone: '' });
    expect(r).toMatchObject({
      discountKr: 1000,
      effectivePercent: 10,
      cappedByCeiling: false,
      label: 'Førstegangskunde (-10%)',
    });
    expect(r.applied).toEqual([{ kind: 'first-time', percent: 10 }]);
  });

  it('gives nothing when neither identifier nor code is supplied', async () => {
    const r = await computeDiscount({ baseTotalKr: BASE, email: '', phone: '' });
    expect(r).toMatchObject({ discountKr: 0, label: null, effectivePercent: 0, applied: [] });
  });

  it('respects the enableFirstTimeDiscount toggle', async () => {
    await setApp({ enableFirstTimeDiscount: 'false' });
    const r = await computeDiscount({ baseTotalKr: BASE, email: 'ny@example.com', phone: '' });
    expect(r.applied).toEqual([]);
  });

  it('a first-time percent of 0 is the same as off', async () => {
    await setApp({ firstTimeDiscountPercent: '0' });
    const r = await computeDiscount({ baseTotalKr: BASE, email: 'ny@example.com', phone: '' });
    expect(r.applied).toEqual([]);
  });

  it('a negative first-time percent is clamped to 0, not applied as a surcharge', async () => {
    await setApp({ firstTimeDiscountPercent: '-25' });
    const r = await computeDiscount({ baseTotalKr: BASE, email: 'ny@example.com', phone: '' });
    expect(r.applied).toEqual([]);
    expect(r.discountKr).toBe(0);
  });

  it('first-time and campaign stack, and the label lists both', async () => {
    const c = await campaignCode({ code: 'STABLE-KODE', percent: 15 });
    const r = await computeDiscount({
      baseTotalKr: BASE,
      email: 'ny@example.com',
      phone: '',
      code: 'STABLE-KODE',
    });
    expect(r.applied).toEqual([
      { kind: 'first-time', percent: 10 },
      { kind: 'campaign', percent: 15, codeId: c.id },
    ]);
    expect(r.effectivePercent).toBe(25);
    expect(r.discountKr).toBe(2500);
    expect(r.label).toBe('Førstegangskunde + Rabattkode (-25%)');
  });

  it('the hard cap trims the stack and flags cappedByCeiling', async () => {
    await campaignCode({ code: 'STOR-KODE', percent: 50 });
    const r = await computeDiscount({
      baseTotalKr: BASE,
      email: 'ny@example.com',
      phone: '',
      code: 'STOR-KODE',
    });
    expect(r.cappedByCeiling).toBe(true);
    expect(r.effectivePercent).toBe(40); // discountHardCap default
    expect(r.discountKr).toBe(4000);
  });

  it('discountHardCap = 0 means uncapped', async () => {
    await setApp({ discountHardCap: '0' });
    await campaignCode({ code: 'STOR-KODE', percent: 50 });
    const r = await computeDiscount({
      baseTotalKr: BASE,
      email: 'ny@example.com',
      phone: '',
      code: 'STOR-KODE',
    });
    expect(r.cappedByCeiling).toBe(false);
    expect(r.effectivePercent).toBe(60);
    expect(r.discountKr).toBe(6000);
  });

  it('a percent over 100 produces a discount larger than the base (caller must clamp)', async () => {
    await setApp({ discountHardCap: '0', enableFirstTimeDiscount: 'false' });
    await campaignCode({ code: 'GALT-HOY', percent: 150 });
    const r = await computeDiscount({ baseTotalKr: BASE, email: 'x@example.com', phone: '', code: 'GALT-HOY' });
    expect(r.discountKr).toBe(15_000);
    expect(r.discountKr).toBeGreaterThan(BASE);
    // buildQuote and createPendingBooking both clamp the net with Math.max(0, …).
  });

  it('first-time wins over a repeat code — the two are mutually exclusive', async () => {
    await repeatCode({ code: 'RETUR-BOTH0001', email: 'ny@example.com' });
    const r = await computeDiscount({
      baseTotalKr: BASE,
      email: 'ny@example.com',
      phone: '',
      code: 'RETUR-BOTH0001',
    });
    expect(r.applied).toEqual([{ kind: 'first-time', percent: 10 }]);
    expect(r.effectivePercent).toBe(10);
  });

  it('a repeat code applies once the customer is no longer first-time', async () => {
    await booking('completed', { email: 'kunde@example.com', phone: '40000009' });
    const code = await repeatCode({ code: 'RETUR-REAL0001', email: 'kunde@example.com' });
    const r = await computeDiscount({
      baseTotalKr: BASE,
      email: 'kunde@example.com',
      phone: '40000009',
      code: 'RETUR-REAL0001',
    });
    expect(r.applied).toEqual([{ kind: 'repeat', percent: 10, codeId: code.id }]);
    expect(r.label).toBe('Returkunde-kode (-10%)');
  });

  it('a repeat code is silently dropped when enableRepeatDiscount is off', async () => {
    await setApp({ enableRepeatDiscount: 'false' });
    await booking('completed', { email: 'kunde@example.com' });
    await repeatCode({ code: 'RETUR-OFF00001', email: 'kunde@example.com' });
    const r = await computeDiscount({
      baseTotalKr: BASE,
      email: 'kunde@example.com',
      phone: '',
      code: 'RETUR-OFF00001',
    });
    expect(r.applied).toEqual([]);
  });

  it('a repeat percent of 0 drops it too', async () => {
    await setApp({ repeatDiscountPercent: '0' });
    await booking('completed', { email: 'kunde@example.com' });
    await repeatCode({ code: 'RETUR-ZERO0001', email: 'kunde@example.com' });
    const r = await computeDiscount({
      baseTotalKr: BASE,
      email: 'kunde@example.com',
      phone: '',
      code: 'RETUR-ZERO0001',
    });
    expect(r.applied).toEqual([]);
  });

  it('campaign codes are independent of the repeat toggle', async () => {
    await setApp({ enableRepeatDiscount: 'false', enableFirstTimeDiscount: 'false' });
    const c = await campaignCode({ code: 'MARKED-2026', percent: 20 });
    const r = await computeDiscount({
      baseTotalKr: BASE,
      email: 'kunde@example.com',
      phone: '',
      code: 'MARKED-2026',
    });
    expect(r.applied).toEqual([{ kind: 'campaign', percent: 20, codeId: c.id }]);
  });

  it('an invalid code leaves the rest of the calculation untouched', async () => {
    const r = await computeDiscount({
      baseTotalKr: BASE,
      email: 'ny@example.com',
      phone: '',
      code: 'FINNES-IKKE',
    });
    expect(r.applied).toEqual([{ kind: 'first-time', percent: 10 }]);
  });

  it('excludeBookingId lets a booking recompute its own discount', async () => {
    const b = await booking('confirmed', { email: 'kunde@example.com', phone: '40000010' });
    const without = await computeDiscount({ baseTotalKr: BASE, email: 'kunde@example.com', phone: '40000010' });
    const with_ = await computeDiscount({
      baseTotalKr: BASE,
      email: 'kunde@example.com',
      phone: '40000010',
      excludeBookingId: b.id,
    });
    expect(without.applied).toEqual([]);
    expect(with_.applied).toEqual([{ kind: 'first-time', percent: 10 }]);
  });

  it('a 0 kr base yields a 0 kr discount and no label', async () => {
    const r = await computeDiscount({ baseTotalKr: 0, email: 'ny@example.com', phone: '' });
    expect(r.discountKr).toBe(0);
    expect(r.label).toBeNull();
    expect(r.effectivePercent).toBe(10); // the percent still applies, the kr does not
  });

  it('rounds the kroner amount half-up', async () => {
    const r = await computeDiscount({ baseTotalKr: 2495, email: 'ny@example.com', phone: '' });
    expect(r.discountKr).toBe(250); // 249.5 → 250
  });
});

// ── issueRepeatCode ──────────────────────────────────────────────────────────

describe('issueRepeatCode', () => {
  it('mints RETUR- plus 8 characters from the no-confusable alphabet', async () => {
    const b = await booking('completed', { email: 'kunde@example.com' });
    const issued = await issueRepeatCode({ email: 'Kunde@Example.COM', bookingId: b.id, expiresInDays: 365 });
    expect(issued).not.toBeNull();
    expect(issued!.code).toMatch(/^RETUR-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);

    const row = await db.repeatDiscountCode.findUniqueOrThrow({ where: { id: issued!.id } });
    expect(row.email).toBe('kunde@example.com'); // normalised on write
    expect(row.issuedForBookingId).toBe(b.id);
    expect(row.redeemedAt).toBeNull();
  });

  it('sets the expiry 365 days out — the value both call sites pass', async () => {
    clock = mockClock('2026-09-06T12:00:00+02:00');
    const b = await booking('completed', { email: 'kunde@example.com' });
    const issued = await issueRepeatCode({ email: 'kunde@example.com', bookingId: b.id, expiresInDays: 365 });
    const row = await db.repeatDiscountCode.findUniqueOrThrow({ where: { id: issued!.id } });
    expect(row.expiresAt!.getTime()).toBe(Date.now() + 365 * 24 * 60 * 60 * 1000);
  });

  it('omitting expiresInDays mints a code that never expires', async () => {
    const b = await booking('completed', { email: 'kunde@example.com' });
    const issued = await issueRepeatCode({ email: 'kunde@example.com', bookingId: b.id });
    const row = await db.repeatDiscountCode.findUniqueOrThrow({ where: { id: issued!.id } });
    expect(row.expiresAt).toBeNull();
  });

  it('returns null when the repeat programme is switched off', async () => {
    await setApp({ enableRepeatDiscount: 'false' });
    const b = await booking('completed', { email: 'kunde@example.com' });
    expect(await issueRepeatCode({ email: 'kunde@example.com', bookingId: b.id })).toBeNull();
    expect(await db.repeatDiscountCode.count()).toBe(0);
  });

  it('returns null for an empty email', async () => {
    const b = await booking('completed');
    expect(await issueRepeatCode({ email: '   ', bookingId: b.id })).toBeNull();
  });

  it('is NOT idempotent per booking — a second call mints a second code', async () => {
    // Safe today only because both call sites guard on a status transition.
    const b = await booking('completed', { email: 'kunde@example.com' });
    const a = await issueRepeatCode({ email: 'kunde@example.com', bookingId: b.id });
    const c = await issueRepeatCode({ email: 'kunde@example.com', bookingId: b.id });
    expect(a!.code).not.toBe(c!.code);
    expect(await db.repeatDiscountCode.count()).toBe(2);
  });
});

// ── redemption ───────────────────────────────────────────────────────────────

describe('redeemCode', () => {
  it('stamps the booking and the timestamp', async () => {
    const b = await booking('confirmed', { email: 'kunde@example.com' });
    const code = await repeatCode({ code: 'RETUR-CLAIM001', email: 'kunde@example.com' });
    await redeemCode(code.id, b.id);
    const row = await db.repeatDiscountCode.findUniqueOrThrow({ where: { id: code.id } });
    expect(row.redeemedByBookingId).toBe(b.id);
    expect(row.redeemedAt).not.toBeNull();
  });

  it('is idempotent — a second call cannot move the code to another booking', async () => {
    const first = await booking('confirmed', { email: 'kunde@example.com', startDateStr: '2027-05-03' });
    const second = await booking('confirmed', { email: 'kunde@example.com', startDateStr: '2027-06-07' });
    const code = await repeatCode({ code: 'RETUR-CLAIM002', email: 'kunde@example.com' });
    await redeemCode(code.id, first.id);
    await redeemCode(code.id, second.id);
    const row = await db.repeatDiscountCode.findUniqueOrThrow({ where: { id: code.id } });
    expect(row.redeemedByBookingId).toBe(first.id);
  });

  it('an unknown codeId is a no-op, not a throw', async () => {
    const b = await booking('confirmed');
    await expect(redeemCode('no-such-code', b.id)).resolves.toBeUndefined();
  });
});

describe('redeemCampaignCode', () => {
  it('increments usedCount and records the redemption', async () => {
    const b = await booking('confirmed', { email: 'kunde@example.com' });
    const c = await campaignCode({ code: 'BRUKT-KODE', maxUses: 5 });
    await redeemCampaignCode(c.id, b.id, 'Kunde@Example.COM');

    const row = await db.campaignDiscountCode.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.usedCount).toBe(1);
    const redemptions = await db.campaignRedemption.findMany({ where: { codeId: c.id } });
    expect(redemptions).toHaveLength(1);
    expect(redemptions[0].email).toBe('kunde@example.com');
  });

  // FIXED E-3: the spend enforces maxUses itself now — validateRepeatCode's
  // read is the preview, this write is the authority.
  it('refuses to spend a code that already sits at its ceiling', async () => {
    const b = await booking('confirmed', { email: 'kunde@example.com' });
    const c = await campaignCode({ code: 'OVERBRUK', maxUses: 1, usedCount: 1 });

    expect(await redeemCampaignCode(c.id, b.id, 'kunde@example.com')).toBe(false);

    const row = await db.campaignDiscountCode.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.usedCount).toBe(1); // never past its own ceiling
    expect(await db.campaignRedemption.count({ where: { codeId: c.id } })).toBe(0);
  });

  it('spends an unlimited code (maxUses: null) every time', async () => {
    const b = await booking('confirmed', { email: 'kunde@example.com' });
    const c = await campaignCode({ code: 'UBEGRENSET', maxUses: null, usedCount: 7 });

    expect(await redeemCampaignCode(c.id, b.id, 'kunde@example.com')).toBe(true);

    const row = await db.campaignDiscountCode.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.usedCount).toBe(8);
  });

  // FIXED E-3: maxUses used to be enforced by a READ (validateRepeatCode) and
  // spent by an unconditional `increment`, so two redemptions that interleaved
  // between the read and the write both passed and a single-use campaign code
  // could be spent twice. The spend is now a conditional updateMany inside the
  // transaction that writes the redemption row, so the loser spends nothing
  // and is told so (`false`).
  it('two concurrent redemptions of a maxUses=1 code: exactly one may succeed', async () => {
    const m = await machine();
    const a = await booking('confirmed', {
      email: 'a@example.com', machineId: m.id, startDateStr: '2027-05-03',
    });
    const bb = await booking('confirmed', {
      email: 'b@example.com', machineId: m.id, startDateStr: '2027-06-07',
    });
    const c = await campaignCode({ code: 'ENGANGS-KODE', maxUses: 1, usedCount: 0 });

    const outcomes = await Promise.all([
      (async () => {
        const v = await validateRepeatCode('ENGANGS-KODE', 'a@example.com');
        if (!v.ok) return 'refused';
        return (await redeemCampaignCode(v.codeId, a.id, 'a@example.com')) ? 'redeemed' : 'refused';
      })(),
      (async () => {
        const v = await validateRepeatCode('ENGANGS-KODE', 'b@example.com');
        if (!v.ok) return 'refused';
        return (await redeemCampaignCode(v.codeId, bb.id, 'b@example.com')) ? 'redeemed' : 'refused';
      })(),
    ]);

    const row = await db.campaignDiscountCode.findUniqueOrThrow({ where: { id: c.id } });
    expect(outcomes.filter((o) => o === 'redeemed')).toHaveLength(1);
    expect(row.usedCount).toBeLessThanOrEqual(1);
  });

  // Both redemptions pass the read, exactly as they did before the fix — it is
  // the second *write* that is now refused, and it leaves no redemption row.
  it('two sequential redemptions of a single-use code: only the first counts', async () => {
    const m = await machine();
    const a = await booking('confirmed', { email: 'a@example.com', machineId: m.id, startDateStr: '2027-05-03' });
    const bb = await booking('confirmed', { email: 'b@example.com', machineId: m.id, startDateStr: '2027-06-07' });
    const c = await campaignCode({ code: 'ENGANGS-KODE-2', maxUses: 1, usedCount: 0 });

    await Promise.all([
      validateRepeatCode('ENGANGS-KODE-2', 'a@example.com'),
      validateRepeatCode('ENGANGS-KODE-2', 'b@example.com'),
    ]).then((vs) => {
      expect(vs.every((v) => v.ok)).toBe(true);
    });
    expect(await redeemCampaignCode(c.id, a.id, 'a@example.com')).toBe(true);
    expect(await redeemCampaignCode(c.id, bb.id, 'b@example.com')).toBe(false);

    const row = await db.campaignDiscountCode.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.usedCount).toBe(1);
    expect(await db.campaignRedemption.count({ where: { codeId: c.id } })).toBe(1);
  });
});

// ── The claim inside createPendingBooking's transaction ──────────────────────

describe('repeat-code claim inside createPendingBooking', () => {
  const EMAIL = 'kunde@example.com';
  const CODE = 'RETUR-CLAIMTX1';
  const DAY_KR = 2490;
  const NET_KR = DAY_KR - 249; // 10 % repeat discount

  /** Payment must be configured or createPendingBooking refuses outright. */
  async function arrange(): Promise<string> {
    await setApp({ stripeEnabled: 'true', stripeSecretKey: 'sk_test_not_a_real_key' });
    const m = await machine();
    // A completed rental in the past disqualifies the customer from the
    // first-time discount, so the repeat code is the discount that applies.
    await booking('completed', {
      email: EMAIL,
      phone: '40000011',
      machineId: m.id,
      skipLocks: true,
      startDateStr: '2024-05-06',
    });
    await repeatCode({ code: CODE, email: EMAIL });
    return m.id;
  }

  function input(machineId: string, startDate: string): CreateBookingInput {
    return {
      name: 'Test Testesen',
      phone: '40000011',
      email: EMAIL,
      deliveryAddress: '',
      rentalType: 'day',
      startDate,
      deliveryDistance: 0,
      deliveryFee: 0,
      selfPickup: true,
      termsAccepted: true,
      machineId,
      discountCode: CODE,
      expectedTotalKr: NET_KR,
    };
  }

  it('a successful booking claims the code atomically and stamps redeemedAt', async () => {
    const machineId = await arrange();
    const { booking: created } = await createPendingBooking(input(machineId, futureDow(MON, 21)));

    expect(created.totalPrice).toBe(NET_KR);
    expect(created.discountKr).toBe(249);
    expect(created.discountLabel).toBe('Returkunde-kode (-10%)');

    const row = await db.repeatDiscountCode.findUniqueOrThrow({ where: { code: CODE } });
    expect(row.redeemedByBookingId).toBe(created.id);
    expect(row.redeemedAt).not.toBeNull();
    expect(emailMock.sent).toEqual([]);
  });

  it('the claim happens in the SAME transaction as the booking row', async () => {
    // Nothing else exists between the claim and the commit, so the only way to
    // observe the claim is together with a committed booking.
    const machineId = await arrange();
    await createPendingBooking(input(machineId, futureDow(MON, 21)));
    const claimed = await db.repeatDiscountCode.findUniqueOrThrow({ where: { code: CODE } });
    const owner = await db.booking.findUniqueOrThrow({ where: { id: claimed.redeemedByBookingId! } });
    expect(owner.status).toBe('pending');
  });

  it('a booking that fails BEFORE the claim leaves the code unredeemed', async () => {
    const machineId = await arrange();
    const start = futureDow(MON, 21);
    // Block the date so getUnavailableDateStringsForRange throws ahead of the
    // transaction — the failure path a customer actually hits.
    await booking('confirmed', { machineId, startDateStr: start, email: 'annen@example.com' });

    await expect(createPendingBooking(input(machineId, start))).rejects.toThrow(BookingValidationError);
    const row = await db.repeatDiscountCode.findUniqueOrThrow({ where: { code: CODE } });
    expect(row.redeemedByBookingId).toBeNull();
    expect(row.redeemedAt).toBeNull();
  });

  it('reusing a claimed code is caught by the drift guard, not by a silent full-price charge', async () => {
    const machineId = await arrange();
    await createPendingBooking(input(machineId, futureDow(MON, 21)));

    // The code is now redeemed, so computeDiscount drops it and the fresh
    // total no longer matches what the customer agreed to.
    await expect(createPendingBooking(input(machineId, futureDow(MON, 60)))).rejects.toThrow(PriceDriftError);
    expect(await db.booking.count({ where: { status: 'pending' } })).toBe(1);
  });

  it('two concurrent bookings on one code: exactly one commits, the loser rolls back', async () => {
    const machineId = await arrange();
    const results = await Promise.allSettled([
      createPendingBooking(input(machineId, futureDow(MON, 21))),
      createPendingBooking(input(machineId, futureDow(MON, 60))),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(BookingValidationError);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toBe('Rabattkoden er allerede brukt.');

    // The loser's booking row and its date locks rolled back with it.
    expect(await db.booking.count({ where: { status: 'pending' } })).toBe(1);
    const locks = await db.bookingDateLock.findMany();
    expect(new Set(locks.map((l) => l.bookingId)).size).toBe(1);

    const row = await db.repeatDiscountCode.findUniqueOrThrow({ where: { code: CODE } });
    expect(row.redeemedByBookingId).toBe(
      (fulfilled[0] as PromiseFulfilledResult<{ booking: { id: string } }>).value.booking.id,
    );
  }, 30_000);
});
