import { describe, it, expect } from 'vitest';
import { computeBookingPrices, validateBookingInput, type CreateBookingInput } from '@/lib/booking-service';
import { DEFAULT_CONFIG } from '@/lib/pricing';

const baseConfig = { ...DEFAULT_CONFIG };

function makeInput(over: Partial<CreateBookingInput> = {}): CreateBookingInput {
  return {
    name: 'Test Testesen',
    phone: '40123456',
    email: 'test@example.no',
    deliveryAddress: 'Storgata 1, 8000 Bodø',
    rentalType: 'day',
    startDate: '2099-06-01',
    deliveryDistance: 10,
    deliveryFee: 0,
    termsAccepted: true,
    expectedTotalKr: 0,
    ...over,
  };
}

describe('computeBookingPrices', () => {
  it('day rental: basePrice + extraHoursCost + deliveryFee = totalPrice', () => {
    const computed = computeBookingPrices(
      { rentalType: 'day', startDate: '2026-06-01', deliveryFee: 500, extraHours: 2 },
      baseConfig,
    );
    expect(computed.basePrice).toBe(baseConfig.weekdayHourly * baseConfig.dayIncludedHours);
    expect(computed.extraHoursCost).toBe(2 * baseConfig.preOrderHourRate);
    expect(computed.deliveryFee).toBe(500);
    expect(computed.totalPrice).toBe(computed.basePrice + computed.extraHoursCost + 500);
    expect(computed.totalHours).toBe(baseConfig.dayIncludedHours + 2);
  });
  it('custom rental respects calculateCustomPrice', () => {
    const computed = computeBookingPrices(
      { rentalType: 'custom', startDate: '2026-06-01', customDays: 3, deliveryFee: 0 },
      baseConfig,
    );
    expect(computed.totalHours).toBe(3 * baseConfig.dayIncludedHours);
  });
  it('equipment override flows through merge', () => {
    const computed = computeBookingPrices(
      { rentalType: 'day', startDate: '2026-06-01', deliveryFee: 0 },
      baseConfig,
      { dayPrice: 9999 },
    );
    expect(computed.basePrice).toBe(9999);
  });
  it('extraHours defaults to 0', () => {
    const computed = computeBookingPrices(
      { rentalType: 'day', startDate: '2026-06-01', deliveryFee: 0 },
      baseConfig,
    );
    expect(computed.extraHours).toBe(0);
    expect(computed.extraHoursCost).toBe(0);
  });
});

describe('validateBookingInput', () => {
  const computed = {
    basePrice: 1000, deliveryFee: 0, totalPrice: 1000,
    extraHours: 0, extraHoursCost: 0, includedHours: 10, totalHours: 10,
  };

  it('passes a valid day rental on a Monday', () => {
    // Pick a Monday >> today
    expect(validateBookingInput(makeInput({ startDate: '2099-06-01' }), baseConfig, computed)).toBeNull();
  });
  it('rejects when terms not accepted', () => {
    expect(validateBookingInput(makeInput({ termsAccepted: false }), baseConfig, computed))
      .toMatch(/godta vilkårene/);
  });
  it('rejects past startDate', () => {
    expect(validateBookingInput(makeInput({ startDate: '2020-01-01' }), baseConfig, computed))
      .toMatch(/fortiden/);
  });
  it('rejects malformed startDate', () => {
    expect(validateBookingInput(makeInput({ startDate: 'tomorrow' }), baseConfig, computed))
      .toMatch(/Ugyldig startdato/);
  });
  it('rejects long names', () => {
    expect(validateBookingInput(makeInput({ name: 'a'.repeat(201) }), baseConfig, computed))
      .toMatch(/Navn er for langt/);
  });
  it('rejects malformed email', () => {
    expect(validateBookingInput(makeInput({ email: 'not-an-email' }), baseConfig, computed))
      .toMatch(/Ugyldig e-postadresse/);
  });
  it('rejects too-short phone', () => {
    expect(validateBookingInput(makeInput({ phone: '12' }), baseConfig, computed))
      .toMatch(/Ugyldig telefonnummer/);
  });
  it('rejects unknown rentalType', () => {
    // @ts-expect-error - intentionally bad type
    expect(validateBookingInput(makeInput({ rentalType: 'forever' }), baseConfig, computed))
      .toMatch(/Ugyldig leietype/);
  });
  it('rejects custom rentals outside 2-90 day range', () => {
    expect(validateBookingInput(makeInput({ rentalType: 'custom', customDays: 1, startDate: '2099-06-01' }), baseConfig, computed))
      .toMatch(/mellom 2 og 90/);
    expect(validateBookingInput(makeInput({ rentalType: 'custom', customDays: 100, startDate: '2099-06-01' }), baseConfig, computed))
      .toMatch(/mellom 2 og 90/);
  });
  it('selfPickup rejects non-zero deliveryFee', () => {
    expect(validateBookingInput(
      makeInput({ selfPickup: true, deliveryAddress: '' }),
      baseConfig,
      { ...computed, deliveryFee: 500 },
    )).toMatch(/Selvhenting/);
  });
  it('rejects when address missing and not selfPickup', () => {
    expect(validateBookingInput(makeInput({ deliveryAddress: '' }), baseConfig, computed))
      .toMatch(/Leveringsadresse/);
  });
  it('rejects delivery fee far above expected (tight tolerance)', () => {
    // chargeableKm = 50-5 = 45, expected = 45 * 25 = 1125. Submit 1300 → off by 175 → reject.
    const conf = { ...baseConfig, deliveryPerKm: 25, minDeliveryFee: 0, deliveryIncludedKm: 5, maxDeliveryRadius: 150 };
    expect(validateBookingInput(
      makeInput({ deliveryDistance: 50, deliveryFee: 1300 }),
      conf,
      { ...computed, deliveryFee: 1300 },
    )).toMatch(/Leveringspris stemmer ikke/);
  });
  it('accepts delivery fee within ±1 kr of expected', () => {
    const conf = { ...baseConfig, deliveryPerKm: 25, minDeliveryFee: 0, deliveryIncludedKm: 5, maxDeliveryRadius: 150 };
    // chargeableKm = 50-5 = 45, expected = 1125. Submit 1125 → exact match → pass.
    expect(validateBookingInput(
      makeInput({ deliveryDistance: 50, deliveryFee: 1125 }),
      conf,
      { ...computed, deliveryFee: 1125 },
    )).toBeNull();
  });
  it('accepts delivery fee when distance is within included km (fee=0)', () => {
    const conf = { ...baseConfig, deliveryPerKm: 25, minDeliveryFee: 0, deliveryIncludedKm: 30, maxDeliveryRadius: 150 };
    expect(validateBookingInput(
      makeInput({ deliveryDistance: 10, deliveryFee: 0 }),
      conf,
      { ...computed, deliveryFee: 0 },
    )).toBeNull();
  });
});
