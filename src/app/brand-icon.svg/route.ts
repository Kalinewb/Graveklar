import { buildBrandIconSvg, normalizeAccent } from '@/lib/brand-icon';
import { loadAppConfig } from '@/lib/app-config';

export const dynamic = 'force-dynamic';

/**
 * The accent-aware SVG favicon, served from the site root.
 *
 * It used to live at /api/icon — which robots.txt disallows for every crawler,
 * so Googlebot-Image could never fetch the only favicon the site declared and
 * search results fell back to the generic globe. Anything a crawler needs to
 * see has to sit outside /api.
 */
export async function GET() {
  const cfg = await loadAppConfig();
  const svg = buildBrandIconSvg({ size: 512, accent: normalizeAccent(cfg['accentColor']) });

  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
      // Long enough that crawlers and tabs aren't refetching it constantly,
      // short enough that an accent change lands the same day.
      'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
    },
  });
}
