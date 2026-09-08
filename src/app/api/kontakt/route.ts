import { NextRequest, NextResponse } from 'next/server';
import { loadAppConfig } from '@/lib/app-config';
import { sendContactMessageEmail } from '@/lib/email';
import { createRateLimiter } from '@/lib/rate-limit';
import { clientIdentity } from '@/lib/client-ip';

export const dynamic = 'force-dynamic';

const checkLimit = createRateLimiter(5, 15 * 60 * 1000);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: NextRequest) {
  const cfg = await loadAppConfig();
  if ((cfg['contactFormEnabled'] || 'true') !== 'true') {
    return NextResponse.json({ error: 'Kontaktskjema er ikke aktivert' }, { status: 404 });
  }

  const ip = clientIdentity(request);
  if (checkLimit(ip)) {
    return NextResponse.json({ error: 'For mange henvendelser. Prøv igjen om litt.' }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldig forespørsel' }, { status: 400 });
  }

  // Honeypot — bots fill hidden fields.
  if (body.website) {
    return NextResponse.json({ error: 'Ugyldig forespørsel' }, { status: 400 });
  }

  const name = String(body.name ?? '').trim();
  const email = String(body.email ?? '').trim();
  const phone = String(body.phone ?? '').trim();
  const message = String(body.message ?? '').trim();

  if (name.length < 2) return NextResponse.json({ error: 'Oppgi navn.' }, { status: 400 });
  if (!EMAIL_RE.test(email)) return NextResponse.json({ error: 'Oppgi en gyldig e-postadresse.' }, { status: 400 });
  if (message.length < 10) return NextResponse.json({ error: 'Skriv en melding (minst 10 tegn).' }, { status: 400 });
  if (message.length > 5000) return NextResponse.json({ error: 'Meldingen er for lang.' }, { status: 400 });

  try {
    const sent = await sendContactMessageEmail({ name, email, phone: phone || undefined, message });
    if (!sent) {
      return NextResponse.json({ error: 'Kontaktskjema er ikke konfigurert. Ta kontakt på telefon eller e-post.' }, { status: 503 });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Contact form error:', err);
    return NextResponse.json({ error: 'Kunne ikke sende meldingen. Prøv igjen senere.' }, { status: 500 });
  }
}
