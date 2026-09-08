import { describe, it, expect } from 'vitest';
import { rentalDayCount, getRentalDateRange } from '@/lib/availability';

describe('rentalDayCount', () => {
  it('day = 1', () => {
    expect(rentalDayCount('day')).toBe(1);
  });
  it('weekend = 3', () => {
    expect(rentalDayCount('weekend')).toBe(3);
  });
  it('week honors customDays only as a multiple of 7', () => {
    // The booking form's week-count stepper sends `customDays = weeks * 7`.
    // Multi-week rentals (1..8 weeks) are honored here. Defend against
    // partial weeks: a non-multiple-of-7 customDays falls back to 7 so a
    // stale or hand-crafted request can't sneak through.
    expect(rentalDayCount('week')).toBe(7);
    expect(rentalDayCount('week', 14)).toBe(14);
    expect(rentalDayCount('week', 21)).toBe(21);
    expect(rentalDayCount('week', 56)).toBe(56);
    expect(rentalDayCount('week', 3)).toBe(7);
    expect(rentalDayCount('week', 10)).toBe(7);
    expect(rentalDayCount('week', 0)).toBe(7);
  });
  it('custom honors customDays', () => {
    expect(rentalDayCount('custom', 5)).toBe(5);
    expect(rentalDayCount('custom', 1)).toBe(1);
  });
  it('custom defaults to 2 when customDays is missing/zero', () => {
    expect(rentalDayCount('custom')).toBe(2);
    expect(rentalDayCount('custom', 0)).toBe(2);
    expect(rentalDayCount('custom', null)).toBe(2);
  });
});

describe('getRentalDateRange', () => {
  it('returns single-day list for "day"', () => {
    expect(getRentalDateRange('2026-06-01', 'day')).toEqual(['2026-06-01']);
  });
  it('returns three days for "weekend"', () => {
    expect(getRentalDateRange('2026-06-05', 'weekend')).toEqual([
      '2026-06-05', '2026-06-06', '2026-06-07',
    ]);
  });
  it('returns seven days for "week"', () => {
    const range = getRentalDateRange('2026-06-01', 'week');
    expect(range).toHaveLength(7);
    expect(range[0]).toBe('2026-06-01');
    expect(range[6]).toBe('2026-06-07');
  });
  it('respects customDays for "custom"', () => {
    expect(getRentalDateRange('2026-06-01', 'custom', 4)).toEqual([
      '2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04',
    ]);
  });
  it('crosses month boundary correctly', () => {
    expect(getRentalDateRange('2026-05-30', 'custom', 4)).toEqual([
      '2026-05-30', '2026-05-31', '2026-06-01', '2026-06-02',
    ]);
  });
});
