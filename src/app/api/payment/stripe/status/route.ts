import { NextResponse } from 'next/server';
import { isStripeEnabled } from '@/lib/stripe';

export const dynamic = 'force-dynamic';

export async function GET() {
  const enabled = await isStripeEnabled();
  return NextResponse.json({ enabled });
}
