/**
 * Booking / availability / delivery test scaffolding.
 *
 * Deliberately separate from `tests/helpers/{db,route,mocks}.ts` — those are
 * the shared harness and are not modified by area tests. Everything here is
 * used only by tests/lib/booking-validation-parity, tests/service/booking-*,
 * tests/api/{bookings,bookings-id,availability,unavailable,delivery,
 * address-suggest}.
 *
 * Nothing in this file calls `vi.mock` (same rule as helpers/mocks.ts) — the
 * db-proxy factory below is *returned* to a `vi.mock` the test file registers.
 */
import type { PrismaClient } from '@prisma/client';

import type { CreateBookingInput } from '@/lib/booking-service';
import type { QuoteInputs } from '@/lib/domain/quote';

// NOTE: this module must not import `./db` (or `@/lib/db`) at the top level.
// `installDbProxy` below is called from inside a `vi.mock('@/lib/db')` factory,
// and a static import would re-enter the module that factory is still building
// — a deadlock. `setPricing` imports it lazily instead.

// ── Redirectable PrismaClient ────────────────────────────────────────────────
//
// `createPendingBooking` reaches the database through the `db` singleton in
// `@/lib/db`, so a concurrency test that wants an isolated `freshDb()` file has
// to swap that singleton. The test file registers:
//
//   vi.mock('@/lib/db', async (orig) => {
//     const actual = await orig() as Record<string, unknown>;
//     const { installDbProxy } = await import('../helpers/booking');
//     return { ...actual, db: installDbProxy(actual.db as PrismaClient) };
//   });
//
// …and then calls `selectDbClient(fresh.client)` / `resetDbClient()`. This module
// never imports `@/lib/db` itself, so registering the mock cannot deadlock on a
// circular import.

let fallbackClient: PrismaClient | null = null;
let activeClient: PrismaClient | null = null;

function currentClient(): PrismaClient {
  const client = activeClient ?? fallbackClient;
  if (!client) {
    throw new Error('[helpers/booking] db proxy used before installDbProxy()');
  }
  return client;
}

/** A PrismaClient-shaped Proxy that forwards to whatever `selectDbClient` selected. */
export const dbProxy: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = currentClient() as unknown as Record<string | symbol, unknown>;
    const value = client[prop];
    return typeof value === 'function'
      ? (value as (...args: unknown[]) => unknown).bind(client)
      : value;
  },
  has(_target, prop) {
    return prop in (currentClient() as unknown as object);
  },
});

/** Register the client the proxy falls back to (the app singleton). */
export function installDbProxy(fallback: PrismaClient): PrismaClient {
  fallbackClient = fallback;
  return dbProxy;
}

/** Point every `db` consumer in this module registry at `client`. */
export function selectDbClient(client: PrismaClient): void {
  activeClient = client;
}

/** Back to the app singleton. */
export function resetDbClient(): void {
  activeClient = null;
}

// ── PricingConfig overrides ──────────────────────────────────────────────────

/**
 * `seedConfigDefaults(overrides)` only overrides AppConfig rows; the delivery
 * numbers (`deliveryPerKm`, `minDeliveryFee`, `maxDeliveryRadius`,
 * `deliveryIncludedKm`, `mvaRate`, …) live in PricingConfig. Call this after
 * seeding, before the code under test reads the config.
 */
export async function setPricing(
  values: Record<string, number>,
  client?: PrismaClient,
): Promise<void> {
  const { db, invalidateCaches } = await import('./db');
  const target = client ?? db;
  for (const [key, value] of Object.entries(values)) {
    await target.pricingConfig.upsert({
      where: { key },
      update: { value },
      create: { key, value, label: key, group: 'delivery' },
    });
  }
  invalidateCaches();
}

// ── Booking input factory ────────────────────────────────────────────────────

/**
 * A `CreateBookingInput` that passes every PII check, so a test can vary the
 * one field it is actually about. `expectedTotalKr` is 0 by default — callers
 * that reach `createPendingBooking` must fill it from `buildQuote`.
 */
export function bookingInput(overrides: Partial<CreateBookingInput> = {}): CreateBookingInput {
  return {
    name: 'Test Testesen',
    phone: '40000000',
    email: 'parity@example.com',
    deliveryAddress: 'Testveien 1, 8000 Bodø',
    rentalType: 'day',
    startDate: '2026-09-14',
    deliveryDistance: 12.5,
    deliveryFee: 0,
    extraHours: 0,
    notes: undefined,
    termsAccepted: true,
    selfPickup: false,
    expectedTotalKr: 0,
    ...overrides,
  };
}

/** The same booking, as the subset `buildQuote` takes (PII minus name/terms). */
export function toQuoteInputs(input: CreateBookingInput): QuoteInputs {
  return {
    rentalType: input.rentalType,
    startDate: input.startDate,
    customDays: input.customDays ?? null,
    machineId: input.machineId ?? null,
    selfPickup: input.selfPickup,
    deliveryDistance: input.deliveryDistance,
    deliveryFee: input.deliveryFee,
    extraHours: input.extraHours,
    email: input.email,
    phone: input.phone,
    code: input.discountCode ?? null,
  };
}

// ── Calendar helpers ─────────────────────────────────────────────────────────

/** Every YYYY-MM-DD in `month` ("2026-10"), in order. */
export function daysInMonth(month: string): string[] {
  const [year, mon] = month.split('-').map(Number);
  const count = new Date(year, mon, 0).getDate();
  return Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}

// ── Distance ─────────────────────────────────────────────────────────────────

/** Same great-circle formula `/api/delivery` uses, for asserting its fallback. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => deg * (Math.PI / 180);
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** `/api/delivery`'s origin when SystemState holds no deliveryOrigin row. */
export const DEFAULT_ORIGIN = { lat: 67.2065, lng: 15.1645 };
