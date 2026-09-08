import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { updateBookingStatus } from '@/lib/booking-service';
import { loadAppConfig, getCancelFreeHours } from '@/lib/app-config';
import { evaluateCancellationPolicy } from '@/lib/cancellation';
import { dbDateToStr } from '@/lib/availability';
import { sendBookingStatusEmail } from '@/lib/email';
import { createRateLimiter } from '@/lib/rate-limit';
import type { Booking } from '@prisma/client';
import { clientIdentity } from '@/lib/client-ip';

// The destructive verb keeps the tight budget: a booking reference is
// human-readable (GK-YYMM-NNN), so an attacker who knows a customer's e-mail
// could otherwise enumerate references and cancel bookings, triggering refunds
// and mails.
const cancelLimit = createRateLimiter(10, 15 * 60 * 1000);
// The GET preview is read-only and is what the emailed link opens, so it gets
// its own, far more generous budget. Sharing the cancel budget meant every
// page load — and every mistyped reference on the ref+e-mail form — spent one
// of the ten attempts the customer needs for the cancel button itself, while
// the free-cancellation deadline kept running.
const previewLimit = createRateLimiter(60, 15 * 60 * 1000);

// Same wording the booking page uses. "Helg (fre–man)" here vs "fre–søn" in
// the booking summary made customers think they had two different periods.
function rentalTypeLabel(t: string) {
  const labels: Record<string, string> = {
    day: '1 dag', weekend: 'Helg', week: '1 uke', custom: 'Tilpasset',
  };
  return labels[t] ?? t;
}

async function computeCancellationFeePreview(booking: { startDate: Date; basePrice: number }) {
  const appCfg = await loadAppConfig();
  // Same helper `updateBookingStatus` uses to write the fee, so the preview
  // and the charge cannot disagree. `cancelFreeHours` is still reported for
  // the page's own wording.
  const { feePercent, hoursUntil } = evaluateCancellationPolicy(
    dbDateToStr(booking.startDate),
    appCfg,
  );

  const fee = feePercent > 0 ? Math.round((booking.basePrice * feePercent) / 100) : 0;
  return { fee, feePercent, cancelFreeHours: getCancelFreeHours(appCfg), hoursUntil };
}

export async function GET(request: NextRequest) {
  const ip = clientIdentity(request);
  if (previewLimit(ip)) return NextResponse.json({ error: 'For mange forespørsler. Prøv igjen om litt.' }, { status: 429 });

  const token = request.nextUrl.searchParams.get('token');
  const ref = request.nextUrl.searchParams.get('ref');
  const email = request.nextUrl.searchParams.get('email');

  let booking: Booking | null = null;

  if (token) {
    booking = await db.booking.findUnique({ where: { cancelToken: token } });
    if (!booking) return NextResponse.json({ error: 'Ugyldig eller utløpt lenke.' }, { status: 404 });
    if (booking.cancelTokenExpiry && booking.cancelTokenExpiry < new Date()) {
      return NextResponse.json({ error: 'Avbestillingslenken har utløpt. Ta kontakt direkte.' }, { status: 410 });
    }
  } else if (ref && email) {
    booking = await db.booking.findUnique({ where: { reference: ref } });
    if (!booking || booking.email.toLowerCase() !== email.toLowerCase().trim()) {
      return NextResponse.json({ error: 'Fant ingen booking med denne referansen og e-postadressen.' }, { status: 404 });
    }
  } else {
    return NextResponse.json({ error: 'Oppgi token eller referanse + e-post.' }, { status: 400 });
  }

  if (!['confirmed', 'pending'].includes(booking.status)) {
    return NextResponse.json({
      error: booking.status === 'cancelled'
        ? 'Denne bookingen er allerede avbestilt.'
        : 'Denne bookingen kan ikke avbestilles.',
      status: booking.status,
    }, { status: 410 });
  }

  const { fee, feePercent, cancelFreeHours, hoursUntil } = await computeCancellationFeePreview(booking);

  return NextResponse.json({
    reference: booking.reference,
    name: booking.name,
    rentalType: rentalTypeLabel(booking.rentalType),
    startDate: dbDateToStr(booking.startDate),
    customDays: booking.customDays,
    deliveryAddress: booking.deliveryAddress,
    totalPrice: booking.totalPrice,
    basePrice: booking.basePrice,
    status: booking.status,
    cancellationFeePreview: fee,
    feePercent,
    cancelFreeHours,
    hoursUntil: Math.round(hoursUntil),
  });
}

export async function POST(request: NextRequest) {
  try {
    const ip = clientIdentity(request);
    if (cancelLimit(ip)) return NextResponse.json({ error: 'For mange forsøk. Prøv igjen om litt.' }, { status: 429 });

    const body = await request.json();
    const { token, reference, email } = body;

    let booking: Booking | null = null;

    if (token) {
      booking = await db.booking.findUnique({ where: { cancelToken: token } });
      if (!booking) return NextResponse.json({ error: 'Ugyldig eller utløpt lenke.' }, { status: 404 });
      if (booking.cancelTokenExpiry && booking.cancelTokenExpiry < new Date()) {
        return NextResponse.json({ error: 'Avbestillingslenken har utløpt. Ta kontakt direkte.' }, { status: 410 });
      }
    } else if (reference && email) {
      booking = await db.booking.findUnique({ where: { reference } });
      if (!booking || booking.email.toLowerCase() !== email.toLowerCase().trim()) {
        return NextResponse.json({ error: 'Fant ingen booking med denne referansen og e-postadressen.' }, { status: 404 });
      }
    } else {
      return NextResponse.json({ error: 'Oppgi token eller referanse + e-post.' }, { status: 400 });
    }

    if (!['confirmed', 'pending'].includes(booking.status)) {
      return NextResponse.json({
        error: booking.status === 'cancelled'
          ? 'Denne bookingen er allerede avbestilt.'
          : 'Denne bookingen kan ikke avbestilles.',
      }, { status: 410 });
    }

    // skipEmails: this route sends its own 'cancelled' email below. Without
    // this, cancelling a *pending* booking would also trigger the service's
    // pending→cancelled "expired" email, double-sending two contradictory
    // notices to the customer.
    const result = await updateBookingStatus(booking.id, 'cancelled', { skipEmails: true, actor: 'customer' });
    const final = await db.booking.findUnique({ where: { id: booking.id } });
    if (!final) return NextResponse.json({ error: 'Booking ikke funnet.' }, { status: 404 });

    // Two near-simultaneous POSTs (double-click, browser retry) both pass
    // the status check above; only the one that performed the transition
    // should email the customer.
    if (result.transitioned) {
      sendBookingStatusEmail(final, 'cancelled').catch((err) => console.error('Email error:', err));
    }

    return NextResponse.json({
      success: true,
      cancellationFee: final.cancellationFee ?? 0,
      refundAmount: final.refundAmount ?? 0,
      reference: final.reference,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Noe gikk galt.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
