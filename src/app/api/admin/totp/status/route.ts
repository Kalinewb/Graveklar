import { NextResponse } from 'next/server';
import { isTotpEnrolled } from '@/lib/totp';

export const dynamic = 'force-dynamic';

// Lightweight probe so the admin UI can decide between "show enrollment
// flow" vs "prompt for code on sensitive save".
export async function GET() {
  return NextResponse.json({ enrolled: await isTotpEnrolled() });
}
