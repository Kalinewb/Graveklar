import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { isAdminAuthenticated } from '@/lib/admin-auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  // Only rows the customer actually filled in are interesting to moderate;
  // "pending" rows are just outstanding requests with no content yet.
  const reviews = await db.review.findMany({
    where: { status: { in: ['submitted', 'approved', 'rejected'] } },
    orderBy: [{ submittedAt: 'desc' }],
    include: { booking: { select: { reference: true, name: true } } },
  });
  return NextResponse.json({ reviews });
}
