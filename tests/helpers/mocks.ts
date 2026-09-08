/**
 * Reusable module-mock factories.
 *
 * IMPORTANT: nothing in this file calls `vi.mock` itself. Vitest hoists every
 * `vi.mock` to the top of the module it appears in, so a `vi.mock` hidden
 * inside a helper here would silently mock Stripe/email/Vipps for *every* test
 * file that imports this module. Each factory therefore just returns the
 * replacement module shape, and the test file does the registration:
 *
 * ```ts
 * vi.mock('@/lib/email', async () => (await import('../helpers/mocks')).mockEmail());
 * import { emailMock } from '../helpers/mocks';
 *
 * beforeEach(() => emailMock.reset());
 * it('mails the admin', async () => {
 *   …
 *   expect(emailMock.by('sendNewBookingAdminNotification')).toHaveLength(1);
 * });
 * ```
 *
 * The recorders (`emailMock`, `stripeMock`, `vippsMock`, `geocodeMock`) are
 * module singletons, so the mock factory and the test file share them.
 */
import { createHmac } from 'node:crypto';
import { vi } from 'vitest';

// ── Email ────────────────────────────────────────────────────────────────────

/** Every runtime export of src/lib/email.ts (all of them are senders). */
export const EMAIL_SENDERS = [
  'sendTestEmail',
  'sendContactMessageEmail',
  'sendNewQuoteRequestAdminNotification',
  'sendQuoteRequestReceivedEmail',
  'sendQuoteOfferEmail',
  'sendNewBookingAdminNotification',
  'sendBookingStatusEmail',
  'sendRepeatDiscountEmail',
  'sendReviewRequestEmail',
  'sendSurveyDiscountEmail',
  'sendPaymentRetryEmail',
  'sendBookingExpiredEmail',
  'sendBookingReminderEmail',
] as const;

export type EmailSender = (typeof EMAIL_SENDERS)[number];

export interface SentEmail {
  fn: EmailSender;
  args: unknown[];
}

/** Shared recorder. `sent` is every call, in order. */
export const emailMock = {
  sent: [] as SentEmail[],
  reset(): void {
    emailMock.sent.length = 0;
  },
  /** Everything recorded for one sender. */
  by(fn: EmailSender): SentEmail[] {
    return emailMock.sent.filter((s) => s.fn === fn);
  },
};

/**
 * Replacement for '@/lib/email' — every sender becomes a recording stub.
 * Nothing leaves the process; nodemailer is never constructed.
 */
export function mockEmail(): Record<string, unknown> {
  emailMock.reset();
  const mod: Record<string, unknown> = {};
  for (const fn of EMAIL_SENDERS) {
    mod[fn] = vi.fn(async (...args: unknown[]) => {
      emailMock.sent.push({ fn, args });
      return true; // sendContactMessageEmail is the only one whose result is read
    });
  }
  return mod;
}

// ── Stripe ───────────────────────────────────────────────────────────────────

/**
 * Build the `stripe-signature` header for `payload`, using Stripe's real
 * scheme: `t=<unix>,v1=<HMAC-SHA256 of "<t>.<payload>">`.
 *
 * The REAL stripe package verifies this, so `verifyStripeWebhook` can be
 * exercised unmodified against a webhook secret seeded into AppConfig — no
 * module mock required, which is the point.
 */
export function signedEvent(payload: string, secret: string, timestampSec?: number): string {
  const t = timestampSec ?? Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${signature}`;
}

/** A minimal Stripe event envelope, JSON-encoded, ready for `signedEvent`. */
export function stripeEventPayload(
  type: string,
  object: Record<string, unknown>,
  id = `evt_test_${Math.random().toString(36).slice(2, 10)}`,
): string {
  return JSON.stringify({
    id,
    object: 'event',
    api_version: '2026-04-22',
    created: Math.floor(Date.now() / 1000),
    type,
    data: { object },
  });
}

export interface StripeMockState {
  /** Every call the fake client received, in order. */
  calls: Array<{ method: string; args: unknown[] }>;
  /** What the fake returns. Mutate before the call under test. */
  responses: {
    checkoutSession: Record<string, unknown>;
    paymentIntent: Record<string, unknown>;
    charge: Record<string, unknown>;
    refund: Record<string, unknown>;
  };
  reset(): void;
  /** Calls for one method, e.g. 'refunds.create'. */
  by(method: string): Array<{ method: string; args: unknown[] }>;
}

function defaultStripeResponses(): StripeMockState['responses'] {
  return {
    checkoutSession: {
      id: 'cs_test_harness',
      object: 'checkout.session',
      status: 'open',
      url: 'https://checkout.stripe.test/c/cs_test_harness',
      payment_intent: 'pi_test_harness',
    },
    paymentIntent: { id: 'pi_test_harness', object: 'payment_intent', status: 'succeeded' },
    charge: {
      id: 'ch_test_harness',
      object: 'charge',
      amount: 100_000,
      amount_refunded: 0,
      refunded: false,
      payment_intent: 'pi_test_harness',
    },
    refund: { id: 're_test_harness', object: 'refund', status: 'succeeded' },
  };
}

export const stripeMock: StripeMockState = {
  calls: [],
  responses: defaultStripeResponses(),
  reset(): void {
    stripeMock.calls.length = 0;
    stripeMock.responses = defaultStripeResponses();
  },
  by(method: string) {
    return stripeMock.calls.filter((c) => c.method === method);
  },
};

class StripeSignatureVerificationError extends Error {
  type = 'StripeSignatureVerificationError';
}
class StripeInvalidRequestError extends Error {
  type = 'StripeInvalidRequestError';
}

/**
 * Replacement for the 'stripe' package. `src/lib/stripe.ts` imports the
 * default export, constructs it with the DB-held secret key, and reads
 * `Stripe.errors.StripeInvalidRequestError` — all three are provided.
 *
 * `webhooks.constructEvent` performs the same HMAC check the real library
 * does, so a mocked test still cannot smuggle an unsigned payload through.
 */
export function mockStripe(): Record<string, unknown> {
  stripeMock.reset();

  const record = (method: string, args: unknown[]) => {
    stripeMock.calls.push({ method, args });
  };

  class FakeStripe {
    static errors = { StripeSignatureVerificationError, StripeInvalidRequestError };
    apiKey: string;

    constructor(apiKey: string) {
      this.apiKey = apiKey;
      record('constructor', [apiKey]);
    }

    checkout = {
      sessions: {
        create: vi.fn(async (...args: unknown[]) => {
          record('checkout.sessions.create', args);
          return stripeMock.responses.checkoutSession;
        }),
        retrieve: vi.fn(async (...args: unknown[]) => {
          record('checkout.sessions.retrieve', args);
          return stripeMock.responses.checkoutSession;
        }),
        expire: vi.fn(async (...args: unknown[]) => {
          record('checkout.sessions.expire', args);
          return { ...stripeMock.responses.checkoutSession, status: 'expired' };
        }),
      },
    };

    paymentIntents = {
      retrieve: vi.fn(async (...args: unknown[]) => {
        record('paymentIntents.retrieve', args);
        return stripeMock.responses.paymentIntent;
      }),
    };

    charges = {
      retrieve: vi.fn(async (...args: unknown[]) => {
        record('charges.retrieve', args);
        return stripeMock.responses.charge;
      }),
      // lib/stripe.ts refundBookingPayment uses charges.list(); keep both.
      list: vi.fn(async (...args: unknown[]) => {
        record('charges.list', args);
        return { object: 'list', data: [stripeMock.responses.charge] };
      }),
    };

    refunds = {
      create: vi.fn(async (...args: unknown[]) => {
        record('refunds.create', args);
        return stripeMock.responses.refund;
      }),
    };

    webhooks = {
      constructEvent: vi.fn((payload: string, header: string, secret: string) => {
        record('webhooks.constructEvent', [payload, header, secret]);
        const parts = Object.fromEntries(
          header.split(',').map((p) => {
            const eq = p.indexOf('=');
            return [p.slice(0, eq).trim(), p.slice(eq + 1).trim()] as [string, string];
          }),
        );
        const expected = createHmac('sha256', secret).update(`${parts.t}.${payload}`).digest('hex');
        if (parts.v1 !== expected) {
          throw new StripeSignatureVerificationError(
            'No signatures found matching the expected signature for payload',
          );
        }
        return JSON.parse(payload);
      }),
    };
  }

  return { default: FakeStripe, Stripe: FakeStripe };
}

// ── Vipps ────────────────────────────────────────────────────────────────────

/** The HTTP-touching exports of src/lib/vipps.ts. Everything else stays real. */
export const VIPPS_HTTP_FUNCTIONS = [
  'getAccessToken',
  'createPayment',
  'getPayment',
  'capturePayment',
  'cancelPayment',
  'refundPayment',
] as const;

export type VippsHttpFunction = (typeof VIPPS_HTTP_FUNCTIONS)[number];

function defaultVippsResponses(): Record<VippsHttpFunction, unknown> {
  return {
    getAccessToken: 'test-access-token',
    createPayment: {
      reference: 'GK-2609-001-ABCDE',
      redirectUrl: 'https://vipps.test/redirect/GK-2609-001-ABCDE',
    },
    getPayment: {
      reference: 'GK-2609-001-ABCDE',
      state: 'AUTHORIZED',
      amount: { currency: 'NOK', value: 100_000 },
    },
    capturePayment: { reference: 'GK-2609-001-ABCDE', state: 'AUTHORIZED' },
    cancelPayment: { reference: 'GK-2609-001-ABCDE', state: 'TERMINATED' },
    refundPayment: { reference: 'GK-2609-001-ABCDE', state: 'AUTHORIZED' },
  };
}

export const vippsMock = {
  calls: [] as Array<{ fn: VippsHttpFunction; args: unknown[] }>,
  /** Per-function return value. Assign a function for dynamic behaviour. */
  responses: defaultVippsResponses(),
  reset(): void {
    vippsMock.calls.length = 0;
    vippsMock.responses = defaultVippsResponses();
  },
  by(fn: VippsHttpFunction) {
    return vippsMock.calls.filter((c) => c.fn === fn);
  },
};

/**
 * Replacement for '@/lib/vipps' that stubs only the six functions that speak
 * HTTP. Pass the real module so the pure helpers (toMinorUnits,
 * verifyWebhookSignature, buildPaymentReference, VippsError, …) stay real:
 *
 * ```ts
 * vi.mock('@/lib/vipps', async (orig) =>
 *   (await import('../helpers/mocks')).mockVipps(await orig()));
 * ```
 */
export function mockVipps(actual: Record<string, unknown>): Record<string, unknown> {
  vippsMock.reset();
  const mod: Record<string, unknown> = { ...actual };
  for (const fn of VIPPS_HTTP_FUNCTIONS) {
    mod[fn] = vi.fn(async (...args: unknown[]) => {
      vippsMock.calls.push({ fn, args });
      const value = vippsMock.responses[fn];
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown)(...args) : value;
    });
  }
  return mod;
}

// ── Geocoding / routing ──────────────────────────────────────────────────────

export interface GeocodeFixture {
  lat: number;
  lng: number;
  displayName: string;
  /** Road distance OSRM should report, in km. */
  distanceKm: number;
}

export const DEFAULT_GEOCODE: GeocodeFixture = {
  lat: 67.2804,
  lng: 14.4049,
  displayName: 'Testveien 1, 8000 Bodø, Norge',
  distanceKm: 12.5,
};

export const geocodeMock = {
  fixture: { ...DEFAULT_GEOCODE },
  /** Every URL the stubbed global fetch was asked for. */
  fetched: [] as string[],
  reset(): void {
    geocodeMock.fetched.length = 0;
    geocodeMock.fixture = { ...DEFAULT_GEOCODE };
  },
};

/**
 * Replacement for '@/lib/geocode' — `geocodeAddress` returns the fixture,
 * `normalizeAddress` (pure) stays real.
 *
 * ```ts
 * vi.mock('@/lib/geocode', async (orig) =>
 *   (await import('../helpers/mocks')).mockGeocode(await orig()));
 * ```
 *
 * `src/app/api/delivery/route.ts` does NOT use this module — it calls
 * Nominatim and OSRM through the global fetch. Use `stubRoutingFetch()` for
 * that path.
 */
export function mockGeocode(actual: Record<string, unknown>): Record<string, unknown> {
  return {
    ...actual,
    geocodeAddress: vi.fn(async (raw: string) => ({
      address: String(raw).replace(/\s+/g, ' ').trim(),
      displayName: geocodeMock.fixture.displayName,
      lat: geocodeMock.fixture.lat,
      lng: geocodeMock.fixture.lng,
      resolvedAt: new Date().toISOString(),
    })),
  };
}

/**
 * Stub the global fetch that `/api/delivery` uses directly: Nominatim for
 * address → coordinates, OSRM for the road distance. Any other URL throws, so
 * a test can never silently reach the network.
 *
 * Safe to call from `beforeEach` — it uses `vi.stubGlobal`, not `vi.mock`, so
 * there is no hoisting to worry about.
 */
export function stubRoutingFetch(fixture: Partial<GeocodeFixture> = {}) {
  geocodeMock.reset();
  Object.assign(geocodeMock.fixture, fixture);

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);
      geocodeMock.fetched.push(url);

      if (url.includes('nominatim.openstreetmap.org')) {
        return new Response(
          JSON.stringify([
            {
              lat: String(geocodeMock.fixture.lat),
              lon: String(geocodeMock.fixture.lng),
              display_name: geocodeMock.fixture.displayName,
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('router.project-osrm.org')) {
        return new Response(
          JSON.stringify({ code: 'Ok', routes: [{ distance: geocodeMock.fixture.distanceKm * 1000 }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`[stubRoutingFetch] unexpected outbound fetch: ${url}`);
    }),
  );

  return {
    state: geocodeMock,
    restore(): void {
      vi.unstubAllGlobals();
      geocodeMock.reset();
    },
  };
}

// ── Clock ────────────────────────────────────────────────────────────────────

/**
 * Freeze the clock at `iso`, in Europe/Oslo. Only `Date` is faked by default —
 * faking `setTimeout` too would stall Prisma's SQLITE_BUSY backoff and any
 * abort-timeout in the routes.
 *
 * ```ts
 * const clock = mockClock('2026-09-06T09:00:00+02:00');
 * … clock.advance(60_000) … clock.restore();
 * ```
 */
export function mockClock(iso: string, toFake: string[] = ['Date']) {
  process.env.TZ = 'Europe/Oslo';
  vi.useFakeTimers({ toFake: toFake as never });
  vi.setSystemTime(new Date(iso));
  return {
    now: () => new Date(),
    set(next: string): void {
      vi.setSystemTime(new Date(next));
    },
    advance(ms: number): void {
      vi.setSystemTime(new Date(Date.now() + ms));
    },
    restore(): void {
      vi.useRealTimers();
    },
  };
}
