import { describe, expect, it } from 'vitest';
import {
  contractSigningLabel,
  isHandoverAllowed,
  resolveContractSigning,
} from '@/lib/contract-signing';
import { buildRentalFlowContext, computeRentalFlow } from '@/lib/rental-flow';

describe('resolveContractSigning', () => {
  it('keeps paid online bookings pending until Digipost/papir is marked', () => {
    const view = resolveContractSigning({
      status: 'confirmed',
      fullyPaidAt: new Date('2026-01-01'),
      termsAcceptedAt: new Date('2026-01-01'),
    });
    expect(view.status).toBe('pending');
    expect(isHandoverAllowed({
      status: 'confirmed',
      fullyPaidAt: new Date('2026-01-01'),
      termsAcceptedAt: new Date('2026-01-01'),
    })).toBe(false);
  });

  it('blocks handover until digipost signed', () => {
    const pending = resolveContractSigning({
      status: 'confirmed',
      contractSigningStatus: 'pending',
    });
    expect(contractSigningLabel(pending)).toContain('ikke sendt');
    expect(isHandoverAllowed({ status: 'confirmed', contractSigningStatus: 'pending' })).toBe(false);

    const sent = resolveContractSigning({
      status: 'confirmed',
      contractSigningStatus: 'sent',
      contractSigningMethod: 'digipost',
      contractSentAt: new Date(),
    });
    expect(contractSigningLabel(sent)).toContain('Digipost');
    expect(isHandoverAllowed({ status: 'confirmed', contractSigningStatus: 'sent' })).toBe(false);

    expect(
      isHandoverAllowed({ status: 'confirmed', contractSigningStatus: 'signed', contractSigningMethod: 'digipost' }),
    ).toBe(true);
    expect(
      isHandoverAllowed({ status: 'confirmed', contractSigningStatus: 'paper', contractSigningMethod: 'paper' }),
    ).toBe(true);
  });
});

describe('computeRentalFlow', () => {
  const phases = [
    { id: '1', name: 'Klargjøring', isActive: true, audience: 'operator', items: [] },
    { id: '2', name: 'Levering', isActive: true, audience: 'operator', items: [] },
    { id: '3', name: 'Retur', isActive: true, audience: 'operator', isCompletionTrigger: true, items: [] },
  ];

  it('prioritises contract signing before prep', () => {
    const ctx = buildRentalFlowContext({
      booking: {
        status: 'confirmed',
        startDate: '2026-07-01',
        selfPickup: false,
        contractSigningStatus: 'pending',
      },
      phases,
      todayStr: '2026-06-30',
      endDate: '2026-07-01',
    });
    expect(computeRentalFlow(ctx).step).toBe('send_contract');
  });
});
