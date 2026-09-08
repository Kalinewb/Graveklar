import { NextResponse } from 'next/server';
import { isVippsEnabled } from '@/lib/vipps-config';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ enabled: await isVippsEnabled() });
}
