import { describe, it, expect } from 'vitest';
import { computeFuelNeeds, fuelCansLabel, FUEL_CAN_SIZE_L, FUEL_SAFETY_MARGIN_L } from '@/lib/fuel';

describe('computeFuelNeeds', () => {
  it('returns non-computable when specs missing', () => {
    const r = computeFuelNeeds({ totalHours: 8, tankLiters: null, consumptionPerHour: 2 });
    expect(r.computable).toBe(false);
    expect(r.cansNeeded).toBe(0);
  });

  it('needs no cans when tank covers planned total', () => {
    const r = computeFuelNeeds({ totalHours: 5, tankLiters: 28, consumptionPerHour: 3 });
    // 15 L usage + 10 margin = 25 ≤ 28
    expect(r.computable).toBe(true);
    expect(r.estimatedUsage).toBe(15);
    expect(r.plannedTotal).toBe(25);
    expect(r.cansNeeded).toBe(0);
  });

  it('rounds up cans beyond tank capacity', () => {
    const r = computeFuelNeeds({ totalHours: 20, tankLiters: 28, consumptionPerHour: 2.5 });
    // 50 + 10 = 60, beyond tank = 32 → ceil(32/20) = 2
    expect(r.cansNeeded).toBe(2);
    expect(r.beyondTank).toBe(32);
  });

  it('uses configured constants', () => {
    expect(FUEL_CAN_SIZE_L).toBe(20);
    expect(FUEL_SAFETY_MARGIN_L).toBe(10);
  });
});

describe('fuelCansLabel', () => {
  it('labels missing data', () => {
    expect(fuelCansLabel(computeFuelNeeds({ totalHours: 0, tankLiters: 0, consumptionPerHour: 0 })))
      .toBe('Drivstoff-data mangler');
  });

  it('labels zero cans', () => {
    const needs = computeFuelNeeds({ totalHours: 5, tankLiters: 28, consumptionPerHour: 3 });
    expect(fuelCansLabel(needs)).toBe('Tank dekker hele turen');
  });

  it('labels required cans', () => {
    const needs = computeFuelNeeds({ totalHours: 20, tankLiters: 28, consumptionPerHour: 2.5 });
    expect(fuelCansLabel(needs)).toBe('2 × 20 L kanner');
  });
});
