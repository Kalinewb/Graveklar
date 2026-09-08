/**
 * POST /api/delivery — address → road distance → delivery fee → signed proof.
 *
 * The route talks to Nominatim and OSRM through the *global* fetch (it does
 * not import `@/lib/geocode`), so `stubRoutingFetch()` is the harness hook.
 * Failure modes it does not model — Nominatim returning nothing, Nominatim
 * unreachable, OSRM down — get a local stub built on the same rule: any URL
 * that is not Nominatim or OSRM throws, so nothing can reach the network.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/email', async () => (await import('../helpers/mocks')).mockEmail());

import { db, ensureSchema, invalidateCaches, machine, resetDb, seedConfigDefaults } from '../helpers/db';
import {
  DEFAULT_ORIGIN,
  bookingInput,
  haversineKm,
  setPricing,
  toQuoteInputs,
} from '../helpers/booking';
import { call } from '../helpers/route';
import { DEFAULT_GEOCODE, geocodeMock, mockClock, stubRoutingFetch } from '../helpers/mocks';
import { computeBookingPrices, validateBookingInput } from '@/lib/booking-service';
import { buildQuote } from '@/lib/domain/quote';
import { loadConfigValues } from '@/lib/config-server';
import { loadAppConfig } from '@/lib/app-config';
import { normalizeDeliveryAddress, verifyDeliveryQuoteToken } from '@/lib/delivery-quote-token';

const NOW = '2026-09-07T09:00:00+02:00';
const SIX_HOURS = 6 * 60 * 60 * 1000;
const ADDRESS = 'Storgata 1, Bodø';

let clock: ReturnType<typeof mockClock>;
let ipCounter = 0;
const ip = () => `198.51.100.${++ipCounter % 250}.${ipCounter}`;

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDb();
  clock = mockClock(NOW);
  await seedConfigDefaults();
});

afterEach(() => {
  clock.restore();
  vi.unstubAllGlobals();
});

interface DeliveryBody {
  distance: number;
  fee: number | null;
  perKmRate?: number;
  address?: string;
  straightLine?: boolean;
  withinRadius?: boolean;
  token?: string;
  error?: string;
}

async function delivery(body: Record<string, unknown>, from: string = ip()) {
  const { POST } = await import('@/app/api/delivery/route');
  return call<DeliveryBody>(POST, {
    method: 'POST',
    path: '/api/delivery',
    body,
    headers: { 'x-forwarded-for': from },
  });
}

/** Change AppConfig rows the `beforeEach` seed already wrote. */
async function setAppConfig(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    await db.appConfig.upsert({
      where: { key },
      update: { value },
      create: { key, value, label: key, group: 'system', type: 'text', isPublic: false, sortOrder: 99 },
    });
  }
  invalidateCaches();
}

/**
 * Local variant of `stubRoutingFetch` for the two upstreams' failure modes.
 * Same guarantee: an unexpected host throws instead of reaching the network.
 */
function stubUpstreams(opts: {
  nominatim?: 'ok' | 'empty' | 'unreachable';
  osrm?: 'ok' | 'down';
  lat?: number;
  lng?: number;
  distanceKm?: number;
}) {
  const nominatim = opts.nominatim ?? 'ok';
  const osrm = opts.osrm ?? 'ok';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);
      if (url.includes('nominatim.openstreetmap.org')) {
        if (nominatim === 'unreachable') throw new TypeError('fetch failed');
        if (nominatim === 'empty') {
          return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(
          JSON.stringify([
            {
              lat: String(opts.lat ?? DEFAULT_ORIGIN.lat),
              lon: String(opts.lng ?? DEFAULT_ORIGIN.lng),
              display_name: 'Storgata 1, 8006 Bodø, Norge',
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('router.project-osrm.org')) {
        if (osrm === 'down') return new Response('upstream is down', { status: 503 });
        return new Response(
          JSON.stringify({ code: 'Ok', routes: [{ distance: (opts.distanceKm ?? 10) * 1000 }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`[delivery.test] unexpected outbound fetch: ${url}`);
    }),
  );
}

describe('POST /api/delivery — fee arithmetic', () => {
  it('rounds the distance to 0.1 km BEFORE the fee is derived from it', async () => {
    await setPricing({ deliveryPerKm: 25, deliveryIncludedKm: 30, minDeliveryFee: 0, maxDeliveryRadius: 150 });
    stubRoutingFetch({ distanceKm: 45.67 });

    const res = await delivery({ address: ADDRESS });

    expect(res.status).toBe(200);
    expect(res.json.distance).toBe(45.7);
    // 45.7 − 30 = 15.7 chargeable × 25 = 392.5 → 393.
    // Off the raw 45.67 it would have been 392 — the client and the drift
    // check would then disagree by a whole krone per 0.1 km of rounding.
    expect(res.json.fee).toBe(393);
    expect(res.json.perKmRate).toBe(25);
    expect(res.json.straightLine).toBe(false);
    expect(res.json.withinRadius).toBe(true);
    expect(res.json.address).toBe('Testveien 1, 8000 Bodø, Norge');
    expect(res.json.token).toEqual(expect.any(String));
  });

  it('charges nothing inside the included distance', async () => {
    await setPricing({ deliveryPerKm: 25, deliveryIncludedKm: 30, minDeliveryFee: 900 });
    stubRoutingFetch({ distanceKm: 12.5 });

    const res = await delivery({ address: ADDRESS });

    expect(res.json.distance).toBe(12.5);
    // The minimum fee applies to a charged delivery, not to a free one.
    expect(res.json.fee).toBe(0);
  });

  it('floors a charged delivery at minDeliveryFee', async () => {
    await setPricing({ deliveryPerKm: 25, deliveryIncludedKm: 30, minDeliveryFee: 900 });
    stubRoutingFetch({ distanceKm: 35 });

    const res = await delivery({ address: ADDRESS });

    expect(res.json.distance).toBe(35);
    expect(res.json.fee).toBe(900); // 5 km × 25 = 125, lifted to the minimum
  });

  it('produces a fee the booking drift check accepts', async () => {
    await setPricing({ deliveryPerKm: 25, deliveryIncludedKm: 30, minDeliveryFee: 0, maxDeliveryRadius: 150 });
    stubRoutingFetch({ distanceKm: 88.34 });

    const res = await delivery({ address: ADDRESS });
    const [config, appConfig] = await Promise.all([loadConfigValues(), loadAppConfig()]);
    const input = bookingInput({
      startDate: '2026-09-14',
      deliveryAddress: ADDRESS,
      deliveryDistance: res.json.distance,
      deliveryFee: res.json.fee ?? 0,
    });

    expect(
      validateBookingInput(input, config, computeBookingPrices(input, config, null), appConfig),
    ).toBeNull();
  });
});

describe('POST /api/delivery — outside the service radius', () => {
  it('reports the distance and a null fee', async () => {
    await setPricing({ maxDeliveryRadius: 150 });
    stubRoutingFetch({ distanceKm: 200 });

    const res = await delivery({ address: ADDRESS });

    expect(res.json.distance).toBe(200);
    expect(res.json.fee).toBeNull();
    expect(res.json.error).toMatch(/Adressen er for langt unna \(over 150 km\)/);
    // No proof is issued for an address outside the radius.
    expect(res.json.token).toBeUndefined();
  });

  // FIXED D-2: the refusal used to be served as HTTP 200 with `error` in the
  // body, so every generic `if (!res.ok)` caller treated it as a successful
  // quote and had to know to look for `fee === null` instead.
  it('answers with a 4xx status', async () => {
    await setPricing({ maxDeliveryRadius: 150 });
    stubRoutingFetch({ distanceKm: 200 });

    const res = await delivery({ address: ADDRESS });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('POST /api/delivery — OSRM unavailable', () => {
  const TIERS: { km: number; multiplier: number }[] = [
    { km: 5, multiplier: 1.3 },
    { km: 20, multiplier: 1.6 },
    { km: 45, multiplier: 1.55 },
    { km: 80, multiplier: 1.45 },
    { km: 120, multiplier: 1.4 },
  ];

  for (const tier of TIERS) {
    it(`estimates ~${tier.km} km straight-line with the ×${tier.multiplier} road multiplier`, async () => {
      await setPricing({ deliveryPerKm: 25, deliveryIncludedKm: 30, minDeliveryFee: 0, maxDeliveryRadius: 500 });
      // Offset along the meridian: 1° of latitude ≈ 111.19 km.
      const lat = DEFAULT_ORIGIN.lat + tier.km / 111.19;
      stubUpstreams({ osrm: 'down', lat, lng: DEFAULT_ORIGIN.lng });

      const res = await delivery({ address: ADDRESS });

      const straight = haversineKm(DEFAULT_ORIGIN.lat, DEFAULT_ORIGIN.lng, lat, DEFAULT_ORIGIN.lng);
      expect(straight).toBeCloseTo(tier.km, 1);
      expect(res.status).toBe(200);
      expect(res.json.straightLine).toBe(true);
      expect(res.json.distance).toBe(Math.round(straight * tier.multiplier * 10) / 10);

      const chargeable = Math.max(0, res.json.distance - 30);
      expect(res.json.fee).toBe(chargeable > 0 ? Math.round(chargeable * 25) : 0);
    });
  }

  it('still produces a fee the booking drift check accepts', async () => {
    await setPricing({ deliveryPerKm: 25, deliveryIncludedKm: 30, minDeliveryFee: 0, maxDeliveryRadius: 500 });
    const lat = DEFAULT_ORIGIN.lat + 45 / 111.19;
    stubUpstreams({ osrm: 'down', lat, lng: DEFAULT_ORIGIN.lng });

    const res = await delivery({ address: ADDRESS });
    const [config, appConfig] = await Promise.all([loadConfigValues(), loadAppConfig()]);
    const input = bookingInput({
      startDate: '2026-09-14',
      deliveryAddress: ADDRESS,
      deliveryDistance: res.json.distance,
      deliveryFee: res.json.fee ?? 0,
    });

    expect(
      validateBookingInput(input, config, computeBookingPrices(input, config, null), appConfig),
    ).toBeNull();
  });
});

describe('POST /api/delivery — bad input and upstream failures', () => {
  it('rejects an address shorter than three characters', async () => {
    stubRoutingFetch();
    for (const address of [undefined, '', '  ', 'ab', 42]) {
      const res = await delivery({ address });
      expect(res.status, `address=${JSON.stringify(address)}`).toBe(400);
      expect(res.json.error).toBe('Oppgi en gyldig adresse');
    }
    // Nothing reached Nominatim.
    expect(geocodeMock.fetched).toEqual([]);
  });

  it('404s when the geocoder finds nothing', async () => {
    stubUpstreams({ nominatim: 'empty' });
    const res = await delivery({ address: 'Ikkeeksisterendeveien 999' });

    expect(res.status).toBe(404);
    expect(res.json.error).toMatch(/Kunne ikke finne adressen/);
  });

  it('503s when the geocoder cannot be reached', async () => {
    stubUpstreams({ nominatim: 'unreachable' });
    const res = await delivery({ address: ADDRESS });

    expect(res.status).toBe(503);
    expect(res.json.error).toMatch(/Sjekk tilkoblingen/);
  });

  it('cuts off at 30 requests per minute per IP', async () => {
    stubRoutingFetch({ distanceKm: 12.5 });
    const from = ip();

    for (let i = 0; i < 30; i++) {
      expect((await delivery({ address: ADDRESS }, from)).status).toBe(200);
    }
    const blocked = await delivery({ address: ADDRESS }, from);
    expect(blocked.status).toBe(429);
    expect(blocked.json.error).toBe('For mange forespørsler. Prøv igjen snart.');
  }, 30_000);
});

describe('POST /api/delivery — the signed quote token', () => {
  it('binds the normalised address, the distance and the fee', async () => {
    await setPricing({ deliveryPerKm: 25, deliveryIncludedKm: 30, minDeliveryFee: 0 });
    stubRoutingFetch({ distanceKm: 45.67 });

    const res = await delivery({ address: '  Storgata   1,   BODØ  ' });
    const token = res.json.token!;
    const quote = { address: ADDRESS, distance: 45.7, fee: 393 };

    expect(normalizeDeliveryAddress('  Storgata   1,   BODØ  ')).toBe('storgata 1, bodø');
    expect(await verifyDeliveryQuoteToken(token, quote)).toBe(true);
    expect(await verifyDeliveryQuoteToken(token, { ...quote, distance: 10 })).toBe(false);
    expect(await verifyDeliveryQuoteToken(token, { ...quote, fee: 0 })).toBe(false);
    expect(await verifyDeliveryQuoteToken(token, { ...quote, address: 'Kirkegata 2, Bodø' })).toBe(false);
    // It signs what the customer typed, not the display name Nominatim
    // returned — so the booking must carry the same string back.
    expect(await verifyDeliveryQuoteToken(token, { ...quote, address: res.json.address! })).toBe(false);
  });

  it('is valid for exactly six hours', async () => {
    await setPricing({ deliveryPerKm: 25, deliveryIncludedKm: 30, minDeliveryFee: 0 });
    stubRoutingFetch({ distanceKm: 45.67 });

    const res = await delivery({ address: ADDRESS });
    const token = res.json.token!;
    const quote = { address: ADDRESS, distance: 45.7, fee: 393 };

    clock.advance(SIX_HOURS - 1);
    expect(await verifyDeliveryQuoteToken(token, quote)).toBe(true);
    clock.advance(2); // now 6 h + 1 ms after issue
    expect(await verifyDeliveryQuoteToken(token, quote)).toBe(false);
  });
});

describe('POST /api/delivery — caller-supplied coordinates', () => {
  // FIXED D-1: the address is geocoded whether or not lat/lng were sent; the
  // coordinates are a precision hint that has to agree with the server's own
  // geocode (within 1 km) before they are used.
  it('geocodes the address anyway and keeps coordinates that agree with it', async () => {
    stubRoutingFetch({ distanceKm: 12.5 });

    const res = await delivery({
      address: ADDRESS,
      // 0.001° of latitude ≈ 110 m from the fixture — well inside the radius.
      lat: DEFAULT_GEOCODE.lat + 0.001,
      lng: DEFAULT_GEOCODE.lng,
    });

    expect(res.status).toBe(200);
    expect(geocodeMock.fetched.some((u) => u.includes('nominatim'))).toBe(true);
    // The echoed address is the geocoder's display name, never the raw string.
    expect(res.json.address).toBe(DEFAULT_GEOCODE.displayName);
    expect(res.json.distance).toBe(12.5);
  });

  // FINDING D-1: the client picked the coordinates, and /api/delivery signed a
  // proof over (address, distance, fee) it never verified against them. Posting
  // the depot's own coordinates with any address string produced a valid
  // 0 km / 0 kr proof for that string — which POST /api/bookings accepted,
  // placing a delivery outside the insured radius at no charge.
  // FIXED: coordinates that do not match the geocode of the address they were
  // sent with are refused, so no proof is issued at all.
  it('does not issue a usable proof for an address it never geocoded', async () => {
    await setAppConfig({
      stripeEnabled: 'true',
      stripeSecretKey: 'sk_test_harness',
      enableFirstTimeDiscount: 'false',
      enableRepeatDiscount: 'false',
    });
    await machine({ quantity: 1 });
    await setPricing({ deliveryPerKm: 25, deliveryIncludedKm: 30, minDeliveryFee: 0, maxDeliveryRadius: 150 });
    stubRoutingFetch({ distanceKm: 0 });

    // The depot's own coordinates, posted with an address ~600 km away. The
    // geocoder resolves 'Trondheim' somewhere else entirely, so the pair is
    // refused and no token is minted.
    const quoted = await delivery({
      address: 'Trondheim',
      lat: DEFAULT_ORIGIN.lat,
      lng: DEFAULT_ORIGIN.lng,
    });
    expect(quoted.status).toBe(400);
    expect(quoted.json.token).toBeUndefined();

    const input = bookingInput({
      startDate: '2026-09-14',
      deliveryAddress: 'Trondheim',
      deliveryDistance: 0,
      deliveryFee: 0,
    });
    const priced = await buildQuote(toQuoteInputs(input));

    const { POST } = await import('@/app/api/bookings/route');
    const booked = await call(POST, {
      method: 'POST',
      path: '/api/bookings',
      headers: { 'x-forwarded-for': ip() },
      body: {
        name: input.name,
        phone: input.phone,
        email: input.email,
        deliveryAddress: 'Trondheim',
        rentalType: 'day',
        startDate: '2026-09-14',
        deliveryDistance: 0,
        deliveryFee: 0,
        termsAccepted: true,
        selfPickup: false,
        expectedTotalKr: priced.totalPrice,
        deliveryQuoteToken: quoted.json.token,
      },
    });

    expect(booked.status).toBe(400);
    expect(await db.booking.count()).toBe(0);
  });
});
