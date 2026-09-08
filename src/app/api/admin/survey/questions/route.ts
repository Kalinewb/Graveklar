import { NextRequest, NextResponse } from 'next/server';
import { isAdminAuthenticated } from '@/lib/admin-auth';
import { db } from '@/lib/db';
import { seedSurveyQuestionsIfEmpty } from '@/lib/survey-service';

export const dynamic = 'force-dynamic';

const VALID_TYPES = new Set([
  'intro', 'radio', 'check', 'likert', 'range', 'text', 'email', 'price-callout',
]);

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function serializeRow(r: {
  id: string; key: string; type: string; section: string; label: string;
  hint: string | null; options: string | null; config: string | null;
  required: boolean; isActive: boolean; sortOrder: number;
}) {
  return {
    id: r.id,
    key: r.key,
    type: r.type,
    section: r.section,
    label: r.label,
    hint: r.hint,
    options: parseJson<string[]>(r.options, []),
    config: parseJson<Record<string, unknown>>(r.config, {}),
    required: r.required,
    isActive: r.isActive,
    sortOrder: r.sortOrder,
  };
}

// GET — all questions (incl. inactive) for the admin builder, ordered.
export async function GET() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  await seedSurveyQuestionsIfEmpty();
  const rows = await db.surveyQuestion.findMany({ orderBy: { sortOrder: 'asc' } });
  return NextResponse.json({ questions: rows.map(serializeRow) });
}

// POST — create a question. Body: {key,type,section,label,hint?,options?,config?,required?,isActive?}
export async function POST(req: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });

  const key = String(body.key || '').trim().toLowerCase();
  const type = String(body.type || '');
  const section = String(body.section || '').trim();
  const label = String(body.label || '').trim();

  if (!/^[a-z0-9_]+$/.test(key)) {
    return NextResponse.json({ error: 'Nøkkel må være små bokstaver, tall eller understrek (a–z, 0–9, _).' }, { status: 400 });
  }
  if (!VALID_TYPES.has(type)) {
    return NextResponse.json({ error: 'Ugyldig spørsmålstype.' }, { status: 400 });
  }
  if (!section || !label) {
    return NextResponse.json({ error: 'Seksjon og spørsmålstekst er påkrevd.' }, { status: 400 });
  }

  const existing = await db.surveyQuestion.findUnique({ where: { key } });
  if (existing) {
    return NextResponse.json({ error: `Nøkkelen «${key}» er allerede i bruk.` }, { status: 409 });
  }

  const max = await db.surveyQuestion.aggregate({ _max: { sortOrder: true } });
  const sortOrder = (max._max.sortOrder ?? 0) + 10;

  const created = await db.surveyQuestion.create({
    data: {
      key,
      type,
      section,
      label,
      hint: body.hint ? String(body.hint) : null,
      options: Array.isArray(body.options) && body.options.length ? JSON.stringify(body.options.map(String)) : null,
      config: body.config && typeof body.config === 'object' ? JSON.stringify(body.config) : null,
      required: body.required !== false,
      isActive: body.isActive !== false,
      sortOrder,
    },
  });
  return NextResponse.json({ question: serializeRow(created) });
}

// PUT — reorder. Body: { ids: string[] } in the desired order.
export async function PUT(req: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const ids: unknown = body?.ids;
  if (!Array.isArray(ids)) {
    return NextResponse.json({ error: 'ids must be an array' }, { status: 400 });
  }
  // The reorder is all-or-nothing, so one stale id (a question deleted in
  // another tab) must fail as a clean 400 naming the problem rather than
  // throwing Prisma's P2025 out of the handler as a bare 500 (finding N-4).
  const wanted = ids.map(String);
  const known = new Set(
    (await db.surveyQuestion.findMany({ where: { id: { in: wanted } }, select: { id: true } })).map((q) => q.id)
  );
  const missing = wanted.filter((id) => !known.has(id));
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Ukjent spørsmåls-id: ${missing.join(', ')}. Last siden på nytt og prøv igjen.` },
      { status: 400 }
    );
  }

  await db.$transaction(
    wanted.map((id, i) =>
      db.surveyQuestion.update({ where: { id }, data: { sortOrder: (i + 1) * 10 } })
    )
  );
  return NextResponse.json({ ok: true });
}
