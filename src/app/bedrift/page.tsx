import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import { db } from '@/lib/db';
import { loadAppConfig } from '@/lib/app-config';
import { buildSiteMetadata } from '@/lib/seo';
import { BedriftClient } from './BedriftClient';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const cfg = await loadAppConfig();
  const name = cfg['businessName'] || 'Graveklar';
  const area = cfg['serviceArea'] || '';
  return buildSiteMetadata(cfg, [], {
    path: '/bedrift',
    title: `Leie til bedrift | ${name}`,
    description: `Be om tilbud på leie av gravemaskin og utstyr til bedrift${area ? ` i ${area}` : ''}. Skreddersydd pris og fleksible vilkår.`,
  });
}

export default async function BedriftPage() {
  const cfg = await loadAppConfig();
  // A page that is switched off has to answer a real 404, not just render the
  // 404 body — crawlers index the disabled page otherwise, and every link
  // checker and uptime monitor reads it as healthy (Q-6). That works only as
  // long as no Suspense boundary sits above this segment: a `loading.tsx` in
  // src/app/ flushed the shell with a 200 status line before this check could
  // run, which is why there is none. Keep it that way, or move the flag test
  // into src/proxy.ts.
  if ((cfg['b2bEnabled'] || 'false') !== 'true') notFound();

  const machines = await db.machine.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, name: true, model: true },
  });

  const name = cfg['businessName'] || 'Graveklar';
  const enabledRentalTypes = (cfg['enabledRentalTypes'] || 'day,weekend,week')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4" /><span className="text-sm">Tilbake til {name}</span>
          </Link>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-10">
        <BedriftClient
          businessName={name}
          machines={machines}
          enabledRentalTypes={enabledRentalTypes}
        />
      </main>
    </div>
  );
}
