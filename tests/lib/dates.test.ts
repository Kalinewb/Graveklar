import { describe, it, expect } from 'vitest';
import { toDateStr, parseDateStr, addDays, isFriday, isWeekday } from '@/lib/dates';

describe('toDateStr', () => {
  it('formats a date as YYYY-MM-DD using local time', () => {
    const d = new Date(2026, 4, 29, 14, 0); // May 29 2026
    expect(toDateStr(d)).toBe('2026-05-29');
  });
  it('pads single-digit months and days', () => {
    const d = new Date(2026, 0, 1, 12, 0);
    expect(toDateStr(d)).toBe('2026-01-01');
  });
});

describe('parseDateStr → addDays round trip', () => {
  it('addDays(+1) advances one calendar day', () => {
    expect(addDays('2026-05-29', 1)).toBe('2026-05-30');
  });
  it('addDays(-1) regresses one calendar day', () => {
    expect(addDays('2026-05-29', -1)).toBe('2026-05-28');
  });
  it('crosses month boundaries', () => {
    expect(addDays('2026-05-31', 1)).toBe('2026-06-01');
  });
  it('crosses year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('handles leap day correctly', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2028-02-29', 1)).toBe('2028-03-01');
  });
  it('parseDateStr uses noon to avoid DST shift', () => {
    const d = parseDateStr('2026-03-29');
    expect(d.getHours()).toBe(12);
  });
});

describe('isWeekday / isFriday', () => {
  it('isWeekday matches Mon–Thu', () => {
    expect(isWeekday('2026-06-01')).toBe(true);  // Mon
    expect(isWeekday('2026-06-02')).toBe(true);  // Tue
    expect(isWeekday('2026-06-04')).toBe(true);  // Thu
  });
  it('isWeekday rejects Fri/Sat/Sun', () => {
    expect(isWeekday('2026-06-05')).toBe(false); // Fri
    expect(isWeekday('2026-06-06')).toBe(false); // Sat
    expect(isWeekday('2026-06-07')).toBe(false); // Sun
  });
  it('isFriday matches Friday', () => {
    expect(isFriday('2026-06-05')).toBe(true);
    expect(isFriday('2026-06-06')).toBe(false);
  });
});
