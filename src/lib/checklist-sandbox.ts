import { getRentalDateRange } from '@/lib/availability';
import { addDays, parseDateStr, todayStr, toDateStr } from '@/lib/dates';
import type { RentalType } from '@/lib/pricing';
import {
  filterPhasesForBooking,
  parseChecklistData,
  resolvePhaseAudience,
  type ChecklistPhaseLike,
} from '@/lib/checklist';
import {
  computeIntervalInfo,
  filterRenterPhases,
  findHandoverPhase,
  getBookingRentalBounds,
  isOperatorHandoverComplete,
  isRenterPhaseAvailable,
} from '@/lib/renter-checklist';

export type SandboxRentalPreset = 'same_day' | 'multi_day';

export interface SandboxBookingConfig {
  selfPickup: boolean;
  rentalPreset: SandboxRentalPreset;
  /** 0-based index into the rental date range */
  dayIndex: number;
}

export interface SandboxBooking {
  id: string;
  reference: string;
  name: string;
  phone: string;
  selfPickup: boolean;
  rentalType: RentalType;
  customDays: number | null;
  startDate: Date;
  checklistData: string;
}

export interface SandboxRenterSubmissionKey {
  phaseId: string;
  intervalKey: string;
}

export function sandboxSubmissionKey(phaseId: string, intervalKey: string): string {
  return `${phaseId}:${intervalKey}`;
}

export function sandboxStartDate(preset: SandboxRentalPreset): string {
  if (preset === 'same_day') return todayStr();
  return addDays(todayStr(), -1);
}

export function sandboxRentalType(preset: SandboxRentalPreset): RentalType {
  return preset === 'same_day' ? 'day' : 'custom';
}

export function sandboxCustomDays(preset: SandboxRentalPreset): number | null {
  return preset === 'same_day' ? null : 3;
}

export function sandboxDateRange(config: Pick<SandboxBookingConfig, 'rentalPreset'>): string[] {
  return getRentalDateRange(
    sandboxStartDate(config.rentalPreset),
    sandboxRentalType(config.rentalPreset),
    sandboxCustomDays(config.rentalPreset),
  );
}

export function sandboxSimulatedNow(config: SandboxBookingConfig): Date {
  const range = sandboxDateRange(config);
  const idx = Math.max(0, Math.min(config.dayIndex, range.length - 1));
  return parseDateStr(range[idx]!);
}

export function buildSandboxBooking(
  config: SandboxBookingConfig,
  operatorData: Record<string, unknown>,
): SandboxBooking {
  const startDateStr = sandboxStartDate(config.rentalPreset);
  return {
    id: 'sandbox',
    reference: 'SANDBOX',
    name: 'Sandbox Kunde',
    phone: '99000000',
    selfPickup: config.selfPickup,
    rentalType: sandboxRentalType(config.rentalPreset),
    customDays: sandboxCustomDays(config.rentalPreset),
    startDate: parseDateStr(startDateStr),
    checklistData: JSON.stringify(operatorData),
  };
}

export { findHandoverPhase };

export function applyHandoverComplete(
  operatorData: Record<string, unknown>,
  phases: ChecklistPhaseLike[],
  booking: { selfPickup: boolean },
  complete: boolean,
): Record<string, unknown> {
  const handover = findHandoverPhase(phases, booking);
  if (!handover) return operatorData;
  const next = { ...operatorData };
  if (complete) {
    next[`__phase_locked_${handover.id}`] = true;
    next[`__phase_locked_at_${handover.id}`] = new Date().toISOString();
  } else {
    delete next[`__phase_locked_${handover.id}`];
    delete next[`__phase_locked_at_${handover.id}`];
  }
  return next;
}

export function findOperatorPhaseIndex<T extends ChecklistPhaseLike>(
  phases: T[],
  booking: { selfPickup: boolean },
  nameRe: RegExp,
): number {
  const operatorPhases = filterPhasesForBooking(phases, booking, { audience: 'operator' });
  const idx = operatorPhases.findIndex((p) => nameRe.test(p.name));
  return idx >= 0 ? idx : 0;
}

export function canLockOperatorPhase(
  phaseId: string,
  operatorPhases: ChecklistPhaseLike[],
  operatorData: Record<string, unknown>,
): boolean {
  const idx = operatorPhases.findIndex((p) => p.id === phaseId);
  if (idx <= 0) return true;
  return operatorPhases
    .slice(0, idx)
    .every((p) => operatorData[`__phase_locked_${p.id}`] === true);
}

export interface SandboxRenterPhaseView {
  id: string;
  name: string;
  intervalKey: string;
  intervalLabel: string;
  available: boolean;
  lockedReason?: string;
  submitted: boolean;
  audience: 'operator' | 'renter';
}

export function buildSandboxRenterPhases(
  phases: ChecklistPhaseLike[],
  booking: SandboxBooking,
  config: SandboxBookingConfig,
  submittedKeys: Set<string>,
): SandboxRenterPhaseView[] {
  const now = sandboxSimulatedNow(config);
  const renterPhases = filterRenterPhases(phases, booking);

  return renterPhases.map((phase) => {
    const availability = isRenterPhaseAvailable(phase, booking, phases, now);
    const interval = computeIntervalInfo(phase, booking, now);
    return {
      id: phase.id,
      name: phase.name,
      intervalKey: interval.key,
      intervalLabel: interval.label,
      available: availability.available,
      lockedReason: availability.reason,
      submitted: submittedKeys.has(sandboxSubmissionKey(phase.id, interval.key)),
      audience: resolvePhaseAudience(phase, booking),
    };
  });
}

export interface SandboxFlowSummary {
  handoverLabel: string;
  handoverComplete: boolean;
  simDayLabel: string;
  renterOpenCount: number;
  renterLockedCount: number;
  hint: string;
}

export function buildSandboxFlowSummary(
  phases: ChecklistPhaseLike[],
  booking: SandboxBooking,
  config: SandboxBookingConfig,
  renterPhaseViews: SandboxRenterPhaseView[],
): SandboxFlowSummary {
  const handover = findHandoverPhase(phases, booking);
  const handoverComplete = isOperatorHandoverComplete(booking, phases);
  const handoverLabel = handover?.name ?? (config.selfPickup ? 'Selvhenting' : 'Levering');
  const simDay = formatSandboxSimDay(config);
  const simDayLabel = sandboxDayLabel(simDay, config);

  const renterOpenCount = renterPhaseViews.filter((p) => p.available && !p.submitted).length;
  const renterLockedCount = renterPhaseViews.filter((p) => !p.available && !p.submitted).length;

  let hint = 'Fyll ut operatør-fasene i rekkefølge, deretter test kunde-QR.';
  if (!handoverComplete) {
    hint = config.selfPickup
      ? `Fullfør «${handoverLabel}» i operatør-panelet før kunde-QR åpnes.`
      : `Fullfør «${handoverLabel}» i operatør-panelet før kunde-QR åpnes.`;
  } else if (renterOpenCount > 0) {
    hint = `${renterOpenCount} kunde-fase${renterOpenCount > 1 ? 'r' : ''} klar på ${simDayLabel}.`;
  } else if (renterLockedCount > 0) {
    const firstLocked = renterPhaseViews.find((p) => !p.available && !p.submitted);
    hint = firstLocked?.lockedReason ?? 'Ingen kunde-faser tilgjengelig på simulert dag.';
  } else {
    hint = 'Alle kunde-faser er levert for denne simuleringen.';
  }

  return {
    handoverLabel,
    handoverComplete,
    simDayLabel,
    renterOpenCount,
    renterLockedCount,
    hint,
  };
}

export function sandboxDayLabel(dateStr: string, config: SandboxBookingConfig): string {
  const bounds = getBookingRentalBounds({
    startDate: parseDateStr(sandboxStartDate(config.rentalPreset)),
    rentalType: sandboxRentalType(config.rentalPreset),
    customDays: sandboxCustomDays(config.rentalPreset),
  });
  const d = new Date(dateStr + 'T12:00:00').toLocaleDateString('nb-NO', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  if (dateStr === bounds.endDate) return `${d} (retur)`;
  if (dateStr === bounds.startDate) return `${d} (start)`;
  return d;
}

export interface SandboxPreset {
  config: SandboxBookingConfig;
  handoverComplete: boolean;
  operatorPhaseIdx?: number;
}

export function sandboxPresetLasteSelvhenting(): SandboxPreset {
  return {
    config: {
      selfPickup: true,
      rentalPreset: 'same_day',
      dayIndex: 0,
    },
    handoverComplete: true,
  };
}

export function sandboxPresetLasteLevering(): SandboxPreset {
  return {
    config: {
      selfPickup: false,
      rentalPreset: 'same_day',
      dayIndex: 0,
    },
    handoverComplete: true,
    operatorPhaseIdx: undefined, // resolved in client via findOperatorPhaseIndex
  };
}

export function sandboxPresetUtlevering(): SandboxPreset {
  return {
    config: {
      selfPickup: false,
      rentalPreset: 'same_day',
      dayIndex: 0,
    },
    handoverComplete: false,
    operatorPhaseIdx: undefined,
  };
}

export function sandboxPresetDagligKontroll(): SandboxPreset {
  return {
    config: {
      selfPickup: true,
      rentalPreset: 'multi_day',
      dayIndex: 1,
    },
    handoverComplete: true,
  };
}

export function parseOperatorData(raw: Record<string, unknown>): Record<string, unknown> {
  return parseChecklistData(JSON.stringify(raw));
}

export function formatSandboxSimDay(config: SandboxBookingConfig): string {
  const now = sandboxSimulatedNow(config);
  return toDateStr(now);
}
