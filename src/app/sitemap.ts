import type { MetadataRoute } from 'next';
import { loadAppConfig } from '@/lib/app-config';
import { db } from '@/lib/db';
import { siteBaseUrl } from '@/lib/seo';

export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const cfg = await loadAppConfig();
  const base = siteBaseUrl(cfg);

  const latestMachine = await db.machine
    .findFirst({
      where: { isActive: true },
      orderBy: { updatedAt: 'desc' },
      select: { updatedAt: true },
    })
    .catch(() => null);

  const homeLastMod = latestMachine?.updatedAt ?? new Date();
  const now = new Date();

  const entries: MetadataRoute.Sitemap = [
    {
      url: `${base}/`,
      lastModified: homeLastMod,
      changeFrequency: 'weekly',
      priority: 1.0,
    },
    {
      url: `${base}/vilkar`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.6,
    },
    {
      url: `${base}/personvern`,
      lastModified: now,
      changeFrequency: 'yearly',
      priority: 0.3,
    },
  ];

  if ((cfg['contactFormEnabled'] || 'true') === 'true') {
    entries.push({
      url: `${base}/kontakt`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.5,
    });
  }

  if ((cfg['b2bEnabled'] || 'false') === 'true') {
    entries.push({
      url: `${base}/bedrift`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.7,
    });
  }

  return entries;
}
