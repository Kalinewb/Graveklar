import { describe, it, expect } from 'vitest';
import { splitMva, chargedTotalKr, type MvaSettings } from '@/lib/mva';

const incl: MvaSettings = { rate: 25, storedInclMva: true };
const ex: MvaSettings = { rate: 25, storedInclMva: false };

describe('chargedTotalKr', () => {
  it('incl-MVA: the net already contains MVA and is the charged total', () => {
    expect(chargedTotalKr(1000, incl)).toBe(1000);
  });
  it('ex-MVA: adds MVA on top so VAT is actually charged (not just shown)', () => {
    expect(chargedTotalKr(1000, ex)).toBe(1250);
  });
  it('ex-MVA: rounds the grossed-up total to whole kroner', () => {
    // 1003 * 1.25 = 1253.75 → 1254
    expect(chargedTotalKr(1003, ex)).toBe(1254);
  });
  it('zero stays zero for both modes', () => {
    expect(chargedTotalKr(0, incl)).toBe(0);
    expect(chargedTotalKr(0, ex)).toBe(0);
  });
});

describe('splitMva', () => {
  it('incl-MVA: exMva + mva reconciles to the stored amount', () => {
    const r = splitMva(1250, incl);
    expect(Math.round(r.exMva)).toBe(1000);
    expect(Math.round(r.mva)).toBe(250);
    expect(r.inclMva).toBe(1250);
  });
  it('ex-MVA: grosses the stored amount up by the MVA rate', () => {
    const r = splitMva(1000, ex);
    expect(r.exMva).toBe(1000);
    expect(Math.round(r.mva)).toBe(250);
    expect(r.inclMva).toBe(1250);
  });
});
