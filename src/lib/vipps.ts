// Vipps MobilePay ePayment API v1 client.
//
// Docs: https://developer.vippsmobilepay.com/docs/APIs/epayment-api/
//
// Deliberately dependency-free and credential-agnostic: every call takes an
// explicit `VippsCredentials` so the caller decides whether those come from
// AppConfig or the environment. Nothing here reads config or touches the DB.
//
// Amounts on the wire are in MINOR units (øre). Everything in this app stores
// kroner, so conversion happens at the boundary via `toMinorUnits()` — never
// pass a kroner value straight into `amount.value`.

import { createHash, createHmac, timingSafeEqual } from 'crypto';

export interface VippsCredentials {
  clientId: string;
  clientSecret: string;
  subscriptionKey: string;
  /** Merchant Serial Number (sales unit id). */
  msn: string;
  environment: 'test' | 'production';
}

export type VippsPaymentState =
  | 'CREATED'
  | 'AUTHORIZED'
  | 'ABORTED'
  | 'EXPIRED'
  | 'TERMINATED';

export interface VippsAmount {
  currency: string;
  value: number;
}

export interface VippsPayment {
  reference: string;
  state: VippsPaymentState;
  pspReference?: string;
  amount: VippsAmount;
  aggregate?: {
    authorizedAmount?: VippsAmount;
    capturedAmount?: VippsAmount;
    refundedAmount?: VippsAmount;
    cancelledAmount?: VippsAmount;
  };
  paymentMethod?: { type?: string };
}

const BASE_URLS: Record<VippsCredentials['environment'], string> = {
  test: 'https://apitest.vipps.no',
  production: 'https://api.vipps.no',
};

// Sent on every call so Vipps support can identify traffic from this app.
// See "HTTP headers" in the API guide — these are required for partners and
// recommended for everyone else.
const SYSTEM_HEADERS: Record<string, string> = {
  'Vipps-System-Name': 'graveklar',
  'Vipps-System-Version': '1.0.0',
  'Vipps-System-Plugin-Name': 'graveklar-booking',
  'Vipps-System-Plugin-Version': '1.0.0',
};

export function vippsBaseUrl(creds: VippsCredentials): string {
  return BASE_URLS[creds.environment];
}

/** Kroner → øre. Rounds to avoid float dust (299.5 * 100 = 29949.999...). */
export function toMinorUnits(kroner: number): number {
  return Math.round(kroner * 100);
}

/** øre → kroner. */
export function fromMinorUnits(minor: number): number {
  return minor / 100;
}

export class VippsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'VippsError';
  }
}

// ── Access token ────────────────────────────────────────────────────────────
// Tokens last ~1 hour. Cached per credential set (a key change or an env
// switch must not reuse the old token), refreshed 60s before expiry.

interface CachedToken {
  token: string;
  expiresAt: number;
}
const tokenCache = new Map<string, CachedToken>();

function cacheKey(creds: VippsCredentials): string {
  // Hashed so the raw client secret never sits in a map key that might end up
  // in a heap dump or log line.
  return createHash('sha256')
    .update(`${creds.environment}:${creds.clientId}:${creds.msn}:${creds.clientSecret}`)
    .digest('hex');
}

export function clearVippsTokenCache(): void {
  tokenCache.clear();
}

export async function getAccessToken(creds: VippsCredentials): Promise<string> {
  const key = cacheKey(creds);
  const cached = tokenCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const res = await fetch(`${vippsBaseUrl(creds)}/accesstoken/get`, {
    method: 'POST',
    headers: {
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      'Ocp-Apim-Subscription-Key': creds.subscriptionKey,
      'Merchant-Serial-Number': creds.msn,
      'Content-Type': 'application/json',
      ...SYSTEM_HEADERS,
    },
    body: '',
  });

  const body = await safeJson(res);
  if (!res.ok) {
    throw new VippsError('Kunne ikke hente Vipps-token', res.status, body);
  }

  const token = (body as { access_token?: string }).access_token;
  if (!token) throw new VippsError('Vipps-token manglet i svaret', 502, body);

  // `expires_in` is seconds and arrives as a string in some responses.
  const expiresIn = Number((body as { expires_in?: string | number }).expires_in) || 3600;
  tokenCache.set(key, {
    token,
    expiresAt: Date.now() + Math.max(60, expiresIn - 60) * 1000,
  });

  return token;
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function authedFetch(
  creds: VippsCredentials,
  path: string,
  init: { method: string; body?: unknown; idempotencyKey?: string },
): Promise<unknown> {
  const token = await getAccessToken(creds);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Ocp-Apim-Subscription-Key': creds.subscriptionKey,
    'Merchant-Serial-Number': creds.msn,
    'Content-Type': 'application/json',
    ...SYSTEM_HEADERS,
  };
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;

  const res = await fetch(`${vippsBaseUrl(creds)}${path}`, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const body = await safeJson(res);
  if (!res.ok) {
    // Vipps returns RFC 7807 problem details; surface the detail for the audit
    // log but never echo it to the customer.
    const detail =
      body && typeof body === 'object' && 'detail' in body
        ? String((body as { detail: unknown }).detail)
        : `HTTP ${res.status}`;
    throw new VippsError(`Vipps ${init.method} ${path} feilet: ${detail}`, res.status, body);
  }
  return body;
}

// ── Payment operations ──────────────────────────────────────────────────────

export interface CreatePaymentInput {
  /** Unique per MSN. a-zA-Z0-9- only, 8–64 chars. Never reuse across attempts. */
  reference: string;
  /** Amount in KRONER — converted to øre internally. */
  amountKroner: number;
  currency?: string;
  /** Shown in the Vipps app. Max 100 chars. */
  paymentDescription: string;
  /** Where Vipps sends the user after they approve or cancel. */
  returnUrl: string;
  /** Optional prefill so the user doesn't retype their number. */
  phoneNumber?: string;
  idempotencyKey: string;
}

export interface CreatePaymentResult {
  reference: string;
  redirectUrl: string;
}

export async function createPayment(
  creds: VippsCredentials,
  input: CreatePaymentInput,
): Promise<CreatePaymentResult> {
  const body: Record<string, unknown> = {
    amount: {
      currency: input.currency || 'NOK',
      value: toMinorUnits(input.amountKroner),
    },
    paymentMethod: { type: 'WALLET' },
    reference: input.reference,
    returnUrl: input.returnUrl,
    userFlow: 'WEB_REDIRECT',
    // Truncated defensively — Vipps rejects overlong descriptions.
    paymentDescription: input.paymentDescription.slice(0, 100),
  };
  if (input.phoneNumber) {
    body.customer = { phoneNumber: input.phoneNumber };
  }

  const res = (await authedFetch(creds, '/epayment/v1/payments', {
    method: 'POST',
    body,
    idempotencyKey: input.idempotencyKey,
  })) as { reference?: string; redirectUrl?: string };

  if (!res?.redirectUrl) {
    throw new VippsError('Vipps returnerte ingen redirectUrl', 502, res);
  }
  return { reference: res.reference || input.reference, redirectUrl: res.redirectUrl };
}

export async function getPayment(
  creds: VippsCredentials,
  reference: string,
): Promise<VippsPayment> {
  return (await authedFetch(creds, `/epayment/v1/payments/${encodeURIComponent(reference)}`, {
    method: 'GET',
  })) as VippsPayment;
}

/**
 * Capture an authorized payment. Vipps only RESERVES funds on authorization —
 * without a capture the money is never actually taken, and the reservation
 * expires. Safe to call repeatedly with the same idempotency key.
 */
export async function capturePayment(
  creds: VippsCredentials,
  reference: string,
  amountKroner: number,
  idempotencyKey: string,
  currency = 'NOK',
): Promise<VippsPayment> {
  return (await authedFetch(
    creds,
    `/epayment/v1/payments/${encodeURIComponent(reference)}/capture`,
    {
      method: 'POST',
      body: { modificationAmount: { currency, value: toMinorUnits(amountKroner) } },
      idempotencyKey,
    },
  )) as VippsPayment;
}

/** Release an uncaptured reservation. Fails once fully captured — refund then. */
export async function cancelPayment(
  creds: VippsCredentials,
  reference: string,
  idempotencyKey: string,
): Promise<VippsPayment> {
  return (await authedFetch(
    creds,
    `/epayment/v1/payments/${encodeURIComponent(reference)}/cancel`,
    { method: 'POST', idempotencyKey },
  )) as VippsPayment;
}

export async function refundPayment(
  creds: VippsCredentials,
  reference: string,
  amountKroner: number,
  idempotencyKey: string,
  currency = 'NOK',
): Promise<VippsPayment> {
  return (await authedFetch(
    creds,
    `/epayment/v1/payments/${encodeURIComponent(reference)}/refund`,
    {
      method: 'POST',
      body: { modificationAmount: { currency, value: toMinorUnits(amountKroner) } },
      idempotencyKey,
    },
  )) as VippsPayment;
}

// ── Webhooks ────────────────────────────────────────────────────────────────

export const VIPPS_WEBHOOK_EVENTS = [
  'epayments.payment.authorized.v1',
  'epayments.payment.aborted.v1',
  'epayments.payment.expired.v1',
  'epayments.payment.cancelled.v1',
  'epayments.payment.captured.v1',
  'epayments.payment.refunded.v1',
  'epayments.payment.terminated.v1',
] as const;

export interface RegisteredWebhook {
  id: string;
  /** Returned ONCE, at registration. Store it — it can't be read back later. */
  secret: string;
}

export async function registerWebhook(
  creds: VippsCredentials,
  url: string,
  events: readonly string[] = VIPPS_WEBHOOK_EVENTS,
): Promise<RegisteredWebhook> {
  return (await authedFetch(creds, '/webhooks/v1/webhooks', {
    method: 'POST',
    body: { url, events },
  })) as RegisteredWebhook;
}

export async function listWebhooks(
  creds: VippsCredentials,
): Promise<{ webhooks: { id: string; url: string; events: string[] }[] }> {
  return (await authedFetch(creds, '/webhooks/v1/webhooks', { method: 'GET' })) as {
    webhooks: { id: string; url: string; events: string[] }[];
  };
}

export async function deleteWebhook(creds: VippsCredentials, id: string): Promise<void> {
  await authedFetch(creds, `/webhooks/v1/webhooks/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export interface VippsWebhookPayload {
  msn: string;
  reference: string;
  pspReference: string;
  /** CREATED | AUTHORIZED | CAPTURED | REFUNDED | CANCELLED | ABORTED | EXPIRED | TERMINATED */
  name: string;
  amount: VippsAmount;
  timestamp: string;
  success: boolean;
  idempotencyKey?: string | null;
}

export interface WebhookVerificationInput {
  method: string;
  /** Path AND query exactly as received, e.g. "/api/payment/vipps/webhook". */
  pathWithQuery: string;
  /** Raw request body — must be the exact bytes, not a re-serialized object. */
  rawBody: string;
  headers: {
    authorization?: string | null;
    xMsDate?: string | null;
    xMsContentSha256?: string | null;
    host?: string | null;
  };
  secret: string;
}

/**
 * Verify an incoming webhook per the Webhooks API authentication scheme:
 *
 *   signed string = "{METHOD}\n{PATH_AND_QUERY}\n{DATE};{HOST};{CONTENT_SHA256}"
 *   signature     = base64(HMAC-SHA256(signed string, webhook secret))
 *
 * and the Authorization header carries `...&Signature=<signature>`.
 *
 * Returns false rather than throwing — the caller answers 401 either way, and
 * a thrown error inside a webhook handler risks leaking detail in the response.
 */
export function verifyWebhookSignature(input: WebhookVerificationInput): boolean {
  const { authorization, xMsDate, xMsContentSha256, host } = input.headers;
  if (!authorization || !xMsDate || !xMsContentSha256 || !host || !input.secret) {
    return false;
  }

  // 1. The body must hash to exactly what the header claims, or the signature
  //    would be validating a body we never saw.
  const computedHash = createHash('sha256').update(input.rawBody, 'utf8').digest('base64');
  if (!constantTimeEquals(computedHash, xMsContentSha256)) return false;

  // 2. Rebuild the canonical string and sign it.
  const signedString = `${input.method.toUpperCase()}\n${input.pathWithQuery}\n${xMsDate};${host};${xMsContentSha256}`;
  const expected = createHmac('sha256', Buffer.from(input.secret, 'utf8'))
    .update(signedString, 'utf8')
    .digest('base64');

  // 3. Pull the signature out of `HMAC-SHA256 SignedHeaders=...&Signature=xxx`.
  const match = /Signature=([^&\s,]+)/i.exec(authorization);
  if (!match) return false;

  return constantTimeEquals(expected, match[1]);
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, so compare lengths first — the
  // length itself is not secret.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ── References ──────────────────────────────────────────────────────────────

const REFERENCE_RE = /^[a-zA-Z0-9-]{8,64}$/;

export function isValidVippsReference(reference: string): boolean {
  return REFERENCE_RE.test(reference);
}

/**
 * Build a Vipps payment reference from a booking reference.
 *
 * References must be unique per sales unit FOREVER, so a retry (customer
 * abandoned the first attempt and started over) cannot reuse the previous one.
 * `attempt` is appended to keep the booking reference greppable in the Vipps
 * portal while staying unique.
 */
export function buildPaymentReference(bookingReference: string, attempt: number): string {
  const base = bookingReference.replace(/[^a-zA-Z0-9-]/g, '');
  const suffix = attempt > 1 ? `-r${attempt}` : '';
  const reference = `${base}${suffix}`;
  if (!isValidVippsReference(reference)) {
    throw new Error(`Ugyldig Vipps-referanse utledet fra "${bookingReference}"`);
  }
  return reference;
}
