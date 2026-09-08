import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { isAdminAuthenticated } from '@/lib/admin-auth';

export const dynamic = 'force-dynamic';

const ACTIONS = new Set(['approve', 'reject']);

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? '');
  if (!ACTIONS.has(action)) {
    return NextResponse.json({ error: 'Ugyldig handling' }, { status: 400 });
  }

  const existing = await db.review.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (existing.status === 'pending') {
    return NextResponse.json({ error: 'Vurderingen er ikke sendt inn ennå' }, { status: 400 });
  }

  const review = await db.review.update({
    where: { id },
    data: { status: action === 'approve' ? 'approved' : 'rejected' },
  });
  return NextResponse.json({ review });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  await db.review.delete({ where: { id } }).catch(() => {});
  return NextResponse.json({ success: true });
}
