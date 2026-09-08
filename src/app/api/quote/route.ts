import { NextRequest, NextResponse } from 'next/server';
import { buildQuote, type QuoteInputs } from '@/lib/domain/quote';
import { createRateLimiter } from '@/lib/rate-limit';
import type { RentalType } from '@/lib/pricing';
import { clientIdentity } from '@/lib/client-ip';

export const dynamic = 'force-dynamic';

// Called on every relevant booking-form change (debounced). Authoritative
// source for prices the customer sees. The same `buildQuote` runs inside
// /api/bookings at submission time — drift is impossible by construction.
const checkLimit = createRateLimiter(60, 60_000);

const VALID_RENTAL_TYPES = new Set<RentalType>(['day', 'weekend', 'week', 'custom']);

/** A finite number, or null. `Number("gratis")` is NaN, and a NaN that reaches
 *  the pricing math comes back out as a 200 whose money fields serialise to
 *  `null` — so unusable input is dropped at the boundary instead. */
function finiteOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function POST(request: NextRequest) {
  const ip = clientIdentity(request);
  if (checkLimit(ip)) {
    return NextResponse.json({ error: 'For mange forespørsler. Prøv igjen om litt.' }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Minimal input shape check — we don't validate full booking semantics
  // here, only enough to call buildQuote safely.
  const rentalType = body.rentalType as RentalType;
  if (!VALID_RENTAL_TYPES.has(rentalType)) {
    return NextResponse.json({ error: 'Ugyldig rentalType' }, { status: 400 });
  }
  const startDate = typeof body.startDate === 'string' ? body.startDate : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return NextResponse.json({ error: 'Ugyldig startDate' }, { status: 400 });
  }

  const inputs: QuoteInputs = {
    rentalType,
    startDate,
    customDays: finiteOrNull(body.customDays),
    machineId: typeof body.machineId === 'string' ? body.machineId : null,
    selfPickup: Boolean(body.selfPickup),
    deliveryDistance: finiteOrNull(body.deliveryDistance),
    deliveryFee: finiteOrNull(body.deliveryFee),
    extraHours: body.extraHours != null ? Math.max(0, Math.min(720, parseInt(String(body.extraHours), 10) || 0)) : 0,
    email: typeof body.email === 'string' ? body.email : undefined,
    phone: typeof body.phone === 'string' ? body.phone : undefined,
    code: typeof body.code === 'string' && body.code.trim().length > 0 ? body.code.trim() : null,
  };

  try {
    const quote = await buildQuote(inputs);
    return NextResponse.json(quote);
  } catch (err) {
    console.error('quote/build error:', err);
    return NextResponse.json({ error: 'Kunne ikke beregne pris.' }, { status: 500 });
  }
}
