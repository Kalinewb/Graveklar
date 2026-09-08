import { NextRequest, NextResponse } from 'next/server';
import { isAdminAuthenticated } from '@/lib/admin-auth';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

const VALID_TYPES = new Set([
  'intro', 'radio', 'check', 'likert', 'range', 'text', 'email', 'price-callout',
]);

// PATCH — update editable fields. Only the keys present in the body change.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });

  const data: Record<string, unknown> = {};
  if (typeof body.label === 'string') data.label = body.label.trim();
  if (typeof body.section === 'string') data.section = body.section.trim();
  if ('hint' in body) data.hint = body.hint ? String(body.hint) : null;
  if (typeof body.type === 'string') {
    if (!VALID_TYPES.has(body.type)) {
      return NextResponse.json({ error: 'Ugyldig spørsmålstype.' }, { status: 400 });
    }
    data.type = body.type;
  }
  if ('options' in body) {
    data.options = Array.isArray(body.options) && body.options.length
      ? JSON.stringify(body.options.map(String))
      : null;
  }
  if ('config' in body) {
    data.config = body.config && typeof body.config === 'object' ? JSON.stringify(body.config) : null;
  }
  if (typeof body.required === 'boolean') data.required = body.required;
  if (typeof body.isActive === 'boolean') data.isActive = body.isActive;
  if (typeof body.sortOrder === 'number') data.sortOrder = body.sortOrder;

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'Ingenting å oppdatere.' }, { status: 400 });
  }

  try {
    await db.surveyQuestion.update({ where: { id }, data });
  } catch {
    return NextResponse.json({ error: 'Fant ikke spørsmålet.' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  await db.surveyQuestion.delete({ where: { id } }).catch(() => null);
  return NextResponse.json({ ok: true });
}
