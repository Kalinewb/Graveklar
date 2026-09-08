import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { loadAppConfig } from '@/lib/app-config';

export const dynamic = 'force-dynamic';

// Fetches the frozen contract for a booking. The HTML in `renderedHtml` is
// the immutable legal artifact — never recomputed from the live TOC.

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: bookingId } = await params;
  const contract = await db.acceptedContract.findUnique({
    where: { bookingId },
  });
  if (!contract) {
    return NextResponse.json(
      { error: 'Ingen frosset kontrakt funnet for denne bookingen.' },
      { status: 404 }
    );
  }
  const [booking, appCfg] = await Promise.all([
    db.booking.findUnique({ where: { id: bookingId } }),
    loadAppConfig(),
  ]);

  // Company identity for the printable contract front page. Pulled LIVE from
  // settings (not the frozen renderContext) so the printout always reflects
  // the current logo/address/contact the admin has configured.
  const company = {
    name: appCfg['businessName'] || 'Graveklar',
    orgNumber: appCfg['orgNumber'] || '',
    address: appCfg['businessAddress'] || '',
    email: appCfg['contactEmail'] || '',
    phone: appCfg['contactPhone'] || '',
    siteUrl: appCfg['siteUrl'] || '',
    // Only surface the logo on the printout when the admin has that toggle on.
    logoUrl: appCfg['logoOnContract'] !== 'false' ? (appCfg['logoUrl'] || '') : '',
  };

  return NextResponse.json({
    company,
    booking: booking ? {
      id: booking.id,
      reference: booking.reference,
      name: booking.name,
      email: booking.email,
    } : null,
    contract: {
      id: contract.id,
      renderedHtml: contract.renderedHtml,
      termsVersionHash: contract.termsVersionHash,
      renderContext: JSON.parse(contract.renderContext) as Record<string, string>,
      acceptedAt: contract.acceptedAt,
      acceptedFromIp: contract.acceptedFromIp,
      acceptanceMethod: contract.acceptanceMethod,
      createdAt: contract.createdAt,
    },
  });
}
