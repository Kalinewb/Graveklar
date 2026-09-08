// Server-only companions to renter-checklist.ts: the lookups that need the
// database. Kept apart so the pure rules module can be bundled for the
// browser (admin checklist sandbox) without dragging PrismaClient along.
import { db } from '@/lib/db';
import { normalizePhone } from '@/lib/phone-normalize';
import { parseChecklistData } from '@/lib/checklist';
import {
  filterRenterPhases,
  formatStoredIntervalLabel,
  isBookingActiveForRenterChecklist,
  toActiveBookingSummary,
  type ActiveBookingSummary,
  type RenterSubmissionView,
} from '@/lib/renter-checklist';

export async function findActiveBookingsByPhone(
  rawPhone: string,
): Promise<ActiveBookingSummary[]> {
  const phone = normalizePhone(rawPhone);
  if (phone.length < 8) return [];

  const candidates = await db.booking.findMany({
    where: { status: 'confirmed' },
    include: { machine: { select: { name: true } } },
    orderBy: { startDate: 'asc' },
  });

  return candidates
    .filter((b) => normalizePhone(b.phone) === phone)
    .filter((b) => isBookingActiveForRenterChecklist(b))
    .map(toActiveBookingSummary);
}

export async function loadRenterSubmissionsForBooking(
  bookingId: string,
  booking: { selfPickup: boolean },
): Promise<{ renterPhaseCount: number; submissions: RenterSubmissionView[] }> {
  const [submissions, phases] = await Promise.all([
    db.checklistSubmission.findMany({
      where: { bookingId },
      orderBy: { submittedAt: 'asc' },
    }),
    db.checklistPhase.findMany({
      where: { isActive: true, audience: 'renter' },
      include: { items: { where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
      orderBy: { sortOrder: 'asc' },
    }),
  ]);

  const phaseMap = new Map(phases.map((p) => [p.id, p]));
  const applicablePhases = filterRenterPhases(phases, booking);

  return {
    renterPhaseCount: applicablePhases.length,
    submissions: submissions.map((s) => {
      const phase = phaseMap.get(s.phaseId);
      const data = parseChecklistData(s.data);
      return {
        id: s.id,
        phaseId: s.phaseId,
        phaseName: phase?.name ?? 'Ukjent fase',
        intervalKey: s.intervalKey,
        intervalLabel: phase
          ? formatStoredIntervalLabel(phase, s.intervalKey)
          : s.intervalKey,
        phone: s.phone,
        submittedAt: s.submittedAt.toISOString(),
        data,
        items: (phase?.items ?? []).map((i) => ({
          id: i.id,
          label: i.label,
          answerType: i.answerType,
          unit: i.unit,
          conditionItemId: i.conditionItemId,
          conditionValue: i.conditionValue,
          minPhotos: i.minPhotos,
        })),
      };
    }),
  };
}
