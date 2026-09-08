import type { ConfigValues } from '@/lib/pricing';
import { getConfigValue } from '@/lib/pricing';

// Single source of truth for the MVA split. Returns the three numbers the
// front-end and emails need: ex MVA, the MVA portion, and the inkl MVA
// total. Caller controls rounding policy — we keep raw values here.

export interface MvaBreakdown {
  exMva: number;
  mva: number;
  inclMva: number;
  mvaRate: number;         // e.g. 25
  storedInclMva: boolean;  // is the input value already inkl mva?
}

export interface MvaSettings {
  rate: number;
  storedInclMva: boolean;
}

export function readMvaSettings(config: ConfigValues): MvaSettings {
  // `getConfigValue` already falls back to the 25 % default when the row is
  // missing and honours a stored 0 (`??`, not `||`). A `|| 25` here could
  // therefore only ever overwrite a *deliberately* configured 0 — an
  // MVA-exempt or reverse-charge setup — with 25 % VAT the business must not
  // collect. A negative rate is nonsense rather than a policy, so it clamps
  // to 0 instead of turning into a discount.
  const configured = getConfigValue(config, 'mvaRate');
  const rate = Number.isFinite(configured) ? Math.max(0, configured) : 0;
  const storedInclMva = getConfigValue(config, 'pricesIncludeMva') === 1
    || getConfigValue(config, 'pricesIncludeMva') > 0;
  return { rate, storedInclMva };
}

/**
 * Split a stored amount into the MVA components. `amount` is whatever value
 * is currently in storage (e.g. dayPrice). Whether that value is ex- or
 * inkl-MVA depends on `pricesIncludeMva` (see settings).
 */
export function splitMva(amount: number, settings: MvaSettings): MvaBreakdown {
  const rate = settings.rate;
  const factor = 1 + rate / 100;
  if (settings.storedInclMva) {
    const inclMva = amount;
    const exMva = inclMva / factor;
    return {
      exMva,
      mva: inclMva - exMva,
      inclMva,
      mvaRate: rate,
      storedInclMva: true,
    };
  }
  // Stored value is ex-MVA — add MVA on top.
  const exMva = amount;
  const inclMva = exMva * factor;
  return {
    exMva,
    mva: inclMva - exMva,
    inclMva,
    mvaRate: rate,
    storedInclMva: false,
  };
}

/** Round to whole kroner — used wherever we display final amounts. */
export function roundKr(n: number): number {
  return Math.round(n);
}

/**
 * The whole-krone amount actually charged for a post-discount `net` subtotal.
 * When prices are stored incl. MVA, `net` already contains MVA and is the
 * charged total; when stored ex-MVA, MVA is ADDED on top so it is genuinely
 * collected (not merely displayed). Single source of truth shared by the
 * quote (what the customer sees) and booking creation (what Stripe charges)
 * so the two can never drift.
 */
export function chargedTotalKr(net: number, settings: MvaSettings): number {
  return roundKr(splitMva(net, settings).inclMva);
}

/** Format helper: "1 234 kr" with optional decimal. */
export function formatKr(n: number, opts: { decimals?: 0 | 2 } = {}): string {
  return n.toLocaleString('nb-NO', {
    minimumFractionDigits: opts.decimals ?? 0,
    maximumFractionDigits: opts.decimals ?? 0,
  });
}
