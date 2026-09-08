import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { isAdminAuthenticated } from '@/lib/admin-auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const requests = await db.quoteRequest.findMany({
    orderBy: [{ createdAt: 'desc' }],
    include: { machine: { select: { id: true, name: true, model: true } } },
  });
  return NextResponse.json({ requests });
}
