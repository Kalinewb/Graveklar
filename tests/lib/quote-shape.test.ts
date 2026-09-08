import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildQuote } from '@/lib/domain/quote';
import { computeDiscount } from '@/lib/discount-engine';
import { computeBookingPrices } from '@/lib/booking-service';
import { DEFAULT_CONFIG } from '@/lib/pricing';

import {
  campaignCode,
  db,
  ensureSchema,
  invalidateCaches,
  resetDb,
  seedConfigDefaults,
} from '../helpers/db';
import { MON, futureDow } from '../helpers/pricing';

// The Quote object's authoritative numbers come from computeBookingPrices
// (pure, covered in booking-prices.test) plus computeDiscount (DB-bound).
// The pure half of the contract is asserted directly below; the discount-line
// distribution is asserted against the REAL buildQuote + discount engine
// rather than a local re-implementation, so a change to either shows up here.

describe('Quote arithmetic contract', () => {
  const cfg = { ...DEFAULT_CONFIG };

  it('subtotal = basePrice + extraHoursCost + deliveryFee for day rental', () => {
    const c = computeBookingPrices(
      { rentalType: 'day', startDate: '2026-06-01', deliveryFee: 750, extraHours: 3 },
      cfg,
    );
    const subtotal = c.basePrice + c.extraHoursCost + c.deliveryFee;
    expect(subtotal).toBe(c.totalPrice);
  });

  it('subtotal scales correctly with extra hours', () => {
    const a = computeBookingPrices({ rentalType: 'day', startDate: '2026-06-01', deliveryFee: 0, extraHours: 0 }, cfg);
    const b = computeBookingPrices({ rentalType: 'day', startDate: '2026-06-01', deliveryFee: 0, extraHours: 5 }, cfg);
    expect(b.totalPrice - a.totalPrice).toBe(5 * cfg.preOrderHourRate);
  });

  it('selfPickup-style booking with deliveryFee=0 produces matching subtotal', () => {
    const c = computeBookingPrices(
      { rentalType: 'weekend', startDate: '2026-06-05', deliveryFee: 0, extraHours: 0 },
      cfg,
    );
    expect(c.deliveryFee).toBe(0);
    expect(c.totalPrice).toBe(c.basePrice + c.extraHoursCost);
  });

  it('per-machine override does not break the arithmetic', () => {
    const c = computeBookingPrices(
      { rentalType: 'day', startDate: '2026-06-01', deliveryFee: 200, extraHours: 1 },
      cfg,
      { dayPrice: 1234, preOrderHourRate: 500 },
    );
    expect(c.basePrice).toBe(1234);
    expect(c.extraHoursCost).toBe(500);
    expect(c.totalPrice).toBe(1234 + 500 + 200);
  });
});

// Discount-line distribution invariant, driven through the real code:
//   src/lib/domain/quote.ts buildQuote  ×  src/lib/discount-engine.ts
// The subtotal is pinned to 5 000 kr (2 490 base + 2 510 delivery) so the
// expected kroner are readable.
describe('Discount line distribution invariant', () => {
  const SUBTOTAL = 5_000;
  const DELIVERY = SUBTOTAL - DEFAULT_CONFIG.weekdayHourly * DEFAULT_CONFIG.dayIncludedHours; // 2510
  const EMAIL = 'ny.kunde@example.com';

  async function setApp(values: Record<string, string>): Promise<void> {
    for (const [key, value] of Object.entries(values)) {
      await db.appConfig.update({ where: { key }, data: { value } });
    }
    invalidateCaches();
  }

  async function quote(code?: string) {
    const q = await buildQuote({
      rentalType: 'day',
      startDate: futureDow(MON, 21),
      selfPickup: false,
      deliveryDistance: 100,
      deliveryFee: DELIVERY,
      email: EMAIL,
      code: code ?? null,
    });
    expect(q.subtotal).toBe(SUBTOTAL);
    return q;
  }

  beforeAll(async () => {
    await ensureSchema();
  });

  beforeEach(async () => {
    await resetDb();
    await seedConfigDefaults();
  });

  it('single uncapped line: amount = subtotal × pct / 100', async () => {
    const q = await quote();
    expect(q.discountLines.map((l) => [l.kind, l.percent, l.amountKr])).toEqual([
      ['first-time', 10, 500],
    ]);
    expect(q.cappedByCeiling).toBe(false);
  });

  it('two lines summing under cap: each line gets its share', async () => {
    await campaignCode({ code: 'TI-PROSENT', percent: 10 });
    const q = await quote('TI-PROSENT');
    expect(q.discountLines.map((l) => [l.kind, l.percent, l.amountKr])).toEqual([
      ['first-time', 10, 500],
      ['campaign', 10, 500],
    ]);
    expect(q.discountKr).toBe(1000);
  });

  it('cap kicks in: each line scaled proportionally', async () => {
    // raw 50 %, cap 40 % → scale 0.8. Two equal 25 % lines → 20 % × 5000 each.
    await setApp({ firstTimeDiscountPercent: '25', discountHardCap: '40' });
    await campaignCode({ code: 'TJUEFEM', percent: 25 });
    const q = await quote('TJUEFEM');
    expect(q.cappedByCeiling).toBe(true);
    expect(q.discountLines.map((l) => [l.kind, l.percent, l.amountKr])).toEqual([
      ['first-time', 20, 1000],
      ['campaign', 20, 1000],
    ]);
    expect(q.discountKr).toBe(2000);
  });

  it('the line percents always sum to the engine’s effectivePercent', async () => {
    await setApp({ firstTimeDiscountPercent: '13', discountHardCap: '30' });
    await campaignCode({ code: 'TJUESYV', percent: 27 });
    const q = await quote('TJUESYV');
    const engine = await computeDiscount({
      baseTotalKr: SUBTOTAL,
      email: EMAIL,
      phone: '',
      code: 'TJUESYV',
    });
    expect(q.discountLines.reduce((s, l) => s + l.percent, 0)).toBeCloseTo(engine.effectivePercent, 6);
    expect(q.discountKr).toBe(engine.discountKr);
    expect(q.totalPrice).toBe(SUBTOTAL - engine.discountKr);
  });

  it('every line amount is its own percent applied to the subtotal, and they sum to discountKr', async () => {
    // FIXED A-6: `discountKr` is ONE rounding of the summed percentage, so
    // rounding each line independently could make the breakdown add up to a
    // krone more than was actually deducted. The last line therefore absorbs
    // the remainder — each line is still its own percent, to within that one
    // krone, and the column now sums to the number at the bottom.
    await setApp({ firstTimeDiscountPercent: '13', discountHardCap: '30' });
    await campaignCode({ code: 'TJUESYV', percent: 27 });
    const q = await quote('TJUESYV');
    for (const line of q.discountLines) {
      expect(Math.abs(line.amountKr - Math.round((SUBTOTAL * line.percent) / 100))).toBeLessThanOrEqual(1);
    }
    expect(q.discountLines.reduce((s, l) => s + l.amountKr, 0)).toBe(q.discountKr);
  });

  it('no applicable discount produces no lines and no label', async () => {
    await setApp({ enableFirstTimeDiscount: 'false' });
    const q = await quote();
    expect(q.discountLines).toEqual([]);
    expect(q.discountKr).toBe(0);
    expect(q.discountLabel).toBeNull();
    expect(q.totalPrice).toBe(SUBTOTAL);
  });
});
