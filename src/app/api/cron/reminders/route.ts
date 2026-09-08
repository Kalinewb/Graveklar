import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { sendBookingReminderEmail } from '@/lib/email';
import { constTimeEqual } from '@/lib/const-time';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error('[cron/reminders] CRON_SECRET is not set — refusing to run');
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 503 });
  }
  const authHeader = request.headers.get('authorization');
  if (!authHeader || !constTimeEqual(authHeader, `Bearer ${cronSecret}`)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStart = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate());
  const tomorrowEnd = new Date(tomorrowStart);
  tomorrowEnd.setHours(23, 59, 59, 999);

  const bookings = await db.booking.findMany({
    where: {
      status: 'confirmed',
      startDate: { gte: tomorrowStart, lte: tomorrowEnd },
      reminderSentAt: null,
    },
  });

  let sent = 0;
  for (const booking of bookings) {
    try {
      await sendBookingReminderEmail(booking);
      await db.booking.update({
        where: { id: booking.id },
        data: { reminderSentAt: new Date() },
      });
      sent++;
    } catch (err) {
      console.error(`Reminder email failed for ${booking.reference}:`, err);
    }
  }

  return NextResponse.json({ sent, total: bookings.length });
}
