import { NextRequest, NextResponse } from 'next/server';
import { runCleanup } from '@/lib/cleanup';
import { constTimeEqual } from '@/lib/const-time';

export const dynamic = 'force-dynamic';

// External cron entry-point. The actual cleanup logic lives in `lib/cleanup`
// so it can also be triggered in-process by /api/availability and
// /api/bookings (lazy, traffic-driven).

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error('[cron/cleanup] CRON_SECRET is not set — refusing to run');
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 503 });
  }
  const authHeader = request.headers.get('authorization');
  if (!authHeader || !constTimeEqual(authHeader, `Bearer ${cronSecret}`)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await runCleanup();
  return NextResponse.json({
    cancelled: result.cancelled,
    orphanLocksReleased: result.orphanLocksReleased,
    tokensSwept: result.tokensSwept,
    orphanUploadsRemoved: result.orphanUploadsRemoved,
  });
}
