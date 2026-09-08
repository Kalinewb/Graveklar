import { describe, it, expect } from 'vitest';
import { buildPricingFromConfig, calculateCustomPrice, getConfigValue, DEFAULT_CONFIG } from '@/lib/pricing';

const baseConfig = { ...DEFAULT_CONFIG };

describe('buildPricingFromConfig', () => {
  it('day price = weekdayHourly × dayIncludedHours when no override', () => {
    const p = buildPricingFromConfig(baseConfig);
    expect(p.day.basePrice).toBe(baseConfig.weekdayHourly * baseConfig.dayIncludedHours);
    expect(p.day.includedHours).toBe(baseConfig.dayIncludedHours);
  });
  it('weekend price = weekendHourly × weekendIncludedHours', () => {
    const p = buildPricingFromConfig(baseConfig);
    expect(p.weekend.basePrice).toBe(baseConfig.weekendHourly * baseConfig.weekendIncludedHours);
  });
  it('week price = weeklyHourly × weekIncludedHours', () => {
    const p = buildPricingFromConfig(baseConfig);
    expect(p.week.basePrice).toBe(baseConfig.weeklyHourly * baseConfig.weekIncludedHours);
  });
  it('per-machine dayPrice override beats computed', () => {
    const p = buildPricingFromConfig({ ...baseConfig, dayPrice: 4242 });
    expect(p.day.basePrice).toBe(4242);
  });
  it('custom tier has zero base — built by calculateCustomPrice instead', () => {
    const p = buildPricingFromConfig(baseConfig);
    expect(p.custom.basePrice).toBe(0);
    expect(p.custom.includedHours).toBe(0);
  });
});

describe('calculateCustomPrice', () => {
  it('weekdayHourly × dayIncludedHours × days for all-weekday rental', () => {
    // 2026-06-01 is Monday. 4 days = Mon Tue Wed Thu.
    const b = calculateCustomPrice('2026-06-01', 4, baseConfig);
    expect(b.weekdayDays).toBe(4);
    expect(b.weekendDays).toBe(0);
    expect(b.totalPrice).toBe(4 * baseConfig.weekdayHourly * baseConfig.dayIncludedHours);
  });
  it('mixed weekdays + weekend uses correct hourly rate per day', () => {
    // 2026-06-05 Fri, 06 Sat, 07 Sun, 08 Mon → 1 weekday, 2 weekend, 1 weekday
    const b = calculateCustomPrice('2026-06-05', 4, baseConfig);
    expect(b.weekdayDays).toBe(2); // Fri + Mon
    expect(b.weekendDays).toBe(2); // Sat + Sun
    const expected =
      2 * baseConfig.weekdayHourly * baseConfig.dayIncludedHours +
      2 * baseConfig.weekendHourly * baseConfig.dayIncludedHours;
    expect(b.totalPrice).toBe(expected);
  });
  it('produces a breakdown row per day with correct labels', () => {
    const b = calculateCustomPrice('2026-06-01', 3, baseConfig);
    expect(b.days).toHaveLength(3);
    expect(b.days[0].label).toBe('Man');
    expect(b.days[1].label).toBe('Tir');
    expect(b.days[2].label).toBe('Ons');
  });
  it('totalHours = days × dayIncludedHours', () => {
    const b = calculateCustomPrice('2026-06-01', 7, baseConfig);
    expect(b.totalHours).toBe(7 * baseConfig.dayIncludedHours);
  });
});

describe('getConfigValue', () => {
  it('returns value when present', () => {
    expect(getConfigValue({ foo: 42 }, 'foo')).toBe(42);
  });
  it('falls back to DEFAULT_CONFIG when missing', () => {
    expect(getConfigValue({}, 'weekdayHourly')).toBe(DEFAULT_CONFIG.weekdayHourly);
  });
  it('returns 0 for fully unknown keys', () => {
    expect(getConfigValue({}, 'someNonexistentKey')).toBe(0);
  });
});
