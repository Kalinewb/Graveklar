// Free Nominatim geocoder for admin-side address → lat/lng resolution.
// Public instance has a strict ≤1 req/sec fair-use policy — fine for the
// admin save flow (one call per save), risky for high-traffic endpoints.

export interface GeocodeResult {
  address: string;       // normalized input
  displayName: string;   // human-readable address Nominatim returned
  lat: number;
  lng: number;
  resolvedAt: string;    // ISO timestamp
}

// Whitespace normalization — collapse runs, trim, single-space all gaps.
// Preserves casing so "Industriveien 5" stays cosmetic, but ensures the
// same address never gets geocoded twice with cosmetic-only differences.
export function normalizeAddress(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

export async function geocodeAddress(rawInput: string): Promise<GeocodeResult | null> {
  const address = normalizeAddress(rawInput);
  if (!address) return null;

  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=no&q=${encodeURIComponent(address)}`;

  try {
    const res = await fetch(url, {
      headers: {
        // Nominatim requires a real UA; use the canonical app URL so the
        // OSM operators can reach us if our usage ever becomes a problem.
        'User-Agent': 'Graveklar/1.0 (kontakt@graveklar.no)',
        'Accept': 'application/json',
      },
    });
    if (!res.ok) {
      console.error('[geocode] HTTP error', { input: address, status: res.status });
      return null;
    }
    const data = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
    if (!Array.isArray(data) || data.length === 0) {
      console.warn('[geocode] no match', { input: address });
      return null;
    }
    const result: GeocodeResult = {
      address,
      displayName: data[0].display_name,
      lat: parseFloat(data[0].lat),
      lng: parseFloat(data[0].lon),
      resolvedAt: new Date().toISOString(),
    };
    if (!Number.isFinite(result.lat) || !Number.isFinite(result.lng)) {
      console.error('[geocode] invalid coords', { input: address, raw: data[0] });
      return null;
    }
    console.info('[geocode] resolved', {
      input: address,
      lat: result.lat,
      lng: result.lng,
      displayName: result.displayName,
    });
    return result;
  } catch (err) {
    console.error('[geocode] fetch failed', { input: address, error: (err as Error).message });
    return null;
  }
}
