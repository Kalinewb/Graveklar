/**
 * Payment-flow helpers for the Phase 1c audit (areas F + G).
 *
 * Nothing here calls `vi.mock` — same rule as helpers/mocks.ts. These are
 * plain builders: config bundles, signed webhook envelopes, and thin wrappers
 * that invoke the real route handlers through `call()`.
 *
 * Every Stripe envelope is signed with the real HMAC scheme (`signedEvent`),
 * and every Vipps envelope with the real Webhooks-API canonical string, so the
 * verification code under test runs unmocked.
 */
import { createHash, createHmac } from 'node:crypto';

import { signedEvent, stripeEventPayload } from './mocks';
import { call, type CallResult } from './route';

// ── Config bundles ───────────────────────────────────────────────────────────

export const STRIPE_WEBHOOK_SECRET = 'whsec_audit_1c';
export const VIPPS_WEBHOOK_SECRET = 'vipps-webhook-secret-audit-1c';
export const SITE_URL = 'http://localhost:3001';

/** AppConfig overrides that switch Stripe on with test credentials. */
export const STRIPE_CONFIG: Record<string, string> = {
  stripeEnabled: 'true',
  stripeSecretKey: 'sk_test_audit1c',
  stripeWebhookSecret: STRIPE_WEBHOOK_SECRET,
  siteUrl: SITE_URL,
};

/** AppConfig overrides that switch Vipps on with complete test credentials. */
export const VIPPS_CONFIG: Record<string, string> = {
  vippsEnabled: 'true',
  vippsEnvironment: 'test',
  vippsClientId: 'audit-client-id',
  vippsClientSecret: 'audit-client-secret',
  vippsSubscriptionKey: 'audit-subscription-key',
  vippsMsn: '123456',
  vippsWebhookSecret: VIPPS_WEBHOOK_SECRET,
  siteUrl: SITE_URL,
};

/** Both providers on at once — the shape production actually runs. */
export const BOTH_PROVIDERS_CONFIG: Record<string, string> = {
  ...STRIPE_CONFIG,
  ...VIPPS_CONFIG,
};

// ── Stripe ───────────────────────────────────────────────────────────────────

export interface StripeEventEnvelope {
  id: string;
  payload: string;
}

let eventSeq = 0;

/** A JSON event envelope plus the id it carries, so a replay can reuse it. */
export function buildStripeEvent(
  type: string,
  object: Record<string, unknown>,
  id = `evt_audit1c_${++eventSeq}`,
): StripeEventEnvelope {
  return { id, payload: stripeEventPayload(type, object, id) };
}

/** A minimal `checkout.session` object with our metadata contract. */
export function checkoutSession(
  bookingId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'cs_test_audit1c',
    object: 'checkout.session',
    status: 'complete',
    payment_status: 'paid',
    payment_intent: 'pi_test_audit1c',
    metadata: { bookingId },
    ...overrides,
  };
}

/** POST a pre-built envelope at the real Stripe webhook route. */
export async function postStripeEnvelope(
  envelope: StripeEventEnvelope,
  opts: { secret?: string; signature?: string } = {},
): Promise<CallResult> {
  const { POST } = await import('@/app/api/payment/stripe/webhook/route');
  const signature =
    opts.signature ?? signedEvent(envelope.payload, opts.secret ?? STRIPE_WEBHOOK_SECRET);
  return call(POST, {
    method: 'POST',
    path: '/api/payment/stripe/webhook',
    body: envelope.payload,
    headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
  });
}

/** Build + post in one step. Returns the response and the envelope used. */
export async function postStripeEvent(
  type: string,
  object: Record<string, unknown>,
  opts: { id?: string; secret?: string } = {},
): Promise<{ res: CallResult; envelope: StripeEventEnvelope }> {
  const envelope = buildStripeEvent(type, object, opts.id);
  const res = await postStripeEnvelope(envelope, { secret: opts.secret });
  return { res, envelope };
}

// ── Vipps ────────────────────────────────────────────────────────────────────

export const VIPPS_WEBHOOK_PATH = '/api/payment/vipps/webhook';

/** A webhook body in the shape lib/vipps.ts documents. */
export function vippsWebhookBody(
  name: string,
  reference: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    msn: VIPPS_CONFIG.vippsMsn,
    reference,
    pspReference: `psp_${reference}`,
    name,
    amount: { currency: 'NOK', value: 249000 },
    timestamp: new Date().toISOString(),
    success: true,
    ...overrides,
  };
}

export interface VippsSignOptions {
  secret?: string;
  host?: string;
  date?: string;
  pathWithQuery?: string;
  method?: string;
  /** Sign a different body than the one actually sent (tamper tests). */
  signedBody?: string;
}

/**
 * The four headers `verifyWebhookSignature` reads, built with the documented
 * canonical string:
 *   "{METHOD}\n{PATH_AND_QUERY}\n{DATE};{HOST};{CONTENT_SHA256}"
 */
export function vippsWebhookHeaders(
  rawBody: string,
  opts: VippsSignOptions = {},
): Record<string, string> {
  const secret = opts.secret ?? VIPPS_WEBHOOK_SECRET;
  const host = opts.host ?? 'localhost:3001';
  const date = opts.date ?? new Date().toUTCString();
  const pathWithQuery = opts.pathWithQuery ?? VIPPS_WEBHOOK_PATH;
  const method = (opts.method ?? 'POST').toUpperCase();

  const contentSha = createHash('sha256')
    .update(opts.signedBody ?? rawBody, 'utf8')
    .digest('base64');
  const signedString = `${method}\n${pathWithQuery}\n${date};${host};${contentSha}`;
  const signature = createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(signedString, 'utf8')
    .digest('base64');

  return {
    authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`,
    'x-ms-date': date,
    'x-ms-content-sha256': contentSha,
    host,
    'content-type': 'application/json',
  };
}

/** POST a signed body at the real Vipps webhook route. */
export async function postVippsWebhook(
  body: Record<string, unknown> | string,
  opts: VippsSignOptions & { headers?: Record<string, string> } = {},
): Promise<CallResult> {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const { POST } = await import('@/app/api/payment/vipps/webhook/route');
  return call(POST, {
    method: 'POST',
    path: VIPPS_WEBHOOK_PATH,
    body: raw,
    headers: { ...vippsWebhookHeaders(raw, opts), ...(opts.headers ?? {}) },
  });
}

/** A `getPayment` response for the Vipps mock. */
export function vippsPayment(
  reference: string,
  state: string,
  amounts: {
    amount?: number;
    authorized?: number;
    captured?: number;
    refunded?: number;
  } = {},
): Record<string, unknown> {
  const value = amounts.amount ?? amounts.authorized ?? 0;
  return {
    reference,
    state,
    pspReference: `psp_${reference}`,
    amount: { currency: 'NOK', value },
    aggregate: {
      ...(amounts.authorized !== undefined
        ? { authorizedAmount: { currency: 'NOK', value: amounts.authorized } }
        : {}),
      ...(amounts.captured !== undefined
        ? { capturedAmount: { currency: 'NOK', value: amounts.captured } }
        : {}),
      ...(amounts.refunded !== undefined
        ? { refundedAmount: { currency: 'NOK', value: amounts.refunded } }
        : {}),
    },
  };
}

// ── Misc ─────────────────────────────────────────────────────────────────────

let ipSeq = 0;

/**
 * A fresh client IP. The route rate limiters are module singletons that live
 * for the whole test file, so every test that must not inherit another test's
 * budget asks for its own address.
 */
export function freshIp(): string {
  ipSeq += 1;
  return `203.0.113.${ipSeq % 250}`;
}

/**
 * Client-address headers for `call()`. Both are set to the same fresh
 * address: the limiters key on `clientIdentity()` (last X-Forwarded-For hop,
 * never X-Real-IP), and older assertions may still read the other one.
 */
export function ipHeaders(ip = freshIp()): Record<string, string> {
  return { 'x-forwarded-for': ip, 'x-real-ip': ip };
}

/**
 * Wait for a condition that a fire-and-forget side effect will satisfy (the
 * review-request IIFE in `updateBookingStatus`, an un-awaited email).
 *
 * Iteration-counted rather than deadline-based on purpose: `mockClock` freezes
 * `Date`, so a `Date.now()` deadline would never expire.
 */
export async function waitFor(
  check: () => boolean | Promise<boolean>,
  { tries = 100, intervalMs = 10, what = 'condition' } = {},
): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor: ${what} never became true`);
}

/** Let already-queued microtasks and un-awaited promises run. */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
