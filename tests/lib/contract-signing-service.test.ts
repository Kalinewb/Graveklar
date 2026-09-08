import { describe, expect, it } from 'vitest';
import {
  buildContractSigningUpdate,
  serializeContractSigningBooking,
} from '@/lib/contract-signing-service';

describe('buildContractSigningUpdate', () => {
  it('marks digipost signed with reference', () => {
    const data = buildContractSigningUpdate('mark_signed', {
      digipostReference: 'DP-99',
      note: 'OK',
    });
    expect(data.contractSigningMethod).toBe('digipost');
    expect(data.contractSigningStatus).toBe('signed');
    expect(data.digipostReference).toBe('DP-99');
    expect(data.contractSigningNote).toBe('OK');
    expect(data.contractSignedAt).toBeInstanceOf(Date);
  });
});

describe('serializeContractSigningBooking', () => {
  it('serializes dates to ISO strings', () => {
    const out = serializeContractSigningBooking({
      id: 'x',
      status: 'confirmed',
      email: 'a@b.no',
      contractSigningMethod: 'digipost',
      contractSigningStatus: 'signed',
      contractSentAt: new Date('2026-06-01T10:00:00Z'),
      contractSignedAt: new Date('2026-06-01T12:00:00Z'),
      digipostReference: 'DP-1',
      contractSigningNote: null,
      termsAcceptedAt: null,
      fullyPaidAt: null,
    });
    expect(out.contractSignedAt).toBe('2026-06-01T12:00:00.000Z');
  });
});
