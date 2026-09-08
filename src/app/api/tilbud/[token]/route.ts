import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { loadAppConfig } from '@/lib/app-config';
import { createRateLimiter } from '@/lib/rate-limit';
import { convertQuoteToBooking } from '@/lib/quote-request';
import { updateBookingStatus } from '@/lib/booking-service';
import { createCheckoutSession, getLiveCheckoutSessionUrl } from '@/lib/stripe';
import { clientIdentity } from '@/lib/client-ip';

export const dynamic = 'force-dynamic';

const checkLimit = createRateLimiter(10, 15 * 60 * 1000);

/** Origin for the Stripe return URLs: the configured siteUrl, falling back to
 *  the request origin — never X-Forwarded-Host / Origin, which a spoofed
 *  request could use to send the customer's post-payment redirect (booking
 *  reference and all) to a foreign host. Mirrors
 *  `POST /api/payment/stripe/create`. */
function resolveOrigin(request: NextRequest, siteUrl: string): string {
  return siteUrl.replace(/\/+$/, '') || request.nextUrl.origin;
}

async function startCardPayment(request: NextRequest, bookingId: string, ip: string) {
  const booking = await db.booking.findUnique({ where: { id: bookingId }, include: { machine: true } });
  if (!booking || booking.status !== 'pending') return null;

  const existing = await getLiveCheckoutSessionUrl(bookingId);
  if (existing) return existing.url;

  const cfg = await loadAppConfig();
  const origin = resolveOrigin(request, cfg['siteUrl'] || '');
  const machineName = booking.machine?.name ?? 'Utstyrsleie';
  const image = booking.machine?.imageUrl
    ? (/^https?:\/\//i.test(booking.machine.imageUrl) ? booking.machine.imageUrl : `${origin}${booking.machine.imageUrl.startsWith('/') ? '' : '/'}${booking.machine.imageUrl}`)
    : null;
  const result = await createCheckoutSession(bookingId, booking.totalPrice, `${machineName} – ${booking.reference}`, origin, image, 60, ip);
  return result?.url ?? null;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const ip =
    clientIdentity(request);
  if (checkLimit(ip)) {
    return NextResponse.json({ error: 'For mange forsøk. Prøv igjen om litt.' }, { status: 429 });
  }

  const { token } = await params;
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    /* default accept */
  }
  const action = body.action === 'decline' ? 'decline' : 'accept';

  const quote = await db.quoteRequest.findUnique({ where: { acceptToken: token }, include: { machine: true } });
  if (!quote) return NextResponse.json({ error: 'Tilbudet finnes ikke' }, { status: 404 });

  // ── Decline ──
  if (action === 'decline') {
    // Only a live offer can be declined. The response has to report the row's
    // real status: telling a customer "avslatt" while the stored status is
    // still konvertert/akseptert/utlopt is the response and the database
    // disagreeing (finding M-2).
    if (quote.status !== 'tilbud_sendt') {
      return NextResponse.json({ success: true, status: quote.status, changed: false });
    }
    await db.quoteRequest.update({ where: { id: quote.id }, data: { status: 'avslatt' } });
    return NextResponse.json({ success: true, status: 'avslatt', changed: true });
  }

  // ── Accept (idempotent) ──
  if (quote.convertedBookingId) {
    if (quote.paymentMode === 'invoice') {
      return NextResponse.json({ success: true, mode: 'invoice', alreadyAccepted: true });
    }
    const url = await startCardPayment(request, quote.convertedBookingId, ip);
    if (url) return NextResponse.json({ success: true, mode: 'card', url, alreadyAccepted: true });
    return NextResponse.json({ success: true, mode: 'card', alreadyAccepted: true });
  }

  if (quote.status !== 'tilbud_sendt') {
    return NextResponse.json({ error: 'Tilbudet er ikke aktivt lenger' }, { status: 409 });
  }

  const now = new Date();
  const expired =
    (quote.acceptTokenExpiry && quote.acceptTokenExpiry < now) ||
    (quote.offerValidUntil && quote.offerValidUntil < now);
  if (expired) {
    await db.quoteRequest.update({ where: { id: quote.id }, data: { status: 'utlopt' } });
    return NextResponse.json({ error: 'Tilbudet er utløpt' }, { status: 410 });
  }

  try {
    const booking = await convertQuoteToBooking(quote);

    if (quote.paymentMode === 'invoice') {
      await updateBookingStatus(booking.id, 'confirmed', {
        fullyPaid: false,
        paymentMethod: 'invoice',
        acceptedFromIp: ip,
      });
      await db.quoteRequest.update({ where: { id: quote.id }, data: { status: 'konvertert' } });
      return NextResponse.json({ success: true, mode: 'invoice', reference: booking.reference });
    }

    // Card: keep booking pending and hand off to Stripe. The webhook
    // confirms + freezes the (business) contract on payment.
    const url = await startCardPayment(request, booking.id, ip);
    if (!url) {
      return NextResponse.json({ error: 'Kortbetaling er ikke tilgjengelig. Ta kontakt med utleier.' }, { status: 503 });
    }
    return NextResponse.json({ success: true, mode: 'card', url, reference: booking.reference });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Kunne ikke akseptere tilbudet';
    console.error('Quote accept error:', error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
