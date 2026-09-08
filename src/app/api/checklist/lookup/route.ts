import { NextRequest, NextResponse } from 'next/server';
import { createRateLimiter } from '@/lib/rate-limit';
import { findActiveBookingsByPhone } from '@/lib/renter-checklist-db';
import { createRenterSessionToken } from '@/lib/renter-checklist-session';
import { normalizePhone } from '@/lib/phone-normalize';
import { loadAppConfig } from '@/lib/app-config';
import { clientIdentity } from '@/lib/client-ip';

const checkLimit = createRateLimiter(15, 15 * 60 * 1000);

export async function POST(request: NextRequest) {
  try {
    const ip = clientIdentity(request);
    if (checkLimit(ip)) {
      return NextResponse.json({ error: 'For mange forsøk. Prøv igjen om litt.' }, { status: 429 });
    }

    const cfg = await loadAppConfig();
    if (cfg['renterChecklistEnabled'] === 'false') {
      return NextResponse.json({ error: 'Sjekkliste er ikke aktivert.' }, { status: 403 });
    }

    const body = await request.json();
    const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
    const bookingId = typeof body.bookingId === 'string' ? body.bookingId : undefined;

    if (!phone || normalizePhone(phone).length < 8) {
      return NextResponse.json({ error: 'Oppgi et gyldig telefonnummer.' }, { status: 400 });
    }

    const bookings = await findActiveBookingsByPhone(phone);

    if (bookings.length === 0) {
      return NextResponse.json({
        error: 'Ingen aktiv booking funnet for dette telefonnummeret. Sjekk at leien er betalt og pågår.',
      }, { status: 404 });
    }

    if (bookings.length > 1 && !bookingId) {
      return NextResponse.json({ bookings, needsSelection: true });
    }

    const chosen = bookingId
      ? bookings.find((b) => b.id === bookingId)
      : bookings[0];

    if (!chosen) {
      return NextResponse.json({ error: 'Ugyldig booking valgt.' }, { status: 400 });
    }

    const sessionToken = await createRenterSessionToken(chosen.id, normalizePhone(phone));

    return NextResponse.json({
      booking: chosen,
      sessionToken,
      needsSelection: false,
    });
  } catch (err) {
    console.error('checklist/lookup error:', err);
    return NextResponse.json({ error: 'Oppslag feilet.' }, { status: 500 });
  }
}
