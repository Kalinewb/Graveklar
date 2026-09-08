import { db } from '@/lib/db';
import { loadConfigValues } from '@/lib/config-server';
import { loadAppConfig } from '@/lib/app-config';
import {
  calendarDaysUntil,
  checkRentalLength,
  computeBookingPrices,
  type CreateBookingInput,
  type EquipmentPricing,
} from '@/lib/booking-service';
import { computeDiscount, type DiscountResult } from '@/lib/discount-engine';
import {
  calculateDeliveryFee,
  deliveryFeeTolerance,
  getConfigValue,
  type ConfigValues,
  type RentalType,
} from '@/lib/pricing';
import { readMvaSettings, splitMva, chargedTotalKr, roundKr } from '@/lib/mva';
import { todayStr, toDateStr } from '@/lib/dates';

// ─────────────────────────────────────────────────────────────────────────
// Quote — the canonical commercial document the customer sees.
//
// Architecture invariant: every monetary number the customer ever sees
// (booking form summary, confirmation modal, Stripe metadata, confirmation
// email, frozen contract) is derived from `buildQuote`. The frontend
// renders the returned object verbatim — it never re-derives totals,
// discounts, percents, or labels on its own. The Stripe `unit_amount` is
// `quote.totalPrice * 100`. /api/bookings re-runs `buildQuote` server-side
// at submission time to detect drift (config changed between preview and
// submit) and rejects with 409 + the fresh quote if numbers differ.
//
// This collapses ~five independent implementations of "what does the
// customer pay" into one. Drift between preview and charge is no longer
// possible by construction.
// ─────────────────────────────────────────────────────────────────────────

export interface QuoteInputs {
  /** Booking shape — same as CreateBookingInput minus PII the quote doesn't need. */
  rentalType: RentalType;
  startDate: string;
  customDays?: number | null;
  machineId?: string | null;
  selfPickup?: boolean;
  deliveryDistance?: number | null;
  deliveryFee?: number | null;
  extraHours?: number;

  /** Discount eligibility inputs. Optional — the quote computes
   *  whatever discounts apply for what's provided. Without email/phone,
   *  no first-time / repeat discount fires. */
  email?: string;
  phone?: string;
  code?: string | null;
}

export interface QuoteDiscountLine {
  kind: 'first-time' | 'repeat' | 'campaign';
  label: string;
  percent: number;
  amountKr: number;
  codeId?: string;
}

export interface QuoteMvaBreakdown {
  exMva: number;
  mvaAmt: number;
  mvaRate: number;
  inclMva: boolean;
}

export interface QuoteWarning {
  code: string;
  message: string;
}

export interface Quote {
  /** Inputs echoed back so the frontend can verify what was priced. */
  inputs: QuoteInputs;

  /** Pre-discount breakdown. */
  basePrice: number;
  extraHoursCost: number;
  extraHours: number;
  includedHours: number;
  totalHours: number;
  deliveryFee: number;
  subtotal: number;

  /** Applied discount lines (post-stacking, post-cap). */
  discountLines: QuoteDiscountLine[];
  discountKr: number;
  discountLabel: string | null;
  cappedByCeiling: boolean;

  /** Final amount the customer is charged. */
  totalPrice: number;

  /** MVA presentation breakdown. */
  mvaBreakdown: QuoteMvaBreakdown;

  /** Non-fatal informational warnings: invalid code, outside radius,
   *  unrecognized email pattern, etc. Always render these. */
  warnings: QuoteWarning[];

  /** False when /api/bookings would refuse this combination. The quote is
   *  still priced (the UI needs numbers to render) but the caller must not
   *  present it as something the customer can actually buy. */
  bookable: boolean;
  /** Norwegian, customer-facing reason `bookable` is false. */
  blockedReason: string | null;

  /** Issued at — useful for the frontend to spot stale quotes. */
  generatedAt: string;
}

const LABEL_FOR_KIND: Record<QuoteDiscountLine['kind'], string> = {
  'first-time': 'Førstegangskunde',
  repeat: 'Returkunde-kode',
  campaign: 'Rabattkode',
};

// ─────────────────────────────────────────────────────────────────────────
// Bookability — the same gate /api/bookings applies, minus the PII checks.
//
// The quote layer used to price anything it was handed: dates in the past,
// a rental type the admin had switched off, a weekend starting on a Tuesday,
// 364 days of rental, an unknown machineId (which silently fell back to the
// global default prices). None of it could ever be charged — /api/bookings
// refused every one — but a preview that quotes numbers the real layer will
// not honour is exactly where price drift starts. Now the quote still returns
// figures (the form needs something to render while the customer edits) and
// says plainly whether they can be bought.
// ─────────────────────────────────────────────────────────────────────────
function checkBookable(
  inputs: QuoteInputs,
  config: ConfigValues,
  appConfig: Record<string, string>,
  machineResolved: boolean,
  /** The fee as the CALLER supplied it, before self-pickup zeroes it. Zeroing
   *  first made the self-pickup guard below unreachable, so the quote called a
   *  combination bookable that `validateBookingInput` — which sees the raw
   *  value — refuses. */
  requestedDeliveryFee: number,
): string | null {
  const enabledTypes = (appConfig['enabledRentalTypes'] || 'day,weekend,week')
    .split(',').map((t) => t.trim()).filter(Boolean);
  if (!enabledTypes.includes(inputs.rentalType)) {
    return 'Denne leietypen er ikke tilgjengelig for booking.';
  }

  if (inputs.machineId && !machineResolved) {
    return 'Valgt utstyr er ikke tilgjengelig.';
  }

  if (inputs.startDate < todayStr()) {
    return 'Startdato kan ikke være i fortiden.';
  }

  const minDaysAhead = Math.round(
    Number(appConfig['minBookingDaysAhead'] ?? '0')
      || getConfigValue(config, 'minBookingDaysAhead')
      || 0,
  );
  if (minDaysAhead > 0) {
    const earliest = new Date();
    earliest.setDate(earliest.getDate() + minDaysAhead);
    if (inputs.startDate < toDateStr(earliest)) {
      return `Booking må gjøres minst ${minDaysAhead} dager i forveien.`;
    }
  }

  const maxAdvanceDays = Number(appConfig['bookingMaxAdvanceDays'] || '365');
  if (calendarDaysUntil(inputs.startDate) > maxAdvanceDays) {
    return `Du kan ikke booke mer enn ${maxAdvanceDays} dager i forveien.`;
  }

  const dow = new Date(inputs.startDate + 'T12:00:00').getDay();
  const jsDow = dow === 0 ? 7 : dow;
  if (inputs.rentalType === 'day') {
    const allowed = new Set(
      (appConfig['dayAllowedDays'] || '1,2,3,4').split(',').map((d) => Number(d.trim())),
    );
    if (!allowed.has(jsDow)) return 'Denne datoen er ikke tilgjengelig for dagsleie.';
  }
  if (inputs.rentalType === 'weekend' && jsDow !== Number(appConfig['weekendStartDay'] || '5')) {
    return 'Helgleie må starte på riktig dag.';
  }
  if (inputs.rentalType === 'week' && jsDow !== Number(appConfig['weekStartDay'] || '1')) {
    return 'Ukeleie må starte på riktig dag.';
  }

  const lengthError = checkRentalLength(inputs.rentalType, inputs.customDays);
  if (lengthError) return lengthError;

  if (!inputs.selfPickup) {
    const distance = inputs.deliveryDistance ?? 0;
    const maxRadius = getConfigValue(config, 'maxDeliveryRadius');
    if (distance > maxRadius) {
      return 'Adressen er utenfor leveringsområdet.';
    }
    // `validateBookingInput` recomputes the fee at submit time and refuses
    // anything outside the tolerance. Without the same check here the preview
    // promised a purchase the submit endpoint rejected — the exact drift
    // `buildQuote` exists to prevent. Same helper, same tolerance, so the two
    // gates cannot disagree.
    const expectedFee = calculateDeliveryFee(config, distance);
    if (Math.abs(requestedDeliveryFee - expectedFee) > deliveryFeeTolerance(config)) {
      return 'Leveringspris stemmer ikke. Oppdater adressen og prøv igjen.';
    }
  } else if (requestedDeliveryFee > 0) {
    return 'Selvhenting skal ikke ha leveringsgebyr.';
  }

  return null;
}

export async function buildQuote(inputs: QuoteInputs): Promise<Quote> {
  const [config, appConfig] = await Promise.all([loadConfigValues(), loadAppConfig()]);

  // Resolve machine (for equipment-specific pricing overrides) and quantity.
  let equipmentPricing: EquipmentPricing | null = null;
  let machineResolved = !inputs.machineId;
  if (inputs.machineId) {
    const machine = await db.machine.findFirst({
      where: { id: inputs.machineId, isActive: true },
    });
    if (machine) {
      machineResolved = true;
      equipmentPricing = {
        dayPrice: machine.dayPrice,
        weekendPrice: machine.weekendPrice,
        weekPrice: machine.weekPrice,
        dayIncludedHours: machine.dayIncludedHours,
        weekendIncludedHours: machine.weekendIncludedHours,
        weekIncludedHours: machine.weekIncludedHours,
        overtimeRate: machine.overtimeRate,
        preOrderHourRate: machine.preOrderHourRate,
      };
    }
  }

  // Delivery fee — for selfPickup, always 0. Otherwise, the frontend has
  // already computed it via /api/delivery; we accept that here as input,
  // check it against our own recomputation in `checkBookable`, and re-validate
  // on /api/bookings submit.
  //
  // `Math.round(NaN)` is NaN, and a non-numeric fee (`Number("gratis")` out of
  // the request body) used to travel from here through subtotal → totalPrice →
  // the MVA split and come back as a 200 whose every money field serialised to
  // `null`. Money is never NaN: an unusable value is 0.
  const rawFee = Number(inputs.deliveryFee ?? 0);
  const requestedDeliveryFee = Number.isFinite(rawFee) ? Math.max(0, Math.round(rawFee)) : 0;
  const deliveryFee = inputs.selfPickup ? 0 : requestedDeliveryFee;

  // Core price math — same function /api/bookings uses for the final value.
  const computed = computeBookingPrices(
    {
      rentalType: inputs.rentalType,
      startDate: inputs.startDate,
      customDays: inputs.customDays ?? undefined,
      deliveryFee,
      extraHours: inputs.extraHours,
    },
    config,
    equipmentPricing,
  );

  const subtotal = computed.basePrice + computed.extraHoursCost + computed.deliveryFee;

  // Discount stacking + cap — identical logic to what /api/bookings runs.
  //
  // Run unconditionally on whatever identity the customer has typed so far.
  // Gating this on "email AND phone" silently withheld discounts the customer
  // had already earned: a campaign code isn't bound to an identity at all, and
  // half-filled forms are the normal state while someone is still typing. It
  // also contradicted /api/check-discount-eligibility, which qualifies on
  // email OR phone — so the page could show "Førstegangskunde – 10 % rabatt"
  // and a valid code while the total stayed at full price with no warning.
  // computeDiscount is safe with empty inputs: isFirstTimeEligible returns
  // false when neither identifier is set, and the code path is skipped
  // without a code.
  const warnings: QuoteWarning[] = [];
  const discount: DiscountResult = await computeDiscount({
    baseTotalKr: subtotal,
    email: inputs.email ?? '',
    phone: inputs.phone ?? '',
    code: inputs.code ?? null,
  });

  // Translate `applied[]` into per-line amounts. The cap (discountHardCap)
  // is applied as a single scale factor across all lines so each line's
  // displayed kr matches the actual total.
  //
  // The lines must add up to `discountKr` exactly. Rounding each line on its
  // own does not: `discountKr` is one rounding of the summed percentage, so a
  // 2 495 kr subtotal with two 10 % lines showed 250 + 250 while 499 was
  // actually deducted. The last line therefore takes the remainder — the
  // customer reads a breakdown that sums to the number at the bottom.
  const rawSumPercent = discount.applied.reduce((s, a) => s + a.percent, 0);
  const scale = rawSumPercent > 0 ? discount.effectivePercent / rawSumPercent : 0;
  let allocatedKr = 0;
  const discountLines: QuoteDiscountLine[] = discount.applied.map((a, i) => {
    const effectivePct = a.percent * scale;
    const isLast = i === discount.applied.length - 1;
    const amountKr = isLast
      ? discount.discountKr - allocatedKr
      : Math.round((subtotal * effectivePct) / 100);
    allocatedKr += amountKr;
    return {
      kind: a.kind,
      label: LABEL_FOR_KIND[a.kind],
      percent: Number(effectivePct.toFixed(2)),
      amountKr,
      codeId: a.codeId,
    };
  });

  // Warning: customer typed a code, validation came back invalid.
  if (inputs.code && discount.applied.findIndex((a) => a.kind !== 'first-time') === -1) {
    // Re-run validateRepeatCode to surface the reason — only when no
    // code-based discount got applied.
    const { validateRepeatCode } = await import('@/lib/discount-engine');
    const validation = await validateRepeatCode(inputs.code, inputs.email ?? '');
    if (!validation.ok) {
      warnings.push({
        code: `code-${validation.reason}`,
        message: REASON_LABELS[validation.reason] ?? 'Ugyldig kode.',
      });
    }
  }

  // Same gate /api/bookings will apply at submit time. Surfaced as a warning
  // too, so a caller that only renders `warnings` still tells the customer.
  const blockedReason = checkBookable(
    inputs, config, appConfig, machineResolved, requestedDeliveryFee,
  );
  if (blockedReason) {
    warnings.push({ code: 'not-bookable', message: blockedReason });
  }

  // MVA. When prices are stored ex-MVA, VAT is ADDED to the charged total —
  // not merely displayed. `chargedTotalKr` / `splitMva` are the shared source
  // of truth, so this matches exactly what booking creation persists and what
  // Stripe charges (the drift guard compares the two).
  const mvaSettings = readMvaSettings(config);
  const net = Math.max(0, subtotal - discount.discountKr);
  const totalPrice = chargedTotalKr(net, mvaSettings);
  const exMva = roundKr(splitMva(net, mvaSettings).exMva);
  const mvaAmt = totalPrice - exMva;
  const mvaBreakdown: QuoteMvaBreakdown = {
    exMva,
    mvaAmt,
    mvaRate: mvaSettings.rate,
    inclMva: mvaSettings.storedInclMva,
  };

  return {
    inputs,
    basePrice: computed.basePrice,
    extraHoursCost: computed.extraHoursCost,
    extraHours: computed.extraHours,
    includedHours: computed.includedHours,
    totalHours: computed.totalHours,
    deliveryFee: computed.deliveryFee,
    subtotal,
    discountLines,
    discountKr: discount.discountKr,
    discountLabel: discount.label,
    cappedByCeiling: discount.cappedByCeiling,
    totalPrice,
    mvaBreakdown,
    warnings,
    bookable: blockedReason === null,
    blockedReason,
    generatedAt: new Date().toISOString(),
  };
}

const REASON_LABELS: Record<string, string> = {
  invalid: 'Ugyldig kode.',
  redeemed: 'Koden er allerede brukt.',
  expired: 'Koden er utløpt.',
  'mismatched-email': 'Koden er knyttet til en annen e-postadresse.',
  inactive: 'Koden er ikke aktiv.',
  exhausted: 'Koden er oppbrukt.',
};

/** Helper for /api/bookings to verify a submitted booking matches the
 *  freshest quote. Returns the drift in kroner (0 means OK), or -1 if
 *  unable to compute. Used to reject "you saw 5000, you'd be charged 5500"
 *  with a clean 409 rather than silently charging. */
export async function priceDriftKr(
  inputs: QuoteInputs,
  expectedTotalKr: number,
): Promise<number> {
  try {
    const fresh = await buildQuote(inputs);
    return Math.abs(fresh.totalPrice - expectedTotalKr);
  } catch {
    return -1;
  }
}

// Re-export inputs interface so callers don't have to import from booking-service.
export type { CreateBookingInput };
