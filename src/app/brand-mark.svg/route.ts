import { buildBrandMarkSvg, normalizeAccent } from '@/lib/brand-icon';
import { loadAppConfig } from '@/lib/app-config';

export const dynamic = 'force-dynamic';

// The header mark. See buildBrandMarkSvg for why this is a request and not
// inline SVG.
export async function GET() {
  const cfg = await loadAppConfig();
  const svg = buildBrandMarkSvg(normalizeAccent(cfg['accentColor']));
  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
    },
  });
}
