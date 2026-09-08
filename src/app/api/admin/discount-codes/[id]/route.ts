import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { isAdminAuthenticated } from '@/lib/admin-auth';
import { writeAuditLog, type AuditChange } from '@/lib/audit-log';

export const dynamic = 'force-dynamic';

// PATCH /api/admin/discount-codes/:id — toggle active or update fields on
// a campaign code. (Single-use RETUR codes are issued by the system and
// can't be edited.)
//
// `percent` is frozen after the first redemption: the customers who already
// paid did so against a specific percentage, and silently changing it
// retroactively muddies accounting + the customer's contract. To rewrite
// the rate, the admin should issue a new code instead.

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  // An unparseable body is a shape error, not a 500 — same rule as the create
  // handler next door.
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldig forespørsel.' }, { status: 400 });
  }

  const existing = await db.campaignDiscountCode.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const data: Record<string, unknown> = {};
  const auditChanges: AuditChange[] = [];

  if (body.isActive !== undefined) {
    data.isActive = !!body.isActive;
    if (existing.isActive !== data.isActive) {
      auditChanges.push({ key: 'isActive', from: existing.isActive, to: data.isActive as boolean });
    }
  }
  if (body.percent !== undefined) {
    const newPercent = Math.max(1, Math.min(100, Number(body.percent) || 1));
    if (newPercent !== existing.percent) {
      if (existing.usedCount > 0) {
        return NextResponse.json(
          { error: 'Prosenten er låst etter første bruk. Opprett en ny kode for ny sats.' },
          { status: 409 }
        );
      }
      data.percent = newPercent;
      auditChanges.push({ key: 'percent', from: existing.percent, to: newPercent });
    }
  }
  if (body.maxUses !== undefined) {
    const newMaxUses = body.maxUses === null ? null : Math.max(1, Number(body.maxUses) || 1);
    if (newMaxUses !== existing.maxUses) {
      data.maxUses = newMaxUses;
      auditChanges.push({ key: 'maxUses', from: existing.maxUses, to: newMaxUses });
    }
  }
  if (body.expiresAt !== undefined) {
    const newExpiresAt = body.expiresAt ? new Date(body.expiresAt as string) : null;
    if (newExpiresAt && Number.isNaN(newExpiresAt.getTime())) {
      return NextResponse.json({ error: 'Ugyldig utløpsdato.' }, { status: 400 });
    }
    const oldIso = existing.expiresAt ? existing.expiresAt.toISOString() : null;
    const newIso = newExpiresAt ? newExpiresAt.toISOString() : null;
    if (oldIso !== newIso) {
      data.expiresAt = newExpiresAt;
      auditChanges.push({ key: 'expiresAt', from: oldIso, to: newIso });
    }
  }
  if (body.notes !== undefined) {
    const newNotes = typeof body.notes === 'string' && body.notes ? body.notes : null;
    if (newNotes !== existing.notes) {
      data.notes = newNotes;
      auditChanges.push({ key: 'notes', from: existing.notes, to: newNotes });
    }
  }

  try {
    const updated = await db.campaignDiscountCode.update({ where: { id }, data });
    if (auditChanges.length > 0) {
      await writeAuditLog({
        action: 'discount_code.update',
        changes: [{ key: 'code', from: existing.code, to: existing.code }, ...auditChanges],
        request: req,
      });
    }
    return NextResponse.json({ campaign: updated });
  } catch (err) {
    console.error('discount code update failed:', err);
    return NextResponse.json({ error: 'Kunne ikke oppdatere rabattkode.' }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  const existing = await db.campaignDiscountCode.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  try {
    await db.campaignDiscountCode.delete({ where: { id } });
    await writeAuditLog({
      action: 'discount_code.delete',
      changes: [
        { key: 'code', from: existing.code, to: null },
        { key: 'percent', from: existing.percent, to: null },
        { key: 'usedCount', from: existing.usedCount, to: null },
      ],
      request: req,
    });
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('discount code delete failed:', err);
    return NextResponse.json({ error: 'Kunne ikke slette rabattkode.' }, { status: 500 });
  }
}
