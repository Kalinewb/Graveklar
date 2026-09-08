import { NextRequest, NextResponse } from 'next/server';
import { isAdminAuthenticated } from '@/lib/admin-auth';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** Mirrors the FAQ route: a wrong JS type is a 400 naming the field, not the
 *  500 `.trim()` on a number produced (finding F-14). */
function firstBadField(body: Record<string, unknown>): string | null {
  for (const f of ['label', 'value', 'detail']) {
    if (body[f] !== undefined && typeof body[f] !== 'string') return f;
  }
  if (body.sortOrder !== undefined && !Number.isInteger(body.sortOrder)) return 'sortOrder';
  if (body.isActive !== undefined && typeof body.isActive !== 'boolean') return 'isActive';
  return null;
}

export async function GET() {
  // Defense in depth: the proxy matcher is not the only gate (finding N-5).
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const cards = await db.insuranceCard.findMany({
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  return NextResponse.json({ cards });
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return NextResponse.json({ error: 'Ugyldig forespørsel' }, { status: 400 });
    }
    const body = parsed as Record<string, unknown>;
    const bad = firstBadField(body);
    if (bad) return NextResponse.json({ error: `Feltet «${bad}» har feil type.` }, { status: 400 });

    const card = await db.insuranceCard.create({
      data: {
        label: (body.label as string | undefined)?.trim() || '',
        value: (body.value as string | undefined)?.trim() || '',
        detail: (body.detail as string | undefined)?.trim() || '',
        sortOrder: (body.sortOrder as number | undefined) ?? 0,
        isActive: body.isActive !== false,
      },
    });
    return NextResponse.json({ success: true, card }, { status: 201 });
  } catch (err) {
    console.error('admin/insurance error:', err);
    return NextResponse.json({ error: 'Kunne ikke opprette forsikringskort' }, { status: 500 });
  }
}
