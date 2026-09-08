import type { MetadataRoute } from 'next';
import { loadAppConfig } from '@/lib/app-config';
import { normalizeAccent } from '@/lib/brand-icon';
import { buildSeoDescription } from '@/lib/seo';

export const dynamic = 'force-dynamic';

/**
 * Web app manifest, served at /manifest.webmanifest.
 *
 * Without one, "add to home screen" has no name and no icon to work from —
 * the browser falls back to a screenshot of the page or a letter tile. The
 * 192 and 512 PNGs are the two sizes the install prompt actually requires;
 * the maskable one lets Android crop it into whatever shape the launcher uses
 * instead of shrinking the square inside a white circle.
 */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const cfg = await loadAppConfig();
  const name = cfg['businessName'] || 'Graveklar';
  const accent = normalizeAccent(cfg['accentColor']);

  return {
    name: `${name} – utstyrsutleie`,
    short_name: name,
    // Same description the page metadata uses, so the install prompt and the
    // search result say the same thing. heroSubtext is deliberately not used:
    // it carries an asterisk pointing at a footnote that doesn't exist here.
    description: buildSeoDescription(cfg),
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#F5F0E6',
    theme_color: accent,
    lang: 'nb',
    categories: ['business', 'utilities'],
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
