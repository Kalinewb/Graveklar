import { describe, it, expect } from 'vitest';
import { formatMachineLabel } from '@/lib/machine-display';

describe('formatMachineLabel', () => {
  it('shows name only when model duplicates name', () => {
    expect(formatMachineLabel({ name: 'Rippa', model: 'Rippa' })).toBe('Rippa');
  });

  it('includes distinct model and year', () => {
    expect(formatMachineLabel({ name: 'Rippa', model: 'R22-1 PRO', year: 2024 }))
      .toBe('Rippa · R22-1 PRO · 2024');
  });
});
