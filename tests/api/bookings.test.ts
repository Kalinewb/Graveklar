/**
 * POST /api/bookings (public) and GET /api/bookings (admin).
 *
 * Auth for the GET lives in src/proxy.ts, not in the handler, so the handler
 * tests call the handler directly and the proxy is asserted separately.
 *
 * Both rate limiters are module singletons keyed by IP, so every test uses its
 * own address — `ip()` hands out a fresh one.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/email', async () => (await import('../helpers/mocks')).mockEmail());
vi.mock('@/lib/cleanup', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    runCleanupIfDue: vi.fn(async () => ({
      ran: true,
      cancelled: 0,
      orphanLocksReleased: 0,
      tokensSwept: 0,
      orphanUploadsRemoved: 0,
    })),
  };
});

import { db, ensureSchema, machine, resetDb, seedConfigDefaults } from '../helpers/db';
import { bookingInput, toQuoteInputs } from '../helpers/booking';
import { adminCookieJar, call, proxyCall } from '../helpers/route';
import { mockClock } from '../helpers/mocks';
import { buildQuote } from '@/lib/domain/quote';
import { signDeliveryQuoteToken } from '@/lib/delivery-quote-token';
import { runCleanupIfDue } from '@/lib/cleanup';

const NOW = '2026-09-07T09:00:00+02:00';
const MONDAY = '2026-09-14';
const ADDRESS = 'Testveien 1, 8000 Bodø';

const PAYABLE = {
  stripeEnabled: 'true',
  stripeSecretKey: 'sk_test_harness',
  enableFirstTimeDiscount: 'false',
  enableRepeatDiscount: 'false',
};

let clock: ReturnType<typeof mockClock>;
let ipCounter = 0;
/** A fresh per-test IP so one test's rate-limit budget never leaks into another. */
const ip = () => `203.0.113.${++ipCounter % 250}.${ipCounter}`;

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDb();
  clock = mockClock(NOW);
  vi.mocked(runCleanupIfDue).mockClear();
});

afterEach(() => {
  clock.restore();
});

async function seed(overrides: Record<string, string> = {}) {
  await seedConfigDefaults({ ...PAYABLE, ...overrides });
  return machine({ quantity: 1 });
}

async function post(body: Record<string, unknown>, from: string = ip()) {
  const { POST } = await import('@/app/api/bookings/route');
  return call(POST, {
    method: 'POST',
    path: '/api/bookings',
    body,
    headers: { 'x-forwarded-for': from },
  });
}

/** A body the route accepts: priced by the real quote, delivery proof signed. */
async function validBody(overrides: Record<string, unknown> = {}) {
  const input = bookingInput({
    rentalType: 'day',
    startDate: MONDAY,
    selfPickup: true,
    deliveryAddress: '',
    deliveryDistance: 0,
    deliveryFee: 0,
    ...(overrides as object),
  });
  const quote = await buildQuote(toQuoteInputs(input));
  const body: Record<string, unknown> = {
    name: input.name,
    phone: input.phone,
    email: input.email,
    deliveryAddress: input.deliveryAddress,
    rentalType: input.rentalType,
    startDate: input.startDate,
    customDays: input.customDays,
    deliveryDistance: input.deliveryDistance,
    deliveryFee: input.deliveryFee,
    extraHours: input.extraHours,
    termsAccepted: true,
    selfPickup: input.selfPickup,
    expectedTotalKr: quote.totalPrice,
    ...overrides,
  };
  if (!body.selfPickup) {
    body.deliveryQuoteToken = await signDeliveryQuoteToken({
      address: String(body.deliveryAddress ?? ''),
      distance: Number(body.deliveryDistance ?? 0),
      fee: Number(body.deliveryFee ?? 0),
    });
  }
  return body;
}

describe('POST /api/bookings — request gates', () => {
  it('rejects a filled honeypot without touching the database', async () => {
    await seed();
    const res = await post({ ...(await validBody()), website: 'https://spam.example' });

    expect(res.status).toBe(400);
    expect(res.json.error).toBe('Ugyldig forespørsel');
    expect(await db.booking.count()).toBe(0);
    expect(await db.bookingDateLock.count()).toBe(0);
  });

  it('rejects a body that is not JSON', async () => {
    await seed();
    const { POST } = await import('@/app/api/bookings/route');
    const res = await call(POST, {
      method: 'POST',
      path: '/api/bookings',
      body: 'not json',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() },
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('Ugyldig forespørsel');
  });

  it('requires a numeric expectedTotalKr', async () => {
    await seed();
    const body = await validBody();

    delete body.expectedTotalKr;
    expect((await post({ ...body })).status).toBe(400);
    expect((await post({ ...body, expectedTotalKr: '4990' })).json.error).toBe('expectedTotalKr påkrevd');
    expect((await post({ ...body, expectedTotalKr: Number.NaN })).json.error).toBe('expectedTotalKr påkrevd');
    expect(await db.booking.count()).toBe(0);
  });

  it('refuses a rental type the admin has switched off', async () => {
    await seed({ enabledRentalTypes: 'week' });
    const res = await post(await validBody({ rentalType: 'day' }));

    expect(res.status).toBe(400);
    expect(res.json.error).toBe('Denne leietypen er ikke tilgjengelig for booking.');
    expect(await db.booking.count()).toBe(0);
  });

  it('requires a delivery proof token unless the customer self-collects', async () => {
    await seed();
    const delivered = await validBody({
      selfPickup: false,
      deliveryAddress: ADDRESS,
      deliveryDistance: 12.5,
      deliveryFee: 0,
    });

    const missing = await post({ ...delivered, deliveryQuoteToken: undefined });
    expect(missing.status).toBe(400);
    expect(missing.json.error).toBe(
      'Leveringsprisen må beregnes på nytt. Velg leveringsadressen igjen og prøv på nytt.',
    );

    // A token measured for a different address must not travel.
    const otherAddress = await post({
      ...delivered,
      deliveryQuoteToken: await signDeliveryQuoteToken({
        address: 'Kirkegata 2, Bodø',
        distance: 12.5,
        fee: 0,
      }),
    });
    expect(otherAddress.status).toBe(400);
    expect(await db.booking.count()).toBe(0);

    // …and with the right proof it goes through.
    const ok = await post(delivered);
    expect(ok.status).toBe(201);
    expect(ok.json.booking.deliveryAddress).toBe(ADDRESS);
  });

  it('creates a self-pickup booking with no delivery proof at all', async () => {
    await seed();
    const res = await post(await validBody());

    expect(res.status).toBe(201);
    expect(res.json.success).toBe(true);
    expect(res.json.booking.selfPickup).toBe(true);
    expect(res.json.booking.status).toBe('pending');
    expect(await db.bookingDateLock.count()).toBe(1);
  });
});

describe('POST /api/bookings — numeric clamping', () => {
  it('clamps extraHours to 720', async () => {
    await seed();
    // Price the booking as the clamped value, so a 201 proves the clamp ran.
    const priced = await validBody({ extraHours: 720 });
    const res = await post({ ...priced, extraHours: 10_000 });

    expect(res.status).toBe(201);
    expect(res.json.booking.extraHours).toBe(720);
  });

  it('clamps a negative extraHours and deliveryDistance to 0', async () => {
    await seed();
    const res = await post({ ...(await validBody()), extraHours: -5, deliveryDistance: -12 });

    expect(res.status).toBe(201);
    expect(res.json.booking.extraHours).toBe(0);
    expect(res.json.booking.deliveryDistance).toBe(0);
  });

  it('clamps deliveryDistance to 500 km before the proof is checked', async () => {
    await seed();
    const body = await validBody({
      selfPickup: false,
      deliveryAddress: ADDRESS,
      deliveryDistance: 12.5,
      deliveryFee: 0,
    });
    // Proof signed for the CLAMPED distance: if the route clamped, the token
    // verifies and the request dies on the radius rule instead of the proof.
    const res = await post({
      ...body,
      deliveryDistance: 9999,
      deliveryQuoteToken: await signDeliveryQuoteToken({ address: ADDRESS, distance: 500, fee: 0 }),
    });

    expect(res.status).toBe(400);
    expect(res.json.error).toBe('Adressen er utenfor leveringsområdet.');
  });

  it('clamps deliveryFee to 50000 before the proof is checked', async () => {
    await seed();
    const body = await validBody({
      selfPickup: false,
      deliveryAddress: ADDRESS,
      deliveryDistance: 12.5,
      deliveryFee: 0,
    });
    const res = await post({
      ...body,
      deliveryFee: 99_999,
      deliveryQuoteToken: await signDeliveryQuoteToken({
        address: ADDRESS,
        distance: 12.5,
        fee: 50_000,
      }),
    });

    expect(res.status).toBe(400);
    expect(res.json.error).toBe('Leveringspris stemmer ikke. Oppdater adressen og prøv igjen.');
  });
});

describe('POST /api/bookings — price drift', () => {
  it('answers 409 with the fresh quote when the agreed total moved', async () => {
    await seed();
    const body = await validBody();
    const agreed = Number(body.expectedTotalKr);

    const res = await post({ ...body, expectedTotalKr: agreed - 500 });

    expect(res.status).toBe(409);
    expect(res.json.priceDrift).toBe(true);
    expect(res.json.expected).toBe(agreed - 500);
    expect(res.json.actual).toBe(agreed);
    expect(res.json.quote.totalPrice).toBe(agreed);
    expect(res.json.quote.bookable).toBe(true);
    expect(await db.booking.count()).toBe(0);
  });
});

describe('POST /api/bookings — rate limits', () => {
  it('charges the hourly budget only for bookings that were actually created', async () => {
    await seed({ dayAllowedDays: '1,2,3,4,5,6,7', blockDayBeforeBooking: 'false', blockDayAfterBooking: 'false' });
    const from = ip();

    // Five refusals first — they must not eat into the budget.
    for (let i = 0; i < 5; i++) {
      const res = await post({ ...(await validBody()), termsAccepted: false }, from);
      expect(res.status).toBe(400);
    }

    const template = await validBody();
    for (let day = 14; day <= 23; day++) {
      const res = await post({ ...template, startDate: `2026-09-${day}` }, from);
      expect(res.status, `booking #${day - 13} should have been created`).toBe(201);
    }
    expect(await db.booking.count()).toBe(10);

    const overBudget = await post({ ...template, startDate: '2026-09-24' }, from);
    expect(overBudget.status).toBe(429);
    expect(overBudget.json.error).toMatch(/uvanlig mange bookinger/);
    expect(await db.booking.count()).toBe(10);
  }, 30_000);

  it('cuts off a burst at 40 requests per 5 minutes, counting refusals too', async () => {
    await seed();
    const from = ip();
    const spam = { website: 'bot' };

    for (let i = 0; i < 40; i++) {
      expect((await post(spam, from)).status).toBe(400);
    }
    const blocked = await post(spam, from);
    expect(blocked.status).toBe(429);
    expect(blocked.json.error).toMatch(/For mange forespørsler på kort tid/);
  }, 30_000);
});

describe('GET /api/bookings (admin list)', () => {
  /** `count` cheap rows with strictly decreasing createdAt. */
  async function seedBookings(count: number) {
    const machineRow = await machine();
    const base = Date.now();
    await db.booking.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        reference: `GK-2609-${String(i).padStart(4, '0')}-AAAAA`,
        name: 'List Test',
        phone: '40000000',
        email: 'list@example.com',
        deliveryAddress: ADDRESS,
        rentalType: 'day',
        startDate: new Date('2026-09-14T00:00:00'),
        deliveryDistance: 0,
        deliveryFee: 0,
        basePrice: 1000,
        totalPrice: 1000,
        status: i % 5 === 0 ? 'confirmed' : 'pending',
        machineId: machineRow.id,
        createdAt: new Date(base - i * 1000),
      })),
    });
  }

  async function list(searchParams: Record<string, string | number> = {}) {
    const { GET } = await import('@/app/api/bookings/route');
    return call(GET, { path: '/api/bookings', searchParams });
  }

  it('sweeps expired pending bookings before answering', async () => {
    await seedConfigDefaults(PAYABLE);
    await list();
    expect(vi.mocked(runCleanupIfDue)).toHaveBeenCalled();
  });

  it('paginates by cursor when ?limit= is given', async () => {
    await seedConfigDefaults(PAYABLE);
    await seedBookings(5);

    const first = await list({ limit: 2 });
    expect(first.status).toBe(200);
    expect(first.json.bookings).toHaveLength(2);
    expect(first.json.hasMore).toBe(true);
    expect(first.json.nextCursor).toBe(first.json.bookings[1].id);

    const second = await list({ limit: 2, cursor: first.json.nextCursor });
    expect(second.json.bookings).toHaveLength(2);
    expect(second.json.hasMore).toBe(true);
    const seen = [...first.json.bookings, ...second.json.bookings].map((b: { id: string }) => b.id);
    expect(new Set(seen).size).toBe(4);

    const last = await list({ limit: 2, cursor: second.json.nextCursor });
    expect(last.json.bookings).toHaveLength(1);
    expect(last.json.hasMore).toBe(false);
    expect(last.json.nextCursor).toBeNull();
  });

  it('clamps ?limit= into 1…1000', async () => {
    await seedConfigDefaults(PAYABLE);
    await seedBookings(1001);

    const capped = await list({ limit: 99_999 });
    expect(capped.json.bookings).toHaveLength(1000);
    expect(capped.json.hasMore).toBe(true);

    const floored = await list({ limit: 0 });
    expect(floored.json.bookings).toHaveLength(1);
    const negative = await list({ limit: -20 });
    expect(negative.json.bookings).toHaveLength(1);
  }, 30_000);

  it('returns every row when ?limit= is omitted — the cap is opt-in (F-8)', async () => {
    await seedConfigDefaults(PAYABLE);
    await seedBookings(1001);

    const all = await list();
    // Documented, deliberate: the admin UI fetches the whole table. The
    // MAX_PAGE_SIZE cap only applies once a caller opts into pagination, so
    // the unpaginated response is unbounded and grows with the business.
    expect(all.json.bookings).toHaveLength(1001);
    expect(all.json.nextCursor).toBeUndefined();
    expect(all.json.hasMore).toBeUndefined();
  }, 30_000);

  it('filters by status', async () => {
    await seedConfigDefaults(PAYABLE);
    await seedBookings(10);

    const confirmed = await list({ status: 'confirmed' });
    expect(confirmed.json.bookings).toHaveLength(2);
    expect(confirmed.json.bookings.every((b: { status: string }) => b.status === 'confirmed')).toBe(true);
  });
});

describe('proxy gate for /api/bookings', () => {
  it('leaves the public POST alone but demands a session for the admin GET', async () => {
    const publicPost = await proxyCall('/api/bookings', { method: 'POST' });
    expect(publicPost.headers.get('x-middleware-next')).toBe('1');

    const anonymousGet = await proxyCall('/api/bookings', { method: 'GET' });
    expect(anonymousGet.status).toBe(401);
    await expect(anonymousGet.clone().json()).resolves.toEqual({ error: 'Unauthorized' });

    const authedGet = await proxyCall('/api/bookings', {
      method: 'GET',
      cookies: await adminCookieJar(),
    });
    expect(authedGet.headers.get('x-middleware-next')).toBe('1');
  });
});
