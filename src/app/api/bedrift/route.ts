import { NextRequest, NextResponse } from 'next/server';
import { loadAppConfig } from '@/lib/app-config';
import { createQuoteRequest, QuoteValidationError } from '@/lib/quote-request';
import { createRateLimiter } from '@/lib/rate-limit';
import { clientIdentity } from '@/lib/client-ip';

export const dynamic = 'force-dynamic';

const checkLimit = createRateLimiter(5, 15 * 60 * 1000);

export async function POST(request: NextRequest) {
  const cfg = await loadAppConfig();
  if ((cfg['b2bEnabled'] || 'false') !== 'true') {
    return NextResponse.json({ error: 'Bedriftsutleie er ikke aktivert' }, { status: 404 });
  }

  const ip = clientIdentity(request);
  if (checkLimit(ip)) {
    return NextResponse.json({ error: 'For mange forespørsler. Prøv igjen om litt.' }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldig forespørsel' }, { status: 400 });
  }

  // Honeypot — same pattern as the booking endpoint.
  if (body.website) {
    return NextResponse.json({ error: 'Ugyldig forespørsel' }, { status: 400 });
  }

  try {
    const quote = await createQuoteRequest({
      company: String(body.company ?? ''),
      orgNumber: String(body.orgNumber ?? ''),
      contactName: String(body.contactName ?? ''),
      email: String(body.email ?? ''),
      phone: String(body.phone ?? ''),
      machineId: typeof body.machineId === 'string' && body.machineId ? body.machineId : null,
      startDate: typeof body.startDate === 'string' && body.startDate ? body.startDate : null,
      rentalType: typeof body.rentalType === 'string' ? body.rentalType : null,
      customDays: body.customDays ? parseInt(String(body.customDays), 10) : null,
      projectDescription: typeof body.projectDescription === 'string' ? body.projectDescription : null,
      trainingConfirmed: Boolean(body.trainingConfirmed),
    });

    // Fire-and-forget notifications — never block or fail the request on SMTP.
    import('@/lib/email')
      .then(({ sendNewQuoteRequestAdminNotification, sendQuoteRequestReceivedEmail }) =>
        Promise.allSettled([
          sendNewQuoteRequestAdminNotification(quote),
          sendQuoteRequestReceivedEmail(quote),
        ])
      )
      .catch((err) => console.error('quote email error:', err));

    return NextResponse.json({ success: true, reference: quote.reference }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Kunne ikke sende forespørsel';
    const isValidation = error instanceof QuoteValidationError;
    if (!isValidation) console.error('Quote request error:', error);
    return NextResponse.json({ error: message }, { status: isValidation ? 400 : 500 });
  }
}
