import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { createCheckoutSession, getLiveCheckoutSessionUrl } from '@/lib/stripe';
import { loadAppConfig } from '@/lib/app-config';
import { createRateLimiter } from '@/lib/rate-limit';
import { clientIdentity } from '@/lib/client-ip';

// A customer whose card is declined legitimately retries, and each retry can
// reach this endpoint; 5 per quarter-hour turned a couple of failed attempts
// into a lockout at the payment step. Session reuse (getLiveCheckoutSessionUrl
// below) already stops repeat clicks from creating parallel sessions, so this
// only needs to be an anti-hammer bound.
const checkLimit = createRateLimiter(30, 15 * 60 * 1000);

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const ip = clientIdentity(request);
    if (checkLimit(ip)) return NextResponse.json({ error: 'For mange betalingsforsøk på kort tid. Vent et par minutter og prøv igjen.' }, { status: 429 });

    const { bookingId } = await request.json();
    if (!bookingId) return NextResponse.json({ error: 'bookingId påkrevd' }, { status: 400 });

    const booking = await db.booking.findUnique({
      where: { id: bookingId },
      include: { machine: true },
    });
    if (!booking) return NextResponse.json({ error: 'expired' }, { status: 410 });
    if (booking.status !== 'pending') return NextResponse.json({ error: 'expired' }, { status: 410 });

    // Reuse an existing live session if the booking already has one. Stops
    // double-clicking "Pay" (or any retry path) from creating parallel
    // sessions that each fire their own webhook events.
    const existing = await getLiveCheckoutSessionUrl(bookingId);
    if (existing) {
      return NextResponse.json({ url: existing.url, sessionId: existing.sessionId, reused: true });
    }

    const amount = booking.totalPrice;
    const machineName = booking.machine?.name ?? 'Utstyrsleie';
    const description = `${machineName} – ${booking.reference}`;

    const appConfig = await loadAppConfig();
    // Return URLs come from the configured siteUrl, falling back to the
    // request origin — never from X-Forwarded-Host / Origin headers, which a
    // spoofed request could use to send the customer's post-payment redirect
    // to a foreign host. Mirrors the callback and cancel routes.
    const origin = (appConfig['siteUrl'] || '').replace(/\/+$/, '') || request.nextUrl.origin;
    const machineImage = booking.machine?.imageUrl;
    const absoluteImage = machineImage
      ? (/^https?:\/\//i.test(machineImage) ? machineImage : `${origin}${machineImage.startsWith('/') ? '' : '/'}${machineImage}`)
      : null;
    const result = await createCheckoutSession(bookingId, amount, description, origin, absoluteImage, 60, ip);

    if (!result) {
      return NextResponse.json({ error: 'Stripe er ikke konfigurert' }, { status: 503 });
    }

    return NextResponse.json({ url: result.url, sessionId: result.sessionId });
  } catch (err) {
    console.error('Stripe create session error:', err);
    return NextResponse.json({ error: 'Feil ved opprettelse av betaling' }, { status: 500 });
  }
}
