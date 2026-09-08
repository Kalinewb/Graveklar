import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import { loadAppConfig } from '@/lib/app-config';
import { buildSiteMetadata } from '@/lib/seo';
import { KontaktClient } from './KontaktClient';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const cfg = await loadAppConfig();
  const name = cfg['businessName'] || 'Graveklar';
  return buildSiteMetadata(cfg, [], {
    path: '/kontakt',
    title: `Kontakt ${name}`,
    description: `Ta kontakt med ${name} – spørsmål om utleie, levering og booking. Vi svarer så raskt vi kan.`,
  });
}

export default async function KontaktPage() {
  const cfg = await loadAppConfig();
  // Must be a real 404 status, not just the 404 body — see the note in
  // src/app/bedrift/page.tsx: a root-level loading.tsx would stream a 200
  // shell before this line runs (Q-6).
  if ((cfg['contactFormEnabled'] || 'true') !== 'true') notFound();

  const name = cfg['businessName'] || 'Graveklar';

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
        <KontaktClient
          businessName={name}
          contactEmail={cfg['contactEmail'] || ''}
          contactPhone={cfg['contactPhone'] || ''}
        />
      </main>
    </div>
  );
}
