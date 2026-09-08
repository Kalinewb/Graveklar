// Booking-aware Vipps operations. lib/vipps.ts speaks HTTP to Vipps and knows
// nothing about this app; this module is the layer that maps a Booking onto
// that client and owns the money-moving decisions.
//
// The critical invariant: `settleAuthorizedPayment` is the ONE path that turns
// an authorized reservation into a captured, confirmed booking, and both the
// webhook and the browser return URL call it. It is safe to run concurrently
// and repeatedly — Vipps idempotency keys make the capture a no-op on replay,
// and updateBookingStatus does an atomic compare-and-set on the status.

import type { Booking } from '@prisma/client';
import { db } from '@/lib/db';
import { loadAppConfig } from '@/lib/app-config';
import { writeAuditLog } from '@/lib/audit-log';
import { confirmBookingPaidFromStripe } from '@/lib/booking-service';
import { requireVippsCredentials } from '@/lib/vipps-config';
import {
  buildPaymentReference,
  capturePayment,
  createPayment,
  getPayment,
  refundPayment,
  toMinorUnits,
  type VippsPayment,
} from '@/lib/vipps';

/** How long a customer has to complete a Vipps payment before we sweep it. */
export const VIPPS_PAYMENT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Start a Vipps payment for a pending booking and return the URL to send the
 * customer to.
 *
 * The amount comes from `booking.totalPrice` and nothing else — that column is
 * written by createPendingBooking after the server-side price/MVA/discount
 * reconciliation, and is the only authoritative charge amount in the system.
 */
export async function createVippsPaymentForBooking(
  booking: Booking,
  origin: string,
): Promise<{ url: string; reference: string }> {
  const creds = await requireVippsCredentials();

  // A reference is burned per attempt: Vipps requires global uniqueness per
  // sales unit, so a retry after an abandoned attempt must not reuse it.
  const attempt = booking.paymentRetries + 1;
  const reference = buildPaymentReference(booking.reference, attempt);

  const appConfig = await loadAppConfig();
  const businessName = appConfig['businessName'] || 'Graveklar';

  const result = await createPayment(creds, {
    reference,
    amountKroner: booking.totalPrice,
    paymentDescription: `${businessName} – ${booking.reference}`,
    returnUrl: `${origin}/api/payment/vipps/return?ref=${encodeURIComponent(reference)}`,
    phoneNumber: normalizeNorwegianPhone(booking.phone),
    // Distinct from the payment reference so a retried create (network blip)
    // doesn't produce a second payment for the same attempt.
    idempotencyKey: `create-${booking.id}-${attempt}`,
  });

  await db.booking.update({
    where: { id: booking.id },
    data: {
      paymentProvider: 'vipps',
      vippsReference: reference,
      vippsState: 'CREATED',
      paymentDeadline: new Date(Date.now() + VIPPS_PAYMENT_WINDOW_MS),
    },
  });

  return { url: result.redirectUrl, reference };
}

/**
 * Vipps wants MSISDN without '+' or spaces: 4712345678. Returns undefined for
 * anything that doesn't look like a Norwegian mobile number rather than
 * sending junk — the field is only a convenience prefill.
 */
function normalizeNorwegianPhone(phone: string | null | undefined): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 8) return `47${digits}`;
  if (digits.length === 10 && digits.startsWith('47')) return digits;
  return undefined;
}

export type SettleOutcome =
  | { status: 'confirmed'; booking: Booking }
  | { status: 'already_handled'; booking: Booking }
  | { status: 'pending'; state: string }
  | { status: 'failed'; state: string }
  | { status: 'unknown_reference' }
  | { status: 'amount_mismatch'; expectedKr: number; authorizedKr: number };

/**
 * Re-read the payment from Vipps, capture it if authorized, and confirm the
 * booking. Idempotent and safe to call from the webhook and the return URL
 * simultaneously.
 *
 * Deliberately re-fetches instead of trusting the webhook body: the webhook
 * tells us *something happened*, but Vipps' own record of the payment is the
 * only thing we will move money on.
 */
export async function settleAuthorizedPayment(
  reference: string,
  opts: { acceptedFromIp?: string | null } = {},
): Promise<SettleOutcome> {
  const booking = await db.booking.findUnique({ where: { vippsReference: reference } });
  if (!booking) return { status: 'unknown_reference' };

  const creds = await requireVippsCredentials();
  const payment = await getPayment(creds, reference);

  if (payment.state !== booking.vippsState) {
    await db.booking.update({
      where: { id: booking.id },
      data: { vippsState: payment.state },
    });
  }

  if (payment.state !== 'AUTHORIZED') {
    // ABORTED / EXPIRED / TERMINATED are terminal; CREATED just means the
    // customer hasn't finished yet.
    return payment.state === 'CREATED'
      ? { status: 'pending', state: payment.state }
      : { status: 'failed', state: payment.state };
  }

  // Guard: the authorized amount must match what we billed. A mismatch means
  // either a bug or tampering — never capture on a mismatch.
  const expectedMinor = toMinorUnits(booking.totalPrice);
  const authorizedMinor = payment.aggregate?.authorizedAmount?.value ?? payment.amount?.value ?? 0;
  if (authorizedMinor !== expectedMinor) {
    await writeAuditLog({
      action: 'vipps.amount_mismatch',
      actor: 'system',
      changes: [
        { key: 'reference', from: null, to: reference },
        { key: 'expectedOre', from: null, to: String(expectedMinor) },
        { key: 'authorizedOre', from: null, to: String(authorizedMinor) },
      ],
    });
    return {
      status: 'amount_mismatch',
      expectedKr: booking.totalPrice,
      authorizedKr: authorizedMinor / 100,
    };
  }

  // Capture. Vipps only RESERVES on authorization — skipping this means the
  // customer sees "paid" in the app but no money ever reaches the account.
  const capturedMinor = payment.aggregate?.capturedAmount?.value ?? 0;
  if (capturedMinor < expectedMinor) {
    await capturePayment(
      creds,
      reference,
      booking.totalPrice,
      `capture-${booking.id}-${expectedMinor}`,
    );
    await db.booking.update({
      where: { id: booking.id },
      data: { vippsCapturedAt: new Date() },
    });
  } else if (!booking.vippsCapturedAt) {
    await db.booking.update({
      where: { id: booking.id },
      data: { vippsCapturedAt: new Date() },
    });
  }

  if (booking.status !== 'pending') {
    const fresh = await db.booking.findUnique({ where: { id: booking.id } });
    return { status: 'already_handled', booking: fresh ?? booking };
  }

  // Shared with Stripe: sets status, fullyPaidAt, freezes the contract and
  // fires the confirmation + admin emails.
  const confirmed = await confirmBookingPaidFromStripe({
    bookingId: booking.id,
    acceptedFromIp: opts.acceptedFromIp ?? null,
    paymentMethod: 'vipps',
    paymentProvider: 'vipps',
  });

  if (!confirmed) {
    const fresh = await db.booking.findUnique({ where: { id: booking.id } });
    return { status: 'already_handled', booking: fresh ?? booking };
  }
  return { status: 'confirmed', booking: confirmed };
}

/**
 * Refund whatever is still owed on a cancelled Vipps booking. Mirrors the
 * fee/partial-refund arithmetic in refundBookingPayment (lib/stripe.ts) so the
 * two providers behave identically on cancellation.
 */
export async function refundVippsBooking(
  booking: Pick<
    Booking,
    'id' | 'reference' | 'totalPrice' | 'cancellationFee' | 'refundAmount' | 'fullyPaidAt' | 'vippsReference'
  >,
): Promise<{ amountRefunded: number } | null> {
  if (!booking.fullyPaidAt || !booking.vippsReference) return null;

  const fee = booking.cancellationFee ?? 0;
  const alreadyRefunded = booking.refundAmount ?? 0;
  const refundKr = booking.totalPrice - fee - alreadyRefunded;
  if (refundKr <= 0) return null;

  const creds = await requireVippsCredentials();
  const payment = await getPayment(creds, booking.vippsReference);

  // Can't refund more than was actually captured.
  const capturedKr = (payment.aggregate?.capturedAmount?.value ?? 0) / 100;
  const refundedKr = (payment.aggregate?.refundedAmount?.value ?? 0) / 100;
  const maxRefundable = capturedKr - refundedKr;
  const amount = Math.min(refundKr, maxRefundable);
  if (amount <= 0) return null;

  await refundPayment(
    creds,
    booking.vippsReference,
    amount,
    `refund-${booking.id}-${toMinorUnits(amount)}`,
  );

  await db.booking.update({
    where: { id: booking.id },
    data: { refundAmount: alreadyRefunded + Math.round(amount) },
  });

  return { amountRefunded: Math.round(amount) };
}

/** Read-through helper for admin views that want the live Vipps state. */
export async function fetchVippsPayment(reference: string): Promise<VippsPayment> {
  const creds = await requireVippsCredentials();
  return getPayment(creds, reference);
}
