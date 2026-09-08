import { describe, it, expect } from 'vitest';

import { computeBookingPrices } from '@/lib/booking-service';
import { rentalDayCount } from '@/lib/availability';
import {
  buildPricingFromConfig,
  calculateCustomPrice,
  getConfigValue,
  DEFAULT_CONFIG,
} from '@/lib/pricing';

import { cfg } from '../helpers/pricing';

// L1 — the per-day custom-rental engine, the tier builder, and the
// equipment-override merge that sits in front of both. Everything here is
// pure; the DB-bound orchestration is in tests/lib/quote.test.ts.

const base = cfg();
const DAY_KR = DEFAULT_CONFIG.weekdayHourly * DEFAULT_CONFIG.dayIncludedHours; // 2490
const WKND_KR = DEFAULT_CONFIG.weekendHourly * DEFAULT_CONFIG.dayIncludedHours; // 3290

describe('getConfigValue', () => {
  it('prefers the stored value', () => {
    expect(getConfigValue(cfg({ weekdayHourly: 300 }), 'weekdayHourly')).toBe(300);
  });

  it('falls back to DEFAULT_CONFIG when the key is absent', () => {
    expect(getConfigValue({}, 'weekdayHourly')).toBe(DEFAULT_CONFIG.weekdayHourly);
  });

  it('returns 0 for a key neither the config nor the defaults know', () => {
    expect(getConfigValue({}, 'noSuchKey')).toBe(0);
  });

  it('an explicit 0 wins over the default (?? not ||)', () => {
    expect(getConfigValue({ minDeliveryFee: 0 }, 'minDeliveryFee')).toBe(0);
    expect(getConfigValue({ weekdayHourly: 0 }, 'weekdayHourly')).toBe(0);
  });
});

describe('buildPricingFromConfig', () => {
  it('each tier is hourlyRate × includedHours when nothing is overridden', () => {
    const p = buildPricingFromConfig(base);
    expect(p.day.basePrice).toBe(DAY_KR);
    expect(p.weekend.basePrice).toBe(
      DEFAULT_CONFIG.weekendHourly * DEFAULT_CONFIG.weekendIncludedHours,
    );
    expect(p.week.basePrice).toBe(DEFAULT_CONFIG.weeklyHourly * DEFAULT_CONFIG.weekIncludedHours);
  });

  it('a machine that overrides only dayPrice keeps the global included hours', () => {
    // mergeEquipmentConfig writes `dayPrice` and leaves `dayIncludedHours`
    // alone when the machine column is NULL.
    const p = buildPricingFromConfig(cfg({ dayPrice: 4000 }));
    expect(p.day.basePrice).toBe(4000);
    expect(p.day.includedHours).toBe(DEFAULT_CONFIG.dayIncludedHours);
    expect(p.day.description).toContain(String(DEFAULT_CONFIG.dayIncludedHours));
  });

  it('an override of 0 is honoured as free, not treated as missing', () => {
    expect(buildPricingFromConfig(cfg({ dayPrice: 0 })).day.basePrice).toBe(0);
  });

  it('the custom tier carries no price of its own', () => {
    const p = buildPricingFromConfig(base);
    expect(p.custom.basePrice).toBe(0);
    expect(p.custom.includedHours).toBe(0);
  });
});

describe('calculateCustomPrice — weekday/weekend split', () => {
  it('charges the weekend rate for Saturday and Sunday only', () => {
    // 2026-05-01 is a Friday: Fri Sat Sun Mon.
    const b = calculateCustomPrice('2026-05-01', 4, base);
    expect(b.days.map((d) => d.label)).toEqual(['Fre', 'Lør', 'Søn', 'Man']);
    expect(b.days.map((d) => d.isWeekend)).toEqual([false, true, true, false]);
    expect(b.weekdayDays).toBe(2);
    expect(b.weekendDays).toBe(2);
    expect(b.totalPrice).toBe(2 * DAY_KR + 2 * WKND_KR);
  });

  it('a rental that starts on Saturday still bills the two weekend days once', () => {
    const b = calculateCustomPrice('2026-05-02', 2, base);
    expect(b.weekendDays).toBe(2);
    expect(b.totalPrice).toBe(2 * WKND_KR);
  });

  it('totalHours is days × dayIncludedHours regardless of weekday mix', () => {
    expect(calculateCustomPrice('2026-05-01', 4, base).totalHours).toBe(
      4 * DEFAULT_CONFIG.dayIncludedHours,
    );
  });

  it('0 days yields an empty, free breakdown', () => {
    const b = calculateCustomPrice('2026-05-01', 0, base);
    expect(b.days).toEqual([]);
    expect(b.totalPrice).toBe(0);
    expect(b.totalHours).toBe(0);
  });

  it('90 days — the documented upper bound — enumerates 90 rows', () => {
    const b = calculateCustomPrice('2026-05-01', 90, base);
    expect(b.days).toHaveLength(90);
    expect(b.weekdayDays + b.weekendDays).toBe(90);
    expect(b.totalPrice).toBe(b.weekdayDays * DAY_KR + b.weekendDays * WKND_KR);
  });
});

// TZ is pinned to Europe/Oslo in tests/setup.ts. The loop walks the calendar
// with `setDate`, which preserves the local wall-clock hour, so a 23- or
// 25-hour day must not shift a date or drop/duplicate a weekend day.
describe('calculateCustomPrice — DST boundaries (Europe/Oslo)', () => {
  it('spring forward 2026-03-29 (23 h day) keeps every date and label', () => {
    const b = calculateCustomPrice('2026-03-27', 4, base);
    expect(b.days.map((d) => d.date)).toEqual([
      '2026-03-27',
      '2026-03-28',
      '2026-03-29',
      '2026-03-30',
    ]);
    expect(b.days.map((d) => d.label)).toEqual(['Fre', 'Lør', 'Søn', 'Man']);
    expect(b.weekendDays).toBe(2);
    expect(b.totalPrice).toBe(2 * DAY_KR + 2 * WKND_KR);
  });

  it('autumn back 2026-10-25 (25 h day) keeps every date and label', () => {
    const b = calculateCustomPrice('2026-10-23', 4, base);
    expect(b.days.map((d) => d.date)).toEqual([
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
    ]);
    expect(b.days.map((d) => d.label)).toEqual(['Fre', 'Lør', 'Søn', 'Man']);
    expect(b.weekendDays).toBe(2);
    expect(b.totalPrice).toBe(2 * DAY_KR + 2 * WKND_KR);
  });

  it('a 14-day span across the spring transition bills exactly 4 weekend days', () => {
    const b = calculateCustomPrice('2026-03-23', 14, base);
    expect(b.weekendDays).toBe(4);
    expect(b.weekdayDays).toBe(10);
    expect(b.days.at(-1)!.date).toBe('2026-04-05');
  });

  it('a 14-day span across the autumn transition bills exactly 4 weekend days', () => {
    const b = calculateCustomPrice('2026-10-19', 14, base);
    expect(b.weekendDays).toBe(4);
    expect(b.weekdayDays).toBe(10);
    expect(b.days.at(-1)!.date).toBe('2026-11-01');
  });
});

describe('rentalDayCount + computeBookingPrices for the week tier', () => {
  it('customDays 14 / 21 / 56 are honoured as 2 / 3 / 8 weeks', () => {
    for (const [days, weeks] of [
      [14, 2],
      [21, 3],
      [56, 8],
    ] as const) {
      expect(rentalDayCount('week', days)).toBe(days);
      const c = computeBookingPrices(
        { rentalType: 'week', startDate: '2026-05-04', customDays: days, deliveryFee: 0 },
        base,
      );
      expect(c.basePrice).toBe(weeks * DEFAULT_CONFIG.weeklyHourly * DEFAULT_CONFIG.weekIncludedHours);
      expect(c.includedHours).toBe(weeks * DEFAULT_CONFIG.weekIncludedHours);
    }
  });

  it('a non-multiple of 7 (customDays 10) falls back to ONE week — price and span agree', () => {
    // Documented behaviour: rentalDayCount clamps the span to 7 days and
    // computeBookingPrices charges 1 week, so the customer is not billed for
    // days the locks do not reserve. The echoed `customDays` still says 10,
    // which is the only place the two disagree (see docs/audit, flag F-A5).
    expect(rentalDayCount('week', 10)).toBe(7);
    const ten = computeBookingPrices(
      { rentalType: 'week', startDate: '2026-05-04', customDays: 10, deliveryFee: 0 },
      base,
    );
    const one = computeBookingPrices(
      { rentalType: 'week', startDate: '2026-05-04', deliveryFee: 0 },
      base,
    );
    expect(ten.basePrice).toBe(one.basePrice);
    expect(ten.includedHours).toBe(one.includedHours);
  });

  it('customDays 0 and negative values fall back to one week', () => {
    expect(rentalDayCount('week', 0)).toBe(7);
    expect(rentalDayCount('week', -14)).toBe(7);
    expect(
      computeBookingPrices(
        { rentalType: 'week', startDate: '2026-05-04', customDays: -14, deliveryFee: 0 },
        base,
      ).basePrice,
    ).toBe(DEFAULT_CONFIG.weeklyHourly * DEFAULT_CONFIG.weekIncludedHours);
  });
});

describe('computeBookingPrices — extra hours and delivery', () => {
  it('extraHours 0 costs nothing and leaves totalHours at the included hours', () => {
    const c = computeBookingPrices(
      { rentalType: 'day', startDate: '2026-05-04', deliveryFee: 0, extraHours: 0 },
      base,
    );
    expect(c.extraHoursCost).toBe(0);
    expect(c.totalHours).toBe(DEFAULT_CONFIG.dayIncludedHours);
  });

  it('extraHours are billed at preOrderHourRate, not overtimeRate', () => {
    const c = computeBookingPrices(
      { rentalType: 'day', startDate: '2026-05-04', deliveryFee: 0, extraHours: 6 },
      base,
    );
    expect(c.extraHoursCost).toBe(6 * DEFAULT_CONFIG.preOrderHourRate);
    expect(c.extraHoursCost).not.toBe(6 * DEFAULT_CONFIG.overtimeRate);
  });

  it('720 extra hours — the /api/quote ceiling — is priced, not clamped, here', () => {
    const c = computeBookingPrices(
      { rentalType: 'day', startDate: '2026-05-04', deliveryFee: 0, extraHours: 720 },
      base,
    );
    expect(c.extraHours).toBe(720);
    expect(c.extraHoursCost).toBe(720 * DEFAULT_CONFIG.preOrderHourRate);
    expect(c.totalHours).toBe(DEFAULT_CONFIG.dayIncludedHours + 720);
  });

  it('negative extraHours clamp to 0', () => {
    const c = computeBookingPrices(
      { rentalType: 'day', startDate: '2026-05-04', deliveryFee: 0, extraHours: -5 },
      base,
    );
    expect(c.extraHours).toBe(0);
    expect(c.extraHoursCost).toBe(0);
  });

  it('the delivery fee is rounded and added verbatim — no re-derivation', () => {
    const c = computeBookingPrices(
      { rentalType: 'day', startDate: '2026-05-04', deliveryFee: 749.6 },
      base,
    );
    expect(c.deliveryFee).toBe(750);
    expect(c.totalPrice).toBe(c.basePrice + c.extraHoursCost + 750);
  });

  it('a NaN delivery fee is treated as 0 rather than poisoning the total (FIXED A-2)', () => {
    const c = computeBookingPrices(
      { rentalType: 'day', startDate: '2026-05-04', deliveryFee: Number.NaN },
      base,
    );
    expect(c.deliveryFee).toBe(0);
    expect(c.totalPrice).toBe(c.basePrice + c.extraHoursCost);
  });
});

describe('mergeEquipmentConfig (via computeBookingPrices)', () => {
  it('a machine with only dayPrice set overrides the price and keeps global hours', () => {
    const c = computeBookingPrices(
      { rentalType: 'day', startDate: '2026-05-04', deliveryFee: 0, extraHours: 2 },
      base,
      {
        dayPrice: 4000,
        weekendPrice: null,
        weekPrice: null,
        dayIncludedHours: null,
        weekendIncludedHours: null,
        weekIncludedHours: null,
        overtimeRate: null,
        preOrderHourRate: null,
      },
    );
    expect(c.basePrice).toBe(4000);
    expect(c.includedHours).toBe(DEFAULT_CONFIG.dayIncludedHours);
    expect(c.extraHoursCost).toBe(2 * DEFAULT_CONFIG.preOrderHourRate);
  });

  it('a null override leaves the global value untouched', () => {
    const c = computeBookingPrices(
      { rentalType: 'day', startDate: '2026-05-04', deliveryFee: 0 },
      base,
      { dayPrice: null, preOrderHourRate: null },
    );
    expect(c.basePrice).toBe(DAY_KR);
  });

  it('a machine-level preOrderHourRate reprices extra hours', () => {
    const c = computeBookingPrices(
      { rentalType: 'day', startDate: '2026-05-04', deliveryFee: 0, extraHours: 3 },
      base,
      { preOrderHourRate: 500 },
    );
    expect(c.extraHoursCost).toBe(1500);
  });

  it('a machine-level weekIncludedHours scales with the week multiplier', () => {
    const c = computeBookingPrices(
      { rentalType: 'week', startDate: '2026-05-04', customDays: 14, deliveryFee: 0 },
      base,
      { weekIncludedHours: 40 },
    );
    expect(c.includedHours).toBe(80);
    // weekPrice is still computed from weeklyHourly × the (overridden) hours.
    expect(c.basePrice).toBe(2 * DEFAULT_CONFIG.weeklyHourly * 40);
  });

  // FIXED A-3: calculateCustomPrice now reads the merged dayPrice/weekendPrice
  // keys, so a machine with an explicit per-day price is billed at that price
  // for `custom` rentals too — not at the global hourly rate.
  it('a machine dayPrice override must apply to custom rentals too', () => {
    const c = computeBookingPrices(
      { rentalType: 'custom', startDate: '2026-05-04', customDays: 2, deliveryFee: 0 },
      base,
      { dayPrice: 4000 },
    );
    expect(c.basePrice).toBe(8000);
  });

  it('…and falls back to the global hourly rate when the machine sets no price', () => {
    const c = computeBookingPrices(
      { rentalType: 'custom', startDate: '2026-05-04', customDays: 2, deliveryFee: 0 },
      base,
      { dayIncludedHours: null, dayPrice: null },
    );
    expect(c.basePrice).toBe(2 * DAY_KR);
  });

  it('scales a weekendPrice override back to one custom day', () => {
    // `weekendPrice` buys `weekendIncludedHours` (the whole Fri–Man package);
    // a custom rental bills every day at `dayIncludedHours`, so a Saturday
    // costs that fraction of the package, not a package per day.
    // 2026-05-09 is a Saturday, 2026-05-10 a Sunday.
    const perDay = Math.round(
      6000 * (DEFAULT_CONFIG.dayIncludedHours / DEFAULT_CONFIG.weekendIncludedHours),
    );
    const c = computeBookingPrices(
      { rentalType: 'custom', startDate: '2026-05-09', customDays: 2, deliveryFee: 0 },
      base,
      { weekendPrice: 6000 },
    );
    expect(c.basePrice).toBe(2 * perDay);
  });

  it('a machine dayIncludedHours override DOES change custom pricing', () => {
    const c = computeBookingPrices(
      { rentalType: 'custom', startDate: '2026-05-04', customDays: 2, deliveryFee: 0 },
      base,
      { dayIncludedHours: 5 },
    );
    expect(c.includedHours).toBe(10);
    expect(c.basePrice).toBe(2 * DEFAULT_CONFIG.weekdayHourly * 5);
  });
});
