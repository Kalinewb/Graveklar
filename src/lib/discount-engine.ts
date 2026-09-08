import { randomBytes } from 'crypto';
import { db } from '@/lib/db';
import { loadAppConfig } from '@/lib/app-config';
import { normalizeEmail, normalizePhone } from '@/lib/phone-normalize';

/**
 * Mint a short, unguessable token suffix for code generation. Uses
 * cryptographically strong randomness; 8 base32-style characters yields
 * ~40 bits of entropy (≈10¹² values) — well beyond what an attacker can
 * brute-force against the rate-limited validation endpoint.
 *
 * Previous implementation used `Math.random().toString(36).slice(0,4)` =
 * 36⁴ ≈ 1.7M codes, which was practically enumerable at the configured
 * rate limit.
 */
function mintCodeSuffix(length = 8): string {
  // Avoid visually-confusable characters (0/O, 1/I/L) so the codes are
  // typeable from an emailed string without ambiguity.
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

// Single source of truth for discount eligibility + application.
//
//   computeDiscount(...)  — derives the final discountKr + label from
//                            email + phone + optional code, capped by the
//                            global hard ceiling. Pure logic (no Stripe).
//
//   isFirstTimeEligible(...)  — used by /api/check-discount-eligibility so
//                                the booking form can preview before submit.
//
//   validateRepeatCode(...)   — used by the same endpoint + by the create-
//                                Stripe-session handler.

export interface DiscountResult {
  /** Final amount in kroner (rounded). 0 = no discount applied. */
  discountKr: number;
  /** Human label for the breakdown line, e.g. "Førstegangskunde (-10%)". */
  label: string | null;
  /** Sum of applied percentages (after cap). */
  effectivePercent: number;
  /** Whether the cap kicked in (for UI hint). */
  cappedByCeiling: boolean;
  /** Diagnostic breakdown for audit. */
  applied: { kind: 'first-time' | 'repeat' | 'campaign'; percent: number; codeId?: string }[];
}

export interface DiscountInputs {
  baseTotalKr: number;          // pre-discount total
  email: string;
  phone: string;
  code?: string | null;         // user-typed repeat code
  excludeBookingId?: string;    // skip a specific row when checking history
}

export async function computeDiscount(inputs: DiscountInputs): Promise<DiscountResult> {
  const appCfg = await loadAppConfig();
  const enableFirst = appCfg['enableFirstTimeDiscount'] === 'true';
  const enableRepeat = appCfg['enableRepeatDiscount'] === 'true';
  const firstPct = Math.max(0, Number(appCfg['firstTimeDiscountPercent'] || '0') || 0);
  const repeatPct = Math.max(0, Number(appCfg['repeatDiscountPercent'] || '0') || 0);
  const capPct = Math.max(0, Number(appCfg['discountHardCap'] || '0') || 0);

  const applied: DiscountResult['applied'] = [];

  // First-time eligibility — strictest signal, sums historic bookings by
  // normalized email OR normalized phone with confirmed/completed status.
  if (enableFirst && firstPct > 0 && (await isFirstTimeEligible(inputs.email, inputs.phone, inputs.excludeBookingId))) {
    applied.push({ kind: 'first-time', percent: firstPct });
  }

  // Code redemption — campaign (multi-use) or single-use repeat (RETUR-XXXX).
  // Each kind has its own percent source.
  if (inputs.code) {
    const valid = await validateRepeatCode(inputs.code, inputs.email);
    if (valid.ok) {
      if (valid.kind === 'campaign') {
        applied.push({ kind: 'campaign', percent: valid.percent, codeId: valid.codeId });
      } else if (enableRepeat && repeatPct > 0) {
        applied.push({ kind: 'repeat', percent: repeatPct, codeId: valid.codeId });
      }
    }
  }

  // First-time + repeat are mutually exclusive by definition (you can't be
  // both new and returning). If both somehow apply, prefer first-time since
  // it requires the strictest evidence.
  const hasFirst = applied.some((a) => a.kind === 'first-time');
  const hasRepeat = applied.some((a) => a.kind === 'repeat');
  if (hasFirst && hasRepeat) {
    const firstRow = applied.find((a) => a.kind === 'first-time')!;
    applied.splice(0, applied.length, firstRow);
  }

  const sumPercent = applied.reduce((s, a) => s + a.percent, 0);
  const cappedByCeiling = sumPercent > capPct && capPct > 0;
  const effectivePercent = cappedByCeiling ? capPct : sumPercent;

  const discountKr = Math.round((inputs.baseTotalKr * effectivePercent) / 100);
  const label = applied.length === 0 || discountKr === 0
    ? null
    : `${applied.map(labelForApplied).join(' + ')} (-${effectivePercent}%)`;

  return { discountKr, label, effectivePercent, cappedByCeiling, applied };
}

function labelForApplied(a: DiscountResult['applied'][number]): string {
  switch (a.kind) {
    case 'first-time': return 'Førstegangskunde';
    case 'repeat':     return 'Returkunde-kode';
    case 'campaign':   return 'Rabattkode';
  }
}

export async function isFirstTimeEligible(
  email: string,
  phone: string,
  excludeBookingId?: string
): Promise<boolean> {
  const normEmail = normalizeEmail(email);
  const normPhone = normalizePhone(phone);
  if (!normEmail && !normPhone) return false;

  const historyWhere = {
    ...(excludeBookingId ? { NOT: { id: excludeBookingId } } : {}),
    status: { in: ['confirmed', 'completed'] },
  };

  // Fast path. `createPendingBooking` lowercases the email on write, so an
  // indexed equality on the normalized value settles the common case in one
  // query.
  if (normEmail) {
    const hit = await db.booking.findFirst({ where: { ...historyWhere, email: normEmail }, select: { id: true } });
    if (hit) return false;
  }

  // Full pass. Two columns cannot be matched in SQL: SQLite has no
  // `mode: 'insensitive'`, so a stored email that is NOT already lower-case
  // (a legacy row, an admin-tool write, an import) is invisible to the query
  // above; and `phone` was never stored in canonical form at all, so it has to
  // go through `normalizePhone` before it can be compared. Both are therefore
  // compared in JS.
  //
  // Paged by `id` rather than a flat `take: 1000`: the old unordered window
  // meant that past a thousand confirmed/completed bookings a returning
  // customer whose row fell outside it silently qualified as first-time
  // again — and stayed that way forever. Paging makes the check complete
  // regardless of table size, at a cost that is bounded per page rather than
  // per database.
  const PAGE = 500;
  let cursor: string | undefined;
  for (;;) {
    const rows = await db.booking.findMany({
      where: historyWhere,
      select: { id: true, email: true, phone: true },
      orderBy: { id: 'asc' },
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const r of rows) {
      if (normEmail && normalizeEmail(r.email) === normEmail) return false;
      if (normPhone && normalizePhone(r.phone) === normPhone) return false;
    }
    if (rows.length < PAGE) break;
    cursor = rows[rows.length - 1].id;
  }
  return true;
}

export async function validateRepeatCode(
  code: string,
  email: string
): Promise<
  | { ok: true; kind: 'repeat';   codeId: string; percent?: number }
  | { ok: true; kind: 'campaign'; codeId: string; percent: number }
  | { ok: false; reason: 'invalid' | 'redeemed' | 'expired' | 'mismatched-email' | 'inactive' | 'exhausted' }
> {
  const trimmed = code.trim().toUpperCase();
  if (!trimmed) return { ok: false, reason: 'invalid' };

  // 1. Campaign code (multi-use, not email-bound). Checked first because
  //    a single code value is only ever one type, never overlapping.
  const campaign = await db.campaignDiscountCode.findUnique({ where: { code: trimmed } });
  if (campaign) {
    if (!campaign.isActive) return { ok: false, reason: 'inactive' };
    if (campaign.expiresAt && campaign.expiresAt < new Date()) return { ok: false, reason: 'expired' };
    if (campaign.maxUses !== null && campaign.usedCount >= campaign.maxUses) {
      return { ok: false, reason: 'exhausted' };
    }
    return { ok: true, kind: 'campaign', codeId: campaign.id, percent: campaign.percent };
  }

  // 2. Single-use repeat code (RETUR-XXXX) bound to a specific email.
  const row = await db.repeatDiscountCode.findUnique({ where: { code: trimmed } });
  if (!row) return { ok: false, reason: 'invalid' };
  // Either signal (`redeemedByBookingId` set, OR a stamped `redeemedAt`
  // remaining after a SetNull cascade when the redeeming booking was
  // deleted) means the code has been used. Checking only the FK would
  // re-open the code after a booking delete.
  if (row.redeemedByBookingId || row.redeemedAt) return { ok: false, reason: 'redeemed' };
  if (row.expiresAt && row.expiresAt < new Date()) return { ok: false, reason: 'expired' };
  if (normalizeEmail(row.email) !== normalizeEmail(email)) {
    return { ok: false, reason: 'mismatched-email' };
  }
  return { ok: true, kind: 'repeat', codeId: row.id };
}

/** Generate a fresh single-use code for a customer after they complete a rental. */
export async function issueRepeatCode(opts: {
  email: string;
  bookingId: string;
  expiresInDays?: number;
}): Promise<{ code: string; id: string } | null> {
  const appCfg = await loadAppConfig();
  if (appCfg['enableRepeatDiscount'] !== 'true') return null;
  const normEmail = normalizeEmail(opts.email);
  if (!normEmail) return null;

  // Format: RETUR-XXXXXXXX (8 chars from a no-confusable alphabet, ≈40 bits).
  let code = `RETUR-${mintCodeSuffix(8)}`;
  // Retry on collision (extremely rare).
  for (let i = 0; i < 5; i++) {
    const exists = await db.repeatDiscountCode.findUnique({ where: { code } });
    if (!exists) break;
    code = `RETUR-${mintCodeSuffix(8)}`;
  }
  const created = await db.repeatDiscountCode.create({
    data: {
      code,
      email: normEmail,
      issuedForBookingId: opts.bookingId,
      expiresAt: opts.expiresInDays
        ? new Date(Date.now() + opts.expiresInDays * 24 * 60 * 60 * 1000)
        : null,
    },
  });
  return { code: created.code, id: created.id };
}

/** Mark a code as redeemed when its booking confirms. Idempotent. */
export async function redeemCode(codeId: string, bookingId: string): Promise<void> {
  await db.repeatDiscountCode.updateMany({
    where: { id: codeId, redeemedByBookingId: null },
    data: { redeemedByBookingId: bookingId, redeemedAt: new Date() },
  });
}

/**
 * Spend one use of a campaign code + log the redemption (for usage analytics).
 *
 * The ceiling is enforced by the write, not by the earlier read in
 * `validateRepeatCode` — same compare-and-set shape as `redeemCode` above.
 * An unconditional `increment` let two redemptions that interleaved between
 * that read and this write both succeed, so a `maxUses: 1` code reached
 * `usedCount: 2` with two redemption rows. The conditional `updateMany`
 * matches nothing for the loser, and the redemption row is only written after
 * a successful spend, inside the same transaction.
 *
 * @returns `true` when a use was spent, `false` when the code was already
 *          exhausted or deactivated (the caller decides what that means —
 *          nothing is written either way).
 */
export async function redeemCampaignCode(codeId: string, bookingId: string, email: string): Promise<boolean> {
  // `maxUses` is a column, so the ceiling has to be read before it can be
  // compared against `usedCount`. Only an admin edit moves it; the value that
  // matters for the race — `usedCount` — is never read here, it is compared
  // inside the UPDATE itself.
  const code = await db.campaignDiscountCode.findUnique({
    where: { id: codeId },
    select: { maxUses: true },
  });
  if (!code) return false;

  return db.$transaction(async (tx) => {
    const spent = await tx.campaignDiscountCode.updateMany({
      where: {
        id: codeId,
        isActive: true,
        ...(code.maxUses !== null ? { usedCount: { lt: code.maxUses } } : {}),
      },
      data: { usedCount: { increment: 1 } },
    });
    if (spent.count === 0) return false;

    await tx.campaignRedemption.create({
      data: { codeId, bookingId, email: normalizeEmail(email) },
    });
    return true;
  });
}

