import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { extractBearerToken, verifyRenterSessionToken } from '@/lib/renter-checklist-session';
import {
  assertPhoneMatchesBooking,
  computeIntervalInfo,
  filterRenterPhases,
  isBookingActiveForRenterChecklist,
  isRenterPhaseAvailable,
  isSubmissionComplete,
} from '@/lib/renter-checklist';
import { resolvePhaseAudience } from '@/lib/checklist';
import { normalizePhone } from '@/lib/phone-normalize';
import { loadAppConfig } from '@/lib/app-config';

export async function POST(request: NextRequest) {
  try {
    const cfg = await loadAppConfig();
    if (cfg['renterChecklistEnabled'] === 'false') {
      return NextResponse.json({ error: 'Sjekkliste er ikke aktivert.' }, { status: 403 });
    }

    const token = extractBearerToken(request.headers.get('authorization'));
    const session = await verifyRenterSessionToken(token);
    if (!session) {
      return NextResponse.json({ error: 'Ugyldig eller utløpt økt. Skann QR-koden på nytt.' }, { status: 401 });
    }

    const body = await request.json();
    const phaseId = typeof body.phaseId === 'string' ? body.phaseId : '';
    const rawData = body.data;

    if (!phaseId || typeof rawData !== 'object' || rawData === null) {
      return NextResponse.json({ error: 'Ugyldig innsending.' }, { status: 400 });
    }

    const booking = await db.booking.findUnique({ where: { id: session.bookingId } });
    if (!booking || !assertPhoneMatchesBooking(booking, session.phone)) {
      return NextResponse.json({ error: 'Booking ikke funnet.' }, { status: 404 });
    }
    if (!isBookingActiveForRenterChecklist(booking)) {
      return NextResponse.json({ error: 'Leien er ikke aktiv.' }, { status: 403 });
    }

    const phase = await db.checklistPhase.findUnique({
      where: { id: phaseId },
      include: { items: { where: { isActive: true } } },
    });
    if (!phase || !phase.isActive || resolvePhaseAudience(phase, booking) !== 'renter') {
      return NextResponse.json({ error: 'Ugyldig sjekklistefase.' }, { status: 400 });
    }

    const allPhases = await db.checklistPhase.findMany({
      where: { isActive: true },
      include: { items: { where: { isActive: true } } },
    });
    const renterPhases = filterRenterPhases(allPhases, booking);
    if (!renterPhases.some((p) => p.id === phase.id)) {
      return NextResponse.json({ error: 'Ugyldig sjekklistefase.' }, { status: 400 });
    }

    const availability = isRenterPhaseAvailable(phase, booking, allPhases);
    if (!availability.available) {
      return NextResponse.json(
        { error: availability.reason ?? 'Sjekklisten er ikke tilgjengelig ennå.' },
        { status: 403 },
      );
    }

    const interval = computeIntervalInfo(phase, booking);

    const existing = await db.checklistSubmission.findUnique({
      where: {
        bookingId_phaseId_intervalKey: {
          bookingId: booking.id,
          phaseId: phase.id,
          intervalKey: interval.key,
        },
      },
    });
    if (existing) {
      return NextResponse.json({ error: `Du har allerede levert ${interval.label.toLowerCase()}.` }, { status: 409 });
    }

    const allowedIds = new Set(phase.items.map((i) => i.id));
    const filtered: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(rawData as Record<string, unknown>)) {
      if (allowedIds.has(key)) filtered[key] = val;
    }

    if (!isSubmissionComplete(phase, filtered)) {
      return NextResponse.json({ error: 'Fyll ut alle påkrevde punkter.' }, { status: 400 });
    }

    const submission = await db.checklistSubmission.create({
      data: {
        bookingId: booking.id,
        phaseId: phase.id,
        intervalKey: interval.key,
        data: JSON.stringify(filtered),
        phone: normalizePhone(session.phone),
      },
    });

    return NextResponse.json({
      success: true,
      submission: {
        id: submission.id,
        phaseId: submission.phaseId,
        intervalKey: submission.intervalKey,
        submittedAt: submission.submittedAt.toISOString(),
      },
    });
  } catch (err) {
    console.error('checklist/submit error:', err);
    return NextResponse.json({ error: 'Innsending feilet.' }, { status: 500 });
  }
}
