import { NextRequest, NextResponse } from 'next/server';
import { isAdminAuthenticated } from '@/lib/admin-auth';
import { db } from '@/lib/db';

/** Same shape check as the create route (finding F-14). */
function firstBadField(body: Record<string, unknown>): string | null {
  for (const f of ['label', 'value', 'detail']) {
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

    const existing = await db.insuranceCard.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return NextResponse.json({ error: 'Forsikringskort ikke funnet' }, { status: 404 });

    const card = await db.insuranceCard.update({
      where: { id },
      data: {
        ...(body.label !== undefined && { label: body.label as string }),
        ...(body.value !== undefined && { value: body.value as string }),
        ...(body.detail !== undefined && { detail: body.detail as string }),
        ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder as number }),
        ...(body.isActive !== undefined && { isActive: body.isActive as boolean }),
      },
    });
    return NextResponse.json({ success: true, card });
  } catch (err) {
    console.error('admin/insurance/[id] error:', err);
    return NextResponse.json({ error: 'Kunne ikke oppdatere forsikringskort' }, { status: 500 });
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
    const existing = await db.insuranceCard.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return NextResponse.json({ error: 'Forsikringskort ikke funnet' }, { status: 404 });
    await db.insuranceCard.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('admin/insurance/[id] error:', err);
    return NextResponse.json({ error: 'Kunne ikke slette forsikringskort' }, { status: 500 });
  }
}
