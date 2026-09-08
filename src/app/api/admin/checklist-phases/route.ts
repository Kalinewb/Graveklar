import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { isValidChecklistAudience } from '@/lib/checklist';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const phases = await db.checklistPhase.findMany({
      orderBy: { sortOrder: 'asc' },
      include: { items: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
    });
    return NextResponse.json({ phases });
  } catch (err) {
    console.error('admin/checklist-phases error:', err);
    return NextResponse.json({ error: 'Feil ved henting' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const appliesTo = ['all', 'delivery', 'selfPickup'].includes(body.appliesTo) ? body.appliesTo : 'all';
    const isCompletionTrigger = Boolean(body.isCompletionTrigger);
    if (isCompletionTrigger) {
      await db.checklistPhase.updateMany({ data: { isCompletionTrigger: false } });
    }
    const phase = await db.checklistPhase.create({
      data: {
        name: body.name || 'Ny fase',
        sortOrder: body.sortOrder ?? 0,
        isActive: body.isActive ?? true,
        appliesTo,
        isCompletionTrigger,
        audience: isValidChecklistAudience(body.audience) ? body.audience : 'operator',
        intervalMode: ['once', 'daily', 'hours', 'return'].includes(body.intervalMode) ? body.intervalMode : 'once',
        intervalHours: body.intervalHours != null ? Number(body.intervalHours) : null,
      },
      include: { items: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
    });
    return NextResponse.json({ phase });
  } catch (err) {
    console.error('admin/checklist-phases error:', err);
    const msg = err instanceof Error && err.message.includes('no such column')
      ? 'Database mangler sjekkliste-kolonner — kjør prisma db push på serveren.'
      : 'Feil ved oppretting';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
