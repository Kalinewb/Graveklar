import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const audience = request.nextUrl.searchParams.get('audience') === 'business' ? 'business' : 'consumer';
  const sections = await db.termsSection.findMany({
    where: { isActive: true, audience },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  return NextResponse.json({ sections });
}
