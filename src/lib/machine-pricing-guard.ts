import { NextResponse } from 'next/server';
import type { AuditChange } from '@/lib/audit-log';

// Machine fields that move what customers are charged. Changing any of them
// must clear the same second-factor bar as /api/config (global pricing) —
// a stolen admin session without the authenticator must not be able to
// silently re-price the fleet. Fuel/photo/description fields are not money.
export const MACHINE_PRICE_FIELDS = [
  'dayPrice',
  'weekendPrice',
  'weekPrice',
  'dayIncludedHours',
  'weekendIncludedHours',
  'weekIncludedHours',
  'overtimeRate',
  'preOrderHourRate',
] as const;

export type MachinePriceField = (typeof MACHINE_PRICE_FIELDS)[number];

// Same coercion the write path uses, so "unchanged" here means "the row
// would be written back identical".
function toStored(v: unknown): number | null {
  return v != null ? Number(v) : null;
}

/** Price fields present in `body` whose stored value would differ from `current`. */
export function changedPriceFields(
  body: Record<string, unknown>,
  current: Record<MachinePriceField, number | null>,
): AuditChange[] {
  const changes: AuditChange[] = [];
  for (const f of MACHINE_PRICE_FIELDS) {
    if (body[f] === undefined) continue;
    const next = toStored(body[f]);
    if (next !== current[f]) changes.push({ key: f, from: current[f], to: next });
  }
  return changes;
}

/** Price fields set to a non-null value in a create payload. */
export function pricedFields(body: Record<string, unknown>): AuditChange[] {
  return MACHINE_PRICE_FIELDS
    .filter((f) => body[f] != null)
    .map((f) => ({ key: f, from: null, to: toStored(body[f]) }));
}

/** 401 body shaped like /api/config so the admin UI's TOTP modal flow can retry. */
export function totpRejection(reason: 'not-enrolled' | 'missing' | 'invalid') {
  const error = reason === 'not-enrolled'
    ? 'Aktivér 2FA før du endrer utstyrspriser.'
    : reason === 'missing'
      ? '2FA-kode mangler for prisendringer.'
      : 'Ugyldig 2FA-kode.';
  return NextResponse.json(
    { error, requiresTotp: true, requiresTotpEnrollment: reason === 'not-enrolled' },
    { status: 401 },
  );
}
