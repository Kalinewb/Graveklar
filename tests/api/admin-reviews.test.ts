import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Same ambient-cookie-store shape as tests/api/admin-discount-codes.test.ts —
// isAdminAuthenticated() reads next/headers' cookies(), not the request.
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

import { booking, db, ensureSchema, resetDb, seedConfigDefaults } from '../helpers/db';
import { COOKIE_NAME, adminSessionToken, call, matcherMatches, proxyCall, type RouteHandler } from '../helpers/route';

// L2 — GET /api/admin/reviews, PATCH+DELETE /api/admin/reviews/[id]. Approve /
// reject / delete customer reviews.

let list: typeof import('@/app/api/admin/reviews/route');
let byId: { PATCH: RouteHandler; DELETE: RouteHandler };

async function signIn(): Promise<void> {
  store.jar = { [COOKIE_NAME]: await adminSessionToken() };
}
function signOut(): void {
  store.jar = {};
}

async function reviewRow(status: string, overrides: Record<string, unknown> = {}) {
  const b = await booking('completed', { skipLocks: true });
  return db.review.create({
    data: {
      bookingId: b.id,
      token: `tok-${Math.random().toString(36).slice(2)}`,
      status,
      rating: status === 'pending' ? null : 4,
      submittedAt: status === 'pending' ? null : new Date(),
      ...overrides,
    },
  });
}

function patch(id: string, body: Record<string, unknown>) {
  return call(byId.PATCH, { method: 'PATCH', params: { id }, body });
}

beforeAll(async () => {
  await ensureSchema();
  list = await import('@/app/api/admin/reviews/route');
  byId = (await import('@/app/api/admin/reviews/[id]/route')) as unknown as typeof byId;
});

beforeEach(async () => {
  await resetDb();
  await seedConfigDefaults();
  await signIn();
});

describe('auth', () => {
  it('the proxy 401s /api/admin/reviews without a session', async () => {
    expect(matcherMatches('/api/admin/reviews')).toBe(true);
    expect(matcherMatches('/api/admin/reviews/abc')).toBe(true);
    expect((await proxyCall('/api/admin/reviews')).status).toBe(401);
  });

  it('each handler 401s on its own', async () => {
    signOut();
    const r = await reviewRow('submitted');
    expect((await call(list.GET, { path: '/api/admin/reviews' })).status).toBe(401);
    expect((await patch(r.id, { action: 'approve' })).status).toBe(401);
    expect((await call(byId.DELETE, { method: 'DELETE', params: { id: r.id } })).status).toBe(401);
  });
});

describe('GET /api/admin/reviews', () => {
  it('excludes pending (unfilled) requests, includes submitted/approved/rejected', async () => {
    await reviewRow('pending');
    const submitted = await reviewRow('submitted');
    const approved = await reviewRow('approved');
    const rejected = await reviewRow('rejected');

    const res = await call(list.GET, { path: '/api/admin/reviews' });
    expect(res.status).toBe(200);
    const ids = res.json.reviews.map((r: { id: string }) => r.id);
    expect(ids).toEqual(expect.arrayContaining([submitted.id, approved.id, rejected.id]));
    expect(ids).toHaveLength(3);
  });

  it('includes the booking reference and name', async () => {
    const r = await reviewRow('submitted');
    const res = await call(list.GET, { path: '/api/admin/reviews' });
    expect(res.json.reviews[0].booking).toMatchObject({ name: expect.any(String), reference: expect.any(String) });
    expect(res.json.reviews[0].id).toBe(r.id);
  });
});

describe('PATCH /api/admin/reviews/[id]', () => {
  it('400s on an action outside approve|reject', async () => {
    const r = await reviewRow('submitted');
    const res = await patch(r.id, { action: 'delete' });
    expect(res.status).toBe(400);
  });

  it('404s on an unknown id', async () => {
    const res = await patch('does-not-exist', { action: 'approve' });
    expect(res.status).toBe(404);
  });

  it('400s when the review is still pending (nothing to moderate yet)', async () => {
    const r = await reviewRow('pending');
    const res = await patch(r.id, { action: 'approve' });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/ikke sendt inn/);
  });

  it('approves a submitted review', async () => {
    const r = await reviewRow('submitted');
    const res = await patch(r.id, { action: 'approve' });
    expect(res.status).toBe(200);
    expect(res.json.review.status).toBe('approved');
  });

  it('rejects a submitted review', async () => {
    const r = await reviewRow('submitted');
    const res = await patch(r.id, { action: 'reject' });
    expect(res.status).toBe(200);
    expect(res.json.review.status).toBe('rejected');
  });

  it('an already-approved review can be flipped to rejected and back', async () => {
    const r = await reviewRow('approved');
    expect((await patch(r.id, { action: 'reject' })).json.review.status).toBe('rejected');
    expect((await patch(r.id, { action: 'approve' })).json.review.status).toBe('approved');
  });

  it('a body that fails to parse as JSON is treated as an empty object (400, not a throw)', async () => {
    const r = await reviewRow('submitted');
    const res = await call(byId.PATCH, {
      method: 'PATCH',
      params: { id: r.id },
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/admin/reviews/[id]', () => {
  it('removes the row', async () => {
    const r = await reviewRow('submitted');
    const res = await call(byId.DELETE, { method: 'DELETE', params: { id: r.id } });
    expect(res.status).toBe(200);
    expect(await db.review.count()).toBe(0);
  });

  // Contrast with FINDING F-10 on /api/admin/quote-requests/[id]: this
  // DELETE catches the not-found case instead of letting it throw.
  it('an unknown id is a graceful no-op — 200, never a throw', async () => {
    const res = await call(byId.DELETE, { method: 'DELETE', params: { id: 'does-not-exist' } });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ success: true });
  });
});
