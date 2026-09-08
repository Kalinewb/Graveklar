import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** Bulk-update sortOrder for all checklist phases. Body: { phaseIds[] }
 *  where phaseIds is the full ordered list of phase IDs (0 = first). */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const phaseIds = Array.isArray(body.phaseIds) ? body.phaseIds.filter((id: unknown) => typeof id === 'string') : [];

    if (phaseIds.length === 0) {
      return NextResponse.json({ error: 'phaseIds påkrevd' }, { status: 400 });
    }

    const existing = await db.checklistPhase.findMany({
      select: { id: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    const existingIds = new Set(existing.map((p) => p.id));

    if (phaseIds.length !== existing.length || !phaseIds.every((id) => existingIds.has(id))) {
      return NextResponse.json({ error: 'phaseIds må inneholde alle faser' }, { status: 400 });
    }

    await db.$transaction(
      phaseIds.map((id, index) =>
        db.checklistPhase.update({ where: { id }, data: { sortOrder: index } })
      )
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('admin/checklist-phases/reorder error:', err);
    return NextResponse.json({ error: 'Feil ved omorganisering' }, { status: 500 });
  }
}
