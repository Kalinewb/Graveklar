import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireTotp } from '@/lib/totp';
import { pricedFields, totpRejection } from '@/lib/machine-pricing-guard';
import { firstNonStringField, isUnusableBody } from '@/lib/machine-input';

export const dynamic = 'force-dynamic';

export async function GET() {
  const machines = await db.machine.findMany({
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: { documents: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
  });
  return NextResponse.json({ machines });
}

// Normalize the documents payload from the admin form into create rows. Drops
// entries without a fileUrl; sortOrder follows array order.
function documentCreateRows(documents: unknown): { title: string; fileUrl: string; sortOrder: number }[] {
  if (!Array.isArray(documents)) return [];
  return documents
    .filter((d): d is { title?: string; fileUrl?: string } => !!d && typeof d === 'object' && !!(d as { fileUrl?: string }).fileUrl)
    .map((d, i) => ({ title: (d.title?.trim() || 'Dokument'), fileUrl: String(d.fileUrl), sortOrder: i }));
}

export async function POST(request: NextRequest) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Ugyldig forespørsel' }, { status: 400 });
    }
    if (isUnusableBody(body)) {
      return NextResponse.json({ error: 'Ugyldig forespørsel' }, { status: 400 });
    }
    // A wrong-typed text field is a client mistake, not a server failure: say
    // which field, with a 400, instead of throwing a TypeError into the
    // catch-all below (I-4).
    const badField = firstNonStringField(body);
    if (badField) {
      return NextResponse.json({ error: `Feltet «${badField}» må være tekst.` }, { status: 400 });
    }
    const input = body as Record<string, any>;

    // New equipment created with prices set is a pricing change — second
    // factor required, same as editing prices on existing equipment.
    if (pricedFields(input).length > 0) {
      const guard = await requireTotp(request);
      if (!guard.ok) return totpRejection(guard.reason);
    }

    const machine = await db.machine.create({
      data: {
        name: input.name?.trim() || 'Nytt utstyr',
        category: input.category?.trim() || null,
        model: input.model?.trim() || '',
        year: input.year?.trim() || null,
        description: input.description?.trim() || null,
        imageUrl: input.imageUrl?.trim() || null,
        isActive: input.isActive !== false,
        specs: input.specs || null,
        features: input.features || null,
        included: input.included || null,
        sortOrder: input.sortOrder ?? 0,
        quantity: input.quantity ?? 1,
        dayPrice: input.dayPrice != null ? Number(input.dayPrice) : null,
        weekendPrice: input.weekendPrice != null ? Number(input.weekendPrice) : null,
        weekPrice: input.weekPrice != null ? Number(input.weekPrice) : null,
        dayIncludedHours: input.dayIncludedHours != null ? Number(input.dayIncludedHours) : null,
        weekendIncludedHours: input.weekendIncludedHours != null ? Number(input.weekendIncludedHours) : null,
        weekIncludedHours: input.weekIncludedHours != null ? Number(input.weekIncludedHours) : null,
        overtimeRate: input.overtimeRate != null ? Number(input.overtimeRate) : null,
        preOrderHourRate: input.preOrderHourRate != null ? Number(input.preOrderHourRate) : null,
        fuelTankLiters: input.fuelTankLiters != null ? Number(input.fuelTankLiters) : null,
        fuelConsumptionPerHour: input.fuelConsumptionPerHour != null ? Number(input.fuelConsumptionPerHour) : null,
        photoScale: input.photoScale != null ? Number(input.photoScale) : null,
        documents: { create: documentCreateRows(input.documents) },
      },
    });
    return NextResponse.json({ success: true, machine }, { status: 201 });
  } catch (err) {
    console.error('admin/machines error:', err);
    return NextResponse.json({ error: 'Kunne ikke opprette utstyr' }, { status: 500 });
  }
}
