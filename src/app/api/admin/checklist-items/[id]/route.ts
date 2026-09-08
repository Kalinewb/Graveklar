import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// Mirrors the list in ../route.ts and in prisma/schema.prisma. Duplicated on
// purpose: a Next route module may only export the handlers and the route
// segment config, so there is nothing to share between two route files.
const ANSWER_TYPES = ['checkbox', 'yesno', 'number', 'text', 'photo', 'measurement'];

function isValidAnswerType(v: unknown): boolean {
  return typeof v === 'string' && ANSWER_TYPES.includes(v);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    // Same whitelist as create: an answerType the renter checklist cannot
    // render must never reach the column (finding U-3).
    if (body.answerType !== undefined && !isValidAnswerType(body.answerType)) {
      return NextResponse.json(
        { error: `Ugyldig svartype. Gyldige verdier: ${ANSWER_TYPES.join(', ')}.` },
        { status: 400 },
      );
    }
    const item = await db.checklistItem.update({
      where: { id },
      data: {
        ...(body.label !== undefined && { label: body.label }),
        ...(body.answerType !== undefined && { answerType: body.answerType }),
        ...(body.unit !== undefined && { unit: body.unit || null }),
        ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }),
        ...(body.isActive !== undefined && { isActive: body.isActive }),
        ...(body.conditionItemId !== undefined && {
          conditionItemId: body.conditionItemId || null,
          conditionValue: body.conditionItemId ? (body.conditionValue || null) : null,
        }),
        ...(body.statKey !== undefined && { statKey: body.statKey?.trim() || null }),
        ...(body.minPhotos !== undefined && {
          minPhotos: body.minPhotos != null ? Math.max(1, Number(body.minPhotos) || 1) : null,
        }),
      },
    });
    return NextResponse.json({ item });
  } catch (err) {
    console.error('admin/checklist-items/[id] error:', err);
    return NextResponse.json({ error: 'Feil ved oppdatering' }, { status: 500 });
  }
}

export async function DELETE(
  _: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await db.checklistItem.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('admin/checklist-items/[id] error:', err);
    return NextResponse.json({ error: 'Feil ved sletting' }, { status: 500 });
  }
}
