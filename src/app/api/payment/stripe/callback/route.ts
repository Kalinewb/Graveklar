import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { loadAppConfig } from '@/lib/app-config';
import { confirmBookingPaidFromStripe } from '@/lib/booking-service';
import Stripe from 'stripe';

export const dynamic = 'force-dynamic';

// Browser-redirect callback from Stripe Checkout. Mirrors the webhook's
// confirm path so that if the webhook is delayed or fails entirely, the
// customer's return to the success URL still drives the full post-payment
// lifecycle (contract freeze, repeat-code redemption, emails). The shared
// transition in updateBookingStatus is race-safe — only one of the two
// paths actually runs the side effects.

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const sessionId = searchParams.get('session_id');
  const bookingId = searchParams.get('bid');
  const appConfig = await loadAppConfig();
  const origin = (appConfig['siteUrl'] || request.nextUrl.origin).replace(/\/+$/, '');

  // Every failure branch below still knows which booking the customer was
  // paying for, so every one of them can hand the home page the reference it
  // needs to say something specific. They used to redirect to a bare
  // `/?stripe=error` / `/?stripe=cancelled`; with no ref the page resolved no
  // booking, showed no dialog and stripped the query string — the customer's
  // payment failed and the site said nothing at all (Q-2).
  const reference = bookingId
    ? await db.booking
        .findUnique({ where: { id: bookingId }, select: { reference: true } })
        .then((b) => b?.reference ?? null)
        .catch(() => null)
    : null;

  const back = (status: 'success' | 'cancelled' | 'error') =>
    NextResponse.redirect(
      `${origin}/?stripe=${status}${reference ? `&ref=${encodeURIComponent(reference)}` : ''}`
    );

  if (!sessionId || !bookingId) return back('error');

  try {
    const secretRow = await db.appConfig.findUnique({ where: { key: 'stripeSecretKey' } });
    if (!secretRow?.value) return back('error');

    const stripe = new Stripe(secretRow.value);
    // Expand payment_intent.payment_method so we can capture the actual
    // method type ('card' / 'vipps' / …) on the booking. Mirrors the
    // webhook path; the shared updateBookingStatus is race-safe so it's
    // fine if both fire.
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent.payment_method'],
    });

    if (session.metadata?.bookingId !== bookingId) return back('error');

    if (session.payment_status !== 'paid') return back('cancelled');

    // The reference lookup above already answers "does this booking exist".
    if (!reference) return back('error');

    const paymentIntentId = typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id ?? null;

    const pi = typeof session.payment_intent === 'object' ? session.payment_intent : null;
    const pm = pi && typeof pi.payment_method === 'object' ? pi.payment_method : null;
    const paymentMethod = pm?.type ?? null;

    await confirmBookingPaidFromStripe({
      bookingId,
      stripePaymentIntentId: paymentIntentId,
      acceptedFromIp: (session.metadata?.acceptedFromIp as string | undefined) ?? null,
      paymentMethod,
    });

    return back('success');
  } catch (err) {
    console.error('Stripe callback error:', err);
    return back('error');
  }
}
