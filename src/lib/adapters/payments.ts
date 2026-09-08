// Payments adapter — Stripe today.
//
// The interface this module exposes is the contract the rest of the app
// depends on. The current implementation lives in `lib/stripe.ts`. Future
// migration to a different processor (Adyen, Klarna direct, etc.) replaces
// just this file's re-exports — callers stay unchanged.
//
// Adapter contract:
//   isPaymentsEnabled()       → boolean       — feature flag
//   createCheckoutSession(...) → { url, sessionId } | null
//   getLiveCheckoutSessionUrl(bookingId) → { url, sessionId } | null
//   refundBookingPayment(booking) → { refundId, amountRefunded } | null
//   verifyWebhookSignature(payload, sig) → Event | null
//
// What "deciding to swap" looks like:
//   1. Implement the contract in `lib/adyen.ts` (or wherever).
//   2. Change the four re-exports below to point at it.
//   3. Run the test suite + the e2e booking happy-path test.
//
// Webhook event shape is provider-specific, so the swap also requires
// updating /api/payment/<provider>/webhook to translate the new shape
// into the same domain actions (`confirmBookingPaidFromStripe`).

export {
  isStripeEnabled as isPaymentsEnabled,
  createCheckoutSession,
  getLiveCheckoutSessionUrl,
  refundBookingPayment,
  verifyStripeWebhook as verifyWebhookSignature,
  type CreateCheckoutResult,
} from '@/lib/stripe';
