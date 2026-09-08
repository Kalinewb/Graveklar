import type { MetadataRoute } from 'next';
import { loadAppConfig } from '@/lib/app-config';
import { siteBaseUrl } from '@/lib/seo';

export const dynamic = 'force-dynamic';

const DISALLOW = ['/admin', '/api', '/sjekkliste', '/omtale', '/tilbud'];

// `Disallow: /api` used to hide the site's only favicon (/api/icon) from
// Googlebot-Image, which is why search results rendered a generic globe. The
// icons now live at the root, but the legacy path stays explicitly allowed —
// a longer matching rule wins over the broader Disallow — so a cached
// reference to it can still be fetched.
const ALLOW = ['/', '/api/icon'];

export default async function robots(): Promise<MetadataRoute.Robots> {
  const cfg = await loadAppConfig();
  const base = siteBaseUrl(cfg);

  const rules: MetadataRoute.Robots['rules'] = [
    { userAgent: '*', allow: ALLOW, disallow: DISALLOW },
    { userAgent: 'Googlebot', allow: ALLOW, disallow: DISALLOW },
    { userAgent: 'Googlebot-Image', allow: ALLOW, disallow: DISALLOW },
    { userAgent: 'Bingbot', allow: ALLOW, disallow: DISALLOW },
    { userAgent: 'GPTBot', allow: ALLOW, disallow: DISALLOW },
    { userAgent: 'ChatGPT-User', allow: ALLOW, disallow: DISALLOW },
    { userAgent: 'OAI-SearchBot', allow: ALLOW, disallow: DISALLOW },
    { userAgent: 'ClaudeBot', allow: ALLOW, disallow: DISALLOW },
    { userAgent: 'PerplexityBot', allow: ALLOW, disallow: DISALLOW },
  ];

  return {
    rules,
    sitemap: `${base}/sitemap.xml`,
  };
}
