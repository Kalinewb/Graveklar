import { NextRequest, NextResponse } from 'next/server';
import { db, withSqliteRetry } from '@/lib/db';
import {
  verifyStripeWebhook,
  createCheckoutSession,
  getSessionPaymentMethodType,
  MAX_PAYMENT_RETRIES,
  PAYMENT_GRACE_MS,
} from '@/lib/stripe';
import { loadAppConfig } from '@/lib/app-config';
import { sendPaymentRetryEmail } from '@/lib/email';
import { confirmBookingPaidFromStripe, updateBookingStatus } from '@/lib/booking-service';
import { writeAuditLog } from '@/lib/audit-log';

export const dynamic = 'force-dynamic';

function rentalDescription(booking: { reference: string; rentalType: string }): string {
  return `Booking ${booking.reference} (${booking.rentalType})`;
}

export async function POST(request: NextRequest) {
  const payload = await request.text();
  const signature = request.headers.get('stripe-signature') ?? '';

  const event = await verifyStripeWebhook(payload, signature);
  if (!event) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  // Idempotency: try to claim this event. The unique (provider, eventId)
  // constraint makes the claim race-safe. If the claim fails we treat the
  // event as already-processed.
  //
  // The claim is retried on SQLITE_BUSY because Stripe will retry on 5xx
  // anyway; better to absorb a few hundred ms of write-lock contention
  // here than to send 500 back and force a redelivery cascade.
  try {
    await withSqliteRetry(
      () => db.webhookEvent.create({ data: { provider: 'stripe', eventId: event.id } }),
      { label: 'webhook claim' },
    );
  } catch (err) {
    const msg = (err as { message?: string }).message ?? '';
    // Unique-constraint failures bubble up here — that's the idempotency
    // signal we want (already-processed event). Anything else is a real
    // claim failure; surface as 500 so Stripe retries.
    if (msg.includes('Unique constraint') || msg.includes('UNIQUE constraint')) {
      return NextResponse.json({ ok: true, duplicate: true });
    }
    console.error('[stripe-webhook] claim failed:', err);
    return NextResponse.json({ error: 'Claim failed' }, { status: 500 });
  }

  // From here on, if the work throws or returns a 5xx, DELETE the claim
  // row so Stripe's retry actually replays the event. Without this, a
  // partial failure (e.g. DB blip after the side-effects started) would
  // permanently mark the event handled and the booking would never finish
  // confirming.
  try {
    await runEvent(event);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[stripe-webhook] handler error, releasing idempotency claim:', err);
    await db.webhookEvent
      .delete({ where: { provider_eventId: { provider: 'stripe', eventId: event.id } } })
      .catch((cleanupErr) => console.error('[stripe-webhook] failed to release claim:', cleanupErr));
    return NextResponse.json({ error: 'Handler error' }, { status: 500 });
  }
}

async function runEvent(event: Awaited<ReturnType<typeof verifyStripeWebhook>>): Promise<void> {
  if (!event) return;

  // Payment success. `checkout.session.completed` fires the moment the
  // customer finishes Checkout — for cards that means paid, but for
  // redirect/async methods (Klarna, bank transfer, …) the session can
  // complete with payment_status 'unpaid' and settle later via
  // `checkout.session.async_payment_succeeded`. Confirming on 'completed'
  // alone would mark a booking paid with no money collected, and the later
  // `async_payment_failed` would then be ignored because the booking is no
  // longer 'pending'. So: confirm only when payment_status is 'paid', from
  // whichever of the two events carries it first. The shared transition is
  // race-safe, so seeing both is harmless.
  if (
    event.type === 'checkout.session.completed' ||
    event.type === 'checkout.session.async_payment_succeeded'
  ) {
    const session = event.data.object;
    const bookingId = session.metadata?.bookingId;
    if (!bookingId) return;
    if (session.payment_status !== 'paid') return;

    const paymentIntentId = typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id ?? null;

    // Resolve which payment method the customer actually used (card / vipps
    // / etc.). Stored on the booking for admin display, CSV export, and
    // reconciliation with Fiken. Best-effort: if Stripe doesn't return it,
    // the column stays null and downstream code falls back gracefully.
    const paymentMethod = await getSessionPaymentMethodType(session.id);

    await confirmBookingPaidFromStripe({
      bookingId,
      stripePaymentIntentId: paymentIntentId,
      acceptedFromIp: (session.metadata?.acceptedFromIp as string | undefined) ?? null,
      paymentMethod,
    });
    return;
  }

  // Payment failed or session expired. The customer gets ONE 30-min retry:
  // we mint a fresh Checkout session (also 30 min) and email the new payment
  // link. If the booking has already used its retry, this second expiry means
  // the payment window is truly closed — cancel immediately (frees the date
  // locks + sends the expiry email) rather than waiting for the lazy cleanup
  // sweep. Without the retry cap the retry session's own expiry would loop
  // back here forever, re-granting a retry every 30 min and never cancelling.
  if (
    event.type === 'checkout.session.async_payment_failed' ||
    event.type === 'checkout.session.expired'
  ) {
    const session = event.data.object;
    const bookingId = session.metadata?.bookingId;
    if (!bookingId) return;

    const booking = await db.booking.findUnique({
      where: { id: bookingId },
      include: { machine: true },
    });
    if (!booking || booking.status !== 'pending') return;

    // Retry budget exhausted → the window is closed. Cancel now.
    if (booking.paymentRetries >= MAX_PAYMENT_RETRIES) {
      await updateBookingStatus(bookingId, 'cancelled');
      return;
    }

    const appCfg = await loadAppConfig();
    const siteUrl = (appCfg['siteUrl'] || '').replace(/\/+$/, '');
    const imageUrl = booking.machine?.imageUrl ?? null;

    // Build the link BEFORE spending anything (finding F-54). The budget and
    // the deadline used to be written first, so an unset siteUrl — the branch
    // below that never even calls Stripe — burned the customer's single second
    // chance on a retry that was never sent, and the next expiry cancelled the
    // booking. Nothing is spent until there is a link to send.
    //
    // A createCheckoutSession that *throws* (a Stripe outage) is deliberately
    // left to propagate: the handler answers 500, the idempotency claim is
    // released, and Stripe redelivers — which is a better outcome for the
    // customer than swallowing the error and quietly dropping the retry.
    let retryUrl: string | null = null;
    if (siteUrl) {
      const result = await createCheckoutSession(
        booking.id,
        booking.totalPrice,
        rentalDescription(booking),
        siteUrl,
        imageUrl,
        30, // 30-minute retry session
        // Carry the original acceptedFromIp through so the retry session,
        // if completed, still freezes the contract with the customer's
        // original acceptance IP rather than null.
        (session.metadata?.acceptedFromIp as string | undefined) ?? null,
      );
      retryUrl = result?.url ?? null;
    }

    if (!retryUrl) {
      console.warn(
        `Could not generate retry session for booking ${booking.reference}; retry budget left intact`
      );
      return;
    }

    await db.booking.update({
      where: { id: bookingId },
      data: {
        paymentDeadline: new Date(Date.now() + PAYMENT_GRACE_MS),
        paymentRetries: { increment: 1 },
      },
    });

    const fresh = await db.booking.findUnique({ where: { id: bookingId } });
    if (fresh) {
      sendPaymentRetryEmail(fresh, retryUrl, 30).catch((err) =>
        console.error('Payment retry email error:', err)
      );
    }
    return;
  }

  // Refund event — fires both when WE call stripe.refunds.create (which our
  // own DB write at lib/stripe.ts:168 already records) and when an admin
  // issues a refund directly from the Stripe dashboard (which we'd otherwise
  // miss). Idempotent: the lookup by stripeRefundId means a second delivery
  // is a no-op.
  if (event.type === 'charge.refunded') {
    const charge = event.data.object;
    const piId = typeof charge.payment_intent === 'string'
      ? charge.payment_intent
      : charge.payment_intent?.id ?? null;
    if (!piId) return;

    const booking = await db.booking.findFirst({
      where: { stripePaymentIntentId: piId },
    });
    if (!booking) return;

    // Cumulative: charge.amount_refunded is the running total across every
    // refund on the charge (ours and dashboard-issued partials), so the
    // booking always reflects what actually went back. Re-deliveries, and
    // our own refunds (already recorded by lib/stripe.ts), converge on the
    // same numbers and become a no-op.
    const totalRefundedKr = Math.round((charge.amount_refunded ?? 0) / 100);
    const latest = charge.refunds?.data?.[0];
    const alreadyCurrent =
      (booking.refundAmount ?? 0) === totalRefundedKr &&
      (!latest || booking.stripeRefundId === latest.id);
    if (alreadyCurrent) return;

    await db.booking.update({
      where: { id: booking.id },
      data: {
        ...(latest ? { stripeRefundId: latest.id } : {}),
        refundAmount: totalRefundedKr,
      },
    });
    await writeAuditLog({
      action: 'booking.refunded_externally',
      changes: [
        { key: 'bookingId', from: booking.id, to: booking.id },
        { key: 'reference', from: booking.reference, to: booking.reference },
        { key: 'refundAmountKr', from: booking.refundAmount ?? null, to: totalRefundedKr },
        { key: 'refundId', from: booking.stripeRefundId ?? null, to: latest?.id ?? null },
      ],
    }).catch((err) => console.error('refund audit log failed:', err));
    return;
  }

  // Dispute (chargeback) opened. Doesn't auto-mutate the booking — that's a
  // judgment call for the admin. Just write an audit row so the admin sees
  // it in the timeline and can investigate.
  if (event.type === 'charge.dispute.created') {
    const dispute = event.data.object;
    const charge = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id;
    if (!charge) return;

    const booking = await db.booking.findFirst({
      where: { stripePaymentIntentId: typeof dispute.payment_intent === 'string' ? dispute.payment_intent : dispute.payment_intent?.id ?? '' },
    });

    await writeAuditLog({
      action: 'stripe.dispute_created',
      changes: [
        { key: 'bookingId', from: booking?.id ?? null, to: booking?.id ?? null },
        { key: 'reference', from: booking?.reference ?? null, to: booking?.reference ?? null },
        { key: 'disputeId', from: null, to: dispute.id },
        { key: 'amountKr', from: null, to: Math.round((dispute.amount || 0) / 100) },
        { key: 'reason', from: null, to: dispute.reason ?? null },
      ],
    }).catch((err) => console.error('dispute audit log failed:', err));
    return;
  }

  // Synchronous payment failure (card declined etc). The Checkout session
  // events above cover async methods (Klarna, Bank Transfer); this one
  // covers the standard card path. Treat as a logged event — the booking is
  // still pending and the customer can retry from the same Checkout URL
  // until it expires.
  if (event.type === 'payment_intent.payment_failed') {
    const pi = event.data.object;
    const bookingId = (pi.metadata as Record<string, string> | undefined)?.bookingId;
    if (!bookingId) return;

    const booking = await db.booking.findUnique({ where: { id: bookingId } });
    if (!booking) return;

    await writeAuditLog({
      action: 'stripe.payment_failed',
      changes: [
        { key: 'bookingId', from: booking.id, to: booking.id },
        { key: 'reference', from: booking.reference, to: booking.reference },
        { key: 'failureCode', from: null, to: pi.last_payment_error?.code ?? null },
        { key: 'failureMessage', from: null, to: pi.last_payment_error?.message ?? null },
      ],
    }).catch((err) => console.error('payment_failed audit log failed:', err));
  }
}
