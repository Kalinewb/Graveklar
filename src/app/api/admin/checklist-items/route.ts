import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * The answer widgets the renter checklist knows how to render, mirroring the
 * list in prisma/schema.prisma. `appliesTo`, `audience` and `intervalMode` are
 * all whitelisted at their admin write site; `answerType` was the one that was
 * not (finding U-3). An unrecognised value renders as nothing the renter can
 * fill, `isItemFilled` never returns true for it, and a phase carrying
 * `isCompletionTrigger` can then never complete — so the booking never
 * auto-completes.
 */
// NOTE: kept as a local const rather than exported and shared with the [id]
// route — a Next route module may only export the handlers and the route
// segment config, so the copy in [id]/route.ts is deliberate.
const ANSWER_TYPES = ['checkbox', 'yesno', 'number', 'text', 'photo', 'measurement'];

function isValidAnswerType(v: unknown): boolean {
  return typeof v === 'string' && ANSWER_TYPES.includes(v);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body.phaseId) return NextResponse.json({ error: 'phaseId påkrevd' }, { status: 400 });
    if (body.answerType !== undefined && body.answerType !== null && !isValidAnswerType(body.answerType)) {
      return NextResponse.json(
        { error: `Ugyldig svartype. Gyldige verdier: ${ANSWER_TYPES.join(', ')}.` },
        { status: 400 },
      );
    }
    const item = await db.checklistItem.create({
      data: {
        phaseId: body.phaseId,
        label: body.label || 'Nytt punkt',
        answerType: body.answerType || 'checkbox',
        unit: body.unit || null,
        sortOrder: body.sortOrder ?? 0,
        isActive: body.isActive ?? true,
        conditionItemId: body.conditionItemId || null,
        conditionValue: body.conditionItemId ? (body.conditionValue || null) : null,
        statKey: body.statKey?.trim() || null,
        minPhotos: body.answerType === 'photo' && body.minPhotos != null
          ? Math.max(1, Number(body.minPhotos) || 1)
          : null,
      },
    });
    return NextResponse.json({ item });
  } catch (err) {
    console.error('admin/checklist-items error:', err);
    return NextResponse.json({ error: 'Feil ved oppretting' }, { status: 500 });
  }
}
