/**
 * Proves the mock factories in tests/helpers/mocks.ts behave as documented.
 *
 * The `vi.mock` registrations below are deliberately at the top level of this
 * file — that is the only place they belong (see the header of mocks.ts).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  emailMock,
  geocodeMock,
  mockClock,
  signedEvent,
  stripeEventPayload,
  stripeMock,
  stubRoutingFetch,
  vippsMock,
} from './helpers/mocks';
import { ensureSchema, resetDb, seedAppConfigDefaults, seedPricingDefaults } from './helpers/db';
import { call } from './helpers/route';
import { toDateStr } from '@/lib/dates';

// Hoisted by vitest above the imports. The dynamic import inside each factory
// is what makes that safe — a top-level binding would be in its TDZ here.
vi.mock('@/lib/email', async () => (await import('./helpers/mocks')).mockEmail());
vi.mock('stripe', async () => (await import('./helpers/mocks')).mockStripe());
vi.mock('@/lib/vipps', async (orig) =>
  (await import('./helpers/mocks')).mockVipps((await orig()) as Record<string, unknown>));
vi.mock('@/lib/geocode', async (orig) =>
  (await import('./helpers/mocks')).mockGeocode((await orig()) as Record<string, unknown>));

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDb();
  emailMock.reset();
  stripeMock.reset();
  vippsMock.reset();
});

describe('mockEmail', () => {
  it('records every sender call and sends nothing', async () => {
    const email = await import('@/lib/email');
    await email.sendBookingReminderEmail({ id: 'bk_1' } as never);
    await email.sendPaymentRetryEmail({ id: 'bk_1' } as never, 'https://pay.test');

    expect(emailMock.sent.map((s) => s.fn)).toEqual([
      'sendBookingReminderEmail',
      'sendPaymentRetryEmail',
    ]);
    expect(emailMock.by('sendPaymentRetryEmail')[0].args[1]).toBe('https://pay.test');
  });
});

describe('mockVipps', () => {
  it('stubs the HTTP calls and keeps the pure helpers real', async () => {
    const vipps = await import('@/lib/vipps');

    expect(vipps.toMinorUnits(299.5)).toBe(29950);
    expect(vipps.isValidVippsReference('GK-2609-001-P6V32')).toBe(true);

    const token = await vipps.getAccessToken({} as never);
    expect(token).toBe('test-access-token');
    expect(vippsMock.by('getAccessToken')).toHaveLength(1);

    vippsMock.responses.getPayment = { reference: 'X', state: 'ABORTED' };
    const payment = await vipps.getPayment({} as never, 'X');
    expect(payment.state).toBe('ABORTED');
  });
});

describe('mockStripe', () => {
  it('verifies a signedEvent through the faked webhooks.constructEvent', async () => {
    await seedAppConfigDefaults({
      stripeEnabled: 'true',
      stripeSecretKey: 'sk_test_harness',
      stripeWebhookSecret: 'whsec_mocked',
    });

    const { verifyStripeWebhook } = await import('@/lib/stripe');
    const payload = stripeEventPayload('charge.refunded', { id: 'ch_1' });

    const event = await verifyStripeWebhook(payload, signedEvent(payload, 'whsec_mocked'));
    expect(event?.type).toBe('charge.refunded');
    expect(stripeMock.by('webhooks.constructEvent')).toHaveLength(1);

    expect(await verifyStripeWebhook(payload, signedEvent(payload, 'whsec_other'))).toBeNull();
  });
});

describe('mockGeocode', () => {
  it('returns the fixture from geocodeAddress and leaves normalizeAddress real', async () => {
    const geocode = await import('@/lib/geocode');
    expect(geocode.normalizeAddress('  Storgata   1  ')).toBe('Storgata 1');

    const result = await geocode.geocodeAddress('Storgata 1');
    expect(result?.lat).toBe(geocodeMock.fixture.lat);
    expect(result?.displayName).toBe(geocodeMock.fixture.displayName);
  });
});

describe('stubRoutingFetch', () => {
  it('feeds Nominatim + OSRM to POST /api/delivery without touching the network', async () => {
    await seedPricingDefaults();
    await seedAppConfigDefaults();
    const routing = stubRoutingFetch({ distanceKm: 42 });

    try {
      const { POST } = await import('@/app/api/delivery/route');
      const res = await call(POST, {
        method: 'POST',
        path: '/api/delivery',
        body: { address: 'Storgata 1, Bodø' },
      });

      expect(res.status).toBe(200);
      expect(res.json.distance).toBe(42);
      // 42 km − 30 included = 12 chargeable × 25 kr/km
      expect(res.json.fee).toBe(300);
      expect(routing.state.fetched.some((u) => u.includes('router.project-osrm.org'))).toBe(true);
    } finally {
      routing.restore();
    }
  });
});

describe('mockClock', () => {
  it('freezes the clock in Europe/Oslo', () => {
    const clock = mockClock('2026-09-06T09:00:00+02:00');
    try {
      expect(toDateStr(new Date())).toBe('2026-09-06');
      expect(new Date().getHours()).toBe(9);
      clock.advance(20 * 60 * 60 * 1000);
      expect(toDateStr(new Date())).toBe('2026-09-07');
    } finally {
      clock.restore();
    }
  });
});
