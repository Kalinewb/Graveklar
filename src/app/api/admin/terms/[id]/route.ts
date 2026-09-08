import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

/**
 * Shape-check the patchable fields before Prisma sees them. Without this a
 * wrong JS type (a number where the admin UI always sends a string, a string
 * where it sends a boolean) reaches Prisma's own validator and the catch-all
 * turns that into a 500 carrying Prisma's internal error text — a client
 * mistake dressed up as a server outage (finding K-1).
 *
 * Returns the offending field name, or null when the body is usable.
 */
function firstBadField(body: Record<string, unknown>): string | null {
  if (body.title !== undefined && typeof body.title !== 'string') return 'title';
  if (body.content !== undefined && typeof body.content !== 'string') return 'content';
  if (body.sortOrder !== undefined && !Number.isInteger(body.sortOrder)) return 'sortOrder';
  if (body.isActive !== undefined && typeof body.isActive !== 'boolean') return 'isActive';
  if (body.audience !== undefined && typeof body.audience !== 'string') return 'audience';
  return null;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      return NextResponse.json({ error: 'Ugyldig forespørsel' }, { status: 400 });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return NextResponse.json({ error: 'Ugyldig forespørsel' }, { status: 400 });
    }
    const body = parsed as Record<string, unknown>;
    const badField = firstBadField(body);
    if (badField) {
      return NextResponse.json({ error: `Feltet «${badField}» har feil type.` }, { status: 400 });
    }

    // A missing row is a 404 here, not the P2025 the catch-all would turn into
    // a 500 — the same answer every other admin CRUD route gives (K-2).
    const existing = await db.termsSection.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: 'Vilkårsseksjon ikke funnet' }, { status: 404 });
    }

    const section = await db.termsSection.update({
      where: { id },
      data: {
        ...(body.title !== undefined && { title: body.title as string }),
        ...(body.content !== undefined && { content: body.content as string }),
        ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder as number }),
        ...(body.isActive !== undefined && { isActive: body.isActive as boolean }),
        ...(body.audience !== undefined && { audience: body.audience === 'business' ? 'business' : 'consumer' }),
      },
    });
    return NextResponse.json({ success: true, section });
  } catch (err) {
    console.error('admin/terms/[id] error:', err);
    return NextResponse.json({ error: 'Kunne ikke oppdatere vilkårsseksjon' }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const existing = await db.termsSection.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: 'Vilkårsseksjon ikke funnet' }, { status: 404 });
    }
    await db.termsSection.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('admin/terms/[id] error:', err);
    return NextResponse.json({ error: 'Kunne ikke slette vilkårsseksjon' }, { status: 500 });
  }
}
