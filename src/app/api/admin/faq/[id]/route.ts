import { NextRequest, NextResponse } from 'next/server';
import { isAdminAuthenticated } from '@/lib/admin-auth';
import { db } from '@/lib/db';

/** Same shape check as the create route — a wrong JS type is a 400 naming the
 *  field, not a Prisma validation error surfacing as a 500 (finding F-14). */
function firstBadField(body: Record<string, unknown>): string | null {
  for (const f of ['question', 'answer']) {
    if (body[f] !== undefined && typeof body[f] !== 'string') return f;
  }
  if (body.sortOrder !== undefined && !Number.isInteger(body.sortOrder)) return 'sortOrder';
  if (body.isActive !== undefined && typeof body.isActive !== 'boolean') return 'isActive';
  return null;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Defense in depth, like every other admin handler (finding N-5).
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const { id } = await params;
    const parsed = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return NextResponse.json({ error: 'Ugyldig forespørsel' }, { status: 400 });
    }
    const body = parsed as Record<string, unknown>;
    const bad = firstBadField(body);
    if (bad) return NextResponse.json({ error: `Feltet «${bad}» har feil type.` }, { status: 400 });

    const existing = await db.faqItem.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return NextResponse.json({ error: 'FAQ-element ikke funnet' }, { status: 404 });

    const item = await db.faqItem.update({
      where: { id },
      data: {
        ...(body.question !== undefined && { question: body.question as string }),
        ...(body.answer !== undefined && { answer: body.answer as string }),
        ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder as number }),
        ...(body.isActive !== undefined && { isActive: body.isActive as boolean }),
      },
    });
    return NextResponse.json({ success: true, item });
  } catch (err) {
    console.error('admin/faq/[id] error:', err);
    return NextResponse.json({ error: 'Kunne ikke oppdatere FAQ-element' }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const { id } = await params;
    const existing = await db.faqItem.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return NextResponse.json({ error: 'FAQ-element ikke funnet' }, { status: 404 });
    await db.faqItem.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('admin/faq/[id] error:', err);
    return NextResponse.json({ error: 'Kunne ikke slette FAQ-element' }, { status: 500 });
  }
}
