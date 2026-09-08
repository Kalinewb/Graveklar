import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildQuote, priceDriftKr, type QuoteInputs } from '@/lib/domain/quote';
import {
  computeBookingPrices,
  validateBookingInput,
  type CreateBookingInput,
} from '@/lib/booking-service';
import { loadAppConfig } from '@/lib/app-config';
import { loadConfigValues } from '@/lib/config-server';
import { DEFAULT_CONFIG } from '@/lib/pricing';

import {
  campaignCode,
  db,
  ensureSchema,
  invalidateCaches,
  machine,
  resetDb,
  seedConfigDefaults,
} from '../helpers/db';
import { ALL_RENTAL_TYPES, FRI, MON, SAT, THU, daysFromNow, futureDow } from '../helpers/pricing';

// buildQuote is the single commercial document: every kroner the customer
// sees, the Stripe unit_amount, and the drift guard all come from here. These
// tests drive it against the scratch database with the shipped PricingConfig
// defaults (weekdayHourly 249 × dayIncludedHours 10 = 2490 kr/day).

const DAY_KR = DEFAULT_CONFIG.weekdayHourly * DEFAULT_CONFIG.dayIncludedHours; // 2490
const WKND_DAY_KR = DEFAULT_CONFIG.weekendHourly * DEFAULT_CONFIG.dayIncludedHours; // 3290
const WEEK_KR = DEFAULT_CONFIG.weeklyHourly * DEFAULT_CONFIG.weekIncludedHours; // 11984
const WEEKEND_KR = DEFAULT_CONFIG.weekendHourly * DEFAULT_CONFIG.weekendIncludedHours; // 6580

/** Overwrite PricingConfig rows (seedConfigDefaults' overrides hit AppConfig). */
async function setPricing(values: Record<string, number>): Promise<void> {
  for (const [key, value] of Object.entries(values)) {
    await db.pricingConfig.update({ where: { key }, data: { value } });
  }
  invalidateCaches();
}

/** Overwrite AppConfig rows after the beforeEach seed. */
async function setApp(values: Record<string, string>): Promise<void> {
  for (const [key, value] of Object.entries(values)) {
    await db.appConfig.update({ where: { key }, data: { value } });
  }
  invalidateCaches();
}

/** A quote for a self-pickup day rental on a bookable weekday. */
function inputs(over: Partial<QuoteInputs> = {}): QuoteInputs {
  return {
    rentalType: 'day',
    startDate: futureDow(MON, 21),
    selfPickup: true,
    deliveryFee: 0,
    deliveryDistance: 0,
    ...over,
  };
}

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDb();
  await seedConfigDefaults();
});

describe('buildQuote — arithmetic contract', () => {
  it('subtotal = basePrice + extraHoursCost + deliveryFee, and echoes its inputs', () => {
    return (async () => {
      const q = await buildQuote(inputs({ selfPickup: false, deliveryFee: 750, deliveryDistance: 40, extraHours: 3 }));
      expect(q.basePrice).toBe(DAY_KR);
      expect(q.extraHoursCost).toBe(3 * DEFAULT_CONFIG.preOrderHourRate);
      expect(q.deliveryFee).toBe(750);
      expect(q.subtotal).toBe(q.basePrice + q.extraHoursCost + q.deliveryFee);
      expect(q.inputs.rentalType).toBe('day');
      expect(new Date(q.generatedAt).toString()).not.toBe('Invalid Date');
    })();
  });

  it('with no discount, totalPrice === subtotal under the incl-MVA default', async () => {
    const q = await buildQuote(inputs());
    expect(q.discountKr).toBe(0);
    expect(q.discountLines).toEqual([]);
    expect(q.discountLabel).toBeNull();
    expect(q.totalPrice).toBe(q.subtotal);
    expect(q.totalPrice).toBe(DAY_KR);
  });

  it('the MVA breakdown always reconciles: exMva + mvaAmt === totalPrice', async () => {
    const q = await buildQuote(inputs({ selfPickup: false, deliveryFee: 137, deliveryDistance: 40 }));
    expect(q.mvaBreakdown.exMva + q.mvaBreakdown.mvaAmt).toBe(q.totalPrice);
    expect(q.mvaBreakdown.mvaRate).toBe(25);
    expect(q.mvaBreakdown.inclMva).toBe(true);
  });

  it('extraHours 0 is the no-op case', async () => {
    const q = await buildQuote(inputs({ extraHours: 0 }));
    expect(q.extraHours).toBe(0);
    expect(q.extraHoursCost).toBe(0);
    expect(q.totalHours).toBe(DEFAULT_CONFIG.dayIncludedHours);
  });

  it('extraHours 720 (the /api/quote ceiling) is priced in full', async () => {
    const q = await buildQuote(inputs({ extraHours: 720 }));
    expect(q.extraHoursCost).toBe(720 * DEFAULT_CONFIG.preOrderHourRate);
    expect(q.totalHours).toBe(DEFAULT_CONFIG.dayIncludedHours + 720);
    expect(q.totalPrice).toBe(DAY_KR + 720 * DEFAULT_CONFIG.preOrderHourRate);
  });
});

describe('buildQuote — rental types and spans', () => {
  it('weekend and week tiers use their own hourly rate', async () => {
    const weekend = await buildQuote(inputs({ rentalType: 'weekend', startDate: futureDow(FRI, 21) }));
    expect(weekend.basePrice).toBe(WEEKEND_KR);
    expect(weekend.includedHours).toBe(DEFAULT_CONFIG.weekendIncludedHours);

    const week = await buildQuote(inputs({ rentalType: 'week', startDate: futureDow(MON, 21) }));
    expect(week.basePrice).toBe(WEEK_KR);
    expect(week.includedHours).toBe(DEFAULT_CONFIG.weekIncludedHours);
  });

  it('week customDays 14 / 21 / 56 scale price and hours by whole weeks', async () => {
    for (const [days, weeks] of [
      [14, 2],
      [21, 3],
      [56, 8],
    ] as const) {
      const q = await buildQuote(inputs({ rentalType: 'week', startDate: futureDow(MON, 21), customDays: days }));
      expect(q.basePrice).toBe(weeks * WEEK_KR);
      expect(q.includedHours).toBe(weeks * DEFAULT_CONFIG.weekIncludedHours);
      expect(q.bookable).toBe(true);
    }
  });

  it('week customDays 10 (not a multiple of 7) prices as ONE week and stays bookable', async () => {
    // Documented behaviour: rentalDayCount clamps the reserved span to 7 days
    // and computeBookingPrices charges one week, so price and locks agree.
    // Only the echoed `inputs.customDays` still says 10 — flag F-A5.
    const q = await buildQuote(inputs({ rentalType: 'week', startDate: futureDow(MON, 21), customDays: 10 }));
    expect(q.basePrice).toBe(WEEK_KR);
    expect(q.includedHours).toBe(DEFAULT_CONFIG.weekIncludedHours);
    expect(q.inputs.customDays).toBe(10);
    expect(q.bookable).toBe(true);
  });

  it('custom spanning Sat+Sun bills the weekend rate for exactly those days', async () => {
    await setApp({ enabledRentalTypes: ALL_RENTAL_TYPES });
    const q = await buildQuote(inputs({ rentalType: 'custom', startDate: futureDow(FRI, 21), customDays: 4 }));
    expect(q.basePrice).toBe(2 * DAY_KR + 2 * WKND_DAY_KR);
    expect(q.includedHours).toBe(4 * DEFAULT_CONFIG.dayIncludedHours);
    expect(q.bookable).toBe(true);
  });

  it('custom over the 2026-03-28/29 spring-forward weekend prices 4 days correctly', async () => {
    await setApp({ enabledRentalTypes: ALL_RENTAL_TYPES });
    const q = await buildQuote(inputs({ rentalType: 'custom', startDate: '2026-03-27', customDays: 4 }));
    expect(q.basePrice).toBe(2 * DAY_KR + 2 * WKND_DAY_KR);
    expect(q.includedHours).toBe(4 * DEFAULT_CONFIG.dayIncludedHours);
  });

  it('custom over the 2026-10-24/25 autumn-back weekend prices 4 days correctly', async () => {
    await setApp({ enabledRentalTypes: ALL_RENTAL_TYPES });
    const q = await buildQuote(inputs({ rentalType: 'custom', startDate: '2026-10-23', customDays: 4 }));
    expect(q.basePrice).toBe(2 * DAY_KR + 2 * WKND_DAY_KR);
  });
});

describe('buildQuote — bookability gate', () => {
  it('custom 2 and 90 days are accepted', async () => {
    await setApp({ enabledRentalTypes: ALL_RENTAL_TYPES });
    for (const days of [2, 90]) {
      const q = await buildQuote(inputs({ rentalType: 'custom', startDate: futureDow(MON, 21), customDays: days }));
      expect(q.bookable).toBe(true);
      expect(q.blockedReason).toBeNull();
      expect(q.warnings).toEqual([]);
    }
  });

  it('custom 1 and 91 days are rejected — but still priced', async () => {
    await setApp({ enabledRentalTypes: ALL_RENTAL_TYPES });
    for (const days of [1, 91]) {
      const q = await buildQuote(inputs({ rentalType: 'custom', startDate: futureDow(MON, 21), customDays: days }));
      expect(q.bookable).toBe(false);
      expect(q.blockedReason).toBe('Tilpasset leieperiode må være mellom 2 og 90 dager.');
      expect(q.warnings).toContainEqual({ code: 'not-bookable', message: q.blockedReason });
      expect(q.totalPrice).toBeGreaterThan(0);
    }
  });

  it('custom is NOT bookable under the shipped enabledRentalTypes default', async () => {
    // APP_CONFIG_DEFAULTS ships 'day,weekend,week' — a custom quote is priced
    // but can never be bought until an admin switches the tier on.
    const q = await buildQuote(inputs({ rentalType: 'custom', startDate: futureDow(MON, 21), customDays: 5 }));
    expect(q.bookable).toBe(false);
    expect(q.blockedReason).toBe('Denne leietypen er ikke tilgjengelig for booking.');
    expect(q.basePrice).toBeGreaterThan(0);
  });

  it('a day rental on Friday/Saturday is refused by dayAllowedDays', async () => {
    const q = await buildQuote(inputs({ startDate: futureDow(SAT, 21) }));
    expect(q.blockedReason).toBe('Denne datoen er ikke tilgjengelig for dagsleie.');
  });

  it('a day rental Mon–Thu is accepted', async () => {
    for (const dow of [MON, THU]) {
      const q = await buildQuote(inputs({ startDate: futureDow(dow, 21) }));
      expect(q.bookable).toBe(true);
    }
  });

  it('weekend must start on Friday and week on Monday', async () => {
    const weekendOnMon = await buildQuote(inputs({ rentalType: 'weekend', startDate: futureDow(MON, 21) }));
    expect(weekendOnMon.blockedReason).toBe('Helgleie må starte på riktig dag.');

    const weekOnFri = await buildQuote(inputs({ rentalType: 'week', startDate: futureDow(FRI, 21) }));
    expect(weekOnFri.blockedReason).toBe('Ukeleie må starte på riktig dag.');
  });

  it('a start date in the past is refused', async () => {
    const q = await buildQuote(inputs({ startDate: daysFromNow(-1) }));
    expect(q.bookable).toBe(false);
    expect(q.blockedReason).toBe('Startdato kan ikke være i fortiden.');
  });

  it('beyond bookingMaxAdvanceDays is refused', async () => {
    await setApp({ bookingMaxAdvanceDays: '30' });
    const q = await buildQuote(inputs({ startDate: futureDow(MON, 60) }));
    expect(q.blockedReason).toBe('Du kan ikke booke mer enn 30 dager i forveien.');
  });

  it('inside minBookingDaysAhead is refused', async () => {
    await setApp({ minBookingDaysAhead: '30' });
    const q = await buildQuote(inputs({ startDate: futureDow(MON, 7) }));
    expect(q.blockedReason).toBe('Booking må gjøres minst 30 dager i forveien.');
  });

  it('beyond maxDeliveryRadius is refused for a delivered rental', async () => {
    const q = await buildQuote(inputs({ selfPickup: false, deliveryDistance: 151, deliveryFee: 3025 }));
    expect(q.blockedReason).toBe('Adressen er utenfor leveringsområdet.');
    expect(q.deliveryFee).toBe(3025); // still priced
  });

  it('exactly maxDeliveryRadius km is inside the area', async () => {
    const q = await buildQuote(inputs({ selfPickup: false, deliveryDistance: 150, deliveryFee: 3000 }));
    expect(q.bookable).toBe(true);
  });

  // FIXED A-4: buildQuote zeroed the delivery fee for selfPickup BEFORE
  // handing it to checkBookable, so the "Selvhenting skal ikke ha
  // leveringsgebyr" branch could never fire. /api/bookings does not zero it
  // and validateBookingInput refuses the same input, so the customer was
  // shown a bookable quote that the submit endpoint rejects.
  it('a self-pickup quote carrying a delivery fee must not claim to be bookable', async () => {
    // FIXED A-4: checkBookable is handed the fee as the caller supplied it.
    const q = await buildQuote(inputs({ selfPickup: true, deliveryFee: 900 }));
    expect(q.bookable).toBe(false);
  });

  it('…and /api/bookings refuses that same input, with the same reason (A-4)', async () => {
    const config = await loadConfigValues();
    const appConfig = await loadAppConfig();
    const input: CreateBookingInput = {
      name: 'Test Testesen',
      phone: '40123456',
      email: 'test@example.com',
      deliveryAddress: '',
      rentalType: 'day',
      startDate: futureDow(MON, 21),
      deliveryDistance: 0,
      deliveryFee: 900,
      selfPickup: true,
      termsAccepted: true,
      expectedTotalKr: 0,
    };
    const computed = computeBookingPrices(input, config);
    expect(validateBookingInput(input, config, computed, appConfig)).toBe(
      'Selvhenting skal ikke ha leveringsgebyr.',
    );

    const q = await buildQuote(inputs({ selfPickup: true, deliveryFee: 900 }));
    expect(q.bookable).toBe(false);
    expect(q.blockedReason).toBe('Selvhenting skal ikke ha leveringsgebyr.');
    // The fee itself is still zeroed for the priced figures.
    expect(q.deliveryFee).toBe(0);
  });

  // FIXED A-5: `custom` was bounded to 2…90 days but `week` had no ceiling on
  // customDays, so a 700-day (100-week) rental quoted and reported bookable.
  it('a week rental must not be quotable beyond the 8-week form ceiling', async () => {
    // FIXED A-5: checkRentalLength caps `week` at MAX_WEEK_RENTAL_WEEKS × 7.
    const q = await buildQuote(inputs({ rentalType: 'week', startDate: futureDow(MON, 21), customDays: 700 }));
    expect(q.bookable).toBe(false);
  });

  it('…and a 700-day week rental is still PRICED, just not bookable (A-5)', async () => {
    const q = await buildQuote(inputs({ rentalType: 'week', startDate: futureDow(MON, 21), customDays: 700 }));
    expect(q.basePrice).toBe(100 * WEEK_KR);
    expect(q.bookable).toBe(false);
    expect(q.blockedReason).toBe('Ukeleie kan ikke være lengre enn 8 uker.');
  });

  it('exactly 8 weeks is still bookable — the ceiling is inclusive', async () => {
    const q = await buildQuote(inputs({ rentalType: 'week', startDate: futureDow(MON, 21), customDays: 56 }));
    expect(q.bookable).toBe(true);
  });
});

describe('buildQuote — equipment resolution', () => {
  it('a machine that overrides only dayPrice keeps the global included hours', async () => {
    const m = await machine({ dayPrice: 4000 });
    const q = await buildQuote(inputs({ machineId: m.id }));
    expect(q.basePrice).toBe(4000);
    expect(q.includedHours).toBe(DEFAULT_CONFIG.dayIncludedHours);
    expect(q.bookable).toBe(true);
  });

  it('an unknown machineId is still priced at global rates but is not bookable', async () => {
    const q = await buildQuote(inputs({ machineId: 'does-not-exist' }));
    expect(q.basePrice).toBe(DAY_KR);
    expect(q.totalPrice).toBe(DAY_KR);
    expect(q.bookable).toBe(false);
    expect(q.blockedReason).toBe('Valgt utstyr er ikke tilgjengelig.');
  });

  it('an inactive machine is treated exactly like an unknown one', async () => {
    const m = await machine({ isActive: false, dayPrice: 9999 });
    const q = await buildQuote(inputs({ machineId: m.id }));
    expect(q.basePrice).toBe(DAY_KR); // the 9999 override is NOT applied
    expect(q.blockedReason).toBe('Valgt utstyr er ikke tilgjengelig.');
  });

  it('no machineId at all resolves to global pricing and stays bookable', async () => {
    await machine({ dayPrice: 4000 });
    const q = await buildQuote(inputs({ machineId: null }));
    // buildQuote does not pick a default machine; /api/bookings does.
    expect(q.basePrice).toBe(DAY_KR);
    expect(q.bookable).toBe(true);
  });
});

describe('buildQuote — MVA modes', () => {
  it('pricesIncludeMva = 1: the stored price IS the charged total', async () => {
    const q = await buildQuote(inputs());
    expect(q.totalPrice).toBe(DAY_KR);
    expect(q.mvaBreakdown).toEqual({
      exMva: 1992,
      mvaAmt: 498,
      mvaRate: 25,
      inclMva: true,
    });
  });

  it('pricesIncludeMva = 0: MVA is added on top of the stored price', async () => {
    await setPricing({ pricesIncludeMva: 0 });
    const q = await buildQuote(inputs());
    expect(q.subtotal).toBe(DAY_KR);
    expect(q.totalPrice).toBe(3113); // 2490 × 1.25 = 3112.5 → 3113
    expect(q.mvaBreakdown).toEqual({
      exMva: 2490,
      mvaAmt: 623,
      mvaRate: 25,
      inclMva: false,
    });
    expect(q.mvaBreakdown.exMva + q.mvaBreakdown.mvaAmt).toBe(q.totalPrice);
  });

  it('a non-default mvaRate flows through to the charged total', async () => {
    await setPricing({ mvaRate: 12, pricesIncludeMva: 0 });
    const q = await buildQuote(inputs());
    expect(q.mvaBreakdown.mvaRate).toBe(12);
    expect(q.totalPrice).toBe(Math.round(DAY_KR * 1.12));
  });

  // FIXED A-1 (quote-level consequence of the mva.ts `rate || 25` fallback).
  it('mvaRate 0 must charge no MVA', async () => {
    // FIXED A-1: src/lib/mva.ts.
    await setPricing({ mvaRate: 0, pricesIncludeMva: 0 });
    const q = await buildQuote(inputs());
    expect(q.totalPrice).toBe(DAY_KR);
  });
});

describe('buildQuote — delivery fee handling', () => {
  it('selfPickup forces the fee to 0 even when one is supplied', async () => {
    const q = await buildQuote(inputs({ selfPickup: true, deliveryFee: 900 }));
    expect(q.deliveryFee).toBe(0);
    expect(q.subtotal).toBe(DAY_KR);
  });

  it('a negative fee clamps to 0', async () => {
    const q = await buildQuote(inputs({ selfPickup: false, deliveryFee: -500, deliveryDistance: 10 }));
    expect(q.deliveryFee).toBe(0);
    expect(q.totalPrice).toBe(DAY_KR);
  });

  it('a fractional fee is rounded to whole kroner', async () => {
    const q = await buildQuote(inputs({ selfPickup: false, deliveryFee: 749.5, deliveryDistance: 40 }));
    expect(q.deliveryFee).toBe(750);
  });

  it('a null/undefined fee is treated as 0', async () => {
    const q = await buildQuote(inputs({ selfPickup: false, deliveryFee: null, deliveryDistance: 10 }));
    expect(q.deliveryFee).toBe(0);
  });

  // FIXED A-2: Math.max(0, Math.round(NaN)) is NaN, so a non-numeric
  // deliveryFee (which /api/quote happily produced via Number("abc"))
  // propagated NaN through subtotal → totalPrice and JSON-serialised to null.
  it('a NaN delivery fee must not poison the quote', async () => {
    // FIXED A-2: src/lib/domain/quote.ts sanitises the fee to 0.
    const q = await buildQuote(inputs({ selfPickup: false, deliveryFee: Number.NaN, deliveryDistance: 10 }));
    expect(Number.isFinite(q.totalPrice)).toBe(true);
  });

  it('…and an unusable fee is treated as 0, not as NaN (A-2)', async () => {
    const q = await buildQuote(inputs({ selfPickup: false, deliveryFee: Number.NaN, deliveryDistance: 10 }));
    expect(q.deliveryFee).toBe(0);
    expect(q.totalPrice).toBe(DAY_KR);
    expect(JSON.parse(JSON.stringify(q)).totalPrice).toBe(DAY_KR);
  });
});

describe('buildQuote — discounts', () => {
  const email = 'ny.kunde@example.com';

  it('a first-time customer gets one discount line that matches discountKr', async () => {
    const q = await buildQuote(inputs({ email }));
    expect(q.discountLines).toEqual([
      { kind: 'first-time', label: 'Førstegangskunde', percent: 10, amountKr: 249, codeId: undefined },
    ]);
    expect(q.discountKr).toBe(249);
    expect(q.discountLabel).toBe('Førstegangskunde (-10%)');
    expect(q.totalPrice).toBe(DAY_KR - 249);
    expect(q.cappedByCeiling).toBe(false);
  });

  it('no identity means no discount at all', async () => {
    const q = await buildQuote(inputs());
    expect(q.discountLines).toEqual([]);
    expect(q.discountKr).toBe(0);
  });

  it('the hard cap scales every line so the displayed percents match the charge', async () => {
    await setApp({ discountHardCap: '15' });
    const code = await campaignCode({ percent: 30 });
    const q = await buildQuote(inputs({ email, code: code.code }));
    expect(q.cappedByCeiling).toBe(true);
    expect(q.discountLines.map((l) => l.percent)).toEqual([3.75, 11.25]); // 10 + 30 scaled to 15
    expect(q.discountLines.reduce((s, l) => s + l.percent, 0)).toBeCloseTo(15, 6);
    expect(q.discountKr).toBe(Math.round((DAY_KR * 15) / 100));
  });

  it('discountHardCap = 0 means uncapped, not "no discounts"', async () => {
    await setApp({ discountHardCap: '0' });
    const code = await campaignCode({ percent: 30 });
    const q = await buildQuote(inputs({ email, code: code.code }));
    expect(q.cappedByCeiling).toBe(false);
    expect(q.discountKr).toBe(Math.round((DAY_KR * 40) / 100));
    expect(q.discountLabel).toBe('Førstegangskunde + Rabattkode (-40%)');
  });

  it('a discount over 100 % clamps the net to 0 rather than going negative', async () => {
    await setApp({ discountHardCap: '0', enableFirstTimeDiscount: 'false' });
    const code = await campaignCode({ percent: 150 });
    const q = await buildQuote(inputs({ email, code: code.code }));
    expect(q.discountKr).toBeGreaterThan(q.subtotal);
    expect(q.totalPrice).toBe(0);
    expect(q.mvaBreakdown.exMva).toBe(0);
    expect(q.mvaBreakdown.mvaAmt).toBe(0);
  });

  it('an invalid code surfaces a warning and leaves the price alone', async () => {
    const q = await buildQuote(inputs({ email, code: 'NOPE-NOPE' }));
    expect(q.warnings).toContainEqual({ code: 'code-invalid', message: 'Ugyldig kode.' });
    expect(q.discountLines.map((l) => l.kind)).toEqual(['first-time']);
  });

  it('an exhausted campaign code surfaces the exhausted warning', async () => {
    const code = await campaignCode({ maxUses: 1, usedCount: 1 });
    const q = await buildQuote(inputs({ email, code: code.code }));
    expect(q.warnings).toContainEqual({ code: 'code-exhausted', message: 'Koden er oppbrukt.' });
  });

  // FIXED A-6: each line was rounded on its own while discountKr is rounded
  // once from the summed percentage, so the lines the customer read could add
  // up to one krone more than the discount actually applied.
  it('the discount lines must sum to discountKr', async () => {
    // FIXED A-6: the last line takes the remainder (src/lib/domain/quote.ts).
    const code = await campaignCode({ percent: 10 });
    // subtotal 2495 → each 10 % line rounds 249.5 up to 250 (sum 500) while
    // discountKr rounds 2495 × 20 % = 499.0 to 499.
    const q = await buildQuote(inputs({ selfPickup: false, deliveryFee: 5, deliveryDistance: 10, email, code: code.code }));
    expect(q.subtotal).toBe(2495);
    expect(q.discountLines.reduce((s, l) => s + l.amountKr, 0)).toBe(q.discountKr);
  });

  it('…and the remainder krone lands on the last line (A-6)', async () => {
    const code = await campaignCode({ percent: 10 });
    const q = await buildQuote(inputs({ selfPickup: false, deliveryFee: 5, deliveryDistance: 10, email, code: code.code }));
    expect(q.discountKr).toBe(499);
    expect(q.discountLines.map((l) => l.amountKr)).toEqual([250, 249]);
    expect(q.totalPrice).toBe(2495 - 499);
  });
});

describe('priceDriftKr', () => {
  it('returns 0 when the expected total is exactly the fresh total', async () => {
    const i = inputs();
    const q = await buildQuote(i);
    expect(await priceDriftKr(i, q.totalPrice)).toBe(0);
  });

  it('returns the absolute drift in kroner in both directions', async () => {
    const i = inputs();
    const q = await buildQuote(i);
    expect(await priceDriftKr(i, q.totalPrice - 1)).toBe(1);
    expect(await priceDriftKr(i, q.totalPrice + 1)).toBe(1);
    expect(await priceDriftKr(i, q.totalPrice - 500)).toBe(500);
  });

  it('a 1 kr drift is inside createPendingBooking’s tolerance, 2 kr is not', async () => {
    const i = inputs();
    const q = await buildQuote(i);
    expect(await priceDriftKr(i, q.totalPrice - 1)).toBeLessThanOrEqual(1);
    expect(await priceDriftKr(i, q.totalPrice - 2)).toBeGreaterThan(1);
  });

  it('catches a mid-flow config change: repricing the day tier shows up as drift', async () => {
    const i = inputs();
    const seen = (await buildQuote(i)).totalPrice;
    await setPricing({ weekdayHourly: 299 });
    expect(await priceDriftKr(i, seen)).toBe(299 * 10 - seen);
  });

  it('returns -1 when the quote cannot be built at all', async () => {
    const exploding = {
      rentalType: 'day',
      get startDate(): string {
        throw new Error('boom');
      },
    } as unknown as QuoteInputs;
    expect(await priceDriftKr(exploding, 1000)).toBe(-1);
  });
});
