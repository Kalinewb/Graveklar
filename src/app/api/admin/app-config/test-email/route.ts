import { NextRequest, NextResponse } from 'next/server';
import { loadAppConfig } from '@/lib/app-config';
import {
  sendTestEmail,
  sendNewBookingAdminNotification,
  sendBookingStatusEmail,
  sendBookingReminderEmail,
  sendPaymentRetryEmail,
} from '@/lib/email';
import { sampleBooking } from '@/lib/email-sample-booking';

const TEMPLATES = [
  'test',
  'new-booking-admin',
  'confirmed',
  'cancelled',
  'reminder',
  'payment-retry',
] as const;
type Template = typeof TEMPLATES[number];

function isTemplate(v: unknown): v is Template {
  return typeof v === 'string' && (TEMPLATES as readonly string[]).includes(v);
}

export async function POST(request: NextRequest) {
  try {
    const config = await loadAppConfig();
    const adminEmail = config['adminEmail'] || process.env.ADMIN_EMAIL;
    if (!adminEmail) {
      return NextResponse.json(
        { error: 'Admin-e-post er ikke konfigurert.' },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(request.url);
    const template: Template = isTemplate(searchParams.get('template'))
      ? (searchParams.get('template') as Template)
      : 'test';

    // Every sender reports whether the message actually left the process.
    // This button is the owner's only way to check the SMTP setup, so a
    // "sent" that was really "skipped, SMTP not configured" is worse than
    // useless (finding P-4).
    let sent: boolean;
    switch (template) {
      case 'test':
        sent = await sendTestEmail(config, adminEmail);
        break;
      case 'new-booking-admin':
        sent = await sendNewBookingAdminNotification(sampleBooking({ email: adminEmail }));
        break;
      case 'confirmed':
        sent = await sendBookingStatusEmail(sampleBooking({ email: adminEmail, status: 'confirmed' }), 'confirmed');
        break;
      case 'cancelled':
        sent = await sendBookingStatusEmail(
          sampleBooking({ email: adminEmail, status: 'cancelled', cancellationFee: 1495, refundAmount: 5025 }),
          'cancelled'
        );
        break;
      case 'reminder':
        sent = await sendBookingReminderEmail(sampleBooking({ email: adminEmail }));
        break;
      case 'payment-retry': {
        const siteUrl = (config['siteUrl'] || '').replace(/\/+$/, '') || 'https://graveklar.no';
        sent = await sendPaymentRetryEmail(
          sampleBooking({ email: adminEmail, status: 'pending', fullyPaidAt: null }),
          `${siteUrl}/eksempel-betalingslenke`,
          30
        );
        break;
      }
    }

    if (!sent) {
      return NextResponse.json(
        {
          error: 'Ingen e-post ble sendt. Kontroller SMTP-oppsettet (vert, bruker og passord) under Innstillinger.',
          template,
          to: adminEmail,
        },
        { status: 400 }
      );
    }

    return NextResponse.json({ success: true, template, to: adminEmail });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ukjent feil';
    return NextResponse.json({ error: `E-post feilet: ${msg}` }, { status: 500 });
  }
}
