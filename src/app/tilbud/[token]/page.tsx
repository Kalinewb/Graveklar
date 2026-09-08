import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { loadAppConfig } from '@/lib/app-config';
import { buildTermsContext, renderTermsString } from '@/lib/terms-template';
import { ensureDefaultBusinessTermsSeeded } from '@/lib/terms-defaults';
import { TilbudClient } from './TilbudClient';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Tilbud',
  robots: { index: false, follow: false },
};

function rentalLabel(rentalType: string | null, customDays: number | null): string | null {
  if (!rentalType) return null;
  if (rentalType === 'custom') return customDays ? `Tilpasset (${customDays} dager)` : 'Tilpasset';
  return ({ day: '1 dag', weekend: 'Helg', week: '1 uke' } as Record<string, string>)[rentalType] ?? rentalType;
}

export default async function TilbudPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const quote = await db.quoteRequest.findUnique({
    where: { acceptToken: token },
    include: { machine: { select: { name: true, model: true } } },
  });
  if (!quote) notFound();

  await ensureDefaultBusinessTermsSeeded();
  const [cfg, sections, ctx] = await Promise.all([
    loadAppConfig(),
    db.termsSection.findMany({
      where: { isActive: true, audience: 'business' },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    }),
    buildTermsContext(),
  ]);

  const businessTerms = sections.map((s) => ({
    title: renderTermsString(s.title, ctx).output,
    items: renderTermsString(s.content, ctx).output.split('\n').map((l) => l.trim()).filter(Boolean),
  }));

  const now = new Date();
  const expired = Boolean(
    (quote.acceptTokenExpiry && quote.acceptTokenExpiry < now) ||
      (quote.offerValidUntil && quote.offerValidUntil < now)
  );

  const period = [
    rentalLabel(quote.rentalType, quote.customDays),
    quote.startDate
      ? `fra ${quote.startDate.toLocaleDateString('nb-NO', { day: 'numeric', month: 'long', year: 'numeric' })}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <TilbudClient
      token={token}
      businessName={cfg['businessName'] || 'Graveklar'}
      orgNumber={cfg['orgNumber'] || ''}
      offer={{
        reference: quote.reference,
        company: quote.company,
        contactName: quote.contactName,
        machineName: quote.machine?.name ?? null,
        period: period || null,
        offerAmount: quote.offerAmount,
        offerMessage: quote.offerMessage,
        offerValidUntil: quote.offerValidUntil ? quote.offerValidUntil.toISOString() : null,
        paymentMode: quote.paymentMode === 'invoice' ? 'invoice' : 'card',
        status: quote.status,
        expired,
        alreadyConverted: Boolean(quote.convertedBookingId),
      }}
      businessTerms={businessTerms}
    />
  );
}
