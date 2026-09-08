/**
 * L2 — equipment CRUD, and the second factor that guards its money fields.
 *
 * A machine row carries both catalogue copy and prices. The rule the routes
 * implement is that touching a price is a pricing change and needs the same
 * second factor as `/api/config`, while a description or an isActive toggle
 * goes through on the session alone. Both directions are asserted here — an
 * over-eager gate is a real cost (an admin who cannot deactivate a broken
 * machine without their phone), not just an inconvenience.
 *
 * Neither route re-checks the admin session: they rely entirely on
 * `src/proxy.ts` (flag F-13, see tests/api/proxy-boundary.test.ts).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db, booking, ensureSchema, machine, resetDb } from '../helpers/db';
import { call, totpHeader, type RouteHandler } from '../helpers/route';
import { mockClock } from '../helpers/mocks';
import { seedTotpSecret, totpCodeFor } from '../helpers/auth';

const FROZEN = '2026-09-06T12:00:05.000Z';

/**
 * The helper's `RouteHandler` hands the handler a widened
 * `Promise<Record<string, string | string[]>>`; these routes declare the narrow
 * `Promise<{ id: string }>`. The two are not assignable in either direction, so
 * the cast lives here, at the call boundary, and nowhere else.
 */
const asRoute = (handler: unknown) => handler as RouteHandler;

async function list() {
  const { GET } = await import('@/app/api/admin/machines/route');
  return call(GET, { path: '/api/admin/machines' });
}

async function create(body: unknown, headers: Record<string, string> = {}) {
  const { POST } = await import('@/app/api/admin/machines/route');
  return call(POST, { method: 'POST', path: '/api/admin/machines', body, headers });
}

async function patch(id: string, body: unknown, headers: Record<string, string> = {}) {
  const { PATCH } = await import('@/app/api/admin/machines/[id]/route');
  return call(asRoute(PATCH), {
    method: 'PATCH', path: `/api/admin/machines/${id}`, body, headers, params: { id },
  });
}

async function remove(id: string) {
  const { DELETE } = await import('@/app/api/admin/machines/[id]/route');
  return call(asRoute(DELETE), { method: 'DELETE', path: `/api/admin/machines/${id}`, params: { id } });
}

beforeAll(() => ensureSchema());
beforeEach(() => resetDb());

// ── Read ─────────────────────────────────────────────────────────────────────

describe('GET /api/admin/machines', () => {
  it('returns machines by sortOrder with their documents attached', async () => {
    const b = await machine({ name: 'B', sortOrder: 1 });
    const a = await machine({ name: 'A', sortOrder: 0 });
    await db.machineDocument.createMany({
      data: [
        { machineId: a.id, title: 'Manual', fileUrl: '/api/uploads/upload-2.pdf', sortOrder: 1 },
        { machineId: a.id, title: 'Datablad', fileUrl: '/api/uploads/upload-1.pdf', sortOrder: 0 },
      ],
    });

    const res = await list();
    expect(res.status).toBe(200);
    expect(res.json.machines.map((m: { id: string }) => m.id)).toEqual([a.id, b.id]);
    expect(res.json.machines[0].documents.map((d: { title: string }) => d.title))
      .toEqual(['Datablad', 'Manual']);
    expect(res.json.machines[1].documents).toEqual([]);
  });
});

// ── Create ───────────────────────────────────────────────────────────────────

describe('POST /api/admin/machines', () => {
  it('creates equipment without prices on the session alone', async () => {
    const res = await create({ name: 'Ny minigraver', model: 'TB216', description: 'Testmaskin' });
    expect(res.status).toBe(201);
    expect(res.json.machine).toMatchObject({ name: 'Ny minigraver', model: 'TB216', isActive: true, quantity: 1 });
    expect(res.json.machine.dayPrice).toBeNull();
    expect(await db.machine.count()).toBe(1);
  });

  it('applies the documented defaults for an almost-empty payload', async () => {
    const res = await create({});
    expect(res.status).toBe(201);
    expect(res.json.machine).toMatchObject({
      name: 'Nytt utstyr', model: '', category: null, isActive: true, sortOrder: 0, quantity: 1,
    });
  });

  it('refuses a create that sets any price while 2FA is not enrolled', async () => {
    for (const field of [
      'dayPrice', 'weekendPrice', 'weekPrice',
      'dayIncludedHours', 'weekendIncludedHours', 'weekIncludedHours',
      'overtimeRate', 'preOrderHourRate',
    ]) {
      const res = await create({ name: 'Priset', [field]: 1000 });
      expect({ field, status: res.status }).toEqual({ field, status: 401 });
      expect(res.json).toMatchObject({ requiresTotp: true, requiresTotpEnrollment: true });
    }
    expect(await db.machine.count()).toBe(0);
  });

  it('demands a code, and accepts a valid one, once 2FA is enrolled', async () => {
    await seedTotpSecret();
    const clock = mockClock(FROZEN);
    try {
      const missing = await create({ name: 'Priset', dayPrice: 2490 });
      expect(missing.status).toBe(401);
      expect(missing.json).toMatchObject({ requiresTotp: true, requiresTotpEnrollment: false });

      const invalid = await create({ name: 'Priset', dayPrice: 2490 }, totpHeader('000000'));
      expect(invalid.status).toBe(401);
      expect(await db.machine.count()).toBe(0);

      const ok = await create({ name: 'Priset', dayPrice: 2490 }, totpHeader(await totpCodeFor()));
      expect(ok.status).toBe(201);
      expect(ok.json.machine.dayPrice).toBe(2490);
    } finally {
      clock.restore();
    }
  });

  it('treats an explicitly null price as not priced', async () => {
    const res = await create({ name: 'Uten pris', dayPrice: null, weekPrice: null });
    expect(res.status).toBe(201);
  });

  it('creates documents in array order and drops entries without a fileUrl', async () => {
    const res = await create({
      name: 'Med manualer',
      documents: [
        { title: '  Bruksanvisning  ', fileUrl: '/api/uploads/upload-1.pdf' },
        { title: '', fileUrl: '/api/uploads/upload-2.pdf' },
        { title: 'Uten fil' },
        null,
        'garbage',
      ],
    });
    expect(res.status).toBe(201);

    const docs = await db.machineDocument.findMany({
      where: { machineId: res.json.machine.id }, orderBy: { sortOrder: 'asc' },
    });
    expect(docs.map((d) => [d.title, d.sortOrder])).toEqual([
      ['Bruksanvisning', 0],
      ['Dokument', 1],
    ]);
  });

  // FIXED I-4: a wrong-typed field used to be a 500, not a 400 — the create
  // path called `body.name?.trim()` (and the same for category/model/year/
  // description/imageUrl) with no type check, so a JSON number where the UI
  // sends a string threw a TypeError into the catch-all as "Kunne ikke
  // opprette utstyr". The payload is now refused with a 400 that names the
  // offending field.
  it('FIXED I-4: answers 400 when a string field arrives as a number', async () => {
    const res = await create({ name: 12345, model: 'TB216' });
    expect(res.status).toBe(400);
  });

  it('names the offending field and writes nothing', async () => {
    for (const [field, body] of [
      ['name', { name: 12345, model: 'TB216' }],
      ['category', { name: 'Ok', category: ['grave'] }],
      ['model', { name: 'Ok', model: { id: 1 } }],
      ['year', { name: 'Ok', year: 2019 }],
      ['description', { name: 'Ok', description: true }],
      ['imageUrl', { name: 'Ok', imageUrl: 7 }],
    ] as const) {
      const res = await create(body);
      expect({ field, status: res.status }).toEqual({ field, status: 400 });
      expect(res.json.error).toContain(field);
    }
    expect(await db.machine.count()).toBe(0);
  });

  it('still accepts a missing or explicitly null text field', async () => {
    const res = await create({ name: 'Kun navn', category: null, description: null });
    expect(res.status).toBe(201);
    expect(res.json.machine.category).toBeNull();
  });

  it('refuses a body that is not an object at all, without a 500', async () => {
    for (const body of ['ikke json-objekt', 42, [1, 2, 3]]) {
      const res = await create(body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
    expect(await db.machine.count()).toBe(0);
  });
});

// ── Update ───────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/machines/[id]', () => {
  it('404s for an unknown id, before doing anything else', async () => {
    const res = await patch('does-not-exist', { dayPrice: 9999 });
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('Utstyr ikke funnet');
  });

  // FIXED I-4, the update half: the same wrong-typed field used to reach
  // Prisma and come back as a 500. It is refused here, and the row is
  // untouched.
  it('answers 400 naming the field when a string field arrives as a number', async () => {
    const m = await machine({ name: 'Takeuchi TB216' });
    const res = await patch(m.id, { name: 12345 });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('name');
    expect((await db.machine.findUniqueOrThrow({ where: { id: m.id } })).name).toBe('Takeuchi TB216');
  });

  it('lets non-price edits through on the session alone', async () => {
    const m = await machine({ dayPrice: 2490 });
    const res = await patch(m.id, {
      description: 'Ny beskrivelse', isActive: false, sortOrder: 3,
      imageUrl: '/api/uploads/upload-1.jpg', quantity: 2, photoScale: 1.2,
      fuelTankLiters: 40, fuelConsumptionPerHour: 3.5,
    });
    expect(res.status).toBe(200);
    expect(res.json.machine).toMatchObject({ description: 'Ny beskrivelse', isActive: false, quantity: 2 });
    expect(await db.adminAuditLog.count()).toBe(0);
  });

  it('lets a price echoed back unchanged through, in either representation', async () => {
    const m = await machine({ dayPrice: 2490, weekPrice: 9900 });
    expect((await patch(m.id, { dayPrice: 2490, weekPrice: '9900', isActive: false })).status).toBe(200);
    expect(await db.adminAuditLog.count()).toBe(0);
  });

  it('refuses a real price change without the second factor', async () => {
    const m = await machine({ dayPrice: 2490 });
    const res = await patch(m.id, { dayPrice: 1 });
    expect(res.status).toBe(401);
    expect(res.json).toMatchObject({ requiresTotp: true, requiresTotpEnrollment: true });
    expect((await db.machine.findUniqueOrThrow({ where: { id: m.id } })).dayPrice).toBe(2490);
  });

  it('refuses clearing a price without the second factor', async () => {
    const m = await machine({ dayPrice: 2490 });
    expect((await patch(m.id, { dayPrice: null })).status).toBe(401);
    expect((await db.machine.findUniqueOrThrow({ where: { id: m.id } })).dayPrice).toBe(2490);
  });

  it('applies a price change with a valid code and audits the before/after', async () => {
    const m = await machine({ name: 'Testgraver', dayPrice: 2490, weekPrice: 9900 });
    await seedTotpSecret();
    const clock = mockClock(FROZEN);
    try {
      const res = await patch(
        m.id,
        { dayPrice: 2990, weekPrice: 9900, description: 'samtidig tekstendring' },
        totpHeader(await totpCodeFor()),
      );
      expect(res.status).toBe(200);
      expect(res.json.machine).toMatchObject({ dayPrice: 2990, description: 'samtidig tekstendring' });
    } finally {
      clock.restore();
    }

    const audit = await db.adminAuditLog.findFirstOrThrow({ where: { action: 'machine.price_change' } });
    expect(JSON.parse(audit.changes)).toEqual([
      { key: 'name', from: 'Testgraver', to: 'Testgraver' },
      { key: 'dayPrice', from: 2490, to: 2990 },
    ]);
  });

  it('replaces documents wholesale when the payload carries them', async () => {
    const m = await machine();
    await db.machineDocument.createMany({
      data: [
        { machineId: m.id, title: 'Gammel A', fileUrl: '/api/uploads/a.pdf', sortOrder: 0 },
        { machineId: m.id, title: 'Gammel B', fileUrl: '/api/uploads/b.pdf', sortOrder: 1 },
      ],
    });

    const res = await patch(m.id, {
      documents: [{ title: 'Ny', fileUrl: '/api/uploads/c.pdf' }],
    });
    expect(res.status).toBe(200);
    const docs = await db.machineDocument.findMany({ where: { machineId: m.id } });
    expect(docs.map((d) => d.title)).toEqual(['Ny']);
  });

  it('leaves documents alone when the payload omits them — a partial PATCH must not wipe manuals', async () => {
    const m = await machine();
    await db.machineDocument.create({
      data: { machineId: m.id, title: 'Manual', fileUrl: '/api/uploads/a.pdf', sortOrder: 0 },
    });

    expect((await patch(m.id, { isActive: false })).status).toBe(200);
    expect(await db.machineDocument.count({ where: { machineId: m.id } })).toBe(1);
  });

  it('clears documents when the payload says so explicitly', async () => {
    const m = await machine();
    await db.machineDocument.create({
      data: { machineId: m.id, title: 'Manual', fileUrl: '/api/uploads/a.pdf', sortOrder: 0 },
    });
    expect((await patch(m.id, { documents: [] })).status).toBe(200);
    expect(await db.machineDocument.count({ where: { machineId: m.id } })).toBe(0);

    // A non-array `documents` is treated as "replace with nothing" too.
    await db.machineDocument.create({
      data: { machineId: m.id, title: 'Manual', fileUrl: '/api/uploads/a.pdf', sortOrder: 0 },
    });
    expect((await patch(m.id, { documents: 'nope' })).status).toBe(200);
    expect(await db.machineDocument.count({ where: { machineId: m.id } })).toBe(0);
  });
});

// ── Delete ───────────────────────────────────────────────────────────────────

describe('DELETE /api/admin/machines/[id]', () => {
  it('refuses with 409 while pending or confirmed bookings reference the machine', async () => {
    const m = await machine();
    await booking('pending', { machineId: m.id, startDateStr: '2026-11-02' });
    await booking('confirmed', { machineId: m.id, startDateStr: '2026-11-10' });

    const res = await remove(m.id);
    expect(res.status).toBe(409);
    expect(res.json.activeBookings).toBe(2);
    expect(res.json.error).toContain('2 aktive booking');
    expect(await db.machine.count({ where: { id: m.id } })).toBe(1);
  });

  it('singularises the refusal message for one booking', async () => {
    const m = await machine();
    await booking('confirmed', { machineId: m.id, startDateStr: '2026-11-02' });
    const res = await remove(m.id);
    expect(res.json.error).toContain('1 aktiv booking');
    expect(res.json.error).not.toContain('aktive');
  });

  it('deletes when nothing active references it, and audits the removal', async () => {
    const m = await machine({ name: 'Utrangert' });
    await db.machineDocument.create({
      data: { machineId: m.id, title: 'Manual', fileUrl: '/api/uploads/a.pdf', sortOrder: 0 },
    });

    const res = await remove(m.id);
    expect(res.status).toBe(200);
    expect(await db.machine.count({ where: { id: m.id } })).toBe(0);
    // Documents cascade with the machine.
    expect(await db.machineDocument.count({ where: { machineId: m.id } })).toBe(0);

    const audit = await db.adminAuditLog.findFirstOrThrow({ where: { action: 'machine.delete' } });
    expect(JSON.parse(audit.changes)).toEqual([
      { key: 'id', from: m.id, to: null },
      { key: 'name', from: 'Utrangert', to: null },
    ]);
  });

  it('404s for an unknown id', async () => {
    const res = await remove('does-not-exist');
    expect(res.status).toBe(404);
  });

  it('needs no second factor — deleting equipment is not a pricing change', async () => {
    // Deliberate asymmetry, recorded so it is a decision rather than an
    // oversight: a delete is blocked by the 409 guard and audited, whereas a
    // silent re-price is not otherwise visible.
    const m = await machine({ dayPrice: 2490 });
    await seedTotpSecret();
    expect((await remove(m.id)).status).toBe(200);
  });
});
