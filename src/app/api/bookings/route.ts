import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { createPendingBooking, BookingValidationError, PriceDriftError } from '@/lib/booking-service';
import { buildQuote } from '@/lib/domain/quote';
import { createConsumableRateLimiter, createRateLimiter } from '@/lib/rate-limit';
import type { RentalType } from '@/lib/pricing';
import { verifyDeliveryQuoteToken } from '@/lib/delivery-quote-token';
import { loadAppConfig } from '@/lib/app-config';
import { clientIdentity } from '@/lib/client-ip';

// Two limits, per IP, doing two different jobs.
//
// `checkBurst` is the anti-hammer guard: generous enough that no real person
// hits it, tight enough that a script can't pound the endpoint. It counts
// every request, including rejected ones.
//
// `bookingBudget` caps how many bookings one address can actually create, and
// is charged ONLY after a booking exists. The previous single 5-per-15-minutes
// limiter counted validation failures too, so a customer who mistyped a date a
// few times was locked out for a quarter of an hour having booked nothing —
// and 5 was low enough that a shared address (CGNAT, an office, a campsite
// wifi) could exhaust it between genuine customers.
const checkBurst = createRateLimiter(40, 5 * 60 * 1000);
const bookingBudget = createConsumableRateLimiter(10, 60 * 60 * 1000);

export async function POST(request: NextRequest) {
  const ip = clientIdentity(request);
  if (checkBurst(ip)) {
    return NextResponse.json({ error: 'For mange forespørsler på kort tid. Vent et minutt og prøv igjen.' }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldig forespørsel' }, { status: 400 });
  }

  if (body.website) {
    return NextResponse.json({ error: 'Ugyldig forespørsel' }, { status: 400 });
  }

  const extraHours = Math.min(Math.max(0, parseInt(String(body.extraHours), 10) || 0), 720);
  const deliveryDistance = Math.min(Math.max(0, parseFloat(String(body.deliveryDistance)) || 0), 500);
  const deliveryFee = Math.min(Math.max(0, parseInt(String(body.deliveryFee), 10) || 0), 50000);

  // Drift-check input: the customer's agreed total. Required so we can prove
  // the contract amount, not just trust that the backend recomputed the same
  // number. Without it, a stale or adversarial client could silently accept
  // whatever total the backend produces.
  if (typeof body.expectedTotalKr !== 'number' || !Number.isFinite(body.expectedTotalKr)) {
    return NextResponse.json({ error: 'expectedTotalKr påkrevd' }, { status: 400 });
  }
  const expectedTotalKr = body.expectedTotalKr;

  // Only rental types the admin has enabled are bookable. The form hides the
  // others, but the API has to enforce it too or a crafted request could book
  // a type (and its pricing) the business has switched off.
  const appCfg = await loadAppConfig();

  // Checked after the config load so the message can offer a way through
  // instead of just "try again later" with no timeframe and no fallback.
  if (bookingBudget.isLimited(ip)) {
    const phone = appCfg['contactPhone'];
    return NextResponse.json({
      error: `Vi har registrert uvanlig mange bookinger fra denne nettforbindelsen den siste timen. Ring oss${phone ? ` på ${phone}` : ''} så ordner vi bookingen for deg med en gang.`,
    }, { status: 429 });
  }

  const enabledTypes = (appCfg['enabledRentalTypes'] || 'day,weekend,week')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!enabledTypes.includes(String(body.rentalType))) {
    return NextResponse.json({ error: 'Denne leietypen er ikke tilgjengelig for booking.' }, { status: 400 });
  }

  // Delivery pricing proof. /api/delivery signs the (address, distance, fee)
  // it measured; without a valid proof a client could claim a shorter
  // distance than reality — cheaper/free delivery, or an address outside the
  // insured service radius. Self-pickup has no delivery leg and needs none.
  const selfPickup = Boolean(body.selfPickup);
  if (!selfPickup) {
    const proofOk = await verifyDeliveryQuoteToken(
      typeof body.deliveryQuoteToken === 'string' ? body.deliveryQuoteToken : null,
      { address: String(body.deliveryAddress ?? ''), distance: deliveryDistance, fee: deliveryFee },
    );
    if (!proofOk) {
      return NextResponse.json(
        { error: 'Leveringsprisen må beregnes på nytt. Velg leveringsadressen igjen og prøv på nytt.' },
        { status: 400 },
      );
    }
  }

  try {
    const { booking } = await createPendingBooking({
      name: String(body.name ?? ''),
      phone: String(body.phone ?? ''),
      email: String(body.email ?? ''),
      deliveryAddress: String(body.deliveryAddress ?? ''),
      rentalType: body.rentalType as RentalType,
      startDate: String(body.startDate ?? ''),
      customDays: body.customDays ? parseInt(String(body.customDays), 10) : undefined,
      preferredTime: typeof body.preferredTime === 'string' ? body.preferredTime : undefined,
      deliveryDistance,
      deliveryFee,
      extraHours,
      notes: typeof body.notes === 'string' ? body.notes : undefined,
      termsAccepted: Boolean(body.termsAccepted),
      machineId: typeof body.machineId === 'string' && body.machineId ? body.machineId : undefined,
      selfPickup: Boolean(body.selfPickup),
      discountCode: typeof body.discountCode === 'string' ? body.discountCode : undefined,
      expectedTotalKr,
    });

    // Charged only now that a booking genuinely exists.
    bookingBudget.consume(ip);
    return NextResponse.json({ success: true, booking }, { status: 201 });
  } catch (error) {
    // Price drift: surface a 409 with the fresh quote so the UI can prompt
    // the customer to confirm the new total. This is the boundary fix for
    // "I saw 5000 in the form but Stripe charged 5500" support tickets.
    if (error instanceof PriceDriftError) {
      try {
        const freshQuote = await buildQuote({
          rentalType: body.rentalType as RentalType,
          startDate: String(body.startDate ?? ''),
          customDays: body.customDays ? parseInt(String(body.customDays), 10) : null,
          machineId: typeof body.machineId === 'string' ? body.machineId : null,
          selfPickup: Boolean(body.selfPickup),
          deliveryDistance,
          deliveryFee,
          extraHours,
          email: typeof body.email === 'string' ? body.email : undefined,
          phone: typeof body.phone === 'string' ? body.phone : undefined,
          code: typeof body.discountCode === 'string' ? body.discountCode : null,
        });
        return NextResponse.json(
          { error: error.message, priceDrift: true, expected: error.expected, actual: error.actual, quote: freshQuote },
          { status: 409 },
        );
      } catch {
        return NextResponse.json({ error: error.message, priceDrift: true }, { status: 409 });
      }
    }
    const message = error instanceof Error ? error.message : 'Kunne ikke opprette booking';
    const isValidation = error instanceof BookingValidationError;
    if (!isValidation) console.error('Booking error:', error);
    return NextResponse.json({ error: message }, { status: isValidation ? 400 : 500 });
  }
}

const MAX_PAGE_SIZE = 1000;

export async function GET(request: NextRequest) {
  // Sweep expired pending bookings before returning the list so the admin
  // never sees stale "Venter på betaling" rows past their 60-min deadline.
  // Throttled inside the helper to once per minute.
  const { runCleanupIfDue } = await import('@/lib/cleanup');
  await runCleanupIfDue().catch((err) => console.error('cleanup error:', err));

  try {
    const { searchParams } = request.nextUrl;
    const limitRaw = parseInt(searchParams.get('limit') ?? '', 10);
    // Optional opt-in pagination. Without ?limit= the endpoint returns
    // every booking (current admin UI behaviour). Capped at MAX_PAGE_SIZE
    // so a future caller can't accidentally fetch unbounded rows.
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(MAX_PAGE_SIZE, limitRaw)) : null;
    const cursor = searchParams.get('cursor');
    const statusFilter = searchParams.get('status');

    const bookings = await db.booking.findMany({
      where: statusFilter ? { status: statusFilter } : undefined,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(limit ? { take: limit + 1 } : {}),
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    if (limit) {
      const hasMore = bookings.length > limit;
      const page = hasMore ? bookings.slice(0, limit) : bookings;
      const nextCursor = hasMore ? page[page.length - 1].id : null;
      return NextResponse.json({ bookings: page, nextCursor, hasMore });
    }
    return NextResponse.json({ bookings });
  } catch (error) {
    console.error('Fetch bookings error:', error);
    return NextResponse.json({ error: 'Kunne ikke hente bookinger' }, { status: 500 });
  }
}
