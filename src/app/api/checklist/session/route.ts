import { toDateStr } from '@/lib/dates';
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
import { parseChecklistData } from '@/lib/checklist';
import { loadAppConfig } from '@/lib/app-config';

export async function GET(request: NextRequest) {
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

    const booking = await db.booking.findUnique({
      where: { id: session.bookingId },
      include: {
        machine: {
          select: {
            name: true,
            documents: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], select: { title: true, fileUrl: true } },
          },
        },
      },
    });
    if (!booking || !assertPhoneMatchesBooking(booking, session.phone)) {
      return NextResponse.json({ error: 'Booking ikke funnet.' }, { status: 404 });
    }
    if (!isBookingActiveForRenterChecklist(booking)) {
      return NextResponse.json({ error: 'Leien er ikke aktiv. Sjekklisten er kun tilgjengelig under leieperioden.' }, { status: 403 });
    }

    const phases = await db.checklistPhase.findMany({
      where: { isActive: true },
      include: { items: { where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
      orderBy: { sortOrder: 'asc' },
    });

    const renterPhases = filterRenterPhases(phases, booking);
    if (renterPhases.length === 0) {
      return NextResponse.json({ error: 'Ingen leietaker-sjekkliste er konfigurert.' }, { status: 404 });
    }

    const submissions = await db.checklistSubmission.findMany({
      where: { bookingId: booking.id },
    });
    const submissionMap = new Map(
      submissions.map((s) => [`${s.phaseId}:${s.intervalKey}`, s]),
    );

    const phaseStates = renterPhases.map((phase) => {
      const interval = computeIntervalInfo(phase, booking);
      const existing = submissionMap.get(`${phase.id}:${interval.key}`);
      const data = existing ? parseChecklistData(existing.data) : {};
      const submitted = !!existing;
      const complete = submitted && isSubmissionComplete(phase, data);
      const availability = isRenterPhaseAvailable(phase, booking, phases);
      return {
        id: phase.id,
        name: phase.name,
        intervalMode: phase.intervalMode ?? 'once',
        intervalHours: phase.intervalHours,
        interval,
        submitted,
        complete,
        available: availability.available,
        lockedReason: availability.reason ?? null,
        submittedAt: existing?.submittedAt?.toISOString() ?? null,
        data,
        items: phase.items.map((i) => ({
          id: i.id,
          label: i.label,
          answerType: i.answerType,
          unit: i.unit,
          conditionItemId: i.conditionItemId,
          conditionValue: i.conditionValue,
          minPhotos: i.minPhotos,
        })),
      };
    });

    const duePhase =
      phaseStates.find((p) => p.available && !p.submitted)
      ?? phaseStates.find((p) => p.available && !p.complete)
      ?? null;

    return NextResponse.json({
      booking: {
        id: booking.id,
        reference: booking.reference,
        name: booking.name,
        equipmentName: booking.machine?.name ?? 'Utstyr',
        startDate: toDateStr(booking.startDate),
        selfPickup: booking.selfPickup,
      },
      businessName: cfg['businessName'] || 'Graveklar',
      machineDocuments: (booking.machine?.documents ?? []).map((d) => ({
        title: d.title,
        fileUrl: d.fileUrl,
      })),
      phases: phaseStates,
      duePhaseId: duePhase?.id ?? null,
    });
  } catch (err) {
    console.error('checklist/session error:', err);
    return NextResponse.json({ error: 'Kunne ikke laste sjekkliste.' }, { status: 500 });
  }
}
