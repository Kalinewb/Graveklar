import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { loadAppConfig } from '@/lib/app-config';
import { createRateLimiter } from '@/lib/rate-limit';
import { isVippsEnabled } from '@/lib/vipps-config';
import { createVippsPaymentForBooking } from '@/lib/vipps-payments';
import { clientIdentity } from '@/lib/client-ip';

const checkLimit = createRateLimiter(5, 15 * 60 * 1000);

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const ip = clientIdentity(request);
    if (checkLimit(ip)) return NextResponse.json({ error: 'For mange betalingsforsøk.' }, { status: 429 });

    const { bookingId } = await request.json();
    if (!bookingId) return NextResponse.json({ error: 'bookingId påkrevd' }, { status: 400 });

    if (!(await isVippsEnabled())) {
      return NextResponse.json({ error: 'Vipps er ikke konfigurert' }, { status: 503 });
    }

    const booking = await db.booking.findUnique({ where: { id: bookingId } });
    // Same contract as the Stripe route: 410 means "this booking can no longer
    // be paid for", which the frontend turns into a fresh-booking prompt.
    if (!booking) return NextResponse.json({ error: 'expired' }, { status: 410 });
    if (booking.status !== 'pending') return NextResponse.json({ error: 'expired' }, { status: 410 });

    const appConfig = await loadAppConfig();
    // Return URL host comes from configured siteUrl, never from request
    // headers — a spoofed Origin must not be able to redirect the customer's
    // post-payment landing to a foreign host.
    const origin = (appConfig['siteUrl'] || '').replace(/\/+$/, '') || request.nextUrl.origin;

    const { url, reference } = await createVippsPaymentForBooking(booking, origin);
    return NextResponse.json({ url, reference });
  } catch (err) {
    console.error('Vipps create payment error:', err);
    return NextResponse.json({ error: 'Feil ved opprettelse av betaling' }, { status: 500 });
  }
}
