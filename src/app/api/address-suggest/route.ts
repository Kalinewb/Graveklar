import { NextRequest, NextResponse } from 'next/server';
import { createRateLimiter } from '@/lib/rate-limit';
import { clientIdentity } from '@/lib/client-ip';

const checkLimit = createRateLimiter(60, 60_000);

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const UA = 'graveklar/1.0';

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

export async function POST(request: NextRequest) {
  try {
    const ip = clientIdentity(request);
    if (checkLimit(ip)) {
      return NextResponse.json({ results: [] }, { status: 429 });
    }

    const { query } = await request.json();

    if (!query || typeof query !== 'string' || query.trim().length < 3) {
      return NextResponse.json({ results: [] });
    }

    const geocodeUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
      query + ', Norge'
    )}&limit=5&countrycodes=no&addressdetails=1`;

    let results: any[];
    try {
      results = await fetchJSON<any[]>(geocodeUrl);
    } catch (e) {
      console.error('Address suggest error:', e);
      return NextResponse.json({ results: [] });
    }

    if (!results || !Array.isArray(results)) {
      return NextResponse.json({ results: [] });
    }

    const suggestions = results.map((r: any) => {
      const addr = r.address || {};
      const parts: string[] = [];
      if (addr.road) {
        const house = addr.house_number ? ` ${addr.house_number}` : '';
        parts.push(`${addr.road}${house}`);
      } else if (addr.pedestrian) {
        parts.push(addr.pedestrian);
      } else if (addr.suburb) {
        parts.push(addr.suburb);
      }
      const city = addr.city || addr.town || addr.village || addr.municipality || '';
      if (addr.postcode && city) {
        parts.push(`${addr.postcode} ${city}`);
      } else if (city) {
        parts.push(city);
      }
      const shortName =
        parts.length >= 2
          ? parts.join(', ')
          : r.display_name.split(',').slice(0, 2).join(',').trim();

      return {
        display_name: r.display_name,
        short_name: shortName,
        lat: r.lat,
        lon: r.lon,
        type: r.type || '',
      };
    });

    return NextResponse.json({ results: suggestions });
  } catch (error: any) {
    console.error('Address suggest error:', error?.message || error);
    return NextResponse.json({ results: [] });
  }
}
