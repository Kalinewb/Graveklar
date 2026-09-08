/**
 * L2 — admin checklist configuration: /api/admin/checklist-phases(+[id],
 * reorder), /api/admin/checklist-items(+[id], reorder), and GET
 * /api/admin/bookings/[id]/checklist-submissions.
 *
 * Admin auth for the first two groups is gated at src/proxy.ts and covered
 * generically by tests/api/admin-route-gating.test.ts, which walks the whole
 * src/app/api/admin/ tree — these tests call the handlers directly.
 *
 * The checklist-submissions route ALSO calls `isAdminAuthenticated()` itself
 * (belt-and-suspenders on top of the proxy gate), which reads the AMBIENT
 * cookie store via `cookies()` from next/headers rather than the request it
 * was handed — an in-process handler call otherwise throws "`cookies` was
 * called outside a request scope". Same fix as tests/api/admin-discount-codes.test.ts.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { booking, checklistPhase, db, ensureSchema, resetDb } from '../helpers/db';
import { COOKIE_NAME, adminSessionToken, call, type RouteHandler } from '../helpers/route';

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDb();
  store.jar = { [COOKIE_NAME]: await adminSessionToken() };
});

async function listPhases() {
  const { GET } = await import('@/app/api/admin/checklist-phases/route');
  return call(GET, { path: '/api/admin/checklist-phases' });
}
async function createPhase(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/admin/checklist-phases/route');
  return call(POST, { method: 'POST', path: '/api/admin/checklist-phases', body });
}
async function patchPhase(id: string, body: Record<string, unknown>) {
  const { PATCH } = await import('@/app/api/admin/checklist-phases/[id]/route');
  return call(PATCH as unknown as RouteHandler, { method: 'PATCH', path: `/api/admin/checklist-phases/${id}`, params: { id }, body });
}
async function deletePhase(id: string) {
  const { DELETE } = await import('@/app/api/admin/checklist-phases/[id]/route');
  return call(DELETE as unknown as RouteHandler, { method: 'DELETE', path: `/api/admin/checklist-phases/${id}`, params: { id } });
}
async function reorderPhases(phaseIds: string[]) {
  const { POST } = await import('@/app/api/admin/checklist-phases/reorder/route');
  return call(POST, { method: 'POST', path: '/api/admin/checklist-phases/reorder', body: { phaseIds } });
}

async function createItem(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/admin/checklist-items/route');
  return call(POST, { method: 'POST', path: '/api/admin/checklist-items', body });
}
async function patchItem(id: string, body: Record<string, unknown>) {
  const { PATCH } = await import('@/app/api/admin/checklist-items/[id]/route');
  return call(PATCH as unknown as RouteHandler, { method: 'PATCH', path: `/api/admin/checklist-items/${id}`, params: { id }, body });
}
async function deleteItem(id: string) {
  const { DELETE } = await import('@/app/api/admin/checklist-items/[id]/route');
  return call(DELETE as unknown as RouteHandler, { method: 'DELETE', path: `/api/admin/checklist-items/${id}`, params: { id } });
}
async function reorderItems(phaseId: string, itemIds: string[]) {
  const { POST } = await import('@/app/api/admin/checklist-items/reorder/route');
  return call(POST, { method: 'POST', path: '/api/admin/checklist-items/reorder', body: { phaseId, itemIds } });
}

async function submissionsFor(bookingId: string) {
  const { GET } = await import('@/app/api/admin/bookings/[id]/checklist-submissions/route');
  return call(GET as unknown as RouteHandler, {
    path: `/api/admin/bookings/${bookingId}/checklist-submissions`,
    params: { id: bookingId },
  });
}

// ── /api/admin/checklist-phases ──────────────────────────────────────────────

describe('GET/POST /api/admin/checklist-phases', () => {
  it('lists phases with their items, ordered by sortOrder', async () => {
    await checklistPhase({ name: 'B', sortOrder: 1 });
    await checklistPhase({ name: 'A', sortOrder: 0 });
    const res = await listPhases();
    expect(res.status).toBe(200);
    expect(res.json.phases.map((p: { name: string }) => p.name)).toEqual(['A', 'B']);
    expect(res.json.phases[0].items.length).toBeGreaterThan(0);
  });

  it('creates a phase with sane defaults and validates enum fields', async () => {
    const res = await createPhase({ name: 'Klargjøring' });
    expect(res.status).toBe(200);
    expect(res.json.phase).toMatchObject({
      name: 'Klargjøring', appliesTo: 'all', audience: 'operator', intervalMode: 'once', isCompletionTrigger: false,
    });
  });

  it('falls back to safe defaults for invalid appliesTo/audience/intervalMode', async () => {
    const res = await createPhase({ name: 'X', appliesTo: 'bogus', audience: 'bogus', intervalMode: 'bogus' });
    expect(res.json.phase).toMatchObject({ appliesTo: 'all', audience: 'operator', intervalMode: 'once' });
  });

  it('creating a second isCompletionTrigger phase clears the flag on every other phase', async () => {
    const first = await createPhase({ name: 'Retur', isCompletionTrigger: true });
    expect(first.json.phase.isCompletionTrigger).toBe(true);

    const second = await createPhase({ name: 'Henting', isCompletionTrigger: true });
    expect(second.json.phase.isCompletionTrigger).toBe(true);

    const firstAfter = await db.checklistPhase.findUniqueOrThrow({ where: { id: first.json.phase.id } });
    expect(firstAfter.isCompletionTrigger).toBe(false);
  });
});

describe('PATCH/DELETE /api/admin/checklist-phases/[id]', () => {
  it('updates only the given fields', async () => {
    const phase = await checklistPhase({ name: 'Original' });
    const res = await patchPhase(phase.id, { name: 'Updated' });
    expect(res.status).toBe(200);
    expect(res.json.phase.name).toBe('Updated');
    expect(res.json.phase.appliesTo).toBe('all');
  });

  it('setting isCompletionTrigger:true on one phase clears it from every other, but not itself', async () => {
    const a = await checklistPhase({ name: 'A', isCompletionTrigger: true });
    const b = await checklistPhase({ name: 'B' });
    await patchPhase(b.id, { isCompletionTrigger: true });

    expect((await db.checklistPhase.findUniqueOrThrow({ where: { id: a.id } })).isCompletionTrigger).toBe(false);
    expect((await db.checklistPhase.findUniqueOrThrow({ where: { id: b.id } })).isCompletionTrigger).toBe(true);
  });

  it('ignores an invalid appliesTo/intervalMode/audience rather than storing it', async () => {
    const phase = await checklistPhase({ name: 'A', appliesTo: 'all' });
    const res = await patchPhase(phase.id, { appliesTo: 'nonsense', audience: 'nonsense', intervalMode: 'nonsense' });
    expect(res.status).toBe(200);
    expect(res.json.phase.appliesTo).toBe('all');
    expect(res.json.phase.audience).toBe('operator');
    expect(res.json.phase.intervalMode).toBe('once');
  });

  it('deletes a phase together with its items (cascade)', async () => {
    const phase = await checklistPhase({ name: 'Doomed' });
    expect(await db.checklistItem.count({ where: { phaseId: phase.id } })).toBeGreaterThan(0);
    const res = await deletePhase(phase.id);
    expect(res.status).toBe(200);
    expect(await db.checklistPhase.count({ where: { id: phase.id } })).toBe(0);
    expect(await db.checklistItem.count({ where: { phaseId: phase.id } })).toBe(0);
  });
});

describe('POST /api/admin/checklist-phases/reorder', () => {
  it('requires the complete set of phase ids', async () => {
    const a = await checklistPhase({ name: 'A', sortOrder: 0 });
    await checklistPhase({ name: 'B', sortOrder: 1 });

    const missingOne = await reorderPhases([a.id]);
    expect(missingOne.status).toBe(400);

    const empty = await reorderPhases([]);
    expect(empty.status).toBe(400);
  });

  it('rejects an id that does not belong to any phase', async () => {
    const a = await checklistPhase({ name: 'A', sortOrder: 0 });
    const res = await reorderPhases([a.id, 'not-a-real-id']);
    expect(res.status).toBe(400);
  });

  it('reassigns sortOrder to match the given order', async () => {
    const a = await checklistPhase({ name: 'A', sortOrder: 0 });
    const b = await checklistPhase({ name: 'B', sortOrder: 1 });
    const res = await reorderPhases([b.id, a.id]);
    expect(res.status).toBe(200);
    expect((await db.checklistPhase.findUniqueOrThrow({ where: { id: b.id } })).sortOrder).toBe(0);
    expect((await db.checklistPhase.findUniqueOrThrow({ where: { id: a.id } })).sortOrder).toBe(1);
  });
});

// ── /api/admin/checklist-items ───────────────────────────────────────────────

describe('POST /api/admin/checklist-items', () => {
  it('requires a phaseId', async () => {
    const res = await createItem({ label: 'X' });
    expect(res.status).toBe(400);
  });

  it('creates an item with defaults and a conditional link', async () => {
    const phase = await checklistPhase({ items: [{ label: 'Skader?', answerType: 'yesno' }] });
    const parent = phase.items[0];
    const res = await createItem({
      phaseId: phase.id, label: 'Bilde av skade', answerType: 'photo',
      conditionItemId: parent.id, conditionValue: 'ja', minPhotos: 3,
    });
    expect(res.status).toBe(200);
    expect(res.json.item).toMatchObject({
      label: 'Bilde av skade', answerType: 'photo', conditionItemId: parent.id, conditionValue: 'ja', minPhotos: 3,
    });
  });

  it('drops conditionValue when conditionItemId is not set', async () => {
    const phase = await checklistPhase();
    const res = await createItem({ phaseId: phase.id, label: 'X', conditionValue: 'ja' });
    expect(res.json.item.conditionValue).toBeNull();
  });

  it('only applies minPhotos to photo items, and floors it at 1', async () => {
    const phase = await checklistPhase();
    const nonPhoto = await createItem({ phaseId: phase.id, label: 'X', answerType: 'text', minPhotos: 5 });
    expect(nonPhoto.json.item.minPhotos).toBeNull();

    const zero = await createItem({ phaseId: phase.id, label: 'Y', answerType: 'photo', minPhotos: 0 });
    expect(zero.json.item.minPhotos).toBe(1);
  });
});

describe('PATCH/DELETE /api/admin/checklist-items/[id]', () => {
  it('updates fields present in the body only', async () => {
    const phase = await checklistPhase({ items: [{ label: 'Original', answerType: 'checkbox' }] });
    const item = phase.items[0];
    const res = await patchItem(item.id, { label: 'Updated' });
    expect(res.status).toBe(200);
    expect(res.json.item).toMatchObject({ label: 'Updated', answerType: 'checkbox' });
  });

  it('clears conditionValue when conditionItemId is explicitly cleared', async () => {
    const phase = await checklistPhase({ items: [
      { label: 'Skader?', answerType: 'yesno' },
      { label: 'Foto', answerType: 'photo' },
    ] });
    const [parent, child] = phase.items;
    await patchItem(child.id, { conditionItemId: parent.id, conditionValue: 'ja' });
    const res = await patchItem(child.id, { conditionItemId: null });
    expect(res.json.item.conditionItemId).toBeNull();
    expect(res.json.item.conditionValue).toBeNull();
  });

  it('deletes an item', async () => {
    const phase = await checklistPhase({ items: [{ label: 'X' }] });
    const item = phase.items[0];
    const res = await deleteItem(item.id);
    expect(res.status).toBe(200);
    expect(await db.checklistItem.count({ where: { id: item.id } })).toBe(0);
  });
});

describe('POST /api/admin/checklist-items/reorder', () => {
  it('requires phaseId and a complete itemIds set for that phase', async () => {
    const phase = await checklistPhase({ items: [{ label: 'A' }, { label: 'B' }] });
    const [a] = phase.items;

    expect((await reorderItems('', [a.id])).status).toBe(400);
    expect((await reorderItems(phase.id, [a.id])).status).toBe(400); // missing B
  });

  it('rejects an itemId from a different phase', async () => {
    const phase = await checklistPhase({ items: [{ label: 'A' }] });
    const other = await checklistPhase({ items: [{ label: 'Z' }] });
    const res = await reorderItems(phase.id, [phase.items[0].id, other.items[0].id]);
    expect(res.status).toBe(400);
  });

  it('reassigns sortOrder within the phase', async () => {
    const phase = await checklistPhase({ items: [{ label: 'A' }, { label: 'B' }] });
    const [a, b] = phase.items;
    const res = await reorderItems(phase.id, [b.id, a.id]);
    expect(res.status).toBe(200);
    expect((await db.checklistItem.findUniqueOrThrow({ where: { id: b.id } })).sortOrder).toBe(0);
    expect((await db.checklistItem.findUniqueOrThrow({ where: { id: a.id } })).sortOrder).toBe(1);
  });
});

// ── GET /api/admin/bookings/[id]/checklist-submissions ──────────────────────

describe('GET /api/admin/bookings/[id]/checklist-submissions', () => {
  it('401s without an admin session', async () => {
    store.jar = {};
    const res = await submissionsFor('abc');
    expect(res.status).toBe(401);
  });

  it('404s for a booking that does not exist', async () => {
    const res = await submissionsFor('no-such-booking');
    expect(res.status).toBe(404);
  });

  it('lists renter submissions with phase name, interval label and item metadata resolved', async () => {
    const renterPhase = await checklistPhase({
      name: 'Daglig kontroll', audience: 'renter', intervalMode: 'daily',
      items: [{ label: 'Drivstoff OK', answerType: 'checkbox' }],
    });
    const b = await booking('confirmed', { skipLocks: true });
    await db.checklistSubmission.create({
      data: {
        bookingId: b.id, phaseId: renterPhase.id, intervalKey: 'day-2026-09-07',
        data: JSON.stringify({ [renterPhase.items[0].id]: true }), phone: '99011223',
      },
    });

    const res = await submissionsFor(b.id);
    expect(res.status).toBe(200);
    expect(res.json.renterPhaseCount).toBe(1);
    expect(res.json.submissions).toHaveLength(1);
    expect(res.json.submissions[0]).toMatchObject({
      phaseName: 'Daglig kontroll',
      intervalKey: 'day-2026-09-07',
      phone: '99011223',
    });
    expect(res.json.submissions[0].items[0]).toMatchObject({ label: 'Drivstoff OK', answerType: 'checkbox' });
  });

  it('falls back to "Ukjent fase" when the submission\'s phase is no longer an active renter phase', async () => {
    // loadRenterSubmissionsForBooking only maps phases that are currently
    // { isActive: true, audience: 'renter' } — a submission whose phase was
    // later deactivated (or reassigned to the operator) still exists (no FK
    // cascade fires), but the phase lookup misses.
    const renterPhase = await checklistPhase({ name: 'Temp', audience: 'renter', intervalMode: 'once' });
    const b = await booking('confirmed', { skipLocks: true });
    await db.checklistSubmission.create({
      data: { bookingId: b.id, phaseId: renterPhase.id, intervalKey: 'once', data: '{}', phone: '99011223' },
    });
    await db.checklistPhase.update({ where: { id: renterPhase.id }, data: { isActive: false } });

    const res = await submissionsFor(b.id);
    expect(res.status).toBe(200);
    expect(res.json.submissions).toHaveLength(1);
    expect(res.json.submissions[0].phaseName).toBe('Ukjent fase');
    expect(res.json.submissions[0].items).toEqual([]);
  });
});
