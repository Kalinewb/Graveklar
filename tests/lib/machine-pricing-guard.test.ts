/**
 * L1 — which machine edits count as a pricing change.
 *
 * This is the predicate that decides whether the second factor is demanded on
 * `/api/admin/machines`. Two failure directions matter: a real price change
 * that slips through as "unchanged" (a stolen session silently re-prices the
 * fleet) and a non-price edit that demands 2FA (an admin who cannot fix a typo
 * in a description without their phone).
 */
import { describe, expect, it } from 'vitest';

import {
  MACHINE_PRICE_FIELDS,
  type MachinePriceField,
  changedPriceFields,
  pricedFields,
  totpRejection,
} from '@/lib/machine-pricing-guard';

const current = (overrides: Partial<Record<MachinePriceField, number | null>> = {}) =>
  Object.fromEntries(
    MACHINE_PRICE_FIELDS.map((f) => [f, overrides[f] ?? null]),
  ) as Record<MachinePriceField, number | null>;

describe('MACHINE_PRICE_FIELDS', () => {
  it('covers every money field and nothing else', () => {
    expect([...MACHINE_PRICE_FIELDS]).toEqual([
      'dayPrice',
      'weekendPrice',
      'weekPrice',
      'dayIncludedHours',
      'weekendIncludedHours',
      'weekIncludedHours',
      'overtimeRate',
      'preOrderHourRate',
    ]);
    // Fuel/photo/description are explicitly not money.
    for (const notMoney of ['fuelTankLiters', 'fuelConsumptionPerHour', 'photoScale', 'description', 'quantity']) {
      expect(MACHINE_PRICE_FIELDS as readonly string[]).not.toContain(notMoney);
    }
  });
});

describe('changedPriceFields', () => {
  it('is empty for a body with no price fields at all', () => {
    expect(changedPriceFields({ description: 'ny tekst', isActive: false }, current())).toEqual([]);
  });

  it('is empty when a price is echoed back unchanged, in either representation', () => {
    const now = current({ dayPrice: 2490, weekIncludedHours: 40 });
    expect(changedPriceFields({ dayPrice: 2490 }, now)).toEqual([]);
    // The admin form posts strings; the write path coerces with Number(), so
    // "2490" is not a change.
    expect(changedPriceFields({ dayPrice: '2490' }, now)).toEqual([]);
    expect(changedPriceFields({ dayPrice: 2490.0, weekIncludedHours: '40' }, now)).toEqual([]);
  });

  it('reports each field that would be written differently', () => {
    const now = current({ dayPrice: 2490, weekPrice: 9900 });
    expect(changedPriceFields({ dayPrice: 2990, weekPrice: 9900 }, now)).toEqual([
      { key: 'dayPrice', from: 2490, to: 2990 },
    ]);
    expect(changedPriceFields({ dayPrice: 1, weekPrice: 2 }, now)).toHaveLength(2);
  });

  it('treats clearing a price and setting one from empty as changes', () => {
    expect(changedPriceFields({ dayPrice: null }, current({ dayPrice: 2490 }))).toEqual([
      { key: 'dayPrice', from: 2490, to: null },
    ]);
    expect(changedPriceFields({ overtimeRate: 350 }, current())).toEqual([
      { key: 'overtimeRate', from: null, to: 350 },
    ]);
  });

  it('ignores fields the body omits, so a partial PATCH never trips 2FA', () => {
    const now = current({ dayPrice: 2490, weekPrice: 9900, overtimeRate: 350 });
    expect(changedPriceFields({ isActive: true }, now)).toEqual([]);
    expect(changedPriceFields({ dayPrice: undefined }, now)).toEqual([]);
  });

  it('counts a 0 price as a change away from null (0 is a price, not "unset")', () => {
    expect(changedPriceFields({ dayPrice: 0 }, current())).toEqual([
      { key: 'dayPrice', from: null, to: 0 },
    ]);
  });

  it('treats an unparseable price as a change to NaN rather than silently ignoring it', () => {
    // Number('abc') is NaN, and NaN !== null, so the guard demands the second
    // factor. Fail-closed: a garbage price is escalated, not waved through.
    const changes = changedPriceFields({ dayPrice: 'abc' }, current({ dayPrice: 2490 }));
    expect(changes).toHaveLength(1);
    expect(Number.isNaN(changes[0].to as number)).toBe(true);
  });
});

describe('pricedFields', () => {
  it('is empty for a create payload with no prices', () => {
    expect(pricedFields({ name: 'Ny graver', model: 'TB216' })).toEqual([]);
    expect(pricedFields({ dayPrice: null, weekPrice: undefined })).toEqual([]);
  });

  it('lists every price the create payload sets', () => {
    expect(pricedFields({ name: 'x', dayPrice: 2490, weekPrice: '9900' })).toEqual([
      { key: 'dayPrice', from: null, to: 2490 },
      { key: 'weekPrice', from: null, to: 9900 },
    ]);
  });

  it('counts a zero price as priced', () => {
    expect(pricedFields({ dayPrice: 0 })).toEqual([{ key: 'dayPrice', from: null, to: 0 }]);
  });
});

describe('totpRejection', () => {
  it('shapes a 401 the admin UI\'s TOTP modal can act on', async () => {
    for (const [reason, enrollment] of [
      ['not-enrolled', true],
      ['missing', false],
      ['invalid', false],
    ] as const) {
      const res = totpRejection(reason);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.requiresTotp).toBe(true);
      expect(body.requiresTotpEnrollment).toBe(enrollment);
      expect(typeof body.error).toBe('string');
      expect(body.error.length).toBeGreaterThan(0);
    }
  });

  it('never leaks which price field triggered the refusal', async () => {
    const body = await totpRejection('missing').json();
    for (const field of MACHINE_PRICE_FIELDS) {
      expect(JSON.stringify(body)).not.toContain(field);
    }
  });
});
