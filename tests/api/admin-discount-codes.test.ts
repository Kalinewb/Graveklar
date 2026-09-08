import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// `isAdminAuthenticated()` reads the AMBIENT cookie store (`cookies()` from
// next/headers), not the request it was handed, so an in-process handler call
// throws "`cookies` was called outside a request scope". This file provides a
// request-scope-free store and drives it per test. Flag F-E8 records that the
// admin routes therefore ignore the cookies on their own NextRequest.
const store = vi.hoisted(() => ({ jar: {} as Record<string, string> }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name in store.jar ? { name, value: store.jar[name] } : undefined),
    getAll: () => Object.entries(store.jar).map(([name, value]) => ({ name, value })),
    has: (name: string) => name in store.jar,
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers(),
}));

import {
  booking,
  campaignCode,
  db,
  ensureSchema,
  repeatCode,
  resetDb,
  seedConfigDefaults,
} from '../helpers/db';
import {
  COOKIE_NAME,
  adminSessionToken,
  call,
  matcherMatches,
  proxyCall,
  type RouteHandler,
} from '../helpers/route';

// L2 — /api/admin/discount-codes (+ /[id]). Campaign-code CRUD: the only place
// a human can mint a percentage off every future booking.

let list: typeof import('@/app/api/admin/discount-codes/route');
let byId: { PATCH: RouteHandler; DELETE: RouteHandler };

async function signIn(): Promise<void> {
  store.jar = { [COOKIE_NAME]: await adminSessionToken() };
}
function signOut(): void {
  store.jar = {};
}

beforeAll(async () => {
  await ensureSchema();
  list = await import('@/app/api/admin/discount-codes/route');
  // The [id] handlers declare `params: Promise<{ id: string }>`; the harness
  // hands over the generic RouteParams shape.
  byId = (await import('@/app/api/admin/discount-codes/[id]/route')) as unknown as typeof byId;
});

beforeEach(async () => {
  await resetDb();
  await seedConfigDefaults();
  await signIn();
});

describe('auth', () => {
  it('the proxy 401s every /api/admin path without a session', async () => {
    expect(matcherMatches('/api/admin/discount-codes')).toBe(true);
    expect(matcherMatches('/api/admin/discount-codes/abc')).toBe(true);
    const res = await proxyCall('/api/admin/discount-codes');
    expect(res.status).toBe(401);
  });

  it('each handler 401s on its own when the session is missing', async () => {
    signOut();
    const c = await campaignCode();
    expect((await call(list.GET, { path: '/api/admin/discount-codes' })).status).toBe(401);
    expect(
      (await call(list.POST, { method: 'POST', path: '/api/admin/discount-codes', body: { code: 'ABC' } }))
        .status,
    ).toBe(401);
    expect(
      (await call(byId.PATCH, { method: 'PATCH', body: { isActive: false }, params: { id: c.id } })).status,
    ).toBe(401);
    expect((await call(byId.DELETE, { method: 'DELETE', params: { id: c.id } })).status).toBe(401);
    expect(await db.campaignDiscountCode.count()).toBe(1); // nothing was touched
  });
});

describe('GET /api/admin/discount-codes', () => {
  it('returns both code families with an empty database', async () => {
    const res = await call(list.GET, { path: '/api/admin/discount-codes' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ repeat: [], campaigns: [] });
  });

  it('resolves the bookings behind a repeat code', async () => {
    const issued = await booking('completed', { email: 'kunde@example.com', startDateStr: '2027-05-03' });
    const used = await booking('confirmed', { email: 'kunde@example.com', startDateStr: '2027-06-07' });
    await repeatCode({
      code: 'RETUR-ABCDEFGH',
      email: 'kunde@example.com',
      issuedForBookingId: issued.id,
      redeemedByBookingId: used.id,
      redeemedAt: new Date(),
    });

    const res = await call(list.GET, { path: '/api/admin/discount-codes' });
    expect(res.json.repeat).toHaveLength(1);
    expect(res.json.repeat[0]).toMatchObject({
      code: 'RETUR-ABCDEFGH',
      email: 'kunde@example.com',
      issuedFor: { reference: issued.reference },
      redeemedBy: { reference: used.reference },
    });
  });

  it('includes campaign redemptions with the customer reference', async () => {
    const b = await booking('confirmed', { email: 'kunde@example.com' });
    const c = await campaignCode({ code: 'SOMMER-2026', percent: 20, maxUses: 10, usedCount: 1 });
    await db.campaignRedemption.create({
      data: { codeId: c.id, bookingId: b.id, email: 'kunde@example.com' },
    });

    const res = await call(list.GET, { path: '/api/admin/discount-codes' });
    expect(res.json.campaigns[0]).toMatchObject({
      code: 'SOMMER-2026',
      percent: 20,
      maxUses: 10,
      usedCount: 1,
      isActive: true,
    });
    expect(res.json.campaigns[0].redemptions[0]).toMatchObject({
      email: 'kunde@example.com',
      bookingRef: b.reference,
      customerName: b.name,
    });
  });
});

describe('POST /api/admin/discount-codes — code format', () => {
  async function create(body: Record<string, unknown>) {
    return call(list.POST, { method: 'POST', path: '/api/admin/discount-codes', body });
  }

  it('accepts A–Z, 0–9 and hyphen, 3…32 characters', async () => {
    for (const code of ['ABC', 'SOMMER-2026', 'A-1', 'X'.repeat(32)]) {
      const res = await create({ code, percent: 10, maxUses: null });
      expect(res.status).toBe(200);
      expect(res.json.campaign.code).toBe(code);
    }
  });

  it('uppercases and trims what the admin typed', async () => {
    const res = await create({ code: '  sommer-2026 ', percent: 10, maxUses: null });
    expect(res.json.campaign.code).toBe('SOMMER-2026');
  });

  it('400s on anything the regex refuses', async () => {
    for (const code of ['', 'AB', 'X'.repeat(33), 'SOMMER 2026', 'SOMMER_2026', 'SØMMER', 'ABC!', null]) {
      const res = await create({ code, percent: 10, maxUses: null });
      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/Ugyldig kode/);
    }
    expect(await db.campaignDiscountCode.count()).toBe(0);
  });

  it('409s on a collision with an existing campaign code', async () => {
    await campaignCode({ code: 'SOMMER-2026' });
    const res = await create({ code: 'sommer-2026', percent: 10, maxUses: null });
    expect(res.status).toBe(409);
    expect(res.json).toEqual({ error: 'Koden eksisterer allerede.' });
    expect(await db.campaignDiscountCode.count()).toBe(1);
  });

  it('409s on a collision with an issued RETUR code', async () => {
    await repeatCode({ code: 'RETUR-ABCDEFGH', email: 'kunde@example.com' });
    const res = await create({ code: 'RETUR-ABCDEFGH', percent: 10, maxUses: null });
    expect(res.status).toBe(409);
    expect(await db.campaignDiscountCode.count()).toBe(0);
  });
});

describe('POST /api/admin/discount-codes — value clamping', () => {
  async function create(body: Record<string, unknown>) {
    return call(list.POST, { method: 'POST', path: '/api/admin/discount-codes', body });
  }

  it('clamps percent into 1…100', async () => {
    const cases: [unknown, number][] = [
      [0, 1],
      [-5, 1],
      [1, 1],
      [50, 50],
      [100, 100],
      [150, 100],
      ['abc', 1],
      [undefined, 1],
      ['25', 25],
    ];
    let n = 0;
    for (const [given, expected] of cases) {
      const res = await create({ code: `KODE-${++n}00`, percent: given, maxUses: null });
      expect(res.json.campaign.percent, `percent ${String(given)}`).toBe(expected);
    }
  });

  it('maxUses: null and "" mean unlimited, a number is floored at 1', async () => {
    expect((await create({ code: 'MAX-NULL', percent: 10, maxUses: null })).json.campaign.maxUses).toBeNull();
    expect((await create({ code: 'MAX-TOM', percent: 10, maxUses: '' })).json.campaign.maxUses).toBeNull();
    expect((await create({ code: 'MAX-NULL0', percent: 10, maxUses: 0 })).json.campaign.maxUses).toBe(1);
    expect((await create({ code: 'MAX-NEG', percent: 10, maxUses: -3 })).json.campaign.maxUses).toBe(1);
    expect((await create({ code: 'MAX-FEM', percent: 10, maxUses: 5 })).json.campaign.maxUses).toBe(5);
  });

  it('omitting maxUses silently produces a SINGLE-use code (flag F-E9)', async () => {
    // `body.maxUses === null` is false for `undefined`, so the else branch runs
    // and Number(undefined) || 1 lands on 1. An admin tool that leaves the
    // field out gets a one-shot code rather than an unlimited one.
    const res = await create({ code: 'MAX-MANGLER', percent: 10 });
    expect(res.json.campaign.maxUses).toBe(1);
  });

  it('isActive defaults to true and only an explicit false switches it off', async () => {
    expect((await create({ code: 'AKTIV-A', percent: 10, maxUses: null })).json.campaign.isActive).toBe(true);
    expect(
      (await create({ code: 'AKTIV-B', percent: 10, maxUses: null, isActive: false })).json.campaign.isActive,
    ).toBe(false);
    expect(
      (await create({ code: 'AKTIV-C', percent: 10, maxUses: null, isActive: 0 })).json.campaign.isActive,
    ).toBe(true);
  });

  it('records the creation in the audit log', async () => {
    await create({ code: 'REVISJON', percent: 25, maxUses: 3 });
    const rows = await db.adminAuditLog.findMany({ where: { action: 'discount_code.create' } });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].changes)).toEqual([
      { key: 'code', from: null, to: 'REVISJON' },
      { key: 'percent', from: null, to: 25 },
      { key: 'maxUses', from: null, to: 3 },
    ]);
  });

  // FIXED E-5: neither handler wrapped `req.json()` or the Prisma write, so
  // malformed input escaped as an unhandled exception (a bare 500 in
  // production) instead of the 400 the shape checks above return.
  it('malformed input must be answered, not thrown', async () => {
    // FIXED E-5: POST, PATCH and DELETE all answer a shape error with a 400
    // and a generic Norwegian message.
    const res = await call(list.POST, {
      method: 'POST',
      path: '/api/admin/discount-codes',
      body: '{ not json',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });

  it('…and an unparseable body and an unparseable date are both 400s (E-5)', async () => {
    const badBody = await call(list.POST, {
      method: 'POST',
      path: '/api/admin/discount-codes',
      body: '{ not json',
      headers: { 'content-type': 'application/json' },
    });
    expect(badBody.status).toBe(400);
    expect(badBody.json).toEqual({ error: 'Ugyldig forespørsel.' });

    const badDate = await call(list.POST, {
      method: 'POST',
      path: '/api/admin/discount-codes',
      body: { code: 'DATO-FEIL', percent: 10, maxUses: null, expiresAt: 'i morgen' },
    });
    expect(badDate.status).toBe(400);
    expect(badDate.json).toEqual({ error: 'Ugyldig utløpsdato.' });
    expect(await db.campaignDiscountCode.count({ where: { code: 'DATO-FEIL' } })).toBe(0);
  });
});

describe('PATCH /api/admin/discount-codes/[id]', () => {
  async function patch(id: string, body: Record<string, unknown>) {
    return call(byId.PATCH, {
      method: 'PATCH',
      path: `/api/admin/discount-codes/${id}`,
      body,
      params: { id },
    });
  }

  it('404s on an unknown id', async () => {
    const res = await patch('does-not-exist', { isActive: false });
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: 'not_found' });
  });

  it('toggles isActive and audits the change', async () => {
    const c = await campaignCode({ code: 'AKTIV-KODE' });
    const res = await patch(c.id, { isActive: false });
    expect(res.status).toBe(200);
    expect(res.json.campaign.isActive).toBe(false);

    const audit = await db.adminAuditLog.findMany({ where: { action: 'discount_code.update' } });
    expect(JSON.parse(audit[0].changes)).toContainEqual({ key: 'isActive', from: true, to: false });
  });

  it('changes percent while the code is unused, and clamps it', async () => {
    const c = await campaignCode({ code: 'NY-SATS', percent: 10, usedCount: 0 });
    expect((await patch(c.id, { percent: 55 })).json.campaign.percent).toBe(55);
    expect((await patch(c.id, { percent: 500 })).json.campaign.percent).toBe(100);
    expect((await patch(c.id, { percent: 0 })).json.campaign.percent).toBe(1);
    expect((await patch(c.id, { percent: 'abc' })).json.campaign.percent).toBe(1);
  });

  it('409s on a percent change once the code has been used', async () => {
    const c = await campaignCode({ code: 'BRUKT-KODE', percent: 10, usedCount: 1 });
    const res = await patch(c.id, { percent: 50 });
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/låst etter første bruk/);
    const row = await db.campaignDiscountCode.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.percent).toBe(10);
  });

  it('re-sending the SAME percent on a used code is a no-op, not a 409', async () => {
    const c = await campaignCode({ code: 'BRUKT-KODE', percent: 10, usedCount: 3 });
    const res = await patch(c.id, { percent: 10, isActive: false });
    expect(res.status).toBe(200);
    expect(res.json.campaign.percent).toBe(10);
    expect(res.json.campaign.isActive).toBe(false);
  });

  it('the 409 aborts the whole patch — isActive is not applied either', async () => {
    const c = await campaignCode({ code: 'BRUKT-KODE', percent: 10, usedCount: 1, isActive: true });
    await patch(c.id, { percent: 50, isActive: false });
    const row = await db.campaignDiscountCode.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.isActive).toBe(true);
  });

  it('updates maxUses and expiresAt, and clears expiry with null', async () => {
    const c = await campaignCode({ code: 'GRENSER' });
    expect((await patch(c.id, { maxUses: 7 })).json.campaign.maxUses).toBe(7);
    expect((await patch(c.id, { maxUses: null })).json.campaign.maxUses).toBeNull();
    expect((await patch(c.id, { maxUses: 0 })).json.campaign.maxUses).toBe(1);

    const iso = '2027-01-01T00:00:00.000Z';
    expect((await patch(c.id, { expiresAt: iso })).json.campaign.expiresAt).toBe(iso);
    expect((await patch(c.id, { expiresAt: null })).json.campaign.expiresAt).toBeNull();
  });

  it('maxUses can be lowered below usedCount, which exhausts the code immediately', async () => {
    const c = await campaignCode({ code: 'SENK-GRENSE', maxUses: 10, usedCount: 4 });
    await patch(c.id, { maxUses: 2 });
    const { validateRepeatCode } = await import('@/lib/discount-engine');
    expect(await validateRepeatCode('SENK-GRENSE', '')).toEqual({ ok: false, reason: 'exhausted' });
  });

  it('writes no audit row when nothing actually changed', async () => {
    const c = await campaignCode({ code: 'UENDRET', percent: 10, isActive: true });
    const res = await patch(c.id, { isActive: true, notes: null });
    expect(res.status).toBe(200);
    expect(await db.adminAuditLog.count({ where: { action: 'discount_code.update' } })).toBe(0);
  });
});

describe('DELETE /api/admin/discount-codes/[id]', () => {
  async function del(id: string) {
    return call(byId.DELETE, {
      method: 'DELETE',
      path: `/api/admin/discount-codes/${id}`,
      params: { id },
    });
  }

  it('404s on an unknown id', async () => {
    expect((await del('does-not-exist')).status).toBe(404);
  });

  it('removes the code, cascades its redemptions and audits the deletion', async () => {
    const b = await booking('confirmed', { email: 'kunde@example.com' });
    const c = await campaignCode({ code: 'SLETTES', percent: 20, usedCount: 1 });
    await db.campaignRedemption.create({
      data: { codeId: c.id, bookingId: b.id, email: 'kunde@example.com' },
    });

    const res = await del(c.id);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ success: true });
    expect(await db.campaignDiscountCode.count()).toBe(0);
    expect(await db.campaignRedemption.count()).toBe(0);

    const audit = await db.adminAuditLog.findMany({ where: { action: 'discount_code.delete' } });
    expect(JSON.parse(audit[0].changes)).toContainEqual({ key: 'code', from: 'SLETTES', to: null });
  });

  it('deleting a campaign code frees the value for reuse', async () => {
    const c = await campaignCode({ code: 'GJENBRUK' });
    await del(c.id);
    const res = await call(list.POST, {
      method: 'POST',
      path: '/api/admin/discount-codes',
      body: { code: 'GJENBRUK', percent: 10, maxUses: null },
    });
    expect(res.status).toBe(200);
  });
});
