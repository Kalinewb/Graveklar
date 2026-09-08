import { NextRequest, NextResponse } from 'next/server';
import { loadConfigValues } from '@/lib/config-server';
import { loadAppConfig } from '@/lib/app-config';
import { calculateDeliveryFee, getConfigValue } from '@/lib/pricing';
import { createRateLimiter } from '@/lib/rate-limit';
import { getDeliveryOrigin } from '@/lib/system-state';
import { signDeliveryQuoteToken } from '@/lib/delivery-quote-token';
import { clientIdentity } from '@/lib/client-ip';

const checkLimit = createRateLimiter(30, 60_000);

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const UA = 'graveklar/1.0';

/** How far a caller-supplied coordinate pair may sit from the server's own
 *  geocode of the same address before the quote is refused. Wide enough for
 *  the normal spread between a picked suggestion and a re-resolved shortened
 *  label, far too narrow to move a delivery between towns. */
const COORD_TRUST_RADIUS_KM = 1;

function getRoadMultiplier(straightLineKm: number): number {
  if (straightLineKm <= 10) return 1.30;
  if (straightLineKm <= 30) return 1.60;
  if (straightLineKm <= 60) return 1.55;
  if (straightLineKm <= 100) return 1.45;
  return 1.40;
}

async function fetchJSON<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timer);
  }
}

async function getOSRMDistance(
  fromLat: number, fromLng: number,
  toLat: number, toLng: number
): Promise<number | null> {
  const url = `https://router.project-osrm.org/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=false`;
  try {
    const data = await fetchJSON<any>(url);
    if (data?.code === 'Ok' && data?.routes?.[0]?.distance) {
      return data.routes[0].distance / 1000;
    }
    return null;
  } catch {
    console.error('OSRM request failed, using fallback multiplier');
    return null;
  }
}

export async function POST(request: NextRequest) {
  try {
    const ip = clientIdentity(request);
    if (checkLimit(ip)) {
      return NextResponse.json({ error: 'For mange forespørsler. Prøv igjen snart.' }, { status: 429 });
    }

    const body = await request.json();
    const { address, lat, lng } = body;

    const [config, , origin] = await Promise.all([
      loadConfigValues(),
      loadAppConfig(),
      getDeliveryOrigin(),
    ]);
    // Origin coords come from SystemState (derived from baseAddress) — never
    // from AppConfig. Fallback to Bodø defaults if SystemState is empty.
    const BASE_LAT = origin?.lat ?? 67.2065;
    const BASE_LNG = origin?.lng ?? 15.1645;
    const DELIVERY_PER_KM = getConfigValue(config, 'deliveryPerKm');
    const MAX_DELIVERY_RADIUS = getConfigValue(config, 'maxDeliveryRadius');

    // The response carries a signed (address, distance, fee) proof that
    // POST /api/bookings trusts *because this route measured it*. So the
    // address is always geocoded here: caller-supplied `lat`/`lng` used to
    // skip geocoding entirely, which meant posting the depot's own
    // coordinates with any address string produced a valid 0 km / 0 kr proof
    // for that string — a delivery outside the insured radius, booked free.
    //
    // The coordinates are still accepted, but only as a precision hint, and
    // only when the server's own geocode of the same address lands within
    // COORD_TRUST_RADIUS_KM of them. That costs the same single Nominatim
    // call as ignoring them outright would, and keeps the exact point of the
    // suggestion the customer picked (the booking form sends the shortened
    // label from /api/address-suggest, which re-resolves less precisely).
    if (!address || typeof address !== 'string' || address.trim().length < 3) {
      return NextResponse.json({ error: 'Oppgi en gyldig adresse' }, { status: 400 });
    }

    const geocodeUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
      address + ', Norge'
    )}&limit=1&countrycodes=no`;

    let geocodeData: any[];
    try {
      geocodeData = await fetchJSON<any[]>(geocodeUrl);
    } catch (e) {
      console.error('Geocoding error:', e);
      return NextResponse.json(
        { error: 'Kunne ikke finne adressen. Sjekk tilkoblingen og prøv igjen.' },
        { status: 503 }
      );
    }

    if (!geocodeData || geocodeData.length === 0) {
      return NextResponse.json(
        { error: 'Kunne ikke finne adressen. Prøv å skrive mer spesifikt, f.eks. "Storgata 1, Oslo".' },
        { status: 404 }
      );
    }

    let destLat = parseFloat(geocodeData[0].lat);
    let destLng = parseFloat(geocodeData[0].lon);
    const displayName: string = geocodeData[0].display_name;

    if (lat !== undefined && lng !== undefined && !isNaN(Number(lat)) && !isNaN(Number(lng))) {
      const drift = haversineDistance(destLat, destLng, Number(lat), Number(lng));
      if (drift > COORD_TRUST_RADIUS_KM) {
        return NextResponse.json(
          { error: 'Koordinatene stemmer ikke med adressen. Velg adressen på nytt fra listen.' },
          { status: 400 }
        );
      }
      destLat = Number(lat);
      destLng = Number(lng);
    }

    let roadDist: number;
    let isEstimated = false;

    const osrmDist = await getOSRMDistance(BASE_LAT, BASE_LNG, destLat, destLng);
    if (osrmDist !== null) {
      roadDist = osrmDist;
    } else {
      const straightDist = haversineDistance(BASE_LAT, BASE_LNG, destLat, destLng);
      roadDist = straightDist * getRoadMultiplier(straightDist);
      isEstimated = true;
    }

    // Round distance to 0.1 km BEFORE the fee math so the value we ship to
    // the client and the value the booking-service drift check recomputes
    // are derived from the same number. Previously the fee was computed on
    // the unrounded distance while the client got the rounded version,
    // which made the drift check reject legitimate submissions at higher
    // per-km rates (the gap could be a multiple of `perKm × 0.1`).
    const displayDistance = Math.round(roadDist * 10) / 10;

    // A refusal is a refusal: this used to be served as HTTP 200 with `error`
    // in the body, so every caller with a generic `if (!res.ok)` read it as a
    // successful quote and had to know to test `fee === null` instead. The
    // body keeps its shape (`error` + `distance` + `fee: null`) so a caller
    // that already reads it still shows the customer the distance.
    if (displayDistance > MAX_DELIVERY_RADIUS) {
      return NextResponse.json({
        error: `Adressen er for langt unna (over ${MAX_DELIVERY_RADIUS} km). Kontakt oss for avtale om levering.`,
        distance: displayDistance,
        fee: null,
      }, { status: 400 });
    }

    // Same helper `validateBookingInput` re-runs at submit time, so the fee
    // signed into the token below cannot fail its own drift check — and a
    // configured `deliveryIncludedKm = 0` really does bill from km 0.
    const fee = calculateDeliveryFee(config, displayDistance);

    return NextResponse.json({
      distance: displayDistance,
      fee,
      perKmRate: DELIVERY_PER_KM,
      address: displayName,
      straightLine: isEstimated,
      withinRadius: true,
      // Signed (address, distance, fee) — POST /api/bookings requires it so
      // the distance/fee can't be edited client-side after this measurement.
      token: await signDeliveryQuoteToken({
        address: typeof address === 'string' ? address : '',
        distance: displayDistance,
        fee,
      }),
    });
  } catch (error: any) {
    console.error('Delivery calculation error:', error?.message || error);
    return NextResponse.json({ error: 'Kunne ikke beregne leveringspris. Prøv igjen.' }, { status: 500 });
  }
}

function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg: number): number {
  return deg * (Math.PI / 180);
}
