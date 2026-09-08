import { NextRequest, NextResponse } from 'next/server';
import { isAdminAuthenticated } from '@/lib/admin-auth';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  // Same shape as the quote-request delete (F-10): check first, so an unknown
  // id is a 404 instead of an unhandled Prisma P2025 (finding N-3).
  const existing = await db.surveyResponse.findUnique({ where: { id }, select: { id: true } });
  if (!existing) {
    return NextResponse.json({ error: 'Svaret finnes ikke' }, { status: 404 });
  }
  await db.surveyResponse.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
