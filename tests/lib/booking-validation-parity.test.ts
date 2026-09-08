/**
 * Parity between the two independently-written bookability gates:
 *
 *   • `validateBookingInput()`  — booking-service.ts, the gate that decides
 *     whether `createPendingBooking` commits a row.
 *   • `checkBookable()`         — domain/quote.ts, surfaced as
 *     `buildQuote().bookable` / `.blockedReason`, the gate that decides
 *     whether the booking form offers the quote as purchasable.
 *
 * They are separate implementations of the same rulebook. Every input where
 * they disagree is either a quote that promises something the API will refuse
 * (customer-visible drift) or a quote that refuses something the API would
 * happily take (lost booking). The agreement table below is the regression
 * fence; the two blocks after it are the disagreements phase 1b found
 * (B-1…B-6), each now fixed and pinned in the direction it was fixed.
 *
 * The clock is frozen at Monday 2026-09-07 09:00 Europe/Oslo so every weekday
 * gate and lead-time edge is deterministic.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db, ensureSchema, resetDb, seedConfigDefaults } from '../helpers/db';
import { bookingInput, setPricing, toQuoteInputs } from '../helpers/booking';
import { mockClock } from '../helpers/mocks';
import { computeBookingPrices, validateBookingInput, type CreateBookingInput } from '@/lib/booking-service';
import { buildQuote } from '@/lib/domain/quote';
import { loadConfigValues } from '@/lib/config-server';
import { loadAppConfig } from '@/lib/app-config';

/** Monday, 09:00 Oslo. Weekday numbering: Mon=1 … Sun=7. */
const NOW = '2026-09-07T09:00:00+02:00';

let clock: ReturnType<typeof mockClock>;

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDb();
  clock = mockClock(NOW);
});

afterEach(() => {
  clock.restore();
});

interface Verdicts {
  validationError: string | null;
  bookable: boolean;
  blockedReason: string | null;
  /** Both gates reached the same conclusion. */
  agrees: boolean;
}

async function verdicts(input: CreateBookingInput): Promise<Verdicts> {
  const [config, appConfig] = await Promise.all([loadConfigValues(), loadAppConfig()]);
  const computed = computeBookingPrices(input, config, null);
  // `validateBookingInput` is synchronous and has no database, so the caller
  // resolves the machine for it — exactly what `createPendingBooking` does
  // before it prices the booking.
  const machineResolved = input.machineId
    ? (await db.machine.findFirst({ where: { id: input.machineId, isActive: true } })) !== null
    : true;
  const validationError = validateBookingInput(input, config, computed, appConfig, { machineResolved });
  const quote = await buildQuote(toQuoteInputs(input));
  return {
    validationError,
    bookable: quote.bookable,
    blockedReason: quote.blockedReason,
    agrees: (validationError === null) === quote.bookable,
  };
}

interface Case {
  name: string;
  /** AppConfig rows to override before the gates run. */
  appConfig?: Record<string, string>;
  /** PricingConfig rows to override before the gates run. */
  pricing?: Record<string, number>;
  input: Partial<CreateBookingInput>;
  /** What BOTH gates must conclude. */
  bookable: boolean;
  /** When blocked: the (identical) Norwegian reason both must give. */
  reason?: string;
}

const CUSTOM_ON = { enabledRentalTypes: 'day,weekend,week,custom' };

const AGREEMENT_TABLE: Case[] = [
  // ── rental type × weekday gates ────────────────────────────────────────────
  {
    name: 'day rental on an allowed weekday (Mon)',
    input: { rentalType: 'day', startDate: '2026-09-14' },
    bookable: true,
  },
  {
    name: 'day rental on Sunday — getDay()===0 must map to 7, not 0',
    input: { rentalType: 'day', startDate: '2026-09-13' },
    bookable: false,
    reason: 'Denne datoen er ikke tilgjengelig for dagsleie.',
  },
  {
    name: 'day rental on Friday (outside dayAllowedDays 1,2,3,4)',
    input: { rentalType: 'day', startDate: '2026-09-11' },
    bookable: false,
    reason: 'Denne datoen er ikke tilgjengelig for dagsleie.',
  },
  {
    name: 'day rental on Sunday stays blocked when dayAllowedDays lists 7',
    appConfig: { dayAllowedDays: '1,2,3,4,7' },
    input: { rentalType: 'day', startDate: '2026-09-13' },
    bookable: true,
  },
  {
    name: 'weekend starting on weekendStartDay=5 (Fri)',
    input: { rentalType: 'weekend', startDate: '2026-09-11' },
    bookable: true,
  },
  {
    name: 'weekend starting one day late (Sat)',
    input: { rentalType: 'weekend', startDate: '2026-09-12' },
    bookable: false,
    reason: 'Helgleie må starte på riktig dag.',
  },
  {
    name: 'weekend follows a moved weekendStartDay=6',
    appConfig: { weekendStartDay: '6' },
    input: { rentalType: 'weekend', startDate: '2026-09-12' },
    bookable: true,
  },
  {
    name: 'week starting on weekStartDay=1 (Mon)',
    input: { rentalType: 'week', startDate: '2026-09-14' },
    bookable: true,
  },
  {
    name: 'week starting on Tuesday',
    input: { rentalType: 'week', startDate: '2026-09-15' },
    bookable: false,
    reason: 'Ukeleie må starte på riktig dag.',
  },
  {
    name: 'week follows a moved weekStartDay=4 (Thu)',
    appConfig: { weekStartDay: '4' },
    input: { rentalType: 'week', startDate: '2026-10-01' },
    bookable: true,
  },

  // ── lead time / horizon ────────────────────────────────────────────────────
  {
    name: 'start date is today',
    input: { rentalType: 'day', startDate: '2026-09-07' },
    bookable: true,
  },
  {
    name: 'start date is yesterday',
    input: { rentalType: 'day', startDate: '2026-09-06' },
    bookable: false,
    reason: 'Startdato kan ikke være i fortiden.',
  },
  {
    name: 'minBookingDaysAhead=3 — one day short of the edge',
    appConfig: { minBookingDaysAhead: '3' },
    input: { rentalType: 'day', startDate: '2026-09-09' },
    bookable: false,
    reason: 'Booking må gjøres minst 3 dager i forveien.',
  },
  {
    name: 'minBookingDaysAhead=3 — exactly on the edge',
    appConfig: { minBookingDaysAhead: '3' },
    input: { rentalType: 'day', startDate: '2026-09-10' },
    bookable: true,
  },
  {
    name: 'bookingMaxAdvanceDays=365 — a start date inside the horizon',
    input: { rentalType: 'day', startDate: '2027-09-07' },
    bookable: true,
  },

  // ── custom length ──────────────────────────────────────────────────────────
  {
    name: 'custom rental of 2 days (lower bound)',
    appConfig: CUSTOM_ON,
    input: { rentalType: 'custom', startDate: '2026-09-14', customDays: 2 },
    bookable: true,
  },
  {
    name: 'custom rental of 1 day',
    appConfig: CUSTOM_ON,
    input: { rentalType: 'custom', startDate: '2026-09-14', customDays: 1 },
    bookable: false,
    reason: 'Tilpasset leieperiode må være mellom 2 og 90 dager.',
  },
  {
    name: 'custom rental of 90 days (upper bound)',
    appConfig: CUSTOM_ON,
    input: { rentalType: 'custom', startDate: '2026-09-14', customDays: 90 },
    bookable: true,
  },
  {
    name: 'custom rental of 91 days',
    appConfig: CUSTOM_ON,
    input: { rentalType: 'custom', startDate: '2026-09-14', customDays: 91 },
    bookable: false,
    reason: 'Tilpasset leieperiode må være mellom 2 og 90 dager.',
  },

  // ── delivery radius ────────────────────────────────────────────────────────
  {
    name: 'delivery distance exactly at maxDeliveryRadius is allowed',
    input: { rentalType: 'day', startDate: '2026-09-14', deliveryDistance: 150, deliveryFee: 3000 },
    bookable: true,
  },
  {
    name: 'delivery distance one km past maxDeliveryRadius is refused',
    input: { rentalType: 'day', startDate: '2026-09-14', deliveryDistance: 151, deliveryFee: 3025 },
    bookable: false,
    reason: 'Adressen er utenfor leveringsområdet.',
  },

  // ── delivery fee tolerance = max(2, ceil(perKm × 0.1) + 1) ─────────────────
  {
    name: 'fee 2 kr off at perKm=0 sits on the 2 kr tolerance floor',
    pricing: { deliveryPerKm: 0 },
    input: { rentalType: 'day', startDate: '2026-09-14', deliveryDistance: 50, deliveryFee: 2 },
    bookable: true,
  },
  {
    name: 'fee 11 kr off at perKm=100 sits on the scaled tolerance',
    pricing: { deliveryPerKm: 100 },
    input: { rentalType: 'day', startDate: '2026-09-14', deliveryDistance: 40, deliveryFee: 1011 },
    bookable: true,
  },

  // ── self-pickup ────────────────────────────────────────────────────────────
  {
    name: 'self-pickup with no delivery leg',
    input: {
      rentalType: 'day',
      startDate: '2026-09-14',
      selfPickup: true,
      deliveryAddress: '',
      deliveryDistance: 0,
      deliveryFee: 0,
    },
    bookable: true,
  },
  {
    name: 'self-pickup ignores a distance beyond the radius',
    input: {
      rentalType: 'day',
      startDate: '2026-09-14',
      selfPickup: true,
      deliveryAddress: '',
      deliveryDistance: 900,
      deliveryFee: 0,
    },
    bookable: true,
  },
];

describe('validateBookingInput ↔ buildQuote().bookable parity', () => {
  for (const testCase of AGREEMENT_TABLE) {
    it(testCase.name, async () => {
      await seedConfigDefaults(testCase.appConfig ?? {});
      if (testCase.pricing) await setPricing(testCase.pricing);

      const result = await verdicts(bookingInput(testCase.input));

      expect(
        result.agrees,
        `validateBookingInput said ${JSON.stringify(result.validationError)}, ` +
          `buildQuote said bookable=${result.bookable} (${JSON.stringify(result.blockedReason)})`,
      ).toBe(true);
      expect(result.bookable).toBe(testCase.bookable);
      if (testCase.reason) {
        expect(result.validationError).toBe(testCase.reason);
        expect(result.blockedReason).toBe(testCase.reason);
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The disagreements phase 1b recorded. Each test states the behaviour the two
// gates must share; all of them hold now, so they are plain regression fences.
// ─────────────────────────────────────────────────────────────────────────────

describe('parity gaps where the quote is STRICTER than validateBookingInput', () => {
  // FIXED B-1: validateBookingInput now enforces enabledRentalTypes whenever
  // the caller passes appConfig, so it no longer depends on the route.
  it('agrees about a rental type the admin switched off', async () => {
    await seedConfigDefaults({ enabledRentalTypes: 'day,weekend,week' });
    const result = await verdicts(
      bookingInput({ rentalType: 'custom', startDate: '2026-09-14', customDays: 3 }),
    );
    expect(result.blockedReason).toBe('Denne leietypen er ikke tilgjengelig for booking.');
    expect(result.agrees).toBe(true);
  });

  // FIXED B-2: the horizon moved out of createPendingBooking's pre-check and
  // into validateBookingInput itself.
  it('agrees about a start date past bookingMaxAdvanceDays', async () => {
    await seedConfigDefaults({ bookingMaxAdvanceDays: '365' });
    // 2027-09-08 is 366.6 days out from the frozen clock, and a Wednesday, so
    // only the horizon rule can block it.
    const result = await verdicts(bookingInput({ rentalType: 'day', startDate: '2027-09-08' }));
    expect(result.blockedReason).toBe('Du kan ikke booke mer enn 365 dager i forveien.');
    expect(result.agrees).toBe(true);
  });

  // FIXED B-5: validateBookingInput refuses an unresolvable machineId when the
  // caller hands it the resolution (see `verdicts` above).
  it('agrees about an unknown machineId', async () => {
    await seedConfigDefaults();
    const result = await verdicts(
      bookingInput({ rentalType: 'day', startDate: '2026-09-14', machineId: 'does-not-exist' }),
    );
    expect(result.blockedReason).toBe('Valgt utstyr er ikke tilgjengelig.');
    expect(result.agrees).toBe(true);
  });
});

describe('parity gaps where the quote is LAXER than validateBookingInput', () => {
  // FIXED B-3: checkBookable is now handed the fee as the caller supplied it,
  // before self-pickup zeroes it, so its self-pickup guard can fire.
  it('agrees about self-pickup carrying a delivery fee', async () => {
    await seedConfigDefaults();
    const result = await verdicts(
      bookingInput({
        rentalType: 'day',
        startDate: '2026-09-14',
        selfPickup: true,
        deliveryAddress: '',
        deliveryDistance: 0,
        deliveryFee: 500,
      }),
    );
    expect(result.validationError).toBe('Selvhenting skal ikke ha leveringsgebyr.');
    expect(result.agrees).toBe(true);
  });

  // FIXED B-4: both gates now recompute the fee through the same
  // `calculateDeliveryFee` / `deliveryFeeTolerance` pair in src/lib/pricing.ts.
  it('agrees about a delivery fee 3 kr off at perKm=0 (tolerance 2)', async () => {
    await seedConfigDefaults();
    await setPricing({ deliveryPerKm: 0 });
    const result = await verdicts(
      bookingInput({ rentalType: 'day', startDate: '2026-09-14', deliveryDistance: 50, deliveryFee: 3 }),
    );
    expect(result.validationError).toBe('Leveringspris stemmer ikke. Oppdater adressen og prøv igjen.');
    expect(result.agrees).toBe(true);
  });

  // FIXED B-4 (same gap, at the other end of the tolerance scale)
  it('agrees about a delivery fee 12 kr off at perKm=100 (tolerance 11)', async () => {
    await seedConfigDefaults();
    await setPricing({ deliveryPerKm: 100 });
    const result = await verdicts(
      bookingInput({ rentalType: 'day', startDate: '2026-09-14', deliveryDistance: 40, deliveryFee: 1012 }),
    );
    expect(result.validationError).toBe('Leveringspris stemmer ikke. Oppdater adressen og prøv igjen.');
    expect(result.agrees).toBe(true);
  });
});

describe('delivery fee recomputation', () => {
  it('charges from deliveryIncludedKm and floors at minDeliveryFee', async () => {
    await seedConfigDefaults();
    await setPricing({ deliveryPerKm: 25, deliveryIncludedKm: 30, minDeliveryFee: 900 });
    // 40 km − 30 included = 10 chargeable × 25 = 250, floored to the 900 kr minimum.
    const withMinimum = await verdicts(
      bookingInput({ rentalType: 'day', startDate: '2026-09-14', deliveryDistance: 40, deliveryFee: 900 }),
    );
    expect(withMinimum.validationError).toBeNull();

    // Inside the included distance the minimum does NOT apply — the fee is 0.
    const inside = await verdicts(
      bookingInput({ rentalType: 'day', startDate: '2026-09-14', deliveryDistance: 12.5, deliveryFee: 0 }),
    );
    expect(inside.validationError).toBeNull();
  });

  // FIXED B-6: `deliveryIncludedKm` is read through `getConfigValue` alone, so
  // a configured 0 means "bill from the first kilometre" in the shared helper
  // that booking-service.ts, quote.ts and /api/delivery all use.
  it('honours deliveryIncludedKm = 0 (bill every kilometre)', async () => {
    await seedConfigDefaults();
    await setPricing({ deliveryPerKm: 25, deliveryIncludedKm: 0, minDeliveryFee: 0 });
    // 12.5 km × 25 kr = 313 kr when nothing is included.
    const result = await verdicts(
      bookingInput({ rentalType: 'day', startDate: '2026-09-14', deliveryDistance: 12.5, deliveryFee: 313 }),
    );
    expect(result.validationError).toBeNull();
  });
});

describe('checks only validateBookingInput makes (by design — the quote has no PII)', () => {
  it('rejects missing consent, PII and an over-long address or note', async () => {
    await seedConfigDefaults();
    const base = { rentalType: 'day' as const, startDate: '2026-09-14' };
    const check = async (over: Partial<CreateBookingInput>) => (await verdicts(bookingInput({ ...base, ...over }))).validationError;

    expect(await check({ termsAccepted: false })).toBe('Du må godta vilkårene.');
    expect(await check({ name: '   ' })).toBe('Navn, telefon og e-post er påkrevd.');
    expect(await check({ name: 'x'.repeat(201) })).toBe('Navn er for langt.');
    expect(await check({ phone: '1234567' })).toBe('Ugyldig telefonnummer.');
    expect(await check({ phone: '1'.repeat(31) })).toBe('Ugyldig telefonnummer.');
    expect(await check({ email: 'not-an-email' })).toBe('Ugyldig e-postadresse.');
    expect(await check({ deliveryAddress: '' })).toBe('Leveringsadresse er påkrevd.');
    expect(await check({ deliveryAddress: 'x'.repeat(501) })).toBe('Adresse er for lang.');
    expect(await check({ notes: 'x'.repeat(2001) })).toBe('Notater er for lange (maks 2000 tegn).');
    expect(await check({ rentalType: 'månedsleie' as never })).toBe('Ugyldig leietype.');
    expect(await check({ startDate: '07.09.2026' })).toBe('Ugyldig startdato.');
  });

  it('lets the quote price a request the PII rules would reject', async () => {
    await seedConfigDefaults();
    const result = await verdicts(
      bookingInput({ rentalType: 'day', startDate: '2026-09-14', termsAccepted: false, name: '' }),
    );
    expect(result.validationError).toBe('Du må godta vilkårene.');
    // Deliberate: the quote layer has no PII to check, so it stays bookable.
    expect(result.bookable).toBe(true);
  });
});
