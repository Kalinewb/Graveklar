import { describe, it, expect } from 'vitest';
import { getCancelFreeHours, getCancelFreeLabel } from '@/lib/cancellation';

describe('getCancelFreeHours', () => {
  it('converts weeks + days to hours', () => {
    expect(getCancelFreeHours({ cancelFreeWeeks: '2', cancelFreeDays: '3' })).toBe(2 * 168 + 3 * 24);
  });
  it('treats missing keys as 0', () => {
    expect(getCancelFreeHours({})).toBe(0);
  });
  it('tolerates non-numeric strings', () => {
    expect(getCancelFreeHours({ cancelFreeWeeks: 'abc', cancelFreeDays: '1' })).toBe(24);
  });
  it('handles zero values explicitly', () => {
    expect(getCancelFreeHours({ cancelFreeWeeks: '0', cancelFreeDays: '0' })).toBe(0);
  });
});

describe('getCancelFreeLabel', () => {
  it('renders weeks + days', () => {
    expect(getCancelFreeLabel({ cancelFreeWeeks: '2', cancelFreeDays: '3' })).toBe('2 uker og 3 dager');
  });
  it('handles singular week', () => {
    expect(getCancelFreeLabel({ cancelFreeWeeks: '1', cancelFreeDays: '0' })).toBe('1 uke');
  });
  it('handles only days', () => {
    expect(getCancelFreeLabel({ cancelFreeWeeks: '0', cancelFreeDays: '5' })).toBe('5 dager');
  });
  it('handles 1 day singular', () => {
    expect(getCancelFreeLabel({ cancelFreeDays: '1' })).toBe('1 dag');
  });
  it('returns "0 timer" for empty config', () => {
    expect(getCancelFreeLabel({})).toBe('0 timer');
  });
});
