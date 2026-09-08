'use client';

import { buildDefaultKeywords, buildSeoDescription, buildSeoTitle, parseSeoKeywords, resolveSeoKeywords } from '@/lib/seo';

interface Props {
  values: Record<string, string>;
  machines: { name: string; model?: string | null; category?: string | null }[];
}

export function SeoPreview({ values, machines }: Props) {
  const title = buildSeoTitle(values);
  const description = buildSeoDescription(values, machines);
  const keywords = resolveSeoKeywords(values, machines);
  const manualCount = parseSeoKeywords(values['seoKeywords']).length;
  const descLen = description.length;

  return (
    <CardLike>
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
        Forhåndsvisning i Google
      </div>
      <div className="rounded-lg border border-border bg-background p-4 space-y-1 max-w-xl">
        <div className="text-[#1a0dab] text-lg leading-snug truncate">{title}</div>
        <div className="text-[#006621] text-sm truncate">
          {(values['siteUrl'] || 'dittdomene.no').replace(/^https?:\/\//, '').replace(/\/+$/, '')}
        </div>
        <div className="text-sm text-[#4d5156] leading-relaxed line-clamp-2">{description}</div>
      </div>
      <div className="mt-3 space-y-1 text-xs text-muted-foreground">
        <p>
          Beskrivelse: <span className={descLen > 160 ? 'text-amber-600 font-medium' : 'text-foreground'}>{descLen}</span>/160 tegn
          {descLen > 160 ? ' – kan kuttes i søkeresultat' : ''}
        </p>
        <p>
          Nøkkelord ({keywords.length}):{' '}
          <span className="text-foreground">{keywords.slice(0, 8).join(' · ')}{keywords.length > 8 ? ' …' : ''}</span>
          {manualCount === 0 && (
            <span className="block mt-1 text-muted-foreground/80">Auto-generert fra utstyr og tjenesteområde – legg inn egne for full kontroll.</span>
          )}
        </p>
        {manualCount === 0 && (
          <p className="text-muted-foreground/80">
            Forslag: {buildDefaultKeywords(values, machines).slice(0, 6).join(', ')}
          </p>
        )}
      </div>
    </CardLike>
  );
}

function CardLike({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 rounded-xl border border-border bg-muted/20 p-4">
      {children}
    </div>
  );
}
