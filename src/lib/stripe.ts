import Stripe from 'stripe';
import { db } from '@/lib/db';

// Unpaid-booking retry budget, spent only by the Stripe webhook
// (checkout.session.expired). A booking gets at most this many second-chance
// Checkout sessions before the next expiry cancels it. The cancel-callback
// (GET /api/payment/stripe/cancel) is a pure redirect since audit finding F-3
// and spends nothing; the customer retries from the page, which reuses or
// mints a session through POST /api/payment/stripe/create.
export const MAX_PAYMENT_RETRIES = 1;
export const PAYMENT_GRACE_MS = 30 * 60 * 1000; // 30-min retry window

// Vipps (the Norwegian wallet) is still gated behind a Stripe API preview
// flag: https://docs.stripe.com/payments/vipps/accept-a-payment. Only the
// Checkout Session create call needs it — scoping the override to that one
// request (rather than the whole client) keeps refunds/retrieves on the
// account's stable API version. Stripe only accepts the header for accounts
// enrolled in the beta ("You do not have permission to pass this beta
// header" otherwise), so it is opt-in via the admin toggle
// `stripeVippsPreview` and always falls back to the stable version.
const VIPPS_PREVIEW_API_VERSION = '2026-08-26.preview; vipps_preview=v1';

function isBetaHeaderRejection(err: unknown): boolean {
  return err instanceof Stripe.errors.StripeInvalidRequestError
    && /beta header|Invalid Stripe API version/i.test(err.message);
}

interface StripeConfig {
  enabled: boolean;
  secretKey: string;
  webhookSecret: string;
  vippsPreview: boolean;
}

async function loadStripeConfig(): Promise<StripeConfig> {
  const rows = await db.appConfig.findMany({
    where: { key: { in: ['stripeSecretKey', 'stripeEnabled', 'stripeWebhookSecret', 'stripeVippsPreview'] } },
  });
  const cfg: Record<string, string> = {};
  for (const r of rows) cfg[r.key] = r.value;
  return {
    enabled: cfg.stripeEnabled === 'true',
    secretKey: cfg.stripeSecretKey ?? '',
    webhookSecret: cfg.stripeWebhookSecret ?? '',
    vippsPreview: cfg.stripeVippsPreview === 'true',
  };
}

async function getStripeClient(): Promise<Stripe | null> {
  const cfg = await loadStripeConfig();
  if (!cfg.enabled || !cfg.secretKey) return null;
  return new Stripe(cfg.secretKey);
}

export async function isStripeEnabled(): Promise<boolean> {
  const cfg = await loadStripeConfig();
  return cfg.enabled && cfg.secretKey.trim().length > 0;
}

export type CreateCheckoutResult = { url: string; sessionId: string };

export async function createCheckoutSession(
  bookingId: string,
  amountNOK: number,
  description: string,
  returnBaseUrl: string,
  imageUrl?: string | null,
  expiresInMinutes: number = 60,
  // Customer IP at acceptance time. Carried through Stripe metadata to the
  // webhook so freezeContractForBooking can stamp it on AcceptedContract.
  acceptedFromIp?: string | null,
): Promise<CreateCheckoutResult | null> {
  const stripe = await getStripeClient();
  if (!stripe) return null;
  const { vippsPreview } = await loadStripeConfig();

  // Prefill the customer's e-mail on the hosted page so they don't retype
  // what they just entered in the booking form (one less field, fewer typos
  // in the receipt address). Only pass it when it looks like an address —
  // Stripe rejects the whole session on an invalid customer_email.
  const bookingRow = await db.booking.findUnique({ where: { id: bookingId }, select: { email: true } });
  const customerEmail = bookingRow?.email?.trim() ?? '';
  const prefillEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail) ? customerEmail : null;

  const productImage = imageUrl && /^https?:\/\//i.test(imageUrl) ? imageUrl : null;

  // Caller controls session lifetime (Stripe enforces a 30-minute minimum,
  // 24-hour maximum). Default 60 min for the first attempt; retry flows pass
  // 30 to align with the customer's 30-minute grace window.
  const clampedMinutes = Math.max(30, Math.min(60 * 24, Math.floor(expiresInMinutes)));
  const expiresAtSec = Math.floor(Date.now() / 1000) + clampedMinutes * 60;

  // One metadata bag, stamped on BOTH the Checkout Session and the
  // PaymentIntent that Checkout creates for it. See payment_intent_data below.
  const paymentMetadata: Record<string, string> = {
    bookingId,
    ...(acceptedFromIp ? { acceptedFromIp } : {}),
  };

  const params: Stripe.Checkout.SessionCreateParams = {
    mode: 'payment',
    expires_at: expiresAtSec,
    line_items: [
      {
        price_data: {
          currency: 'nok',
          // Stripe requires an integer minor unit (øre). Round defensively so
          // a fractional-kr total (e.g. from a future percentage discount)
          // can never produce a non-integer unit_amount.
          unit_amount: Math.round(amountNOK * 100),
          product_data: {
            name: description,
            ...(productImage ? { images: [productImage] } : {}),
          },
        },
        quantity: 1,
      },
    ],
    metadata: paymentMetadata,
    // Checkout does NOT copy session metadata onto the PaymentIntent it
    // creates. Without this, every PaymentIntent-scoped webhook — today
    // `payment_intent.payment_failed` — arrives with an empty metadata bag,
    // reads no bookingId and returns early, so the card-decline audit row was
    // never written in production. (The unit test passed because it hand-built
    // a PI carrying metadata that real Stripe traffic never has.) Stamping the
    // same bag here is what lets those handlers resolve the booking.
    payment_intent_data: { metadata: paymentMetadata },
    ...(prefillEmail ? { customer_email: prefillEmail } : {}),
    // The site is Norwegian-only; keep the hosted page in the same language
    // instead of following the browser locale.
    locale: 'nb',
    success_url: `${returnBaseUrl}/api/payment/stripe/callback?session_id={CHECKOUT_SESSION_ID}&bid=${encodeURIComponent(bookingId)}`,
    cancel_url: `${returnBaseUrl}/api/payment/stripe/cancel?bid=${encodeURIComponent(bookingId)}`,
  };

  let session: Stripe.Checkout.Session;
  if (vippsPreview) {
    try {
      session = await stripe.checkout.sessions.create(params, { apiVersion: VIPPS_PREVIEW_API_VERSION });
    } catch (err) {
      if (!isBetaHeaderRejection(err)) throw err;
      // Account not (yet) enrolled in the Vipps beta. A payment must never
      // fail because of an optional wallet, so retry on the stable version
      // and shout so the admin turns the toggle off or asks Stripe for access.
      console.warn(
        '[stripe] Vipps preview header rejected by Stripe — falling back to the stable API version. ' +
        'Disable "Vipps via Stripe (forhåndsvisning)" in admin until Stripe grants the vipps_preview beta.',
      );
      session = await stripe.checkout.sessions.create(params);
    }
  } else {
    session = await stripe.checkout.sessions.create(params);
  }

  // Mirror the Stripe expiry on the booking's paymentDeadline (plus a small
  // buffer for clock skew + webhook transit). This keeps cleanup aligned
  // with Stripe — the booking can never auto-cancel while the customer is
  // still in a live Checkout session.
  const deadlineMs = expiresAtSec * 1000 + 2 * 60 * 1000;
  await db.booking.update({
    where: { id: bookingId },
    data: {
      stripeSessionId: session.id,
      paymentDeadline: new Date(deadlineMs),
    },
  });

  return { url: session.url!, sessionId: session.id };
}

/** Return the URL of the booking's existing Stripe Checkout session iff it
 *  is still valid (status='open', not expired). Returns null otherwise —
 *  the caller should mint a new session via createCheckoutSession.
 *
 *  Eliminates the previous footgun of POST /api/payment/stripe/create
 *  always minting a new session: a customer who clicked "Pay" twice (or
 *  whose browser retried) would end up with two parallel live sessions
 *  for the same booking, generating two webhook event streams. With reuse,
 *  the booking has at most one live session at any time. */
export async function getLiveCheckoutSessionUrl(bookingId: string): Promise<CreateCheckoutResult | null> {
  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    select: { stripeSessionId: true, paymentDeadline: true },
  });
  if (!booking?.stripeSessionId) return null;
  if (booking.paymentDeadline && booking.paymentDeadline < new Date()) return null;

  const stripe = await getStripeClient();
  if (!stripe) return null;

  try {
    const session = await stripe.checkout.sessions.retrieve(booking.stripeSessionId);
    // status: 'open' = still payable; 'expired' / 'complete' = done.
    if (session.status === 'open' && session.url) {
      return { url: session.url, sessionId: session.id };
    }
    return null;
  } catch (err) {
    // If retrieve fails (deleted, network blip, key rotated), fall through
    // so the caller creates a fresh session. Safer than 500'ing the user.
    console.warn('[stripe] could not retrieve existing session, will create new:', err);
    return null;
  }
}

/** Pull the PaymentMethod.type used to pay this Checkout session.
 *  Returns 'card' / 'vipps' / etc. on success; null when:
 *   - Stripe isn't configured
 *   - the session has no payment_intent yet (e.g. checkout still open)
 *   - the payment_intent has no payment_method attached
 *   - the retrieve fails (logs + null, not throw — caller should tolerate).
 *  Used by the confirm path (webhook + callback) so admin/CSV/email can
 *  show how the customer paid. */
export async function getSessionPaymentMethodType(sessionId: string): Promise<string | null> {
  const stripe = await getStripeClient();
  if (!stripe) return null;
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent.payment_method'],
    });
    const pi = session.payment_intent;
    if (!pi || typeof pi === 'string') return null;
    const pm = pi.payment_method;
    if (!pm || typeof pm === 'string') return null;
    return pm.type ?? null;
  } catch (err) {
    console.warn('[stripe] getSessionPaymentMethodType failed:', err);
    return null;
  }
}

export async function refundBookingPayment(
  booking: {
    id: string;
    totalPrice: number;
    cancellationFee: number | null;
    stripePaymentIntentId: string | null;
    stripeRefundId: string | null;
    refundAmount: number | null;
    fullyPaidAt: Date | null;
  }
): Promise<{ refundId: string; amountRefunded: number } | null> {
  const stripe = await getStripeClient();
  if (!stripe) return null;

  if (!booking.fullyPaidAt) return null;
  if (!booking.stripePaymentIntentId) return null;

  // Target: everything above the cancellation fee, minus whatever has
  // already gone back — our own earlier refund, or a partial refund the
  // admin issued from the Stripe dashboard (recorded on the booking by the
  // charge.refunded webhook). A fully refunded booking short-circuits here,
  // which is what makes this safe to call on every cancel.
  const fee = booking.cancellationFee ?? 0;
  const alreadyRefundedKr = booking.refundAmount ?? 0;
  const refundAmountNOK = booking.totalPrice - fee - alreadyRefundedKr;
  if (refundAmountNOK <= 0) return null;

  const pi = await stripe.paymentIntents.retrieve(booking.stripePaymentIntentId);
  if (pi.status !== 'succeeded') return null;

  const charges = await stripe.charges.list({ payment_intent: booking.stripePaymentIntentId, limit: 1 });
  const charge = charges.data[0];
  if (!charge || charge.refunded) return null;

  const maxRefundable = charge.amount - charge.amount_refunded;
  const refundAmountOre = Math.min(Math.round(refundAmountNOK * 100), maxRefundable);
  if (refundAmountOre <= 0) return null;

  const refund = await stripe.refunds.create(
    {
      payment_intent: booking.stripePaymentIntentId,
      amount: refundAmountOre,
      reason: 'requested_by_customer',
    },
    // Keyed on the amount as well: a retry of the same top-up returns the
    // same refund, while a later, different top-up (after a partial
    // dashboard refund) is a new request rather than an idempotency clash.
    { idempotencyKey: `refund-${booking.id}-${refundAmountOre}` },
  );

  await db.booking.update({
    where: { id: booking.id },
    data: {
      stripeRefundId: refund.id,
      refundAmount: alreadyRefundedKr + Math.round(refundAmountOre / 100),
    },
  });

  return { refundId: refund.id, amountRefunded: Math.round(refundAmountOre / 100) };
}

export async function verifyStripeWebhook(
  payload: string,
  signature: string,
): Promise<Stripe.Event | null> {
  const cfg = await loadStripeConfig();
  if (!cfg.webhookSecret || !cfg.secretKey) return null;
  const stripe = new Stripe(cfg.secretKey);
  try {
    return stripe.webhooks.constructEvent(payload, signature, cfg.webhookSecret);
  } catch {
    return null;
  }
}
