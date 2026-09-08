import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { dbDateToStr, getRentalDateRange } from '@/lib/availability';
import type { RentalType } from '@/lib/pricing';
import { addDays } from '@/lib/dates';
import { runCleanupIfDue } from '@/lib/cleanup';
import { loadAppConfig } from '@/lib/app-config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  // Piggy-back cleanup on every availability query so expired pending
  // bookings get swept without an external cron. Throttled to once per
  // minute inside the helper.
  runCleanupIfDue().catch((err) => console.error('cleanup error:', err));

  try {
    const { searchParams } = new URL(request.url);
    const month = searchParams.get('month');

    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json(
        { error: 'Ugyldig måned. Bruk format YYYY-MM.' },
        { status: 400 }
      );
    }

    const machineId = searchParams.get('machineId') || undefined;

    const [year, mon] = month.split('-').map(Number);
    const monthStart = new Date(year, mon - 1, 1);
    const monthEnd = new Date(year, mon, 0, 23, 59, 59, 999);
    const monthStartStr = dbDateToStr(monthStart);
    const monthEndStr = dbDateToStr(monthEnd);

    const unavailableDates = new Set<string>();
    const tentativeDates = new Set<string>();

    const adminUnavailable = await db.unavailableDate.findMany({
      where: { date: { gte: monthStart, lte: monthEnd } },
    });
    for (const ud of adminUnavailable) {
      unavailableDates.add(dbDateToStr(ud.date));
    }

    // Look back far enough to catch long rentals that START before this month
    // but SPAN into it. 90 days covers the `custom` cap, but `week` takes a
    // multiple of 7 and older rows can be longer still, so the window is
    // widened to whatever the table actually holds: a rental can never span
    // more days than the largest `customDays` on a live booking. Without this
    // a long rental starting further back was invisible to the calendar while
    // the conflict check still refused its days — a green day the customer is
    // told is "opptatt" at submit.
    const longestSpan = await db.booking.aggregate({
      _max: { customDays: true },
      where: { status: { in: ['confirmed', 'pending'] } },
    });
    // +1 for the day-before turnaround buffer.
    const lookbackDays = Math.max(90, (longestSpan._max.customDays ?? 0) + 1);
    const lookbackStart = addDays(monthStartStr, -lookbackDays);
    const lookbackDate = new Date(lookbackStart + 'T00:00:00');

    // …and one day PAST the month end, because a booking that starts on the
    // 1st of next month still lays its day-before buffer on the last day of
    // this one.
    const queryEnd = new Date(monthEnd.getTime());
    queryEnd.setDate(queryEnd.getDate() + 1);

    const bookings = await db.booking.findMany({
      where: {
        status: 'confirmed',
        startDate: { gte: lookbackDate, lte: queryEnd },
        ...(machineId ? { machineId } : {}),
      },
    });

    // Pending bookings with date locks: their slots are reserved until the
    // customer pays. If they fail/expire, paymentDeadline gates a 30-min
    // grace window. These dates surface as `tentativeDates` — clearly marked
    // in the calendar as "may free up soon" rather than silently blocked.
    const now = new Date();
    const pendingBookings = await db.booking.findMany({
      where: {
        status: 'pending',
        startDate: { gte: lookbackDate, lte: queryEnd },
        ...(machineId ? { machineId } : {}),
      },
    });

    let equipmentQuantity = 1;
    if (machineId) {
      const machine = await db.machine.findUnique({ where: { id: machineId } });
      if (machine) equipmentQuantity = machine.quantity;
    }

    // Turnaround buffer toggles (admin → Innstillinger → Booking). Default on.
    const appCfg = await loadAppConfig();
    const blockBefore = appCfg['blockDayBeforeBooking'] !== 'false';
    const blockAfter = appCfg['blockDayAfterBooking'] !== 'false';

    const dateBookingCount = new Map<string, number>();
    const turnaroundDates = new Set<string>();
    for (const booking of bookings) {
      const startStr = dbDateToStr(booking.startDate);
      const span = getRentalDateRange(
        startStr,
        booking.rentalType as RentalType,
        booking.customDays
      );
      // Auto-turnaround / scheduled maintenance: the day BEFORE the booking
      // starts (prep, pre-delivery inspection) and the day AFTER the last
      // day (cleanup, refuel). Customers see both as occupied; admin sees
      // them as "Vedlikehold".
      const dayBefore = blockBefore && span[0] ? addDays(span[0], -1) : null;
      const dayAfter = blockAfter && span[span.length - 1]
        ? addDays(span[span.length - 1], 1)
        : null;
      if (dayBefore && dayBefore >= monthStartStr && dayBefore <= monthEndStr) {
        turnaroundDates.add(dayBefore);
      }
      if (dayAfter && dayAfter >= monthStartStr && dayAfter <= monthEndStr) {
        turnaroundDates.add(dayAfter);
      }
      // A buffer day occupies one SLOT of the machine, exactly like a rental
      // day — that is how `getUnavailableDateStringsForRange` counts it. It
      // used to be tallied separately and then marked unavailable whenever it
      // was "still free", the inverse of the intent: on a machine with
      // quantity > 1 the buffer days around a single booking were hidden from
      // customers even though `createPendingBooking` would have taken them.
      const reserved = [
        ...(dayBefore ? [dayBefore] : []),
        ...span,
        ...(dayAfter ? [dayAfter] : []),
      ];
      for (const d of reserved) {
        if (d >= monthStartStr && d <= monthEndStr) {
          dateBookingCount.set(d, (dateBookingCount.get(d) || 0) + 1);
        }
      }
    }

    for (const [date, count] of dateBookingCount) {
      if (count >= equipmentQuantity) {
        unavailableDates.add(date);
      }
    }

    // Map pending bookings to tentative dates (only those not already firmly
    // booked by confirmed bookings). Their turnaround buffer days are
    // tentative too — the server-side conflict check (booking-service
    // getUnavailableDateStringsForRange) treats them as reserved, so the
    // calendar must not offer them as free. Pending rows past their payment
    // deadline are about to be swept and are ignored.
    //
    // Boundary: `runCleanup` owns the deadline instant — it cancels at
    // `paymentDeadline < now`, so a booking whose deadline is exactly now is
    // still alive and still holds its `BookingDateLock` rows. Dropping it here
    // at `<= now` released the day in the calendar while the lock table still
    // held the slot. Strictly `<` puts the sweep, this calendar and the
    // conflict check on the same side of the instant.
    const pendingDateCount = new Map<string, number>();
    for (const booking of pendingBookings) {
      if (booking.paymentDeadline && booking.paymentDeadline < now) continue;
      const startStr = dbDateToStr(booking.startDate);
      const span = getRentalDateRange(
        startStr,
        booking.rentalType as RentalType,
        booking.customDays
      );
      const reserved = [
        ...(blockBefore && span[0] ? [addDays(span[0], -1)] : []),
        ...span,
        ...(blockAfter && span[span.length - 1] ? [addDays(span[span.length - 1], 1)] : []),
      ];
      for (const d of reserved) {
        if (d >= monthStartStr && d <= monthEndStr) {
          pendingDateCount.set(d, (pendingDateCount.get(d) || 0) + 1);
        }
      }
    }
    for (const [date, count] of pendingDateCount) {
      const confirmedHere = dateBookingCount.get(date) || 0;
      // Only mark tentative if confirmed alone wouldn't have filled all slots.
      if (confirmedHere + count >= equipmentQuantity && !unavailableDates.has(date)) {
        tentativeDates.add(date);
      }
    }

    return NextResponse.json({
      unavailableDates: Array.from(unavailableDates).sort(),
      tentativeDates: Array.from(tentativeDates).sort(),
      // Days auto-marked for scheduled maintenance (cleanup after a booking
      // ends). Customer-side they're folded into unavailableDates; admin can
      // render them distinctly to know cleaning is scheduled.
      turnaroundDates: Array.from(turnaroundDates).sort(),
    });
  } catch (error: unknown) {
    console.error('Availability error:', error);
    return NextResponse.json(
      { error: 'Kunne ikke hente tilgjengelighet.' },
      { status: 500 }
    );
  }
}
