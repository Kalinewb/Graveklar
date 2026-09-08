import { NextRequest, NextResponse } from 'next/server';
import { isAdminAuthenticated } from '@/lib/admin-auth';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const rows = await db.surveyResponse.findMany({
    orderBy: { createdAt: 'desc' },
    take: 500,
  });

  return NextResponse.json({ rows, total: rows.length });
}
