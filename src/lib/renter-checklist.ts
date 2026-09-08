// Pure rules for the renter (QR kiosk) checklist: which phases apply, when a
// daily/hourly interval is due, whether a booking is currently active. No DB
// access here — this module is imported by client bundles (admin checklist
// sandbox). DB-backed lookups live in renter-checklist-db.ts.
import { normalizePhone } from '@/lib/phone-normalize';
import { getRentalDateRange, rentalDayCount } from '@/lib/availability';
import type { RentalType } from '@/lib/pricing';
import { toDateStr } from '@/lib/dates';
import { isItemFilled, isItemActive, parseChecklistData, resolvePhaseAudience, filterPhasesForBooking, type ChecklistPhaseLike } from '@/lib/checklist';
import type { Booking, Machine } from '@prisma/client';

export type ChecklistAudience = 'operator' | 'renter';
export type IntervalMode = 'once' | 'daily' | 'hours' | 'return';

export interface RentalBounds {
  startDate: string;
  endDate: string;
  totalDays: number;
}

export interface ActiveBookingSummary {
  id: string;
  reference: string;
  name: string;
  equipmentName: string;
  startDate: string;
  endDate: string;
  rentalDay: number;
  totalDays: number;
  selfPickup: boolean;
}

export interface IntervalInfo {
  key: string;
  label: string;
  slotIndex: number;
}

type BookingRow = Pick<
  Booking,
  'id' | 'reference' | 'name' | 'phone' | 'status' | 'startDate' | 'rentalType' | 'customDays' | 'fullyPaidAt' | 'selfPickup'
> & { machine?: Pick<Machine, 'name'> | null };

export function getBookingRentalBounds(booking: {
  startDate: Date;
  rentalType: string;
  customDays?: number | null;
}): RentalBounds {
  const startDate = toDateStr(booking.startDate);
  const range = getRentalDateRange(
    startDate,
    booking.rentalType as RentalType,
    booking.customDays,
  );
  return {
    startDate,
    endDate: range[range.length - 1] ?? startDate,
    totalDays: range.length,
  };
}

/** Confirmed, paid, and today falls within the rental calendar span. */
export function isBookingActiveForRenterChecklist(
  booking: Pick<Booking, 'status' | 'fullyPaidAt' | 'startDate' | 'rentalType' | 'customDays'>,
  now = new Date(),
): boolean {
  if (booking.status !== 'confirmed') return false;
  if (!booking.fullyPaidAt) return false;
  const today = toDateStr(now);
  const { startDate, endDate } = getBookingRentalBounds(booking);
  return today >= startDate && today <= endDate;
}

export function rentalDayNumber(booking: {
  startDate: Date;
  rentalType: string;
  customDays?: number | null;
}, now = new Date()): number {
  const { startDate, totalDays } = getBookingRentalBounds(booking);
  const today = toDateStr(now);
  if (today < startDate) return 0;
  const range = getRentalDateRange(startDate, booking.rentalType as RentalType, booking.customDays);
  const idx = range.indexOf(today);
  if (idx === -1) return totalDays;
  return idx + 1;
}

export function toActiveBookingSummary(booking: BookingRow): ActiveBookingSummary {
  const bounds = getBookingRentalBounds(booking);
  return {
    id: booking.id,
    reference: booking.reference,
    name: booking.name,
    equipmentName: booking.machine?.name ?? 'Utstyr',
    startDate: bounds.startDate,
    endDate: bounds.endDate,
    rentalDay: rentalDayNumber(booking),
    totalDays: bounds.totalDays,
    selfPickup: booking.selfPickup,
  };
}


export function filterRenterPhases<T extends ChecklistPhaseLike>(
  phases: T[],
  booking: { selfPickup: boolean },
): T[] {
  return phases.filter((phase) => {
    if (phase.isActive === false) return false;
    if (resolvePhaseAudience(phase, booking) !== 'renter') return false;
    const mode = phase.appliesTo ?? 'all';
    if (mode === 'delivery') return !booking.selfPickup;
    if (mode === 'selfPickup') return booking.selfPickup;
    return true;
  });
}

const HANDOVER_NAME_RE = /lever|utlever|delivery|selvhent|hent/i;

/** Operator handover phase (Levering / Selvhenting) for the booking type. */
export function findHandoverPhase<T extends ChecklistPhaseLike>(
  phases: T[],
  booking: { selfPickup: boolean },
): T | undefined {
  const operatorPhases = filterPhasesForBooking(phases, booking, { audience: 'operator' });
  return operatorPhases.find((p) => HANDOVER_NAME_RE.test(p.name));
}

/** Operator handover phase locked — used to gate renter QR checklists. */
export function isOperatorHandoverComplete(
  booking: { selfPickup: boolean; checklistData?: string | null },
  allPhases: ChecklistPhaseLike[],
): boolean {
  const handover = findHandoverPhase(allPhases, booking);
  if (!handover) return true;
  const data = parseChecklistData(booking.checklistData);
  return data[`__phase_locked_${handover.id}`] === true;
}

/** Renter QR phases unlock only after operator handover (Levering/Selvhenting) is locked. */
export function isRenterPhaseAvailable(
  phase: ChecklistPhaseLike,
  booking: {
    startDate: Date;
    rentalType: string;
    customDays?: number | null;
    selfPickup: boolean;
    checklistData?: string | null;
  },
  allPhases: ChecklistPhaseLike[],
  now = new Date(),
): { available: boolean; reason?: string } {
  if (!isOperatorHandoverComplete(booking, allPhases)) {
    return {
      available: false,
      reason: booking.selfPickup
        ? 'Tilgjengelig når henting/utlevering er fullført av operatør'
        : 'Tilgjengelig når levering er fullført',
    };
  }

  const mode = (phase.intervalMode ?? 'once') as IntervalMode;
  if (mode !== 'return') return { available: true };

  const bounds = getBookingRentalBounds(booking);
  const today = toDateStr(now);

  // The return checklist opens on the LAST rental day, not on the return
  // morning: the schedule hands the machine back at e.g. "Man 07:00", so the
  // renter fills it in the evening before. The label therefore names the last
  // rental day explicitly — "ved retur (<date>)" printed this same date and
  // read as the return day, one day earlier than the schedule and the
  // confirmation email say (Q-13).
  if (today < bounds.endDate) {
    const endLabel = new Date(bounds.endDate + 'T12:00:00').toLocaleDateString('nb-NO', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
    return { available: false, reason: `Tilgjengelig siste leiedag, før retur (${endLabel})` };
  }

  return { available: true };
}

export function computeIntervalInfo(
  phase: { intervalMode?: string | null; intervalHours?: number | null },
  booking: { startDate: Date; rentalType: string; customDays?: number | null },
  now = new Date(),
): IntervalInfo {
  const mode = (phase.intervalMode ?? 'once') as IntervalMode;
  const bounds = getBookingRentalBounds(booking);

  if (mode === 'once') {
    return { key: 'once', label: 'Engangskontroll', slotIndex: 0 };
  }

  if (mode === 'return') {
    return { key: 'return', label: 'Ved retur', slotIndex: 0 };
  }

  if (mode === 'daily') {
    const today = toDateStr(now);
    const range = getRentalDateRange(bounds.startDate, booking.rentalType as RentalType, booking.customDays);
    const dayIdx = range.indexOf(today);
    const dayNum = dayIdx >= 0 ? dayIdx + 1 : 1;
    return {
      key: `day-${today}`,
      label: `Dag ${dayNum} av ${bounds.totalDays}`,
      slotIndex: dayNum,
    };
  }

  const hours = Math.max(1, Number(phase.intervalHours) || 24);
  const rentalStart = new Date(bounds.startDate + 'T07:00:00');
  const elapsedMs = Math.max(0, now.getTime() - rentalStart.getTime());
  const slotIndex = Math.floor(elapsedMs / (hours * 60 * 60 * 1000));
  return {
    key: `h${slotIndex}`,
    label: `Kontroll ${slotIndex + 1} (hver ${hours} t)`,
    slotIndex,
  };
}

export function isSubmissionComplete(
  phase: ChecklistPhaseLike,
  data: Record<string, unknown>,
): boolean {
  const activeItems = phase.items.filter((i) => isItemActive(i, data, phase.items));
  if (activeItems.length === 0) return false;
  return activeItems.every((item) => isItemFilled(item, data[item.id]));
}

export function assertPhoneMatchesBooking(
  booking: Pick<Booking, 'phone'>,
  sessionPhone: string,
): boolean {
  return normalizePhone(booking.phone) === sessionPhone;
}

/** Human label for a stored ChecklistSubmission.intervalKey. */
export function formatStoredIntervalLabel(
  phase: { intervalMode?: string | null; intervalHours?: number | null },
  intervalKey: string,
): string {
  if (intervalKey === 'once') return 'Engangskontroll';
  if (intervalKey === 'return') return 'Ved retur';
  if (intervalKey.startsWith('day-')) {
    const date = intervalKey.slice(4);
    const parsed = new Date(date + 'T12:00:00');
    if (!Number.isNaN(parsed.getTime())) {
      return `Dag ${parsed.toLocaleDateString('nb-NO', { day: 'numeric', month: 'short' })}`;
    }
    return `Dag ${date}`;
  }
  const slotMatch = /^h(\d+)$/.exec(intervalKey);
  if (slotMatch) {
    const slot = Number(slotMatch[1]) + 1;
    const hours = Math.max(1, Number(phase.intervalHours) || 24);
    return `Kontroll ${slot} (hver ${hours} t)`;
  }
  return intervalKey;
}

export interface RenterSubmissionView {
  id: string;
  phaseId: string;
  phaseName: string;
  intervalKey: string;
  intervalLabel: string;
  phone: string;
  submittedAt: string;
  data: Record<string, unknown>;
  items: Array<{ id: string; label: string; answerType: string; unit?: string | null; conditionItemId?: string | null; conditionValue?: string | null; minPhotos?: number | null }>;
}


export function hoursUntilNextInterval(
  phase: { intervalMode?: string | null; intervalHours?: number | null },
  booking: { startDate: Date; rentalType: string; customDays?: number | null },
  now = new Date(),
): number {
  const mode = (phase.intervalMode ?? 'once') as IntervalMode;
  if (mode !== 'hours') return 0;
  const hours = Math.max(1, Number(phase.intervalHours) || 24);
  const bounds = getBookingRentalBounds(booking);
  const rentalStart = new Date(bounds.startDate + 'T07:00:00');
  const elapsedMs = Math.max(0, now.getTime() - rentalStart.getTime());
  const slotMs = hours * 60 * 60 * 1000;
  const intoSlot = elapsedMs % slotMs;
  if (intoSlot < 60_000) return 0; // first minute of slot = due
  return Math.ceil((slotMs - intoSlot) / (60 * 60 * 1000));
}

export { rentalDayCount };
