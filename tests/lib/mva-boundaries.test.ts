import { describe, it, expect } from 'vitest';

import {
  chargedTotalKr,
  readMvaSettings,
  roundKr,
  splitMva,
  type MvaSettings,
} from '@/lib/mva';

import { cfg } from '../helpers/pricing';

// L1 — pure MVA arithmetic and the settings reader. `src/lib/mva.ts` is the
// single source of truth shared by buildQuote (what the customer sees) and
// createPendingBooking (what Stripe charges), so every boundary here is a
// boundary in the charged amount.

const incl: MvaSettings = { rate: 25, storedInclMva: true };
const ex: MvaSettings = { rate: 25, storedInclMva: false };

describe('readMvaSettings', () => {
  it('reads mvaRate and pricesIncludeMva=1 straight out of PricingConfig', () => {
    expect(readMvaSettings(cfg({ mvaRate: 25, pricesIncludeMva: 1 }))).toEqual({
      rate: 25,
      storedInclMva: true,
    });
  });

  it('pricesIncludeMva=0 means the stored prices are ex-MVA', () => {
    expect(readMvaSettings(cfg({ pricesIncludeMva: 0 }))).toEqual({
      rate: 25,
      storedInclMva: false,
    });
  });

  it('any positive pricesIncludeMva counts as incl-MVA', () => {
    expect(readMvaSettings(cfg({ pricesIncludeMva: 0.5 })).storedInclMva).toBe(true);
    expect(readMvaSettings(cfg({ pricesIncludeMva: 2 })).storedInclMva).toBe(true);
  });

  it('a negative pricesIncludeMva is treated as ex-MVA', () => {
    expect(readMvaSettings(cfg({ pricesIncludeMva: -1 })).storedInclMva).toBe(false);
  });

  it('a non-default rate is honoured', () => {
    expect(readMvaSettings(cfg({ mvaRate: 12 })).rate).toBe(12);
  });

  // FIXED A-1: readMvaSettings did `rate || 25`, so an admin who set
  // mvaRate to 0 (MVA-exempt / reverse charge) silently got 25 % added.
  it('mvaRate = 0 must mean zero MVA, not the 25 % fallback', () => {
    // FIXED A-1: src/lib/mva.ts reads the configured rate and clamps only
    // a negative one; getConfigValue already supplies the 25 % default.
    expect(readMvaSettings(cfg({ mvaRate: 0 })).rate).toBe(0);
  });

  it('mvaRate = 0 charges no MVA at all — the A-1 fix, end to end', () => {
    const s = readMvaSettings(cfg({ mvaRate: 0, pricesIncludeMva: 0 }));
    expect(chargedTotalKr(1000, s)).toBe(1000);
  });
});

describe('splitMva', () => {
  it('incl-MVA: the stored amount is the gross and reconciles exactly', () => {
    const r = splitMva(1250, incl);
    expect(r.inclMva).toBe(1250);
    expect(r.exMva).toBeCloseTo(1000, 10);
    expect(r.exMva + r.mva).toBeCloseTo(r.inclMva, 10);
    expect(r.storedInclMva).toBe(true);
  });

  it('ex-MVA: the stored amount is the net and MVA is added on top', () => {
    const r = splitMva(1000, ex);
    expect(r.exMva).toBe(1000);
    expect(r.inclMva).toBeCloseTo(1250, 10);
    expect(r.exMva + r.mva).toBeCloseTo(r.inclMva, 10);
    expect(r.storedInclMva).toBe(false);
  });

  it('rate 0 makes the split a no-op in both directions', () => {
    const zero: MvaSettings = { rate: 0, storedInclMva: true };
    expect(splitMva(999, zero)).toMatchObject({ exMva: 999, mva: 0, inclMva: 999 });
    expect(splitMva(999, { ...zero, storedInclMva: false })).toMatchObject({
      exMva: 999,
      mva: 0,
      inclMva: 999,
    });
  });

  it('zero and negative amounts pass through without inventing MVA', () => {
    expect(splitMva(0, incl).mva).toBe(0);
    expect(splitMva(0, ex).mva).toBe(0);
    expect(splitMva(-100, ex).inclMva).toBeCloseTo(-125, 10);
  });
});

describe('roundKr', () => {
  it('rounds to whole kroner', () => {
    expect(roundKr(1249.4)).toBe(1249);
    expect(roundKr(1249.5)).toBe(1250);
  });

  it('uses Math.round semantics: .5 always goes up, including for negatives', () => {
    expect(roundKr(-1.5)).toBe(-1);
    expect(roundKr(-1.6)).toBe(-2);
  });
});

describe('chargedTotalKr', () => {
  it('incl-MVA: the net is already the charged total', () => {
    expect(chargedTotalKr(2490, incl)).toBe(2490);
  });

  it('ex-MVA: MVA is collected, not merely displayed', () => {
    expect(chargedTotalKr(2490, ex)).toBe(3113); // 3112.5 → 3113
  });

  it('the half-krone boundary rounds up', () => {
    expect(chargedTotalKr(1002, ex)).toBe(1253); // 1252.5 → 1253
    expect(chargedTotalKr(1001, ex)).toBe(1251); // 1251.25 → 1251
  });

  it('zero stays zero in both modes', () => {
    expect(chargedTotalKr(0, incl)).toBe(0);
    expect(chargedTotalKr(0, ex)).toBe(0);
  });
});

// The quote presents `exMva` rounded on its own and derives `mvaAmt` as
// `totalPrice - exMva`, which is what keeps the three numbers on the customer's
// breakdown adding up exactly even though each one is rounded. Sweep the whole
// realistic price range to prove there is no remainder-krone that escapes.
describe('quote-style breakdown reconciliation (the remainder krone)', () => {
  function breakdown(net: number, settings: MvaSettings) {
    const totalPrice = chargedTotalKr(net, settings);
    const exMva = roundKr(splitMva(net, settings).exMva);
    return { totalPrice, exMva, mvaAmt: totalPrice - exMva };
  }

  for (const [name, settings] of [
    ['incl-MVA', incl],
    ['ex-MVA', ex],
  ] as const) {
    it(`${name}: exMva + mvaAmt === totalPrice for every net 0…3000 kr`, () => {
      const offenders: number[] = [];
      for (let net = 0; net <= 3000; net++) {
        const b = breakdown(net, settings);
        if (b.exMva + b.mvaAmt !== b.totalPrice) offenders.push(net);
      }
      expect(offenders).toEqual([]);
    });

    it(`${name}: mvaAmt never drifts more than 1 kr from the exact VAT`, () => {
      const offenders: { net: number; mvaAmt: number; exact: number }[] = [];
      for (let net = 0; net <= 3000; net++) {
        const b = breakdown(net, settings);
        const exact = splitMva(net, settings).mva;
        if (Math.abs(b.mvaAmt - exact) > 1) offenders.push({ net, mvaAmt: b.mvaAmt, exact });
      }
      expect(offenders).toEqual([]);
    });
  }

  it('incl-MVA 2490 kr: 1992 ex + 498 MVA', () => {
    expect(breakdown(2490, incl)).toEqual({ totalPrice: 2490, exMva: 1992, mvaAmt: 498 });
  });

  it('ex-MVA 2490 kr: 2490 ex + 623 MVA = 3113 charged', () => {
    expect(breakdown(2490, ex)).toEqual({ totalPrice: 3113, exMva: 2490, mvaAmt: 623 });
  });
});
