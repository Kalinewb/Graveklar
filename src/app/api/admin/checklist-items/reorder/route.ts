import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** Bulk-update sortOrder for all items in a phase. Body: { phaseId, itemIds[] }
 *  where itemIds is the full ordered list of item IDs (0 = first). */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const phaseId = typeof body.phaseId === 'string' ? body.phaseId : '';
    const itemIds = Array.isArray(body.itemIds) ? body.itemIds.filter((id: unknown) => typeof id === 'string') : [];

    if (!phaseId || itemIds.length === 0) {
      return NextResponse.json({ error: 'phaseId og itemIds påkrevd' }, { status: 400 });
    }

    const existing = await db.checklistItem.findMany({
      where: { phaseId },
      select: { id: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    const existingIds = new Set(existing.map((i) => i.id));

    if (itemIds.length !== existing.length || !itemIds.every((id) => existingIds.has(id))) {
      return NextResponse.json({ error: 'itemIds må inneholde alle punkter i fasen' }, { status: 400 });
    }

    await db.$transaction(
      itemIds.map((id, index) =>
        db.checklistItem.update({ where: { id }, data: { sortOrder: index } })
      )
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('admin/checklist-items/reorder error:', err);
    return NextResponse.json({ error: 'Feil ved omorganisering' }, { status: 500 });
  }
}
