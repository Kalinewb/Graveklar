'use client';

import { useCallback, useState } from 'react';
import { FileText, BookOpen, Building2 } from 'lucide-react';
import { SegmentedControl } from '@/components/admin-ui';
import { formatMachineLabel } from '@/lib/machine-display';

export interface TermsSectionView {
  title: string;
  items: string[];
}

export interface ManualDocumentView {
  id: string;
  title: string;
  fileUrl: string;
}

export interface ManualMachineView {
  id: string;
  name: string;
  model: string | null;
  documents: ManualDocumentView[];
}

type Tab = 'vilkår' | 'bedrift' | 'manualer';

interface Props {
  initialTab: Tab;
  businessName: string;
  orgNumber: string;
  lastModifiedLabel: string | null;
  businessLastModifiedLabel: string | null;
  terms: TermsSectionView[];
  businessTerms: TermsSectionView[];
  manuals: ManualMachineView[];
}

export function VilkarClient({
  initialTab,
  businessName,
  orgNumber,
  lastModifiedLabel,
  businessLastModifiedLabel,
  terms,
  businessTerms,
  manuals,
}: Props) {
  const hasTerms = terms.length > 0;
  const hasBusinessTerms = businessTerms.length > 0;
  const hasManuals = manuals.length > 0;
  const [tab, setTab] = useState<Tab>(() => {
    if (initialTab === 'manualer' && hasManuals) return 'manualer';
    if (initialTab === 'bedrift' && hasBusinessTerms) return 'bedrift';
    if (hasTerms) return 'vilkår';
    if (hasBusinessTerms) return 'bedrift';
    if (hasManuals) return 'manualer';
    return 'vilkår';
  });

  const switchTab = useCallback((next: string) => {
    const value = next as Tab;
    setTab(value);
    const url = new URL(window.location.href);
    if (value === 'vilkår') url.searchParams.delete('vis');
    else url.searchParams.set('vis', value);
    window.history.replaceState(null, '', url.pathname + url.search);
  }, []);

  const activeTerms = tab === 'bedrift' ? businessTerms : terms;
  const toggleOptions = [
    ...(hasTerms ? [{ value: 'vilkår', label: 'Privat' }] : []),
    ...(hasBusinessTerms ? [{ value: 'bedrift', label: 'Bedrift' }] : []),
    ...(hasManuals ? [{ value: 'manualer', label: 'Manualer' }] : []),
  ];
  const showToggle = toggleOptions.length > 1;

  return (
    <>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            {tab === 'manualer'
              ? <BookOpen className="w-5 h-5 text-primary" />
              : tab === 'bedrift'
              ? <Building2 className="w-5 h-5 text-primary" />
              : <FileText className="w-5 h-5 text-primary" />}
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              {tab === 'manualer'
                ? 'Manualer og dokumenter'
                : tab === 'bedrift'
                ? 'Leievilkår – bedrift'
                : 'Leievilkår – privat'}
            </h1>
            {tab === 'vilkår' && lastModifiedLabel && (
              <p className="text-sm text-muted-foreground mt-0.5">
                Sist oppdatert {lastModifiedLabel}
              </p>
            )}
            {tab === 'bedrift' && (
              <p className="text-sm text-muted-foreground mt-0.5">
                Gjelder ved utleie til næringsdrivende (B2B)
                {businessLastModifiedLabel ? ` · Sist oppdatert ${businessLastModifiedLabel}` : ''}
              </p>
            )}
            {tab === 'manualer' && (
              <p className="text-sm text-muted-foreground mt-0.5">
                Bruksanvisninger og dokumenter for utstyret
              </p>
            )}
          </div>
        </div>

        {showToggle && (
          <SegmentedControl
            options={toggleOptions}
            value={tab}
            onChange={switchTab}
          />
        )}
      </div>

      {(tab === 'vilkår' || tab === 'bedrift') && (
        <>
          {activeTerms.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8">
              Vilkår er ikke konfigurert ennå. Ta kontakt med utleier.
            </p>
          ) : (
            <div className="space-y-8 text-sm leading-relaxed text-foreground/90">
              {activeTerms.map((section, idx) => (
                <section key={idx}>
                  <h2 className="text-base font-semibold mb-2 text-foreground">
                    {idx + 1}. {section.title}
                  </h2>
                  <ul className="space-y-1.5 text-muted-foreground">
                    {section.items.map((item, i) => (
                      <li key={i} className="flex gap-2">
                        {/* Full-strength muted, not /50: the 50 % opacity
                            composited to #696054 on the dark page ground —
                            2.99:1, under the 4.5:1 AA floor, on all 23 clause
                            numbers (W-6). The plain token is 6.5:1 in both
                            themes and is already the quiet tone this wants. */}
                        <span className="shrink-0 text-muted-foreground font-mono text-xs mt-0.5">
                          {idx + 1}.{i + 1}
                        </span>
                        <span className="leading-relaxed">{item}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}

              <p className="text-xs text-muted-foreground pt-4 border-t border-border">
                {businessName}{orgNumber ? ` · Org.nr ${orgNumber}` : ''}.{' '}
                {tab === 'bedrift'
                  ? 'Gjelder ved utleie til næringsdrivende. Fullstendige vilkår bekreftes ved inngåelse av leieavtale.'
                  : 'Disse vilkårene er utarbeidet i samsvar med Forbrukertilsynets standardvilkår. Fullstendige vilkår vises og bekreftes også ved booking.'}
              </p>
            </div>
          )}
        </>
      )}

      {tab === 'manualer' && (
        <>
          {!hasManuals ? (
            <p className="text-sm text-muted-foreground py-8">
              Ingen manualer er lagt ut ennå.
            </p>
          ) : (
            <div className="space-y-6">
              {manuals.map((m) => (
                <div key={m.id}>
                  <h2 className="text-base font-semibold mb-2 text-foreground">
                    {formatMachineLabel(m)}
                  </h2>
                  <ul className="space-y-1.5">
                    {m.documents.map((d) => (
                      <li key={d.id}>
                        <a
                          href={d.fileUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-2 text-sm text-primary hover:underline underline-offset-2"
                        >
                          <FileText className="w-4 h-4 shrink-0" />
                          {d.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
