import { buildBrandIconSvg, normalizeAccent } from '@/lib/brand-icon';
import { loadAppConfig } from '@/lib/app-config';

export const dynamic = 'force-dynamic';

// Legacy path for the browser-tab favicon. The canonical one is
// /brand-icon.svg — this is under /api, which robots.txt disallows, so it must
// never be the only icon the site declares. Kept so existing bookmarks and
// cached references keep resolving.
export async function GET() {
  const cfg = await loadAppConfig();
  const svg = buildBrandIconSvg({ size: 512, accent: normalizeAccent(cfg['accentColor']) });

  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
    },
  });
}
