'use client';

import { use, useEffect, useState, type ReactNode } from 'react';
import { Printer, ArrowLeft, Loader2, Shield, Hash, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface CompanyInfo {
  name: string;
  orgNumber: string;
  address: string;
  email: string;
  phone: string;
  siteUrl: string;
  logoUrl: string;
}

interface ContractPayload {
  company: CompanyInfo;
  booking: { id: string; reference: string; name: string; email: string } | null;
  contract: {
    id: string;
    renderedHtml: string;
    termsVersionHash: string;
    renderContext: Record<string, string>;
    acceptedAt: string;
    acceptedFromIp: string | null;
    acceptanceMethod: string;
    createdAt: string;
  };
}

// ── Printable contract front page ────────────────────────────────────────
// Composed at view time from the booking snapshot (frozen renderContext) plus
// the LIVE company identity from settings. Sits ahead of the frozen terms so
// "Skriv ut" yields a per-order cover sheet (parties, equipment, price, ID
// check, signatures) followed by the agreed terms.

const RENTAL_TYPE_LABELS: Record<string, string> = {
  day: 'Døgn',
  weekend: 'Helg',
  week: 'Uke',
  custom: 'Tilpasset',
};

function CoverField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{label}</dt>
      <dd className="text-sm text-zinc-900">{value || '–'}</dd>
    </div>
  );
}

function SignatureLine({ role, name }: { role: string; name?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="h-12 border-b border-zinc-400" />
      <div className="text-[11px] text-zinc-600">
        {role}
        {name ? ` — ${name}` : ''}
      </div>
      <div className="text-[10px] text-zinc-400">Sted og dato</div>
    </div>
  );
}

function ContractCover({ company, ctx }: { company: CompanyInfo; ctx: Record<string, string> }) {
  const kr = (s?: string) => {
    const n = Number(s);
    return Number.isFinite(n) && s !== '' && s != null ? `${n.toLocaleString('nb-NO')} kr` : '–';
  };
  const fmtDate = (s?: string) => {
    if (!s) return '–';
    const d = new Date(`${s}T00:00:00`);
    return Number.isNaN(d.getTime())
      ? s
      : d.toLocaleDateString('nb-NO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  };

  const reference = ctx['booking.reference'] || '';
  const selfPickup = ctx['booking.selfPickup'] === 'true';
  const customDays = ctx['booking.customDays'];
  const rentalType = ctx['booking.rentalType'] || '';
  const machineName = ctx['booking.machine.name'] || '';
  const machineModel = ctx['booking.machine.model'] || '';
  const discountKr = Number(ctx['booking.discountKr']);
  const hasDiscount = Number.isFinite(discountKr) && discountKr > 0;
  const extraHours = Number(ctx['booking.extraHours']);

  const durationLabel = customDays
    ? `${customDays} ${Number(customDays) === 1 ? 'dag' : 'dager'}`
    : RENTAL_TYPE_LABELS[rentalType] || rentalType || '–';

  return (
    <section
      className="bg-white text-zinc-900 rounded-xl shadow-sm border border-border p-8 print:border-0 print:shadow-none print:rounded-none print:p-0"
      style={{ breakAfter: 'page' }}
    >
      {/* Header: logo + company identity */}
      <header className="flex items-start justify-between gap-4 pb-5 border-b border-zinc-200">
        <div className="flex items-center gap-3 min-w-0">
          {company.logoUrl ? (
            <img src={company.logoUrl} alt={company.name} className="h-12 w-auto max-w-[160px] object-contain" />
          ) : null}
          <div className="min-w-0">
            <div className="text-lg font-bold leading-tight">{company.name}</div>
            {company.orgNumber ? (
              <div className="text-xs text-zinc-500">Org.nr {company.orgNumber}</div>
            ) : null}
          </div>
        </div>
        <div className="text-right text-[11px] text-zinc-600 leading-snug shrink-0">
          {company.address ? <div>{company.address}</div> : null}
          {company.phone ? <div>{company.phone}</div> : null}
          {company.email ? <div>{company.email}</div> : null}
          {company.siteUrl ? <div>{company.siteUrl.replace(/^https?:\/\//, '')}</div> : null}
        </div>
      </header>

      {/* Title + reference */}
      <div className="flex items-baseline justify-between gap-3 mt-5">
        <h1 className="text-2xl font-bold tracking-tight">Leiekontrakt</h1>
        {reference ? (
          <span className="font-mono text-sm text-zinc-600">{reference}</span>
        ) : null}
      </div>

      {/* Parties */}
      <div className="grid grid-cols-2 gap-6 mt-6">
        <div>
          <h2 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">Utleier</h2>
          <div className="text-sm text-zinc-900">{company.name}</div>
          {company.orgNumber ? <div className="text-xs text-zinc-500">Org.nr {company.orgNumber}</div> : null}
          {company.address ? <div className="text-xs text-zinc-500">{company.address}</div> : null}
        </div>
        <div>
          <h2 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">Leietaker</h2>
          <div className="text-sm text-zinc-900">{ctx['booking.name'] || '–'}</div>
          {ctx['booking.phone'] ? <div className="text-xs text-zinc-500">{ctx['booking.phone']}</div> : null}
          {ctx['booking.email'] ? <div className="text-xs text-zinc-500">{ctx['booking.email']}</div> : null}
        </div>
      </div>

      {/* Booking details */}
      <h2 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mt-7 mb-3 pb-1 border-b border-zinc-200">
        Bookingdetaljer
      </h2>
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4">
        <CoverField label="Utstyr" value={[machineName, machineModel].filter(Boolean).join(' · ')} />
        <CoverField label="Leietype" value={RENTAL_TYPE_LABELS[rentalType] || rentalType} />
        <CoverField label="Varighet" value={durationLabel} />
        <CoverField label="Oppstart" value={fmtDate(ctx['booking.startDate'])} />
        <CoverField label="Levering" value={selfPickup ? 'Henting hos utleier' : 'Levering til adresse'} />
        <CoverField label={selfPickup ? 'Adresse' : 'Leveringsadresse'} value={ctx['booking.deliveryAddress']} />
        <CoverField label="Inkluderte timer" value={ctx['booking.includedHours'] || '–'} />
        {Number.isFinite(extraHours) && extraHours > 0 ? (
          <CoverField label="Forhåndsbestilte timer" value={String(extraHours)} />
        ) : null}
      </dl>

      {/* Price summary */}
      <h2 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mt-7 mb-3 pb-1 border-b border-zinc-200">
        Pris
      </h2>
      <dl className="text-sm space-y-1.5 max-w-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-zinc-600">Grunnpris</dt>
          <dd className="tabular-nums">{kr(ctx['booking.basePrice'])}</dd>
        </div>
        {Number(ctx['booking.extraHoursCost']) > 0 ? (
          <div className="flex justify-between gap-4">
            <dt className="text-zinc-600">Forhåndsbestilte timer</dt>
            <dd className="tabular-nums">{kr(ctx['booking.extraHoursCost'])}</dd>
          </div>
        ) : null}
        {Number(ctx['booking.deliveryFee']) > 0 ? (
          <div className="flex justify-between gap-4">
            <dt className="text-zinc-600">Levering</dt>
            <dd className="tabular-nums">{kr(ctx['booking.deliveryFee'])}</dd>
          </div>
        ) : null}
        {hasDiscount ? (
          <div className="flex justify-between gap-4 text-emerald-700">
            <dt>{ctx['booking.discountLabel'] || 'Rabatt'}</dt>
            <dd className="tabular-nums">−{kr(ctx['booking.discountKr'])}</dd>
          </div>
        ) : null}
        <div className="flex justify-between gap-4 pt-1.5 border-t border-zinc-200 font-semibold">
          <dt>Totalt betalt</dt>
          <dd className="tabular-nums">{kr(ctx['booking.totalPrice'])}</dd>
        </div>
      </dl>

      {/* Signatures */}
      <h2 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mt-7 mb-3 pb-1 border-b border-zinc-200">
        Signering
      </h2>
      <div className="grid grid-cols-2 gap-8 mt-8">
        <SignatureLine role="Utleier" name={company.name} />
        <SignatureLine role="Leietaker" name={ctx['booking.name']} />
      </div>
    </section>
  );
}

export default function ContractViewerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [data, setData] = useState<ContractPayload | null>(null);
  const [error, setError] = useState('');

  // The contract opens in a new tab (target="_blank" rel="noopener"), so there's
  // no history to go back to and window.close() is blocked. Fall back to /admin.
  const goBack = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      window.history.back();
    } else {
      window.location.href = '/admin';
    }
  };

  useEffect(() => {
    fetch(`/api/admin/bookings/${id}/contract`)
      .then(async (r) => {
        if (!r.ok) {
          const e = await r.json();
          throw new Error(e.error || 'Kunne ikke hente kontrakt');
        }
        return r.json() as Promise<ContractPayload>;
      })
      .then(setData)
      .catch((e) => setError((e as Error).message));
  }, [id]);

  // Once the contract is loaded: name the document "Kontrakt - <email>" so the
  // browser's Save-as-PDF defaults to that filename. With ?autoprint=1 (opened
  // from the booking detail's print button) also fire the print dialog right
  // away and close the helper tab afterwards — so the admin never has to open
  // and navigate the contract page manually.
  useEffect(() => {
    if (!data) return;
    const label = data.booking?.email || data.booking?.reference || 'kontrakt';
    document.title = `Kontrakt - ${label}`;
    const autoprint = new URLSearchParams(window.location.search).get('autoprint') === '1';
    if (!autoprint) return;
    const closeAfter = () => window.close();
    window.addEventListener('afterprint', closeAfter);
    // Small delay so the cover + terms (and the logo image) are laid out
    // before the print snapshot is taken.
    const t = setTimeout(() => window.print(), 450);
    return () => {
      clearTimeout(t);
      window.removeEventListener('afterprint', closeAfter);
    };
  }, [data]);

  if (error) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6 bg-background">
        <div className="max-w-md text-center space-y-3">
          <p className="text-destructive font-medium">{error}</p>
          <Button variant="outline" onClick={goBack}>
            <ArrowLeft className="w-4 h-4 mr-2" /> Tilbake
          </Button>
        </div>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </main>
    );
  }

  const { contract, booking } = data;

  // The frozen artifact is a FULL <html><body style="…"> document. Injecting
  // it via innerHTML drops the <body> tag (and its framing styles: font,
  // max-width, padding) — leaving the terms unstyled and edge-to-edge, which
  // prints badly. Extract the body's inner HTML and re-apply the framing on a
  // wrapper instead, so the on-screen and PDF output match the document.
  const termsInner = (() => {
    const html = contract.renderedHtml || '';
    const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    return m ? m[1] : html;
  })();

  return (
    <main className="min-h-screen bg-background">
      {/* Print rules for the frozen contract: real page margins, and keep each
          terms section + its heading together so a clause never splits across
          a page boundary in the PDF. */}
      <style
        dangerouslySetInnerHTML={{
          __html: `@media print {
            @page { margin: 16mm; }
            .frozen-terms section { break-inside: avoid; page-break-inside: avoid; }
            .frozen-terms h1, .frozen-terms h2 { break-after: avoid; page-break-after: avoid; }
          }`,
        }}
      />
      {/* Toolbar — hidden on print */}
      <div className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur print:hidden">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Button size="sm" variant="ghost" onClick={goBack}>
              <ArrowLeft className="w-4 h-4 mr-1.5" /> Tilbake
            </Button>
            <div className="text-sm min-w-0">
              <div className="font-semibold truncate">
                {booking?.reference} – {booking?.name}
              </div>
              <div className="text-xs text-muted-foreground truncate">Frosset kontrakt</div>
            </div>
          </div>
          <Button size="sm" onClick={() => window.print()} className="gap-2">
            <Printer className="w-4 h-4" /> Skriv ut / lagre som PDF
          </Button>
        </div>
      </div>

      {/* Printable contract front page — per-order cover sheet. Prints on its
          own page (breakAfter), then the frozen terms follow. */}
      <div className="max-w-3xl mx-auto px-4 pt-6 print:px-0 print:pt-0">
        <ContractCover company={data.company} ctx={contract.renderContext} />
      </div>

      <div className="max-w-6xl mx-auto px-4 py-6 grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-6 print:block print:p-0">
        {/* Frozen HTML body content — what the customer agreed to. The body's
            own framing (font/max-width/padding) is re-applied here since the
            <body> wrapper is stripped on injection. print:block above collapses
            the grid so the printed terms use the full page, not the 1fr column
            that leaves a gap where the (hidden) sidebar was. */}
        <article
          className="frozen-terms bg-white text-zinc-900 rounded-xl shadow-sm border border-border print:border-0 print:shadow-none print:rounded-none"
          style={{
            fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
            maxWidth: '760px',
            margin: '0 auto',
            padding: '2.5rem 2rem',
          }}
          dangerouslySetInnerHTML={{ __html: termsInner }}
        />

        {/* Metadata sidebar — hidden on print so the printed contract is
            the document itself, not an audit dump. */}
        <aside className="space-y-4 print:hidden">
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
              <Shield className="w-3.5 h-3.5" /> Aksept
            </h3>
            <dl className="text-xs space-y-1.5">
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Akseptert</dt>
                <dd className="text-right">{new Date(contract.acceptedAt).toLocaleString('nb-NO')}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Metode</dt>
                <dd className="text-right font-mono text-[11px]">{contract.acceptanceMethod}</dd>
              </div>
              {contract.acceptedFromIp && (
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">IP</dt>
                  <dd className="text-right font-mono text-[11px]">{contract.acceptedFromIp}</dd>
                </div>
              )}
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3" />Frosset</dt>
                <dd className="text-right">{new Date(contract.createdAt).toLocaleString('nb-NO')}</dd>
              </div>
            </dl>
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
              <Hash className="w-3.5 h-3.5" /> Versjon
            </h3>
            <code className="block text-[10px] font-mono break-all bg-muted px-2 py-1.5 rounded">
              {contract.termsVersionHash}
            </code>
            <p className="text-[11px] text-muted-foreground mt-1.5 leading-snug">
              SHA-256 av (vilkårsmal + variabler). Endrer du vilkårene senere, beholder denne kontrakten samme hash.
            </p>
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Variabler ved aksept
            </h3>
            <dl className="text-xs space-y-1">
              {Object.entries(contract.renderContext).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2 border-b border-border/50 py-0.5">
                  <dt className="font-mono text-[10px] text-muted-foreground">{k}</dt>
                  <dd className="text-right truncate max-w-[140px]" title={v}>{v || '–'}</dd>
                </div>
              ))}
            </dl>
          </section>
        </aside>
      </div>
    </main>
  );
}
