import { NextRequest, NextResponse } from 'next/server';
import { isAdminAuthenticated } from '@/lib/admin-auth';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** The text columns the admin form writes, plus the two shared shape fields.
 *  A wrong JS type here used to reach `.trim()` (POST) or Prisma (PATCH) and
 *  surface as a 500; it is a client mistake, so it is a 400 (finding F-14). */
function firstBadField(body: Record<string, unknown>, text: string[]): string | null {
  for (const f of text) {
    if (body[f] !== undefined && typeof body[f] !== 'string') return f;
  }
  if (body.sortOrder !== undefined && !Number.isInteger(body.sortOrder)) return 'sortOrder';
  if (body.isActive !== undefined && typeof body.isActive !== 'boolean') return 'isActive';
  return null;
}

export async function GET() {
  // Defense in depth: every other /api/admin/* handler re-checks the session
  // itself rather than trusting the proxy matcher to be the only gate
  // (finding N-5).
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const items = await db.faqItem.findMany({
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  return NextResponse.json({ items });
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
    const bad = firstBadField(body, ['question', 'answer']);
    if (bad) return NextResponse.json({ error: `Feltet «${bad}» har feil type.` }, { status: 400 });

    const item = await db.faqItem.create({
      data: {
        question: (body.question as string | undefined)?.trim() || '',
        answer: (body.answer as string | undefined)?.trim() || '',
        sortOrder: (body.sortOrder as number | undefined) ?? 0,
        isActive: body.isActive !== false,
      },
    });
    return NextResponse.json({ success: true, item }, { status: 201 });
  } catch (err) {
    console.error('admin/faq error:', err);
    return NextResponse.json({ error: 'Kunne ikke opprette FAQ-element' }, { status: 500 });
  }
}
