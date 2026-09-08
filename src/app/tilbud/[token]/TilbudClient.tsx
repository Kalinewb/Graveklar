'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Building2, CheckCircle2, Clock, CreditCard, FileText, Loader2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface TermsView {
  title: string;
  items: string[];
}

interface Offer {
  reference: string;
  company: string;
  contactName: string;
  machineName: string | null;
  period: string | null;
  offerAmount: number | null;
  offerMessage: string | null;
  offerValidUntil: string | null;
  paymentMode: 'card' | 'invoice';
  status: string;
  expired: boolean;
  alreadyConverted: boolean;
}

interface Props {
  token: string;
  businessName: string;
  orgNumber: string;
  offer: Offer;
  businessTerms: TermsView[];
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <main className="max-w-2xl mx-auto px-4 py-12">{children}</main>
    </div>
  );
}

function StatusCard({ icon, title, text, tone = 'muted' }: { icon: React.ReactNode; title: string; text: string; tone?: 'muted' | 'green' | 'red' }) {
  const ring = tone === 'green' ? 'bg-green-100 text-green-700' : tone === 'red' ? 'bg-red-100 text-red-700' : 'bg-muted text-muted-foreground';
  return (
    <div className="text-center py-12">
      <div className={`w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-5 ${ring}`}>{icon}</div>
      <h1 className="text-2xl font-bold tracking-tight mb-2">{title}</h1>
      <p className="text-muted-foreground max-w-md mx-auto">{text}</p>
      <div className="mt-8">
        <Button asChild variant="outline"><Link href="/">Til forsiden</Link></Button>
      </div>
    </div>
  );
}

export function TilbudClient({ token, businessName, orgNumber, offer, businessTerms }: Props) {
  const [submitting, setSubmitting] = useState<null | 'accept' | 'decline'>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<null | 'invoice' | 'declined'>(null);

  const terminalDeclined = offer.status === 'avslatt';
  const terminalAccepted = offer.alreadyConverted || offer.status === 'konvertert' || offer.status === 'akseptert';
  const notActive = offer.status !== 'tilbud_sendt';

  const post = async (action: 'accept' | 'decline') => {
    setError(null);
    setSubmitting(action);
    try {
      const res = await fetch(`/api/tilbud/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Noe gikk galt');
      if (action === 'decline') {
        setDone('declined');
        return;
      }
      if (data.mode === 'card' && data.url) {
        window.location.href = data.url;
        return;
      }
      setDone('invoice');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Noe gikk galt');
      setSubmitting(null);
    }
  };

  if (done === 'declined' || terminalDeclined) {
    return (
      <Shell>
        <StatusCard icon={<XCircle className="w-7 h-7" />} title="Tilbud avslått" text="Du har takket nei til tilbudet. Ta gjerne kontakt om du ønsker et nytt." />
      </Shell>
    );
  }
  if (done === 'invoice') {
    return (
      <Shell>
        <StatusCard tone="green" icon={<CheckCircle2 className="w-7 h-7" />} title="Tilbud akseptert" text={`Takk! Vi har registrert aksepten for ${offer.reference}. Du mottar bekreftelse og faktura på e-post.`} />
      </Shell>
    );
  }
  if (terminalAccepted && offer.paymentMode === 'invoice') {
    return (
      <Shell>
        <StatusCard tone="green" icon={<CheckCircle2 className="w-7 h-7" />} title="Allerede akseptert" text={`Dette tilbudet (${offer.reference}) er allerede akseptert. Bekreftelse er sendt på e-post.`} />
      </Shell>
    );
  }
  if (offer.expired && !terminalAccepted) {
    return (
      <Shell>
        <StatusCard icon={<Clock className="w-7 h-7" />} title="Tilbudet er utløpt" text="Gyldighetsperioden for dette tilbudet har gått ut. Ta kontakt for et oppdatert tilbud." />
      </Shell>
    );
  }
  if (notActive && !terminalAccepted) {
    return (
      <Shell>
        <StatusCard icon={<FileText className="w-7 h-7" />} title="Tilbudet er ikke aktivt" text="Dette tilbudet er ikke lenger tilgjengelig. Ta kontakt med utleier." />
      </Shell>
    );
  }

  const validUntil = offer.offerValidUntil
    ? new Date(offer.offerValidUntil).toLocaleDateString('nb-NO', { day: 'numeric', month: 'long', year: 'numeric' })
    : null;
  const acceptLabel = offer.paymentMode === 'card' ? 'Aksepter og betal' : 'Aksepter tilbud';

  return (
    <Shell>
      <div className="flex items-center gap-3 mb-1">
        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          <Building2 className="w-5 h-5 text-primary" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight">Tilbud på leie</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        {businessName}{orgNumber ? ` · Org.nr ${orgNumber}` : ''} · Referanse {offer.reference}
      </p>

      {terminalAccepted && offer.paymentMode === 'card' && (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          Tilbudet er akseptert, men betalingen er ikke fullført. Klikk «{acceptLabel}» for å fullføre betalingen.
        </div>
      )}

      <div className="rounded-xl border border-border bg-card p-5 space-y-3">
        <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <div className="text-muted-foreground">Firma: <span className="text-foreground font-medium">{offer.company}</span></div>
          <div className="text-muted-foreground">Kontakt: <span className="text-foreground">{offer.contactName}</span></div>
          <div className="text-muted-foreground">Maskin: <span className="text-foreground">{offer.machineName ?? 'Etter avtale'}</span></div>
          <div className="text-muted-foreground">Periode: <span className="text-foreground">{offer.period ?? 'Etter avtale'}</span></div>
        </div>
        <div className="flex items-end justify-between pt-3 border-t border-border">
          <div>
            <div className="text-xs text-muted-foreground">Pris (eks. mva)</div>
            <div className="text-3xl font-bold tracking-tight">
              {offer.offerAmount != null ? `${offer.offerAmount.toLocaleString('nb-NO')} kr` : '—'}
            </div>
          </div>
          <div className="text-right text-sm text-muted-foreground">
            <div className="inline-flex items-center gap-1.5">
              <CreditCard className="w-4 h-4" />
              {offer.paymentMode === 'card' ? 'Kortbetaling' : 'Faktura'}
            </div>
            {validUntil && <div className="text-xs mt-1">Gyldig til {validUntil}</div>}
          </div>
        </div>
        {offer.offerMessage && (
          <p className="text-sm bg-muted/40 rounded-lg p-3 text-muted-foreground whitespace-pre-wrap">{offer.offerMessage}</p>
        )}
      </div>

      {businessTerms.length > 0 && (
        <details className="mt-6 rounded-xl border border-border bg-card">
          <summary className="cursor-pointer px-5 py-3 text-sm font-medium select-none">Bedriftsvilkår</summary>
          <div className="px-5 pb-5 space-y-5 text-sm border-t border-border pt-4">
            {businessTerms.map((section, idx) => (
              <section key={idx}>
                <h3 className="font-semibold text-foreground mb-1.5">{idx + 1}. {section.title}</h3>
                <ul className="space-y-1 text-muted-foreground">
                  {section.items.map((item, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="shrink-0 text-muted-foreground/50 font-mono text-xs mt-0.5">{idx + 1}.{i + 1}</span>
                      <span className="leading-relaxed">{item}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </details>
      )}

      <p className="text-xs text-muted-foreground mt-5">
        Ved å akseptere bekrefter du bedriftsvilkårene, herunder at fører har gyldig dokumentert opplæring (M2) og at
        bedriften er arbeidsgiver med ansvar for HMS ved bruk.
      </p>

      {error && <p className="text-sm text-destructive mt-4">{error}</p>}

      <div className="flex flex-col sm:flex-row gap-3 mt-6">
        <Button size="lg" className="flex-1" onClick={() => post('accept')} disabled={submitting !== null}>
          {submitting === 'accept' ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
          {acceptLabel}
        </Button>
        <Button size="lg" variant="outline" onClick={() => post('decline')} disabled={submitting !== null}>
          {submitting === 'decline' ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
          Takk nei
        </Button>
      </div>
    </Shell>
  );
}
