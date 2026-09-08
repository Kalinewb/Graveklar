import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { writeAuditLog } from '@/lib/audit-log';
import { requireTotp } from '@/lib/totp';
import { changedPriceFields, totpRejection } from '@/lib/machine-pricing-guard';
import { firstNonStringField, isUnusableBody } from '@/lib/machine-input';

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
    if (isUnusableBody(parsed)) {
      return NextResponse.json({ error: 'Ugyldig forespørsel' }, { status: 400 });
    }
    // Same shape check as create: a wrong-typed text field is a 400 naming the
    // field, not a Prisma error surfacing as a 500 (I-4).
    const badField = firstNonStringField(parsed);
    if (badField) {
      return NextResponse.json({ error: `Feltet «${badField}» må være tekst.` }, { status: 400 });
    }
    const body = parsed as Record<string, any>;

    // Price fields are money: changing one needs the second factor, same as
    // /api/config. Non-price edits (description, photo, isActive toggle from
    // the list) go through on the session alone.
    const current = await db.machine.findUnique({ where: { id } });
    if (!current) return NextResponse.json({ error: 'Utstyr ikke funnet' }, { status: 404 });
    const priceChanges = changedPriceFields(body, current);
    if (priceChanges.length > 0) {
      const guard = await requireTotp(request);
      if (!guard.ok) return totpRejection(guard.reason);
    }

    const machine = await db.machine.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.category !== undefined && { category: body.category || null }),
        ...(body.model !== undefined && { model: body.model }),
        ...(body.year !== undefined && { year: body.year || null }),
        ...(body.description !== undefined && { description: body.description || null }),
        ...(body.imageUrl !== undefined && { imageUrl: body.imageUrl || null }),
        ...(body.isActive !== undefined && { isActive: body.isActive }),
        ...(body.specs !== undefined && { specs: body.specs }),
        ...(body.features !== undefined && { features: body.features }),
        ...(body.included !== undefined && { included: body.included }),
        ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }),
        ...(body.quantity !== undefined && { quantity: Number(body.quantity) }),
        ...(body.dayPrice !== undefined && { dayPrice: body.dayPrice != null ? Number(body.dayPrice) : null }),
        ...(body.weekendPrice !== undefined && { weekendPrice: body.weekendPrice != null ? Number(body.weekendPrice) : null }),
        ...(body.weekPrice !== undefined && { weekPrice: body.weekPrice != null ? Number(body.weekPrice) : null }),
        ...(body.dayIncludedHours !== undefined && { dayIncludedHours: body.dayIncludedHours != null ? Number(body.dayIncludedHours) : null }),
        ...(body.weekendIncludedHours !== undefined && { weekendIncludedHours: body.weekendIncludedHours != null ? Number(body.weekendIncludedHours) : null }),
        ...(body.weekIncludedHours !== undefined && { weekIncludedHours: body.weekIncludedHours != null ? Number(body.weekIncludedHours) : null }),
        ...(body.overtimeRate !== undefined && { overtimeRate: body.overtimeRate != null ? Number(body.overtimeRate) : null }),
        ...(body.preOrderHourRate !== undefined && { preOrderHourRate: body.preOrderHourRate != null ? Number(body.preOrderHourRate) : null }),
        ...(body.fuelTankLiters !== undefined && { fuelTankLiters: body.fuelTankLiters != null ? Number(body.fuelTankLiters) : null }),
        ...(body.fuelConsumptionPerHour !== undefined && { fuelConsumptionPerHour: body.fuelConsumptionPerHour != null ? Number(body.fuelConsumptionPerHour) : null }),
        ...(body.photoScale !== undefined && { photoScale: body.photoScale != null ? Number(body.photoScale) : null }),
      },
    });

    // Documents are a relation, replaced wholesale when the form submits them.
    // Only touch the table when `documents` is present so a partial PATCH
    // (e.g. an isActive toggle from the list) never wipes a machine's manuals.
    if (body.documents !== undefined) {
      const rows = (Array.isArray(body.documents) ? body.documents : [])
        .filter((d: unknown): d is { title?: string; fileUrl?: string } => !!d && typeof d === 'object' && !!(d as { fileUrl?: string }).fileUrl)
        .map((d: { title?: string; fileUrl?: string }, i: number) => ({
          machineId: id,
          title: d.title?.trim() || 'Dokument',
          fileUrl: String(d.fileUrl),
          sortOrder: i,
        }));
      await db.machineDocument.deleteMany({ where: { machineId: id } });
      if (rows.length) await db.machineDocument.createMany({ data: rows });
    }

    if (priceChanges.length > 0) {
      await writeAuditLog({
        action: 'machine.price_change',
        changes: [{ key: 'name', from: current.name, to: current.name }, ...priceChanges],
        request,
      }).catch((err) => console.error('machine price audit log failed:', err));
    }

    return NextResponse.json({ success: true, machine });
  } catch (err) {
    console.error('admin/machines/[id] PATCH error:', err);
    return NextResponse.json({ error: 'Kunne ikke oppdatere utstyr' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    // Refuse if ANY booking or quote request still references this machine —
    // not just the active ones. `Booking.machine` is an optional relation with
    // no `onDelete`, so Prisma defaults to SetNull and the database will
    // silently detach a *completed* rental from the equipment it rented (and
    // `BookingDateLock.machineId` has no foreign key at all, so its rows would
    // point at nothing). This route's 409 is the only thing standing in the
    // way, so it has to cover the whole history — finding U-1. Deactivate the
    // machine instead; nothing in the panel needs it gone.
    const [activeRefs, bookingRefs, quoteRefs] = await Promise.all([
      db.booking.count({ where: { machineId: id, status: { in: ['pending', 'confirmed'] } } }),
      db.booking.count({ where: { machineId: id } }),
      db.quoteRequest.count({ where: { machineId: id } }),
    ]);
    if (activeRefs > 0) {
      return NextResponse.json(
        {
          error: `Kan ikke slette: ${activeRefs} aktiv${activeRefs === 1 ? '' : 'e'} booking${activeRefs === 1 ? '' : 'er'} bruker dette utstyret. Marker det som inaktivt i stedet, eller avbestill bookingen først.`,
          activeBookings: activeRefs,
          references: bookingRefs + quoteRefs,
        },
        { status: 409 }
      );
    }
    if (bookingRefs + quoteRefs > 0) {
      const parts: string[] = [];
      if (bookingRefs > 0) parts.push(`${bookingRefs} booking${bookingRefs === 1 ? '' : 'er'}`);
      if (quoteRefs > 0) parts.push(`${quoteRefs} tilbudsforespørsel${quoteRefs === 1 ? '' : 'er'}`);
      return NextResponse.json(
        {
          error: `Kan ikke slette: ${parts.join(' og ')} i historikken bruker dette utstyret. Marker det som inaktivt i stedet — historikken må beholde koblingen til maskinen.`,
          activeBookings: 0,
          references: bookingRefs + quoteRefs,
        },
        { status: 409 }
      );
    }
    const machine = await db.machine.findUnique({ where: { id } });
    if (!machine) return NextResponse.json({ error: 'Utstyr ikke funnet' }, { status: 404 });
    await db.machine.delete({ where: { id } });
    await writeAuditLog({
      action: 'machine.delete',
      changes: [
        { key: 'id', from: machine.id, to: null },
        { key: 'name', from: machine.name, to: null },
      ],
      request,
    });
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('admin/machines/[id] DELETE error:', err);
    return NextResponse.json({ error: 'Kunne ikke slette utstyr' }, { status: 500 });
  }
}
