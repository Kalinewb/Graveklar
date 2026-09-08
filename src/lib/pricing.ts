import { DEFAULT_CONFIG as DEFAULT_CONFIG_IMPORTED } from '@/lib/config-defaults';

export type RentalType = "day" | "weekend" | "week" | "custom";

export interface PricingConfig {
  basePrice: number;
  includedHours: number;
  label: string;
  description: string;
}

export const DEFAULT_CONFIG: Record<string, number> = DEFAULT_CONFIG_IMPORTED;

// Config values type
export type ConfigValues = Record<string, number>;

// Fetch config from API (client-side)
export async function getConfig(): Promise<ConfigValues> {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    if (data.values) {
      return { ...DEFAULT_CONFIG, ...data.values };
    }
    return { ...DEFAULT_CONFIG };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// Get config value with fallback
export function getConfigValue(config: ConfigValues, key: string): number {
  return config[key] ?? DEFAULT_CONFIG[key] ?? 0;
}

// ── Delivery fee ─────────────────────────────────────────────────────────
// One implementation of "what does this delivery cost", shared by the three
// places that used to derive it on their own: `POST /api/delivery` (which
// measures the distance and signs the quote), `validateBookingInput` (which
// re-derives it at submit time to catch a client-side edit) and
// `checkBookable` (which has to tell the customer *before* they fill in the
// form whether the fee they are shown will survive that check). Three copies
// of one formula is exactly how a preview starts promising a price the submit
// endpoint refuses.
//
// `deliveryIncludedKm` is read through `getConfigValue`, so a configured 0
// means "bill from the first kilometre" — the old `|| 30` silently reinstated
// 30 free kilometres and made the setting do the opposite of what it says.
export function calculateDeliveryFee(config: ConfigValues, distanceKm: number): number {
  const includedKm = getConfigValue(config, 'deliveryIncludedKm');
  const perKm = getConfigValue(config, 'deliveryPerKm');
  const minFee = getConfigValue(config, 'minDeliveryFee');
  const chargeableKm = Math.max(0, distanceKm - includedKm);
  // Inside the included distance the minimum fee does NOT apply — delivery is
  // free, not "free but at least minDeliveryFee".
  return chargeableKm > 0 ? Math.max(minFee, Math.round(chargeableKm * perKm)) : 0;
}

/**
 * Margin of error when comparing a submitted fee against `calculateDeliveryFee`.
 * Scales with `deliveryPerKm` because /api/delivery rounds the distance to
 * 0.1 km before the fee math and JS float drift can move the recomputation by
 * up to that much. Floored at 2 kr so a config with `perKm = 0` still
 * tolerates ordinary rounding noise, and bounded at less than a single
 * kilometre's worth so an adversarial client cannot shave a meaningful amount.
 */
export function deliveryFeeTolerance(config: ConfigValues): number {
  return Math.max(2, Math.ceil(getConfigValue(config, 'deliveryPerKm') * 0.1) + 1);
}

// Build PRICING from config values.
//
// Each tier's price is computed: `hourlyRate × includedHours`. A per-machine
// override (e.g. an explicit `dayPrice` on the Machine row) takes precedence
// over the computed value because pricing.ts is called with that override
// already merged into `config` by mergeEquipmentConfig in booking-service.ts.
export function buildPricingFromConfig(config: ConfigValues): Record<RentalType, PricingConfig> {
  const weekdayHourly = getConfigValue(config, 'weekdayHourly');
  const weekendHourly = getConfigValue(config, 'weekendHourly');
  const weeklyHourly  = getConfigValue(config, 'weeklyHourly');
  const dayHours      = getConfigValue(config, 'dayIncludedHours');
  const weekendHours  = getConfigValue(config, 'weekendIncludedHours');
  const weekHours     = getConfigValue(config, 'weekIncludedHours');

  // Per-machine override is merged into config under the legacy keys so we
  // still honor them. Falls through to computed when not set.
  const dayPrice     = config['dayPrice']     ?? dayHours    * weekdayHourly;
  const weekendPrice = config['weekendPrice'] ?? weekendHours * weekendHourly;
  const weekPrice    = config['weekPrice']    ?? weekHours   * weeklyHourly;

  return {
    day: {
      basePrice: dayPrice,
      includedHours: dayHours,
      label: "Døgn",
      description: `Man–tor, ${dayHours} timer inkludert`,
    },
    weekend: {
      basePrice: weekendPrice,
      includedHours: weekendHours,
      label: "Helg",
      description: `Fre 16:00 – Man 08:00, ${weekendHours} timer inkludert`,
    },
    week: {
      basePrice: weekPrice,
      includedHours: weekHours,
      label: "Uke",
      description: `7 dager, ${weekHours} timer inkludert`,
    },
    custom: {
      basePrice: 0,
      includedHours: 0,
      label: "Tilpasset",
      description: "Velg antall dager selv",
    },
  };
}

// Helper: check if a date is a weekend day (Saturday or Sunday)
function isWeekendDay(date: Date): boolean {
  const day = date.getDay(); // 0 = Sunday, 6 = Saturday
  return day === 0 || day === 6;
}

export interface CustomPriceBreakdown {
  days: { date: string; label: string; isWeekend: boolean; price: number }[];
  weekdayDays: number;
  weekendDays: number;
  totalHours: number;
  totalPrice: number;
}

export function calculateCustomPrice(
  startDate: string,
  days: number,
  config: ConfigValues
): CustomPriceBreakdown {
  const weekdayHourly = getConfigValue(config, 'weekdayHourly');
  const weekendHourly = getConfigValue(config, 'weekendHourly');
  const dayIncludedHours = getConfigValue(config, 'dayIncludedHours');
  const weekendIncludedHours = getConfigValue(config, 'weekendIncludedHours');

  // A per-machine price override reaches us under the legacy `dayPrice` /
  // `weekendPrice` keys (merged by mergeEquipmentConfig in booking-service).
  // The custom walk used to read the *global* hourly rates only, so a
  // 4 000 kr/day machine was billed at the house rate the moment the customer
  // picked `custom` — while its included-hours override was honored.
  //
  // The overrides are tier prices, not day rates: `dayPrice` buys
  // `dayIncludedHours`, `weekendPrice` buys `weekendIncludedHours` (the whole
  // Fri–Man package). A custom rental bills every day — weekend days
  // included — at `dayIncludedHours`, so the weekend override is scaled back
  // to one such day instead of charging a full weekend package per Saturday.
  const weekdayDayPrice = config['dayPrice'] ?? weekdayHourly * dayIncludedHours;
  const weekendDayPrice =
    config['weekendPrice'] != null && weekendIncludedHours > 0
      ? Math.round(config['weekendPrice'] * (dayIncludedHours / weekendIncludedHours))
      : weekendHourly * dayIncludedHours;

  const start = new Date(startDate + 'T00:00:00');
  const breakdown: CustomPriceBreakdown['days'] = [];
  let weekdayDays = 0;
  let weekendDays = 0;
  let totalPrice = 0;

  const dayLabels = ['Søn', 'Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør'];

  for (let i = 0; i < days; i++) {
    const current = new Date(start);
    current.setDate(current.getDate() + i);
    const isWknd = isWeekendDay(current);
    const dayPrice = isWknd ? weekendDayPrice : weekdayDayPrice;

    if (isWknd) weekendDays++;
    else weekdayDays++;

    totalPrice += dayPrice;

    breakdown.push({
      date: `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}-${String(current.getDate()).padStart(2, '0')}`,
      label: dayLabels[current.getDay()],
      isWeekend: isWknd,
      price: dayPrice,
    });
  }

  return {
    days: breakdown,
    weekdayDays,
    weekendDays,
    totalHours: days * dayIncludedHours,
    totalPrice,
  };
}
