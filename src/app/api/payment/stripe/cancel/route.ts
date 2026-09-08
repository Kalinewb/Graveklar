import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { loadAppConfig } from '@/lib/app-config';

export const dynamic = 'force-dynamic';

// Browser-redirect target for Stripe Checkout's cancel_url: resolve the
// booking id Stripe carries back into the booking *reference*, and hand the
// homepage the `?stripe=cancelled&ref=…` it needs to reopen the booking with a
// "Prøv igjen" button.
//
// It is a redirect and nothing else, on purpose (finding F-3). This handler
// used to mint a fresh Checkout session, increment `paymentRetries`, re-stamp
// `paymentDeadline` and send two e-mails. A GET must be safe: the cancel_url
// is a plain link that a browser prefetcher, a link scanner or an antivirus
// proxy will follow without anyone clicking it, and because the retry budget
// is shared with the webhook, one such fetch spent the customer's only second
// chance — the next `checkout.session.expired` then cancelled the booking.
//
// What replaces it:
//   - the retry the customer *asks* for — the "Prøv igjen" button in the
//     cancelled state of the confirmation dialog, which POSTs the booking id
//     to /api/payment/{vipps,stripe}/create (rate limited, reuses a live
//     session, answers 410 once the booking can no longer be paid for);
//   - the retry e-mail, which still goes out from the webhook's
//     `checkout.session.expired` branch when the abandoned session lapses.

export async function GET(request: NextRequest) {
  const bookingId = request.nextUrl.searchParams.get('bid');
  const appConfig = await loadAppConfig();
  const origin = (appConfig['siteUrl'] || request.nextUrl.origin).replace(/\/+$/, '');

  // No id, or an id that resolves to nothing: there is no booking to reopen,
  // so the homepage gets the error state rather than a cancellation popup with
  // nothing in it.
  if (!bookingId) return NextResponse.redirect(`${origin}/?stripe=error`);

  const booking = await db.booking
    .findUnique({ where: { id: bookingId }, select: { reference: true } })
    .catch(() => null);

  if (!booking) return NextResponse.redirect(`${origin}/?stripe=error`);

  return NextResponse.redirect(
    `${origin}/?stripe=cancelled&ref=${encodeURIComponent(booking.reference)}`
  );
}
