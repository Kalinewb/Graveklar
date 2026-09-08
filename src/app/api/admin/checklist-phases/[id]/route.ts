import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { isValidChecklistAudience } from '@/lib/checklist';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    if (body.isCompletionTrigger === true) {
      await db.checklistPhase.updateMany({
        where: { id: { not: id } },
        data: { isCompletionTrigger: false },
      });
    }
    const phase = await db.checklistPhase.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }),
        ...(body.isActive !== undefined && { isActive: body.isActive }),
        ...(body.appliesTo !== undefined && ['all', 'delivery', 'selfPickup'].includes(body.appliesTo) && { appliesTo: body.appliesTo }),
        ...(body.isCompletionTrigger !== undefined && { isCompletionTrigger: Boolean(body.isCompletionTrigger) }),
        ...(body.audience !== undefined && isValidChecklistAudience(body.audience) && { audience: body.audience }),
        ...(body.intervalMode !== undefined && ['once', 'daily', 'hours', 'return'].includes(body.intervalMode) && { intervalMode: body.intervalMode }),
        ...(body.intervalHours !== undefined && { intervalHours: body.intervalHours == null ? null : Number(body.intervalHours) }),
      },
      include: { items: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
    });
    return NextResponse.json({ phase });
  } catch (err) {
    console.error('admin/checklist-phases/[id] error:', err);
    return NextResponse.json({ error: 'Feil ved oppdatering' }, { status: 500 });
  }
}

export async function DELETE(
  _: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await db.checklistPhase.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('admin/checklist-phases/[id] error:', err);
    return NextResponse.json({ error: 'Feil ved sletting' }, { status: 500 });
  }
}
