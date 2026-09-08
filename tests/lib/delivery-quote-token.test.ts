import { describe, it, expect } from 'vitest';
import {
  signDeliveryQuoteToken,
  verifyDeliveryQuoteToken,
  normalizeDeliveryAddress,
} from '@/lib/delivery-quote-token';

const quote = { address: 'Storgata 1, Bodø', distance: 12.3, fee: 0 };

describe('delivery quote token', () => {
  it('round-trips the exact quote', async () => {
    const token = await signDeliveryQuoteToken(quote);
    expect(await verifyDeliveryQuoteToken(token, quote)).toBe(true);
  });

  it('tolerates whitespace/case differences in the address', async () => {
    const token = await signDeliveryQuoteToken(quote);
    expect(await verifyDeliveryQuoteToken(token, { ...quote, address: '  storgata 1,   BODØ ' })).toBe(true);
    expect(normalizeDeliveryAddress('  Storgata  1 ')).toBe('storgata 1');
  });

  it('rejects a shorter distance or lower fee than was measured', async () => {
    const paid = { address: 'Fjellveien 9, Fauske', distance: 61.4, fee: 1162 };
    const token = await signDeliveryQuoteToken(paid);
    expect(await verifyDeliveryQuoteToken(token, { ...paid, distance: 10 })).toBe(false);
    expect(await verifyDeliveryQuoteToken(token, { ...paid, fee: 0 })).toBe(false);
  });

  it('rejects a different address, a tampered token, and a missing token', async () => {
    const token = await signDeliveryQuoteToken(quote);
    expect(await verifyDeliveryQuoteToken(token, { ...quote, address: 'Kirkegata 2, Bodø' })).toBe(false);
    expect(await verifyDeliveryQuoteToken(token.slice(0, -2) + 'AA', quote)).toBe(false);
    expect(await verifyDeliveryQuoteToken(null, quote)).toBe(false);
    expect(await verifyDeliveryQuoteToken('not-a-token', quote)).toBe(false);
  });

  it('handles non-Latin-1 characters in the address', async () => {
    const q = { address: 'Øvre Bakke 3 – Tromsø 🚜', distance: 3, fee: 0 };
    const token = await signDeliveryQuoteToken(q);
    expect(await verifyDeliveryQuoteToken(token, q)).toBe(true);
  });
});
