import { NextRequest, NextResponse } from 'next/server';
import { db, withSqliteRetry } from '@/lib/db';
import { loadAppConfig } from '@/lib/app-config';
import { writeAuditLog } from '@/lib/audit-log';
import { sendPaymentRetryEmail } from '@/lib/email';
import { updateBookingStatus } from '@/lib/booking-service';
import { MAX_PAYMENT_RETRIES } from '@/lib/stripe';
import { loadVippsConfig } from '@/lib/vipps-config';
import { verifyWebhookSignature, type VippsWebhookPayload } from '@/lib/vipps';
import { createVippsPaymentForBooking, settleAuthorizedPayment } from '@/lib/vipps-payments';

export const dynamic = 'force-dynamic';

const PROVIDER = 'vipps';

export async function POST(request: NextRequest) {
  // Raw body first — the signature covers the exact bytes, so a re-serialized
  // object would never match.
  const rawBody = await request.text();

  const cfg = await loadVippsConfig();
  if (!cfg.webhookSecret) {
    console.error('[vipps-webhook] no webhook secret configured — rejecting');
    return NextResponse.json({ error: 'Not configured' }, { status: 503 });
  }

  const ok = verifyWebhookSignature({
    method: 'POST',
    // Vipps signs the path it called, including any query string.
    pathWithQuery: request.nextUrl.pathname + request.nextUrl.search,
    rawBody,
    headers: {
      authorization: request.headers.get('authorization'),
      xMsDate: request.headers.get('x-ms-date'),
      xMsContentSha256: request.headers.get('x-ms-content-sha256'),
      host: request.headers.get('host'),
    },
    secret: cfg.webhookSecret,
  });
  if (!ok) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let event: VippsWebhookPayload;
  try {
    event = JSON.parse(rawBody) as VippsWebhookPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!event?.reference || !event?.name) {
    return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
  }

  // Idempotency, same shape as the Stripe webhook. pspReference identifies the
  // individual operation; pairing it with the event name keeps two different
  // events that share a pspReference distinct.
  const eventId = `${event.name}-${event.pspReference || event.reference}`;
  try {
    await withSqliteRetry(
      () => db.webhookEvent.create({ data: { provider: PROVIDER, eventId } }),
      { label: 'vipps webhook claim' },
    );
  } catch (err) {
    const msg = (err as { message?: string }).message ?? '';
    if (msg.includes('Unique constraint') || msg.includes('UNIQUE constraint')) {
      return NextResponse.json({ ok: true, duplicate: true });
    }
    console.error('[vipps-webhook] claim failed:', err);
    return NextResponse.json({ error: 'Claim failed' }, { status: 500 });
  }

  // Release the claim on failure so Vipps' retry actually replays the event.
  try {
    await runEvent(event);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[vipps-webhook] handler error, releasing idempotency claim:', err);
    await db.webhookEvent
      .delete({ where: { provider_eventId: { provider: PROVIDER, eventId } } })
      .catch((cleanupErr) => console.error('[vipps-webhook] failed to release claim:', cleanupErr));
    return NextResponse.json({ error: 'Handler error' }, { status: 500 });
  }
}

async function runEvent(event: VippsWebhookPayload): Promise<void> {
  const name = event.name.toUpperCase();

  // AUTHORIZED is the only event that moves money: settle re-reads the payment
  // from Vipps, captures it, and confirms the booking.
  if (name === 'AUTHORIZED') {
    const outcome = await settleAuthorizedPayment(event.reference);
    if (outcome.status === 'amount_mismatch') {
      console.error(
        `[vipps-webhook] refusing to capture ${event.reference}: authorized ${outcome.authorizedKr} kr vs expected ${outcome.expectedKr} kr`,
      );
    }
    return;
  }

  // Customer walked away, timed out, or we cancelled the reservation.
  if (name === 'ABORTED' || name === 'EXPIRED' || name === 'TERMINATED') {
    await handleFailedPayment(event, name);
    return;
  }

  // Money-movement confirmations. The capture/refund calls already wrote our
  // own record; these events are the authoritative echo, including for actions
  // taken from the Vipps portal rather than by this app.
  if (name === 'CAPTURED') {
    const booking = await db.booking.findUnique({ where: { vippsReference: event.reference } });
    if (booking && !booking.vippsCapturedAt) {
      await db.booking.update({
        where: { id: booking.id },
        data: { vippsCapturedAt: new Date() },
      });
    }
    return;
  }

  if (name === 'REFUNDED' || name === 'CANCELLED') {
    const booking = await db.booking.findUnique({ where: { vippsReference: event.reference } });
    if (!booking) return;
    const refundedKr = Math.round((event.amount?.value ?? 0) / 100);
    await writeAuditLog({
      action: name === 'REFUNDED' ? 'vipps.refunded' : 'vipps.cancelled',
      actor: 'system',
      changes: [
        { key: 'bookingId', from: null, to: booking.id },
        { key: 'reference', from: null, to: booking.reference },
        { key: 'amountKr', from: null, to: String(refundedKr) },
      ],
    });
    // Only widen the recorded refund — a refund we initiated has already been
    // written, and this echo must not double-count it.
    if (name === 'REFUNDED' && refundedKr > (booking.refundAmount ?? 0)) {
      await db.booking.update({
        where: { id: booking.id },
        data: { refundAmount: refundedKr },
      });
    }
    return;
  }
}

/**
 * A payment that will never be authorized. Mirrors the Stripe expiry branch:
 * grant one more attempt with a fresh payment link, or cancel once the retry
 * budget is spent.
 */
async function handleFailedPayment(event: VippsWebhookPayload, state: string): Promise<void> {
  const booking = await db.booking.findUnique({ where: { vippsReference: event.reference } });
  if (!booking || booking.status !== 'pending') return;

  await db.booking.update({ where: { id: booking.id }, data: { vippsState: state } });

  if (booking.paymentRetries >= MAX_PAYMENT_RETRIES) {
    await updateBookingStatus(booking.id, 'cancelled');
    return;
  }

  const appCfg = await loadAppConfig();
  const siteUrl = (appCfg['siteUrl'] || '').replace(/\/+$/, '');

  // Nothing is spent until a retry payment actually exists (finding F-54).
  // The increment and the deadline extension used to run first, so a blank
  // siteUrl — or a Vipps error a moment later — burned the customer's single
  // second chance on a payment that was never created, and the next failure
  // event cancelled the booking.
  if (!siteUrl) {
    console.warn(
      `[vipps-webhook] no siteUrl configured; skipping retry link for ${booking.reference} — retry budget left intact`,
    );
    return;
  }

  let retryUrl: string;
  try {
    // `createVippsPaymentForBooking` derives the attempt number (and therefore
    // the "-r2" reference suffix) from `paymentRetries + 1`, so hand it the
    // count this retry *will* have. The row itself is only incremented below,
    // once the payment exists.
    const { url } = await createVippsPaymentForBooking(
      { ...booking, paymentRetries: booking.paymentRetries + 1 },
      siteUrl,
    );
    retryUrl = url;
  } catch (err) {
    console.error(
      `[vipps-webhook] could not create retry payment for ${booking.reference} — retry budget left intact:`,
      err,
    );
    return;
  }

  // Only the counter. `createVippsPaymentForBooking` has just stamped
  // `paymentDeadline` with its own payment window (VIPPS_PAYMENT_WINDOW_MS),
  // and that is the window the link it returned is actually good for — writing
  // the shorter Stripe grace over it would let the cleanup sweep cancel the
  // booking while the customer still has a live Vipps payment open. (Before
  // the F-54 reorder this write ran *first* and the create overwrote it, so
  // the effective deadline was already the Vipps one; this keeps that.)
  await db.booking.update({
    where: { id: booking.id },
    data: { paymentRetries: { increment: 1 } },
  });

  // Re-read so the e-mail quotes the new reference and deadline.
  const fresh = await db.booking.findUnique({ where: { id: booking.id } });
  if (!fresh) return;
  sendPaymentRetryEmail(fresh, retryUrl, 30).catch((err) =>
    console.error('[vipps-webhook] retry email error:', err),
  );
}
