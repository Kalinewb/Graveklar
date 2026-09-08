export interface ChecklistItemLike {
  id: string;
  answerType: string;
  isActive?: boolean;
  conditionItemId?: string | null;
  conditionValue?: string | null;
}

export interface ChecklistPhaseLike {
  id: string;
  name: string;
  sortOrder?: number;
  isActive?: boolean;
  appliesTo?: string;
  isCompletionTrigger?: boolean;
  audience?: string;
  intervalMode?: string;
  intervalHours?: number | null;
  items: ChecklistItemLike[];
}

const COMPLETION_NAME_RE = /retur|hent|return|pickup/i;
const PREP_NAME_RE = /klargjør|forbered|prep/i;

export const CHECKLIST_AUDIENCES = ['operator', 'renter', 'split'] as const;
export type ChecklistAudienceMode = (typeof CHECKLIST_AUDIENCES)[number];

/** Who fills this phase for a given booking. `split` = operator on delivery,
 *  renter (QR) on self-pickup. */
export function resolvePhaseAudience(
  phase: Pick<ChecklistPhaseLike, 'audience'>,
  booking: { selfPickup: boolean },
): 'operator' | 'renter' {
  const aud = phase.audience ?? 'operator';
  if (aud === 'split') return booking.selfPickup ? 'renter' : 'operator';
  if (aud === 'renter') return 'renter';
  return 'operator';
}

export function isValidChecklistAudience(value: unknown): value is ChecklistAudienceMode {
  return typeof value === 'string' && (CHECKLIST_AUDIENCES as readonly string[]).includes(value);
}

function matchesAppliesTo(phase: Pick<ChecklistPhaseLike, 'appliesTo'>, booking: { selfPickup: boolean }): boolean {
  const mode = phase.appliesTo ?? 'all';
  if (mode === 'delivery') return !booking.selfPickup;
  if (mode === 'selfPickup') return booking.selfPickup;
  return true;
}

export function parseChecklistData(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function isMetaKey(key: string): boolean {
  return key.startsWith('__');
}

export function filterPhasesForBooking<T extends ChecklistPhaseLike>(
  phases: T[],
  booking: { selfPickup: boolean },
  options?: { audience?: 'operator' | 'renter' },
): T[] {
  return phases.filter((phase) => {
    if (phase.isActive === false) return false;
    if (!matchesAppliesTo(phase, booking)) return false;
    const resolved = resolvePhaseAudience(phase, booking);
    if (options?.audience && resolved !== options.audience) return false;
    if (!options?.audience && resolved === 'renter') return false;
    return true;
  });
}

// Normalize a photo answer to a URL array. Tolerates the legacy single-string
// shape (older submissions stored one URL) and the new string[] shape.
export function photoUrls(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (typeof value === 'string' && value.length > 0) return [value];
  return [];
}

export function photoMin(item: { minPhotos?: number | null }): number {
  return Math.max(1, item.minPhotos ?? 1);
}

export function isItemFilled(
  item: { answerType: string; minPhotos?: number | null },
  value: unknown,
): boolean {
  if (item.answerType === 'checkbox') return value === true;
  // yesno is answered as soon as it's either true (Ja) or false (Nei).
  if (item.answerType === 'yesno') return value === true || value === false;
  if (item.answerType === 'photo') return photoUrls(value).length >= photoMin(item);
  return value !== undefined && value !== null && value !== '' && value !== false;
}

export function formatChecklistAnswerValue(
  item: { answerType: string; unit?: string | null },
  value: unknown,
): string {
  if (item.answerType === 'checkbox' || item.answerType === 'yesno') {
    if (item.answerType === 'yesno' && value !== true && value !== false) return '—';
    return value === true ? 'Ja' : 'Nei';
  }
  if (value === undefined || value === null || value === '') return '—';
  return String(value);
}

// Does an item's controlling condition currently hold? Items without a
// conditionItemId are always active. `pool` is the set of sibling items
// (same phase) used to look up the controlling item's answer type.
export function isConditionMet(
  item: ChecklistItemLike,
  data: Record<string, unknown>,
  pool: ChecklistItemLike[],
): boolean {
  if (!item.conditionItemId) return true;
  const parent = pool.find((p) => p.id === item.conditionItemId);
  if (!parent) return true; // controlling item gone → don't trap the user
  const parentValue = data[item.conditionItemId];
  const want = (item.conditionValue ?? '').trim().toLowerCase();
  if (parent.answerType === 'checkbox' || parent.answerType === 'yesno') {
    const isYes = parentValue === true;
    const wantYes = want === 'ja' || want === 'true' || want === 'yes' || want === '1';
    return isYes === wantYes;
  }
  return String(parentValue ?? '').trim().toLowerCase() === want;
}

// An item counts toward progress/completion only if it's active AND its
// condition (if any) is met.
export function isItemActive(
  item: ChecklistItemLike,
  data: Record<string, unknown>,
  pool: ChecklistItemLike[],
): boolean {
  if (item.isActive === false) return false;
  return isConditionMet(item, data, pool);
}

export function isOperatorChecklistComplete(data: Record<string, unknown>): boolean {
  return data['__locked'] === true;
}

export function countChecklistProgress(
  phases: ChecklistPhaseLike[],
  data: Record<string, unknown>,
  booking: { selfPickup: boolean },
  options?: { includeFuel?: boolean; fuelDone?: boolean },
): { done: number; total: number } {
  const applicable = filterPhasesForBooking(phases, booking);
  let done = 0;
  let total = 0;

  for (const phase of applicable) {
    const activeItems = phase.items.filter((item) => isItemActive(item, data, phase.items));
    for (const item of activeItems) {
      total++;
      if (isItemFilled(item, data[item.id])) done++;
    }
  }

  if (options?.includeFuel) {
    total++;
    if (options.fuelDone) done++;
  }

  return { done, total };
}

export function findCompletionTriggerPhase<T extends ChecklistPhaseLike>(
  phases: T[],
  booking: { selfPickup: boolean },
): T | null {
  const applicable = filterPhasesForBooking(phases, booking);
  const explicit = applicable.find((phase) => phase.isCompletionTrigger === true);
  if (explicit) return explicit;
  return applicable.find((phase) => COMPLETION_NAME_RE.test(phase.name)) ?? null;
}

export function isCompletionPhaseDone(
  phase: ChecklistPhaseLike,
  data: Record<string, unknown>,
): boolean {
  const activeItems = phase.items.filter((item) => isItemActive(item, data, phase.items));
  if (activeItems.length === 0) return false;
  return activeItems.every((item) => isItemFilled(item, data[item.id]));
}

// Parse a numeric checklist answer, tolerating Norwegian decimal commas
// ("9,2") and stray spaces/units. Returns null when not a finite number.
export function parseNumericAnswer(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/\s+/g, '').replace(',', '.');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export interface StatItemLike {
  id: string;
  label: string;
  answerType: string;
  unit?: string | null;
  statKey?: string | null;
}

export interface ChecklistStat {
  key: string;
  label: string;
  unit: string | null;
  startValue: number;
  endValue: number;
  delta: number;
  startPhase: string;
  endPhase: string;
  points: number; // how many phases contributed a reading
}

// Build "Statistikk" rows by tracking numeric (number/measurement) readings
// across phases. Items are grouped by statKey, or — when unset — by their
// normalized label, so the same meter measured on Levering and Retur pairs
// up automatically. A row is produced only when ≥2 phases supplied a value.
export function computeChecklistStats(
  phases: Array<{ name: string; items: StatItemLike[] }>,
  data: Record<string, unknown>,
): ChecklistStat[] {
  const groups = new Map<string, {
    label: string;
    unit: string | null;
    points: Array<{ phase: string; value: number }>;
  }>();

  for (const phase of phases) {
    for (const item of phase.items) {
      if (item.answerType !== 'number' && item.answerType !== 'measurement') continue;
      const value = parseNumericAnswer(data[item.id]);
      if (value === null) continue;
      const key = (item.statKey?.trim() || item.label.trim().toLowerCase());
      if (!key) continue;
      const group = groups.get(key) ?? { label: item.label, unit: item.unit ?? null, points: [] };
      group.points.push({ phase: phase.name, value });
      groups.set(key, group);
    }
  }

  const stats: ChecklistStat[] = [];
  for (const [key, group] of groups) {
    if (group.points.length < 2) continue;
    const first = group.points[0];
    const last = group.points[group.points.length - 1];
    stats.push({
      key,
      label: group.label,
      unit: group.unit,
      startValue: first.value,
      endValue: last.value,
      delta: last.value - first.value,
      startPhase: first.phase,
      endPhase: last.phase,
      points: group.points.length,
    });
  }
  return stats;
}

// Norwegian number formatting (comma decimals) for stat display.
export function formatStatNumber(n: number): string {
  return n.toLocaleString('nb-NO', { maximumFractionDigits: 2 });
}

export function findPrepPhaseIndex(phases: ChecklistPhaseLike[]): number {
  const active = phases.filter((phase) => phase.isActive !== false);
  const idx = active.findIndex((phase) => PREP_NAME_RE.test(phase.name));
  return idx === -1 ? 0 : idx;
}
