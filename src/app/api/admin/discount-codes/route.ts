import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { isAdminAuthenticated } from '@/lib/admin-auth';
import { writeAuditLog } from '@/lib/audit-log';

export const dynamic = 'force-dynamic';

// GET /api/admin/discount-codes — returns:
//   { repeat: [...], campaigns: [...] }
// Used by the Rabattkoder admin page.

export async function GET() {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const [repeat, campaigns] = await Promise.all([
    db.repeatDiscountCode.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    db.campaignDiscountCode.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        redemptions: {
          orderBy: { redeemedAt: 'desc' },
          take: 50,
        },
      },
    }),
  ]);

  // For repeat codes, resolve who issued + who used (Booking refs).
  const issuedIds = repeat.map((r) => r.issuedForBookingId).filter(Boolean) as string[];
  const redeemedIds = repeat.map((r) => r.redeemedByBookingId).filter(Boolean) as string[];
  const allBookingIds = [...new Set([...issuedIds, ...redeemedIds, ...campaigns.flatMap((c) => c.redemptions.map((r) => r.bookingId))])];
  const bookings = allBookingIds.length > 0
    ? await db.booking.findMany({
        where: { id: { in: allBookingIds } },
        select: { id: true, reference: true, name: true, email: true, phone: true },
      })
    : [];
  const bookingMap = new Map(bookings.map((b) => [b.id, b]));

  return NextResponse.json({
    repeat: repeat.map((r) => ({
      id: r.id,
      code: r.code,
      email: r.email,
      issuedFor: r.issuedForBookingId ? bookingMap.get(r.issuedForBookingId) ?? null : null,
      redeemedBy: r.redeemedByBookingId ? bookingMap.get(r.redeemedByBookingId) ?? null : null,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
      redeemedAt: r.redeemedAt,
    })),
    campaigns: campaigns.map((c) => ({
      id: c.id,
      code: c.code,
      percent: c.percent,
      maxUses: c.maxUses,
      usedCount: c.usedCount,
      expiresAt: c.expiresAt,
      isActive: c.isActive,
      notes: c.notes,
      createdAt: c.createdAt,
      redemptions: c.redemptions.map((red) => ({
        id: red.id,
        email: red.email,
        bookingRef: bookingMap.get(red.bookingId)?.reference ?? null,
        customerName: bookingMap.get(red.bookingId)?.name ?? null,
        redeemedAt: red.redeemedAt,
      })),
    })),
  });
}

// POST /api/admin/discount-codes — create a new campaign code.
export async function POST(req: NextRequest) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  // An unparseable body used to escape as an unhandled exception — a bare 500
  // — instead of the 400 every other shape error here returns.
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldig forespørsel.' }, { status: 400 });
  }

  const code = String(body.code || '').trim().toUpperCase();
  if (!code || !/^[A-Z0-9-]{3,32}$/.test(code)) {
    return NextResponse.json({ error: 'Ugyldig kode. Bare A-Z, 0-9, og bindestrek (3-32 tegn).' }, { status: 400 });
  }
  const percent = Math.max(1, Math.min(100, Number(body.percent) || 0));
  const maxUses = body.maxUses === null || body.maxUses === '' ? null : Math.max(1, Number(body.maxUses) || 1);
  // `new Date("i morgen")` is an Invalid Date, which Prisma rejects at the
  // driver with an exception. Answer it as the shape error it is.
  let expiresAt: Date | null = null;
  if (body.expiresAt) {
    expiresAt = new Date(body.expiresAt as string);
    if (Number.isNaN(expiresAt.getTime())) {
      return NextResponse.json({ error: 'Ugyldig utløpsdato.' }, { status: 400 });
    }
  }

  // Refuse if the code collides with an existing campaign or repeat code.
  const [existingCampaign, existingRepeat] = await Promise.all([
    db.campaignDiscountCode.findUnique({ where: { code } }),
    db.repeatDiscountCode.findUnique({ where: { code } }),
  ]);
  if (existingCampaign || existingRepeat) {
    return NextResponse.json({ error: 'Koden eksisterer allerede.' }, { status: 409 });
  }

  try {
    const created = await db.campaignDiscountCode.create({
      data: {
        code, percent, maxUses, expiresAt,
        notes: typeof body.notes === 'string' && body.notes ? body.notes : null,
        isActive: body.isActive !== false,
      },
    });
    await writeAuditLog({
      action: 'discount_code.create',
      changes: [
        { key: 'code', from: null, to: created.code },
        { key: 'percent', from: null, to: created.percent },
        { key: 'maxUses', from: null, to: created.maxUses },
      ],
      request: req,
    });
    return NextResponse.json({ campaign: created });
  } catch (err) {
    // Never hand the client Prisma's message: it carries the absolute path of
    // this file and an excerpt of its source.
    console.error('discount code create failed:', err);
    return NextResponse.json({ error: 'Kunne ikke opprette rabattkode.' }, { status: 500 });
  }
}
