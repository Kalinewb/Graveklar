// ─────────────────────────────────────────────────────────────────────────
// Pricing authority:
// All booking totals, discounts, VAT/MVA, and reconciliation logic must
// flow through `lib/domain/quote.ts:buildQuote`. Do not derive monetary
// values in route handlers, UI components, exports, or admin tools. The
// helpers in this file (computeBookingPrices, validateBookingInput) exist
// to back buildQuote — they are not a second pricing engine.
// ─────────────────────────────────────────────────────────────────────────

import { db, withSqliteRetry } from '@/lib/db';
import { readMvaSettings, chargedTotalKr } from '@/lib/mva';
import {
  findCompletionTriggerPhase,
  isCompletionPhaseDone,
  parseChecklistData,
} from '@/lib/checklist';
import {
  buildPricingFromConfig,
  calculateCustomPrice,
  calculateDeliveryFee,
  deliveryFeeTolerance,
  getConfigValue,
  type ConfigValues,
  type RentalType,
} from '@/lib/pricing';
import { loadConfigValues } from '@/lib/config-server';
import {
  dateToDbMidnight,
  dbDateToStr,
  getRentalDateRange,
  rentalDayCount,
} from '@/lib/availability';
import { loadAppConfig } from '@/lib/app-config';
import { evaluateCancellationPolicy } from '@/lib/cancellation';
import { todayStr, toDateStr } from '@/lib/dates';
import { isStripeEnabled, refundBookingPayment } from '@/lib/stripe';
import { isVippsEnabled } from '@/lib/vipps-config';
import { freezeContractForBooking } from '@/lib/freeze-contract';
import {
  computeDiscount,
  redeemCampaignCode,
  issueRepeatCode,
} from '@/lib/discount-engine';
import {
  sendBookingStatusEmail,
  sendNewBookingAdminNotification,
  sendRepeatDiscountEmail,
  sendBookingExpiredEmail,
} from '@/lib/email';
import { writeAuditLog } from '@/lib/audit-log';
import type { Booking } from '@prisma/client';

export class BookingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookingValidationError';
  }
}

export class BookingClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookingClientError';
  }
}

export interface CreateBookingInput {
  name: string;
  phone: string;
  email: string;
  deliveryAddress: string;
  rentalType: RentalType;
  startDate: string;
  customDays?: number;
  preferredTime?: string;
  deliveryDistance: number;
  deliveryFee: number;
  extraHours?: number;
  notes?: string;
  termsAccepted: boolean;
  machineId?: string;
  selfPickup?: boolean;
  /** Optional repeat-discount code the customer entered ("RETUR-XXXX"). */
  discountCode?: string;
  /** What the customer saw as the total in the booking confirmation
   *  modal. Used for drift detection: if the freshly-computed total
   *  differs by more than 1 kr (config changed mid-flow, code became
   *  invalid, etc.) we reject with PriceDriftError so the UI can prompt
   *  the customer with the fresh numbers. Required at the API boundary —
   *  callers without an agreed total cannot create a booking. */
  expectedTotalKr: number;
}

/** Thrown by createPendingBooking when the customer's expectedTotalKr
 *  disagrees with the freshly-computed total. The handler surfaces a
 *  409 + the fresh quote so the UI can show "price changed — confirm?". */
export class PriceDriftError extends Error {
  constructor(public expected: number, public actual: number) {
    super(`Pris endret seg: forventet ${expected} kr, beregnet ${actual} kr.`);
    this.name = 'PriceDriftError';
  }
}

export interface ComputedBookingPrices {
  basePrice: number;
  deliveryFee: number;
  totalPrice: number;
  extraHours: number;
  extraHoursCost: number;
  includedHours: number;
  totalHours: number;
}

export interface EquipmentPricing {
  dayPrice?: number | null;
  weekendPrice?: number | null;
  weekPrice?: number | null;
  dayIncludedHours?: number | null;
  weekendIncludedHours?: number | null;
  weekIncludedHours?: number | null;
  overtimeRate?: number | null;
  preOrderHourRate?: number | null;
}

function mergeEquipmentConfig(config: ConfigValues, eq?: EquipmentPricing | null): ConfigValues {
  if (!eq) return config;
  const merged = { ...config };
  if (eq.dayPrice != null) merged['dayPrice'] = eq.dayPrice;
  if (eq.weekendPrice != null) merged['weekendPrice'] = eq.weekendPrice;
  if (eq.weekPrice != null) merged['weekPrice'] = eq.weekPrice;
  if (eq.dayIncludedHours != null) merged['dayIncludedHours'] = eq.dayIncludedHours;
  if (eq.weekendIncludedHours != null) merged['weekendIncludedHours'] = eq.weekendIncludedHours;
  if (eq.weekIncludedHours != null) merged['weekIncludedHours'] = eq.weekIncludedHours;
  if (eq.overtimeRate != null) merged['overtimeRate'] = eq.overtimeRate;
  if (eq.preOrderHourRate != null) merged['preOrderHourRate'] = eq.preOrderHourRate;
  return merged;
}

export function computeBookingPrices(
  input: Pick<
    CreateBookingInput,
    'rentalType' | 'startDate' | 'customDays' | 'deliveryFee' | 'extraHours'
  >,
  config: ConfigValues,
  equipmentPricing?: EquipmentPricing | null
): ComputedBookingPrices {
  const cfg = mergeEquipmentConfig(config, equipmentPricing);
  const rentalType = input.rentalType;
  const extraHours = Math.max(0, input.extraHours ?? 0);
  const preOrderHourRate = getConfigValue(cfg, 'preOrderHourRate');
  const extraHoursCost = extraHours * preOrderHourRate;

  let basePrice: number;
  let includedHours: number;

  if (rentalType === 'custom') {
    const days = rentalDayCount('custom', input.customDays);
    const breakdown = calculateCustomPrice(input.startDate, days, cfg);
    basePrice = breakdown.totalPrice;
    includedHours = breakdown.totalHours;
  } else {
    const pricing = buildPricingFromConfig(cfg);
    const tier = pricing[rentalType];
    if (!tier) {
      basePrice = 0;
      includedHours = 0;
    } else {
      // Multi-week rentals: customer picks 1..8 weeks; backend scales the
      // weekly tier price + included hours by week count. rentalDayCount
      // already enforces the multiple-of-7 invariant.
      const weeks =
        rentalType === 'week' && input.customDays && input.customDays % 7 === 0
          ? Math.max(1, input.customDays / 7)
          : 1;
      basePrice = tier.basePrice * weeks;
      includedHours = tier.includedHours * weeks;
    }
  }

  // A non-numeric fee (`Number("gratis")` from the request body) used to reach
  // this line as NaN and poison every money field downstream — subtotal,
  // totalPrice, the MVA split — all the way to a 200 response whose amounts
  // serialise as `null`. Money is never NaN: an unusable value is 0 and the
  // drift check refuses the booking if that is not what the customer agreed.
  const deliveryFee = Number.isFinite(input.deliveryFee) ? Math.round(input.deliveryFee) : 0;
  const totalHours = includedHours + extraHours;
  const totalPrice = basePrice + extraHoursCost + deliveryFee;

  return {
    basePrice,
    deliveryFee,
    totalPrice,
    extraHours,
    extraHoursCost,
    includedHours,
    totalHours,
  };
}

// Crockford-ish base32 alphabet, ambiguous glyphs (0/O/1/I/L) removed so a
// reference is safe to read aloud over the phone.
const REF_SUFFIX_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// 5 random chars from a 30-char alphabet ≈ 24 bits of entropy. The sequential
// GK-YYMM-NNN prefix stays for human readability (the admin reads it as "Nth
// booking of the month"), but the random tail means the full reference can't
// be guessed from the sequence — that's what gates the ref+email cancellation
// lookup against enumeration.
function randomRefSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  let out = '';
  for (const b of bytes) out += REF_SUFFIX_ALPHABET[b % REF_SUFFIX_ALPHABET.length];
  return out;
}

export async function generateBookingReference(): Promise<string> {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `GK-${yy}${mm}-`;

  // Half-open window [monthStart, nextMonthStart). The previous upper bound
  // was `new Date(y, m + 1, 0, 23, 59, 59)` — 23:59:59.000, not .999 — so a
  // booking created in the last 999 ms of a month fell outside `lte` and was
  // not counted, and the next booking of that month reused its sequence
  // number. A `lt` on the next month's first instant has no such edge.
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const count = await db.booking.count({
    where: { createdAt: { gte: monthStart, lt: nextMonthStart } },
  });

  for (let offset = 0; offset < 20; offset++) {
    const candidate = `${prefix}${String(count + 1 + offset).padStart(3, '0')}-${randomRefSuffix()}`;
    const exists = await db.booking.findUnique({ where: { reference: candidate } });
    if (!exists) return candidate;
  }

  return `${prefix}${Date.now().toString(36).toUpperCase().slice(-4)}-${randomRefSuffix()}`;
}

export async function getUnavailableDateStringsForRange(
  range: string[],
  excludeBookingId?: string,
  machineId?: string
): Promise<string[]> {
  const unavailable = new Set<string>();

  const minDate = dateToDbMidnight(range[0]);
  const maxDate = dateToDbMidnight(range[range.length - 1]);
  maxDate.setHours(23, 59, 59, 999);

  const adminBlocks = await db.unavailableDate.findMany({
    where: { date: { gte: minDate, lte: maxDate } },
  });
  for (const b of adminBlocks) {
    unavailable.add(dbDateToStr(b.date));
  }

  // Confirmed bookings AND still-live pending ones (unpaid but inside their
  // payment window). Pending bookings already hold their own rental days via
  // BookingDateLock; including them here is what makes their turnaround
  // buffer days count too — otherwise two customers could book back-to-back
  // while the first is still paying, and both confirm with no cleanup day
  // between them. Expired-but-not-yet-swept pending rows are ignored.
  //
  // Boundary: `runCleanup` owns the deadline instant. It cancels at
  // `paymentDeadline < now`, so a booking whose deadline is exactly now is
  // still alive — and still holds its `BookingDateLock` rows. Reading it as
  // expired here (`> now`) meant that at the boundary this check called the
  // day free while the lock table still held the slot, so the customer was
  // offered a green day and refused at submit with "opptatt". `>= now` puts
  // all three readers — the sweep, the calendar and this check — on the same
  // side of the instant.
  const now = new Date();
  const holders = (await db.booking.findMany({
    where: {
      status: { in: ['confirmed', 'pending'] },
      ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
      ...(machineId ? { machineId } : {}),
    },
  })).filter((b) => b.status === 'confirmed' || !b.paymentDeadline || b.paymentDeadline >= now);

  let equipmentQuantity = 1;
  if (machineId) {
    const machine = await db.machine.findUnique({ where: { id: machineId } });
    if (machine) equipmentQuantity = machine.quantity;
  }

  // Turnaround buffer toggles (admin → Innstillinger → Booking), default on.
  // Must match the customer-facing /api/availability computation so the
  // server-side conflict check and the calendar agree.
  const turnCfg = await loadAppConfig();
  const blockBefore = turnCfg['blockDayBeforeBooking'] !== 'false';
  const blockAfter = turnCfg['blockDayAfterBooking'] !== 'false';

  const dateBookingCount = new Map<string, number>();
  // Each booking reserves its rental days PLUS (optionally) one prep day
  // before and one cleanup day after — so a candidate range that lands on an
  // enabled turnaround day counts as a conflict, matching what customers see
  // in the calendar.
  const shiftDay = (dateStr: string, offset: number) => {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + offset);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${da}`;
  };
  for (const booking of holders) {
    const start = dbDateToStr(booking.startDate);
    const span = getRentalDateRange(start, booking.rentalType as RentalType, booking.customDays);
    const reserved = [
      ...(blockBefore ? [shiftDay(span[0], -1)] : []),
      ...span,
      ...(blockAfter ? [shiftDay(span[span.length - 1], 1)] : []),
    ];
    for (const d of reserved) {
      if (range.includes(d)) {
        dateBookingCount.set(d, (dateBookingCount.get(d) || 0) + 1);
      }
    }
  }

  for (const [date, count] of dateBookingCount) {
    if (count >= equipmentQuantity) {
      unavailable.add(date);
    }
  }

  return Array.from(unavailable);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_RENTAL_TYPES = new Set(['day', 'weekend', 'week', 'custom']);

/**
 * Upper bound on a `week` rental, in weeks — the same 1…8 the booking form's
 * week stepper offers (HomePage.tsx). `custom` was bounded to 2…90 days from
 * the start but `week` took any positive multiple of 7, so a 700-day rental
 * priced as 100 weekly tiers, reported itself bookable, and would have minted
 * 700 `BookingDateLock` rows. `bookingMaxAdvanceDays` only ever looked at the
 * START date, so nothing else caught it.
 */
export const MAX_WEEK_RENTAL_WEEKS = 8;

/**
 * Whole calendar days from today to `dateStr`, both ends taken at Oslo local
 * midnight.
 *
 * Not the same as `(start − now) / 86_400_000`: the two Oslo days that are 23
 * and 25 hours long make that quotient drift by an hour either way, so a start
 * date exactly `bookingMaxAdvanceDays` *calendar* days out measured 30.0417
 * across the autumn transition and was refused. Rounding the quotient of two
 * local midnights absorbs the ±1 h and leaves a whole number of calendar days.
 */
export function calendarDaysUntil(dateStr: string, from: Date = new Date()): number {
  const start = new Date(dateStr + 'T00:00:00');
  const today = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  return Math.round((start.getTime() - today.getTime()) / 86_400_000);
}

/**
 * The rental-length ceiling for a rental type, or null when the length is
 * fine. Shared with `checkBookable` (via the quote layer) so the preview and
 * the submit refuse the same spans with the same Norwegian wording.
 */
export function checkRentalLength(
  rentalType: RentalType,
  customDays: number | null | undefined,
): string | null {
  if (rentalType === 'custom') {
    const days = customDays ?? 0;
    if (days < 2 || days > 90) return 'Tilpasset leieperiode må være mellom 2 og 90 dager.';
  }
  if (rentalType === 'week' && customDays != null && customDays > MAX_WEEK_RENTAL_WEEKS * 7) {
    return `Ukeleie kan ikke være lengre enn ${MAX_WEEK_RENTAL_WEEKS} uker.`;
  }
  return null;
}

/** Facts `validateBookingInput` cannot look up itself — it is synchronous and
 *  has no database. The caller has already resolved them to price the booking,
 *  so it hands them over rather than making the validator async. */
export interface BookingValidationContext {
  /** Whether `input.machineId` resolved to an ACTIVE machine. Omitted means
   *  "not checked" — every production caller resolves the machine first. */
  machineResolved?: boolean;
}

export function validateBookingInput(
  input: CreateBookingInput,
  config: ConfigValues,
  computed: ComputedBookingPrices,
  appConfig?: Record<string, string>,
  context?: BookingValidationContext
): string | null {
  if (!input.termsAccepted) {
    return 'Du må godta vilkårene.';
  }

  const name = input.name?.trim() ?? '';
  const phone = input.phone?.trim() ?? '';
  const email = input.email?.trim() ?? '';

  if (!name || !phone || !email) {
    return 'Navn, telefon og e-post er påkrevd.';
  }
  if (name.length > 200) return 'Navn er for langt.';
  if (phone.length < 8 || phone.length > 30) return 'Ugyldig telefonnummer.';
  if (!EMAIL_RE.test(email) || email.length > 254) return 'Ugyldig e-postadresse.';

  if (!input.selfPickup) {
    if (!input.deliveryAddress?.trim()) return 'Leveringsadresse er påkrevd.';
    if (input.deliveryAddress.trim().length > 500) return 'Adresse er for lang.';
  }

  if (input.notes && input.notes.length > 2000) return 'Notater er for lange (maks 2000 tegn).';

  if (!VALID_RENTAL_TYPES.has(input.rentalType)) {
    return 'Ugyldig leietype.';
  }
  // `VALID_RENTAL_TYPES` is the static vocabulary; `enabledRentalTypes` is
  // what the business currently sells. Only the route used to check the
  // second one, so `createPendingBooking` was not self-sufficient: a seed
  // script, an admin tool or a future endpoint could create a booking for a
  // tier the admin had switched off. Enforced only when the caller passes
  // `appConfig` — without it there is no configuration to read.
  if (appConfig) {
    const enabledTypes = (appConfig['enabledRentalTypes'] || 'day,weekend,week')
      .split(',').map((t) => t.trim()).filter(Boolean);
    if (!enabledTypes.includes(input.rentalType)) {
      return 'Denne leietypen er ikke tilgjengelig for booking.';
    }
  }
  // Same shape for the machine: the quote layer refuses an unresolvable
  // machineId, so the validator has to as well or the two gates disagree.
  if (input.machineId && context?.machineResolved === false) {
    return 'Valgt utstyr er ikke tilgjengelig.';
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)) {
    return 'Ugyldig startdato.';
  }
  if (input.startDate < todayStr()) {
    return 'Startdato kan ikke være i fortiden.';
  }
  // Moved from PricingConfig → AppConfig group='booking' (Step-2 cleanup).
  // Old PricingConfig key kept as fallback for one release in case any
  // caller hasn't passed appConfig yet — remove in the follow-up.
  const minDaysAhead = Math.round(
    Number(appConfig?.['minBookingDaysAhead'] ?? '0')
      || getConfigValue(config, 'minBookingDaysAhead')
      || 0
  );
  if (minDaysAhead > 0) {
    // Use local date (toDateStr) — toISOString() shifts to UTC and produces
    // off-by-one errors when CET evening crosses midnight UTC.
    const earliest = new Date();
    earliest.setDate(earliest.getDate() + minDaysAhead);
    const earliestStr = toDateStr(earliest);
    if (input.startDate < earliestStr) {
      return `Booking må gjøres minst ${minDaysAhead} dager i forveien.`;
    }
  }
  // The far end of the same window. `createPendingBooking` checked this in the
  // caller, not in the validator, so the function that names itself the
  // validator passed a date 400 days out. Same AppConfig gate as above: only
  // enforced when the caller supplies the configuration.
  if (appConfig) {
    const maxAdvanceDays = Number(appConfig['bookingMaxAdvanceDays'] || '365');
    if (calendarDaysUntil(input.startDate) > maxAdvanceDays) {
      return `Du kan ikke booke mer enn ${maxAdvanceDays} dager i forveien.`;
    }
  }
  {
    const startDow = new Date(input.startDate + 'T12:00:00').getDay();
    const jsDow = startDow === 0 ? 7 : startDow;
    if (input.rentalType === 'day') {
      const allowed = new Set((appConfig?.['dayAllowedDays'] || '1,2,3,4').split(',').map(s => Number(s.trim())));
      if (!allowed.has(jsDow)) return 'Denne datoen er ikke tilgjengelig for dagsleie.';
    }
    if (input.rentalType === 'weekend') {
      const startDay = Number(appConfig?.['weekendStartDay'] || '5');
      if (jsDow !== startDay) return 'Helgleie må starte på riktig dag.';
    }
    if (input.rentalType === 'week') {
      const startDay = Number(appConfig?.['weekStartDay'] || '1');
      if (jsDow !== startDay) return 'Ukeleie må starte på riktig dag.';
    }
  }
  const lengthError = checkRentalLength(input.rentalType, input.customDays);
  if (lengthError) return lengthError;

  if (input.selfPickup) {
    if (computed.deliveryFee > 0) {
      return 'Selvhenting skal ikke ha leveringsgebyr.';
    }
  } else {
    const maxRadius = getConfigValue(config, 'maxDeliveryRadius');
    if (input.deliveryDistance > maxRadius) {
      return 'Adressen er utenfor leveringsområdet.';
    }
    // Shared with /api/delivery and the quote layer — see `calculateDeliveryFee`.
    const expectedFee = calculateDeliveryFee(config, input.deliveryDistance);
    if (Math.abs(computed.deliveryFee - expectedFee) > deliveryFeeTolerance(config)) {
      return 'Leveringspris stemmer ikke. Oppdater adressen og prøv igjen.';
    }
  }

  return null;
}

export async function createPendingBooking(input: CreateBookingInput) {
  const [config, appConfig] = await Promise.all([loadConfigValues(), loadAppConfig()]);

  if (appConfig['maintenanceMode'] === 'true') {
    throw new BookingValidationError('Booking er midlertidig deaktivert. Prøv igjen senere.');
  }

  // A booking is only creatable if at least one payment provider can actually
  // take money. Vipps is the primary method; Stripe covers card.
  const [stripeReady, vippsReady] = await Promise.all([isStripeEnabled(), isVippsEnabled()]);
  if (!stripeReady && !vippsReady) {
    throw new BookingValidationError('Betaling er ikke konfigurert. Booking er utilgjengelig.');
  }

  // Note: minimum lead-time is enforced by `minBookingDaysAhead` in
  // PricingConfig (see line ~250 above); the duplicate `bookingMinNoticeHours`
  // AppConfig key was removed.

  // The booking horizon, the enabled rental tiers and the machine lookup are
  // all enforced inside `validateBookingInput` now, so this function has one
  // gate instead of a pre-check here and a validator below that disagreed
  // about what it covered.
  let resolvedMachine: { id: string; quantity: number; dayPrice: number | null; weekendPrice: number | null; weekPrice: number | null; dayIncludedHours: number | null; weekendIncludedHours: number | null; weekIncludedHours: number | null; overtimeRate: number | null; preOrderHourRate: number | null } | null = null;
  let machineResolved = true;
  if (input.machineId) {
    const machine = await db.machine.findFirst({
      where: { id: input.machineId, isActive: true },
    });
    machineResolved = machine !== null;
    resolvedMachine = machine;
  } else {
    const firstMachine = await db.machine.findFirst({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    resolvedMachine = firstMachine ?? null;
  }

  const equipmentPricing: EquipmentPricing | null = resolvedMachine ? {
    dayPrice: resolvedMachine.dayPrice,
    weekendPrice: resolvedMachine.weekendPrice,
    weekPrice: resolvedMachine.weekPrice,
    dayIncludedHours: resolvedMachine.dayIncludedHours,
    weekendIncludedHours: resolvedMachine.weekendIncludedHours,
    weekIncludedHours: resolvedMachine.weekIncludedHours,
    overtimeRate: resolvedMachine.overtimeRate,
    preOrderHourRate: resolvedMachine.preOrderHourRate,
  } : null;

  const computed = computeBookingPrices(input, config, equipmentPricing);
  const validationError = validateBookingInput(input, config, computed, appConfig, { machineResolved });
  if (validationError) {
    throw new BookingValidationError(validationError);
  }

  // Discount eligibility — backend authority for the Stripe amount. The
  // booking form previews the same calc via /api/check-discount-eligibility
  // but the value that lands on the booking comes from here.
  const discount = await computeDiscount({
    baseTotalKr: computed.totalPrice,
    email: input.email,
    phone: input.phone,
    code: input.discountCode || null,
  });

  // Drift check: did the customer see the same total we're about to
  // commit to Stripe? Tolerance ±1 kr (rounding noise). Reject with
  // PriceDriftError if so — the API layer translates to 409 + fresh quote.
  // MVA is applied via the same shared helper buildQuote uses, so when prices
  // are stored ex-MVA the charged total includes VAT and still matches the
  // quote the customer was shown.
  const net = Math.max(0, computed.totalPrice - discount.discountKr);
  const finalTotal = chargedTotalKr(net, readMvaSettings(config));
  if (Math.abs(finalTotal - input.expectedTotalKr) > 1) {
    throw new PriceDriftError(input.expectedTotalKr, finalTotal);
  }

  const range = getRentalDateRange(
    input.startDate,
    input.rentalType,
    input.customDays
  );
  const resolvedMachineId = resolvedMachine?.id ?? null;
  const equipmentQuantity = resolvedMachine?.quantity ?? 1;

  if (!resolvedMachineId) {
    throw new BookingValidationError('Ingen utstyr valgt.');
  }

  const conflicts = await getUnavailableDateStringsForRange(range, undefined, resolvedMachineId);
  if (conflicts.length > 0) {
    throw new BookingValidationError(
      'En eller flere dager i perioden er opptatt. Velg en annen dato.'
    );
  }

  const reference = await generateBookingReference();

  try {
    const booking = await withSqliteRetry(
      () => db.$transaction(async (tx) => {
        const created = await tx.booking.create({
        data: {
          reference,
          name: input.name.trim(),
          phone: input.phone.trim(),
          email: input.email.trim().toLowerCase(),
          deliveryAddress: input.deliveryAddress.trim(),
          rentalType: input.rentalType,
          startDate: dateToDbMidnight(input.startDate),
          customDays:
            input.rentalType === 'custom'
              ? rentalDayCount('custom', input.customDays)
              : input.rentalType === 'week' && input.customDays && input.customDays % 7 === 0 && input.customDays > 7
                ? input.customDays
                : null,
          preferredTime: input.preferredTime?.trim() || null,
          deliveryDistance: input.deliveryDistance,
          deliveryFee: computed.deliveryFee,
          basePrice: computed.basePrice,
          totalPrice: finalTotal,
          discountKr: discount.discountKr > 0 ? discount.discountKr : null,
          discountLabel: discount.label,
          extraHours: computed.extraHours,
          extraHoursCost: computed.extraHoursCost,
          includedHours: computed.includedHours,
          totalHours: computed.totalHours,
          notes: input.notes?.trim() || null,
          selfPickup: input.selfPickup ?? false,
          status: 'pending',
          termsAcceptedAt: new Date(),
          machineId: resolvedMachineId,
          // Match the default Stripe Checkout session lifetime (60 min). The
          // cron/in-process cleanup uses this to decide when a booking that
          // never got paid can be cancelled — keeping the two clocks aligned
          // prevents the race where the booking auto-cancels while the
          // customer is still in Stripe Checkout and would pay successfully.
          paymentDeadline: new Date(Date.now() + 60 * 60 * 1000),
        },
      });

      const existingLocks = await tx.bookingDateLock.findMany({
        where: { machineId: resolvedMachineId, date: { in: range.map(dateToDbMidnight) } },
        select: { date: true, slot: true },
      });

      const slotsTaken = new Map<string, Set<number>>();
      for (const lock of existingLocks) {
        const key = dbDateToStr(lock.date);
        if (!slotsTaken.has(key)) slotsTaken.set(key, new Set());
        slotsTaken.get(key)!.add(lock.slot);
      }

      const lockData: { bookingId: string; machineId: string; date: Date; slot: number }[] = [];
      for (const dateStr of range) {
        const taken = slotsTaken.get(dateStr) ?? new Set();
        let slot = -1;
        for (let i = 0; i < equipmentQuantity; i++) {
          if (!taken.has(i)) { slot = i; break; }
        }
        if (slot === -1) {
          throw new BookingValidationError('En eller flere dager i perioden er opptatt. Velg en annen dato.');
        }
        lockData.push({
          bookingId: created.id,
          machineId: resolvedMachineId,
          date: dateToDbMidnight(dateStr),
          slot,
        });
      }

      await tx.bookingDateLock.createMany({ data: lockData });

      // Claim the single-use repeat code inside the same transaction. Doing
      // this here instead of at confirmation closes the race where two
      // pending bookings each pass validation (which only reads), then both
      // get the discount applied. The atomic `updateMany` with
      // `redeemedByBookingId: null` means at most one transaction wins; the
      // loser throws and the whole booking rolls back.
      const repeatApplied = discount.applied.find((a) => a.kind === 'repeat');
      if (repeatApplied?.codeId) {
        const claim = await tx.repeatDiscountCode.updateMany({
          where: { id: repeatApplied.codeId, redeemedByBookingId: null },
          data: { redeemedByBookingId: created.id, redeemedAt: new Date() },
        });
        if (claim.count === 0) {
          throw new BookingValidationError('Rabattkoden er allerede brukt.');
        }
      }

      return created;
      }, {
        // SQLite is single-writer; under concurrent booking attempts the
        // interactive-transaction default (5 s) can expire while waiting for
        // the write lock, surfacing as a "Socket timeout"/"Transaction
        // already closed" error instead of a clean result. Wider windows let
        // contending transactions serialise and finish (the loser then sees
        // the slot is taken). maxWait = time to acquire a connection;
        // timeout = max transaction duration.
        maxWait: 8000,
        timeout: 15000,
      }),
      { label: 'createPendingBooking transaction' }
    );

    // Mark campaign-code redemption after the booking is committed. Done
    // outside the booking transaction so a slow analytics write can't
    // roll back the booking. Single-use repeat codes are redeemed by the
    // Stripe webhook after payment confirms.
    const campaignApplied = discount.applied.find((a) => a.kind === 'campaign');
    if (campaignApplied?.codeId) {
      const spent = await redeemCampaignCode(campaignApplied.codeId, booking.id, input.email)
        .catch((err) => {
          console.error('Campaign code redemption failed:', err);
          return false;
        });
      // `false` means the code hit its ceiling (or was deactivated) between
      // the price calculation and this write — the conditional spend refused
      // it, so nothing was counted against the code. The booking itself has
      // already committed; log the discrepancy so it is visible rather than
      // silently over-spending the campaign.
      if (!spent) {
        console.warn(
          `Campaign code ${campaignApplied.codeId} could not be spent for booking ${booking.reference} (exhausted or inactive).`
        );
      }
    }

    return { booking, computed };
  } catch (err) {
    if (err instanceof BookingValidationError) throw err;
    const msg = (err as { message?: string }).message ?? '';
    if (msg.includes('Unique constraint') || msg.includes('UNIQUE constraint')) {
      throw new BookingValidationError('En eller flere dager i perioden er opptatt. Velg en annen dato.');
    }
    // High-contention failures (SQLite write-lock waits that blew the
    // transaction timeout). The booking did NOT commit — surface a clean,
    // retryable message instead of a raw "Socket timeout" 500.
    if (
      msg.includes('Transaction already closed') ||
      msg.includes('Socket timeout') ||
      msg.includes('database is locked') ||
      msg.includes('SQLITE_BUSY')
    ) {
      throw new BookingValidationError('Systemet er opptatt akkurat nå. Vent et øyeblikk og prøv igjen.');
    }
    throw err;
  }
}

export type BookingStatus =
  | 'pending'
  | 'confirmed'
  | 'cancelled'
  | 'completed';

// ─────────────────────────────────────────────────────────────────────────
// Lifecycle authority:
// Automatic completion is driven by ChecklistPhase.isCompletionTrigger.
// Do not introduce phase-name matching or sort-order heuristics for new
// lifecycle automations. The legacy regex fallback in this function
// exists ONLY to bridge pre-migration phases — new transitions must add
// their own explicit boolean column on ChecklistPhase or the equivalent.
// ─────────────────────────────────────────────────────────────────────────
// Auto-complete a booking when its completion-trigger checklist phase has
// every active item marked done. Idempotent — if the booking is already
// completed/cancelled, this is a no-op. Called from the admin checklist
// PATCH path only; the customer kiosk POST is filtered to customer-phase
// items and cannot reach this code.
export async function maybeAutoCompleteOnReturDone(bookingId: string): Promise<boolean> {
  const booking = await db.booking.findUnique({ where: { id: bookingId } });
  if (!booking) return false;
  if (booking.status === 'completed' || booking.status === 'cancelled') return false;

  const phases = await db.checklistPhase.findMany({
    where: { isActive: true },
    include: { items: { where: { isActive: true } } },
  });

  const returPhase = findCompletionTriggerPhase(phases, booking);
  if (!returPhase || returPhase.items.length === 0) return false;

  const data = parseChecklistData(booking.checklistData);
  if (!isCompletionPhaseDone(returPhase, data)) return false;

  // Trigger the normal complete transition — issues repeat code, sends
  // the completion email, releases date locks where applicable.
  await updateBookingStatus(bookingId, 'completed');
  return true;
}

export interface UpdateBookingStatusOptions {
  fullyPaid?: boolean;
  adminNote?: string;
  /** Set when the Stripe webhook or callback confirms a payment. */
  stripePaymentIntentId?: string | null;
  /** Customer IP captured at Stripe acceptance time; flows into the
   *  frozen AcceptedContract row. */
  acceptedFromIp?: string | null;
  /** Suppress the customer/admin confirmation emails for callers that
   *  prefer to send their own (default: emails fire on confirmed). */
  skipEmails?: boolean;
  /** PaymentMethod.type from the Stripe PaymentIntent ('card' | 'vipps' | …).
   *  Captured at confirmation time so admin + CSV + email can show how
   *  the customer paid. Null when unknown (admin-mark-paid path, or pre-
   *  instrumentation bookings). */
  paymentMethod?: string | null;
  /** Which gateway took the money ('stripe' | 'vipps'). Only the Vipps flow
   *  used to set this, so every card booking was stored with a null provider
   *  and any report grouped by provider counted Stripe revenue as unknown. */
  paymentProvider?: string | null;
  /** Who caused this transition, for the audit log. Defaults to 'system',
   *  which is what a Stripe/Vipps callback, the expiry cron or the customer's
   *  own cancel link actually is. Only routes behind the admin session should
   *  pass 'admin' — otherwise the append-only log claims an operator did
   *  things no operator touched. */
  actor?: string;
}

/** Result of updateBookingStatus: the (possibly updated) booking plus
 *  whether THIS call performed the status transition. Callers that attach
 *  one-shot side effects to a transition (goodwill codes, customer emails)
 *  must gate on `transitioned` — a duplicate or retried request returns the
 *  same row with `transitioned: false`. */
export type BookingStatusResult = Booking & {
  transitioned: boolean;
  previousStatus: string;
};

/**
 * The booking lifecycle, as a table. Anything not listed here is refused.
 *
 * Without it `updateBookingStatus` performed *any* status → status write: a
 * cancelled booking could be walked back to `confirmed` — re-freezing the
 * contract and re-mailing the customer — with its date locks already deleted,
 * and a finished rental could be "cancelled" into a 100 % refund with no
 * cancellation fee (the fee branch only fires from `confirmed`). `cancelled`
 * and `completed` are therefore terminal.
 *
 * Same-status calls are not transitions and are not covered here: they stay
 * the idempotent no-op (or plain field update — an admin editing the note on
 * a cancelled booking, a replayed webhook) they have always been.
 */
const LEGAL_TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['cancelled', 'completed'],
  cancelled: [],
  completed: [],
};

/** Status names as the admin reads them, for the refusal message. */
const STATUS_LABELS: Record<string, string> = {
  pending: 'venter',
  confirmed: 'bekreftet',
  cancelled: 'avbestilt',
  completed: 'fullført',
};

/**
 * `cancelled` and `completed` are terminal, and a terminal booking occupies no
 * dates: the calendar and `checkBookable` only count `confirmed` and `pending`
 * rows. Only `cancelled` used to release its `BookingDateLock` rows, so a
 * rental marked done before its last day (an early return) kept holding every
 * remaining day — green in the calendar, `bookable: true` from /api/quote, and
 * refused at submit with "En eller flere dager i perioden er opptatt" because
 * `createPendingBooking` allocates its slots from that very table. Idempotent
 * by construction: `deleteMany` on an already-empty set is a no-op.
 */
async function releaseDateLocksForTerminalStatus(
  bookingId: string,
  status: BookingStatus,
): Promise<void> {
  if (status !== 'cancelled' && status !== 'completed') return;
  await db.bookingDateLock.deleteMany({ where: { bookingId } });
}

export async function updateBookingStatus(
  id: string,
  status: BookingStatus,
  options?: UpdateBookingStatusOptions
): Promise<BookingStatusResult> {
  const booking = await db.booking.findUnique({ where: { id } });
  if (!booking) throw new BookingClientError('Booking ikke funnet.');

  // Idempotency short-circuit: caller asked for the state we're already in
  // AND there's nothing new to stamp.
  if (booking.status === status
      && !options?.stripePaymentIntentId
      && !options?.fullyPaid
      && options?.adminNote === undefined
      && !options?.paymentMethod) {
    // A terminal booking holds no dates. Releasing here as well as on the
    // transition below makes the release idempotent: a replayed call, or a
    // row that reached `completed` before this rule existed, still ends up
    // with its locks cleared instead of holding the slot forever.
    await releaseDateLocksForTerminalStatus(id, status);
    return { ...booking, transitioned: false, previousStatus: booking.status };
  }

  const previousStatus = booking.status;

  // Refuse anything outside the lifecycle before a single side effect runs:
  // no fee, no refund, no lock deletion, no mail, no audit row.
  if (
    previousStatus !== status &&
    !LEGAL_TRANSITIONS[previousStatus as BookingStatus]?.includes(status)
  ) {
    throw new BookingClientError(
      `Kan ikke endre status fra «${STATUS_LABELS[previousStatus] ?? previousStatus}» til «${STATUS_LABELS[status] ?? status}».`
    );
  }

  const data: {
    status: string;
    fullyPaidAt?: Date;
    cancellationFee?: number;
    adminNote?: string;
    stripePaymentIntentId?: string;
    paymentDeadline?: Date | null;
    paymentMethod?: string;
    paymentProvider?: string;
  } = { status };

  if (options?.fullyPaid) data.fullyPaidAt = new Date();
  if (options?.adminNote !== undefined) data.adminNote = options.adminNote;
  if (options?.stripePaymentIntentId) data.stripePaymentIntentId = options.stripePaymentIntentId;
  if (options?.paymentMethod) data.paymentMethod = options.paymentMethod;
  if (options?.paymentProvider) data.paymentProvider = options.paymentProvider;
  // Successful payment clears the deadline; the booking is no longer racing
  // the cleanup sweep.
  if (status === 'confirmed') data.paymentDeadline = null;

  if (status === 'cancelled' && previousStatus === 'confirmed') {
    const appCfg = await loadAppConfig();
    // Shared with the /api/booking/cancel preview so the fee the customer is
    // quoted is the fee that gets written.
    const { feePercent } = evaluateCancellationPolicy(dbDateToStr(booking.startDate), appCfg);

    if (feePercent > 0) {
      data.cancellationFee = Math.round((booking.basePrice * feePercent) / 100);
    }
  }

  // Atomic compare-and-set: only one concurrent caller wins the transition.
  // Without this, two simultaneous calls (e.g. Stripe webhook + browser
  // callback both arriving at "checkout.session.completed") would both pass
  // the booking.status check above and both run the post-confirm side
  // effects → double emails, double anything.
  const updateResult = await db.booking.updateMany({
    where: { id, status: previousStatus },
    data,
  });
  if (updateResult.count === 0) {
    // Lost the race — return current state.
    const current = await db.booking.findUnique({ where: { id } });
    return { ...(current ?? booking), transitioned: false, previousStatus };
  }

  const updated = await db.booking.findUnique({ where: { id } });
  if (!updated) throw new BookingClientError('Booking forsvant etter oppdatering.');

  // Same-status writes (e.g. an admin editing the note on an already
  // cancelled booking) are legitimate updates but NOT transitions — no
  // audit "transition" row and no one-shot side effects for them.
  const transitioned = previousStatus !== status;

  // Audit the transition. The bookingId is encoded in the changes so the
  // per-booking timeline endpoint can filter the log for narrative
  // reconstruction ("admin marked as paid at 14:08, refund issued 15:02").
  // Best-effort — audit failures don't roll back the transition.
  if (transitioned) {
    writeAuditLog({
      action: `booking.${status}`,
      actor: options?.actor ?? 'system',
      changes: [
        { key: 'bookingId', from: id, to: id },
        { key: 'reference', from: updated.reference, to: updated.reference },
        { key: 'status', from: previousStatus, to: status },
      ],
    }).catch((err) => console.error('booking audit log failed:', err));
  }

  await releaseDateLocksForTerminalStatus(id, status);

  // Freeze the contract when a booking becomes confirmed via ANY path
  // (Stripe webhook OR admin "Marker som betalt"). Idempotent — checks for
  // an existing AcceptedContract before creating a new one.
  if (status === 'confirmed' && previousStatus !== 'confirmed') {
    try {
      await freezeContractForBooking({
        bookingId: id,
        acceptedFromIp: options?.acceptedFromIp ?? null,
        acceptanceMethod: 'checkbox',
      });
    } catch (err) {
      console.error('Contract freeze failed:', err);
    }

    // B2B: a quote request only becomes `konvertert` — "turned into a real
    // Booking" — once the money has landed. `convertQuoteToBooking` stamps
    // `convertedBookingId` and leaves the status at `akseptert`, and neither
    // the Stripe nor the Vipps callback ever touched `QuoteRequest`, so a
    // fully-paid card quote stayed `akseptert` forever and the admin UI kept
    // offering "Send tilbud" and "Trekk tilbake" on a locked, paid booking.
    // The conditional `updateMany` matches at most the single row that is
    // still `akseptert`: a replayed webhook or a concurrent confirm cannot
    // move it twice, and a quote an admin has since withdrawn is left alone.
    await db.quoteRequest
      .updateMany({
        where: { convertedBookingId: id, status: 'akseptert' },
        data: { status: 'konvertert' },
      })
      .catch((err) => console.error('QuoteRequest konvertert update failed:', err));

    // Repeat-code (RETUR-XXXX) redemption now happens inside the booking-
    // creation transaction — see `createPendingBooking`. By confirmation
    // time the code is already locked to this booking, so nothing to do
    // here.

    // Customer + admin confirmation emails. Centralized here so the Stripe
    // webhook, the browser callback, and admin "mark as paid" all produce
    // the same notifications. (Was previously webhook/callback-only — admin
    // marking a booking paid never emailed anyone.)
    if (!options?.skipEmails) {
      sendBookingStatusEmail(updated, 'confirmed').catch((err) =>
        console.error('Confirmation email failed:', err)
      );
      sendNewBookingAdminNotification(updated).catch((err) =>
        console.error('Admin notification email failed:', err)
      );
    }
  }

  // Mark-completed: issue a repeat-discount code (single-use, email-bound)
  // and email it to the customer. Idempotent — `issueRepeatCode` checks the
  // setting toggle, so disabling the toggle stops the emails immediately.
  if (status === 'completed' && previousStatus !== 'completed') {
    try {
      const issued = await issueRepeatCode({
        email: updated.email,
        bookingId: updated.id,
        expiresInDays: 365,
      });
      if (issued) {
        const appCfg = await loadAppConfig();
        const percent = Number(appCfg['repeatDiscountPercent'] || '10') || 10;
        const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
        sendRepeatDiscountEmail(updated, issued.code, percent, expiresAt).catch((err) =>
          console.error('Repeat discount email failed', err)
        );
      }
    } catch (err) {
      console.error('[issue-repeat-code] failed', err);
    }

    // Post-rental review request. Idempotent (one Review row per booking) and
    // gated by the reviewsEnabled toggle. Best-effort — never blocks the
    // status transition.
    if (!options?.skipEmails) {
      (async () => {
        try {
          const appCfg = await loadAppConfig();
          if ((appCfg['reviewsEnabled'] || 'true') !== 'true') return;
          const { ensureReviewRequest } = await import('@/lib/review');
          const created = await ensureReviewRequest(updated.id);
          if (created) {
            const { sendReviewRequestEmail } = await import('@/lib/email');
            await sendReviewRequestEmail(updated, created.token);
          }
        } catch (err) {
          console.error('[review-request] failed', err);
        }
      })();
    }
  }

  // Auto-refund on cancel, routed to whichever provider took the money. Both
  // implementations work out what is still owed (cancellation fee and any
  // earlier partial refund deducted) and no-op when nothing is.
  if (status === 'cancelled' && updated.fullyPaidAt) {
    if (updated.vippsReference) {
      try {
        // Dynamic import: vipps-payments imports confirmBookingPaidFromStripe
        // from this module, so a static import here would be circular.
        const { refundVippsBooking } = await import('@/lib/vipps-payments');
        const result = await refundVippsBooking(updated);
        if (result) {
          console.log(`Vipps refund issued for ${updated.reference}: ${result.amountRefunded} kr`);
        }
      } catch (err) {
        console.error(`Auto-refund (Vipps) failed for ${updated.reference}:`, err);
      }
    } else if (updated.stripePaymentIntentId) {
      try {
        const result = await refundBookingPayment(updated);
        if (result) {
          console.log(`Refund issued for ${updated.reference}: ${result.amountRefunded} kr (${result.refundId})`);
        }
      } catch (err) {
        console.error(`Auto-refund failed for ${updated.reference}:`, err);
      }
    }
  }

  // pending → cancelled: this is the cleanup-cron path (the booking timed
  // out before payment landed). The admin- and customer-initiated cancels
  // route their own emails through /api/bookings/[id] and
  // /api/booking/cancel respectively. We only fire here for the silent
  // expiry case so we don't double-send.
  if (
    status === 'cancelled' &&
    previousStatus === 'pending' &&
    !options?.skipEmails
  ) {
    sendBookingExpiredEmail(updated).catch((err) =>
      console.error('Expired-booking email failed:', err),
    );
  }

  return { ...updated, transitioned, previousStatus };
}

/** Caller helper: confirm a booking from the Stripe webhook or browser
 *  callback. Wraps updateBookingStatus with the right options. Returns the
 *  updated booking, or null if it wasn't pending (already-confirmed,
 *  cancelled, etc. — caller should treat as already-handled). */
export async function confirmBookingPaidFromStripe(opts: {
  bookingId: string;
  stripePaymentIntentId?: string | null;
  acceptedFromIp?: string | null;
  paymentMethod?: string | null;
  /** Which gateway took the money. Defaults to 'stripe' — the Vipps settle
   *  path passes 'vipps' so confirmation does not overwrite the provider
   *  `createVippsPaymentForBooking` already stamped, which made every Vipps
   *  booking look like a Stripe one to any report grouped by provider. */
  paymentProvider?: string | null;
}): Promise<Booking | null> {
  const before = await db.booking.findUnique({ where: { id: opts.bookingId } });
  if (!before || before.status !== 'pending') return null;
  const updated = await updateBookingStatus(opts.bookingId, 'confirmed', {
    fullyPaid: true,
    stripePaymentIntentId: opts.stripePaymentIntentId ?? null,
    acceptedFromIp: opts.acceptedFromIp ?? null,
    paymentMethod: opts.paymentMethod ?? null,
    paymentProvider: opts.paymentProvider ?? 'stripe',
  });
  // Only the caller that actually performed the pending → confirmed
  // transition gets the booking back. The loser of a concurrent confirm gets
  // `transitioned: false` (and a row that is already 'confirmed'), and must
  // see the documented `null` so it treats the payment as already handled
  // instead of re-running its own one-shot side effects.
  return updated.transitioned && updated.status === 'confirmed' ? updated : null;
}
