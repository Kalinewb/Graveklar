import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { dateToDbMidnight, dbDateToStr } from '@/lib/availability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/unavailable?month=2026-06 — list unavailable dates for a month
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const month = searchParams.get('month'); // format: 2026-06

    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json(
        { error: 'Ugyldig måned. Bruk format YYYY-MM.' },
        { status: 400 }
      );
    }

    const [year, mon] = month.split('-').map(Number);
    const monthStart = new Date(year, mon - 1, 1);
    const monthEnd = new Date(year, mon, 0, 23, 59, 59, 999);

    const unavailableDates = await db.unavailableDate.findMany({
      where: {
        date: {
          gte: monthStart,
          lte: monthEnd,
        },
      },
      orderBy: { date: 'asc' },
    });

    return NextResponse.json({
      unavailableDates: unavailableDates.map((ud) => ({
        id: ud.id,
        date: dbDateToStr(ud.date),
        reason: ud.reason,
      })),
    });
  } catch (error: any) {
    console.error('Unavailable GET error:', error?.message || error);
    return NextResponse.json(
      { error: 'Kunne ikke hente utilgjengelige datoer.' },
      { status: 500 }
    );
  }
}

// POST /api/unavailable — mark dates as unavailable
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { dates, reason } = body; // dates: string[] (YYYY-MM-DD format), reason?: string

    if (!dates || !Array.isArray(dates) || dates.length === 0) {
      return NextResponse.json(
        { error: 'Angi minst én dato.' },
        { status: 400 }
      );
    }

    // Filter out dates that are already locked to an active booking. Blocking
    // a date that already has a confirmed booking would corrupt the usage %
    // (the day is double-counted) and surface as "blocked" to admins even
    // though a customer holds the slot.
    const validDates = (dates as unknown[]).filter(
      (d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)
    );
    const lockedSet = new Set<string>();
    if (validDates.length > 0) {
      const lockedRows = await db.bookingDateLock.findMany({
        where: { date: { in: validDates.map(dateToDbMidnight) } },
        select: { date: true },
      });
      for (const row of lockedRows) {
        lockedSet.add(dbDateToStr(row.date));
      }
    }
    const skipped = validDates.filter((d) => lockedSet.has(d));
    const writable = validDates.filter((d) => !lockedSet.has(d));

    const results: { id: string; date: string; reason: string | null }[] = [];
    for (const dateStr of writable) {
      try {
        const created = await db.unavailableDate.upsert({
          where: { date: dateToDbMidnight(dateStr) },
          update: { reason: reason || null },
          create: {
            date: dateToDbMidnight(dateStr),
            reason: reason || null,
          },
        });
        results.push({
          id: created.id,
          date: dbDateToStr(created.date),
          reason: created.reason,
        });
      } catch {
        // Skip duplicates or invalid dates
      }
    }

    return NextResponse.json({ success: true, created: results, skipped });
  } catch (error: any) {
    console.error('Unavailable POST error:', error?.message || error);
    return NextResponse.json(
      { error: 'Kunne ikke opprette utilgjengelige datoer.' },
      { status: 500 }
    );
  }
}

// DELETE /api/unavailable — remove unavailable dates
export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const { ids, dates } = body; // ids: string[] OR dates: string[] (YYYY-MM-DD)

    // `deleted` is the number of rows deleteMany actually removed, never the
    // length of the request — the admin calendar has to be able to tell a
    // delete from a no-op.
    if (ids && Array.isArray(ids)) {
      const removed = await db.unavailableDate.deleteMany({
        where: { id: { in: ids } },
      });
      return NextResponse.json({ success: true, deleted: removed.count });
    }

    if (dates && Array.isArray(dates)) {
      // Rows are written at Oslo local midnight (`dateToDbMidnight`), so they
      // must be matched the same way. Building `new Date(d + 'T00:00:00.000Z')`
      // here looked for UTC midnight — one or two hours off — and matched
      // nothing, so un-blocking a date from the calendar silently did nothing.
      const dateObjects = dates
        .filter((d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .map((d: string) => dateToDbMidnight(d));

      const removed = await db.unavailableDate.deleteMany({
        where: { date: { in: dateObjects } },
      });
      return NextResponse.json({ success: true, deleted: removed.count });
    }

    return NextResponse.json(
      { error: 'Angi ids eller dates for sletting.' },
      { status: 400 }
    );
  } catch (error: any) {
    console.error('Unavailable DELETE error:', error?.message || error);
    return NextResponse.json(
      { error: 'Kunne ikke slette utilgjengelige datoer.' },
      { status: 500 }
    );
  }
}
