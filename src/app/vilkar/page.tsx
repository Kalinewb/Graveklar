import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import { db } from '@/lib/db';
import { loadAppConfig } from '@/lib/app-config';
import { buildTermsContext, renderTermsString } from '@/lib/terms-template';
import { ensureDefaultBusinessTermsSeeded } from '@/lib/terms-defaults';
import { buildSiteMetadata } from '@/lib/seo';
import { VilkarClient } from './VilkarClient';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const cfg = await loadAppConfig();
  const name = cfg['businessName'] || 'Graveklar';
  return buildSiteMetadata(cfg, [], {
    path: '/vilkar',
    title: `Leievilkår og manualer | ${name}`,
    description: `Leievilkår, bruksanvisninger og dokumenter for utleie av maskiner og utstyr hos ${name}.`,
  });
}

export default async function VilkarPage({
  searchParams,
}: {
  searchParams: Promise<{ vis?: string }>;
}) {
  const { vis } = await searchParams;

  await ensureDefaultBusinessTermsSeeded();

  const [cfg, sections, businessSections, machines] = await Promise.all([
    loadAppConfig(),
    db.termsSection.findMany({
      where: { isActive: true, audience: 'consumer' },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    }),
    db.termsSection.findMany({
      where: { isActive: true, audience: 'business' },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    }),
    db.machine.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { documents: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
    }),
  ]);

  const machinesWithDocs = machines
    .filter((m) => m.documents.length > 0)
    .map((m) => ({
      id: m.id,
      name: m.name,
      model: m.model,
      documents: m.documents.map((d) => ({
        id: d.id,
        title: d.title,
        fileUrl: d.fileUrl,
      })),
    }));

  const ctx = await buildTermsContext();
  const name = cfg['businessName'] || 'Graveklar';
  const org = cfg['orgNumber'] || '';

  const toView = (s: { title: string; content: string }) => ({
    title: renderTermsString(s.title, ctx).output,
    items: renderTermsString(s.content, ctx)
      .output.split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  });
  const terms = sections.map(toView);
  // The Bedrift tab states "Gjelder ved utleie til næringsdrivende (B2B)" — an
  // offer in the operator's own terms. With `b2bEnabled` off, /bedrift is a 404
  // and the insurance cover is consumer-only, so publishing it promised a
  // service that does not exist (Q-14). The rows stay in the database: an
  // individually negotiated offer at /tilbud/<token> renders the same business
  // terms and is not gated on the public B2B page.
  const b2bEnabled = (cfg['b2bEnabled'] || 'false') === 'true';
  const businessTerms = b2bEnabled ? businessSections.map(toView) : [];

  const fmtModified = (rows: { updatedAt: Date }[]) => {
    const latest = rows.reduce<Date | null>((acc, s) => (!acc || s.updatedAt > acc ? s.updatedAt : acc), null);
    return latest
      ? latest.toLocaleDateString('nb-NO', { day: 'numeric', month: 'long', year: 'numeric' })
      : null;
  };
  const lastModifiedLabel = fmtModified(sections);
  const businessLastModifiedLabel = b2bEnabled ? fmtModified(businessSections) : null;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="max-w-3xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4" /><span className="text-sm">Tilbake til {name}</span>
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-10">
        <VilkarClient
          initialTab={vis === 'manualer' ? 'manualer' : vis === 'bedrift' ? 'bedrift' : 'vilkår'}
          businessName={name}
          orgNumber={org}
          lastModifiedLabel={lastModifiedLabel}
          businessLastModifiedLabel={businessLastModifiedLabel}
          terms={terms}
          businessTerms={businessTerms}
          manuals={machinesWithDocs}
        />
      </main>
    </div>
  );
}
