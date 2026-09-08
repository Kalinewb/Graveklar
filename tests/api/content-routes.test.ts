import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Ambient cookie store — same shape as tests/api/admin-discount-codes.test.ts.
// Since FIXED N-5 the /api/admin/faq* and /api/admin/insurance* handlers call
// isAdminAuthenticated() themselves, so every CRUD test signs in through this
// jar; the N-5 describe deliberately leaves it empty.
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

import { db, ensureSchema, resetDb, seedConfigDefaults } from '../helpers/db';
import { COOKIE_NAME, adminSessionToken, matcherMatches, proxyCall, call, type RouteHandler } from '../helpers/route';

// L2 — public GET /api/faq + /api/insurance; admin CRUD for both
// (GET/POST /api/admin/faq, PATCH/DELETE /api/admin/faq/[id], and the
// insurance mirror).

let faqPublicGET: typeof import('@/app/api/faq/route').GET;
let insurancePublicGET: typeof import('@/app/api/insurance/route').GET;
let faqAdmin: typeof import('@/app/api/admin/faq/route');
let faqAdminById: { PATCH: RouteHandler; DELETE: RouteHandler };
let insuranceAdmin: typeof import('@/app/api/admin/insurance/route');
let insuranceAdminById: { PATCH: RouteHandler; DELETE: RouteHandler };

beforeAll(async () => {
  await ensureSchema();
  ({ GET: faqPublicGET } = await import('@/app/api/faq/route'));
  ({ GET: insurancePublicGET } = await import('@/app/api/insurance/route'));
  faqAdmin = await import('@/app/api/admin/faq/route');
  faqAdminById = (await import('@/app/api/admin/faq/[id]/route')) as unknown as typeof faqAdminById;
  insuranceAdmin = await import('@/app/api/admin/insurance/route');
  insuranceAdminById = (await import('@/app/api/admin/insurance/[id]/route')) as unknown as typeof insuranceAdminById;
});

beforeEach(async () => {
  await resetDb();
  await seedConfigDefaults();
  store.jar = { [COOKIE_NAME]: await adminSessionToken() };
});

/** Drop the admin session for a test that must reach a handler unauthenticated. */
function signOut(): void {
  store.jar = {};
}

describe('the proxy gates every /api/admin/faq* and /api/admin/insurance* path', () => {
  it('matcher covers both trees', () => {
    expect(matcherMatches('/api/admin/faq')).toBe(true);
    expect(matcherMatches('/api/admin/faq/abc')).toBe(true);
    expect(matcherMatches('/api/admin/insurance')).toBe(true);
    expect(matcherMatches('/api/admin/insurance/abc')).toBe(true);
  });

  it('401s without a session', async () => {
    expect((await proxyCall('/api/admin/faq')).status).toBe(401);
    expect((await proxyCall('/api/admin/insurance')).status).toBe(401);
  });
});

// FIXED N-5: unlike EVERY other /api/admin/* route in this codebase
// (discount-codes, quote-requests, reviews, machines, app-config, survey…),
// the FAQ and insurance admin handlers never called isAdminAuthenticated()
// themselves. They were safe only because the proxy matcher happens to cover
// every /api/admin/* path — the exact single point of failure H-2
// (docs/audit/phase1d-auth-config-uploads.md) already demonstrated once for
// the bare '/api/admin' path — so calling a handler directly (as this L2
// harness does, and as any future internal caller or route refactor might)
// performed full unauthenticated reads AND writes. All eight handlers now
// re-check the session themselves.
describe('FIXED N-5 — FAQ/insurance admin handlers gate on their own session check', () => {
  beforeEach(() => signOut());

  it('GET /api/admin/faq refuses a direct call with no session', async () => {
    const res = await call(faqAdmin.GET, { path: '/api/admin/faq' });
    expect(res.status).toBe(401);
  });

  it('…and reads nothing: an inactive item stays invisible', async () => {
    await db.faqItem.create({ data: { question: 'Q', answer: 'A', isActive: false } });
    const res = await call(faqAdmin.GET, { path: '/api/admin/faq' });
    expect(res.status).toBe(401);
    expect(res.json.items).toBeUndefined();
  });

  it('POST /api/admin/faq refuses a direct call with no session', async () => {
    const res = await call(faqAdmin.POST, {
      method: 'POST', path: '/api/admin/faq', body: { question: 'Q', answer: 'A' },
    });
    expect(res.status).toBe(401);
    expect(await db.faqItem.count()).toBe(0);
  });

  it('POST /api/admin/insurance refuses a direct call with no session', async () => {
    const res = await call(insuranceAdmin.POST, {
      method: 'POST', path: '/api/admin/insurance', body: { label: 'L', value: 'V', detail: 'D' },
    });
    expect(res.status).toBe(401);
    expect(await db.insuranceCard.count()).toBe(0);
  });

  it('every mutating handler on both trees refuses without a session', async () => {
    const faqItem = await db.faqItem.create({ data: { question: 'Q', answer: 'A' } });
    const card = await db.insuranceCard.create({ data: { label: 'L', value: 'V', detail: 'D' } });

    expect((await call(faqAdminById.PATCH, { method: 'PATCH', params: { id: faqItem.id }, body: { answer: 'X' } })).status).toBe(401);
    expect((await call(faqAdminById.DELETE, { method: 'DELETE', params: { id: faqItem.id } })).status).toBe(401);
    expect((await call(insuranceAdmin.GET, { path: '/api/admin/insurance' })).status).toBe(401);
    expect((await call(insuranceAdminById.PATCH, { method: 'PATCH', params: { id: card.id }, body: { value: 'X' } })).status).toBe(401);
    expect((await call(insuranceAdminById.DELETE, { method: 'DELETE', params: { id: card.id } })).status).toBe(401);

    expect(await db.faqItem.count()).toBe(1);
    expect(await db.insuranceCard.count()).toBe(1);
  });
});

describe('GET /api/faq (public)', () => {
  it('only returns active items, ordered by sortOrder then createdAt', async () => {
    await db.faqItem.create({ data: { question: 'Hidden', answer: 'A', isActive: false, sortOrder: 0 } });
    const second = await db.faqItem.create({ data: { question: 'Second', answer: 'A', isActive: true, sortOrder: 20 } });
    const first = await db.faqItem.create({ data: { question: 'First', answer: 'A', isActive: true, sortOrder: 10 } });

    const res = await call(faqPublicGET, { path: '/api/faq' });
    expect(res.status).toBe(200);
    expect(res.json.items.map((i: { id: string }) => i.id)).toEqual([first.id, second.id]);
  });
});

describe('GET /api/insurance (public)', () => {
  it('only returns active cards, ordered by sortOrder then createdAt', async () => {
    await db.insuranceCard.create({ data: { label: 'Hidden', value: 'V', detail: 'D', isActive: false } });
    const shown = await db.insuranceCard.create({ data: { label: 'Shown', value: 'V', detail: 'D', isActive: true } });

    const res = await call(insurancePublicGET, { path: '/api/insurance' });
    expect(res.status).toBe(200);
    expect(res.json.cards.map((c: { id: string }) => c.id)).toEqual([shown.id]);
  });
});

describe('admin FAQ CRUD', () => {
  it('GET returns every item, active or not', async () => {
    await db.faqItem.create({ data: { question: 'Q1', answer: 'A1', isActive: true } });
    await db.faqItem.create({ data: { question: 'Q2', answer: 'A2', isActive: false } });
    const res = await call(faqAdmin.GET, { path: '/api/admin/faq' });
    expect(res.json.items).toHaveLength(2);
  });

  it('POST creates an item, defaulting isActive true and sortOrder 0', async () => {
    const res = await call(faqAdmin.POST, {
      method: 'POST', path: '/api/admin/faq', body: { question: '  Har dere depositum?  ', answer: '  Nei.  ' },
    });
    expect(res.status).toBe(201);
    expect(res.json.item).toMatchObject({ question: 'Har dere depositum?', answer: 'Nei.', isActive: true, sortOrder: 0 });
  });

  it('PATCH updates only the fields present in the body', async () => {
    const item = await db.faqItem.create({ data: { question: 'Old Q', answer: 'Old A', sortOrder: 5 } });
    const res = await call(faqAdminById.PATCH, {
      method: 'PATCH', params: { id: item.id }, body: { answer: 'New A' },
    });
    expect(res.status).toBe(200);
    const row = await db.faqItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row.answer).toBe('New A');
    expect(row.question).toBe('Old Q');
  });

  it('DELETE removes the item', async () => {
    const item = await db.faqItem.create({ data: { question: 'Q', answer: 'A' } });
    const res = await call(faqAdminById.DELETE, { method: 'DELETE', params: { id: item.id } });
    expect(res.status).toBe(200);
    expect(await db.faqItem.count()).toBe(0);
  });

  // FIXED F-14: `question`/`answer` are required String columns; the admin
  // handlers did `body.question?.trim()` (POST) or handed the raw value
  // straight to Prisma (PATCH) with no type check. A JSON number where the UI
  // always sends a string threw — `.trim` is not a function on POST, a Prisma
  // validation error on PATCH — and both landed in the generic catch-all as a
  // 500 rather than the 400 a client mistake should get.
  it('POST answers 400, not 500, when question/answer arrive as numbers', async () => {
    const res = await call(faqAdmin.POST, {
      method: 'POST', path: '/api/admin/faq', body: { question: 12345, answer: 'A' },
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('question');
    expect(await db.faqItem.count()).toBe(0);
  });

  // Rewritten for FIXED F-14: the other shape fields are covered too.
  it('POST 400s on a wrong-typed sortOrder/isActive, and on a non-object body', async () => {
    for (const body of [
      { question: 'Q', answer: 'A', sortOrder: 'first' },
      { question: 'Q', answer: 'A', isActive: 'yes' },
    ]) {
      const res = await call(faqAdmin.POST, { method: 'POST', path: '/api/admin/faq', body });
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
    const arr = await call(faqAdmin.POST, { method: 'POST', path: '/api/admin/faq', body: ['nope'] });
    expect(arr.status).toBe(400);
    expect(await db.faqItem.count()).toBe(0);
  });

  it('PATCH answers 400, not 500, when question arrives as a number', async () => {
    const item = await db.faqItem.create({ data: { question: 'Q', answer: 'A' } });
    const res = await call(faqAdminById.PATCH, {
      method: 'PATCH', params: { id: item.id }, body: { question: 12345 },
    });
    expect(res.status).toBe(400);
    expect((await db.faqItem.findUniqueOrThrow({ where: { id: item.id } })).question).toBe('Q');
  });

  // Rewritten for FIXED F-14 (and the 404 that came with it): an unknown id is
  // not a 500 either.
  it('PATCH/DELETE answer 404 for an id that does not exist', async () => {
    expect((await call(faqAdminById.PATCH, { method: 'PATCH', params: { id: 'nope' }, body: { answer: 'X' } })).status).toBe(404);
    expect((await call(faqAdminById.DELETE, { method: 'DELETE', params: { id: 'nope' } })).status).toBe(404);
  });
});

describe('admin insurance CRUD', () => {
  it('GET returns every card, active or not', async () => {
    await db.insuranceCard.create({ data: { label: 'L1', value: 'V1', detail: 'D1', isActive: true } });
    await db.insuranceCard.create({ data: { label: 'L2', value: 'V2', detail: 'D2', isActive: false } });
    const res = await call(insuranceAdmin.GET, { path: '/api/admin/insurance' });
    expect(res.json.cards).toHaveLength(2);
  });

  it('POST creates a card', async () => {
    const res = await call(insuranceAdmin.POST, {
      method: 'POST', path: '/api/admin/insurance',
      body: { label: '  Kasko  ', value: '  Inkludert  ', detail: '  Egenandel 10 000 kr  ' },
    });
    expect(res.status).toBe(201);
    expect(res.json.card).toMatchObject({ label: 'Kasko', value: 'Inkludert', detail: 'Egenandel 10 000 kr' });
  });

  it('PATCH updates only the fields present in the body', async () => {
    const card = await db.insuranceCard.create({ data: { label: 'L', value: 'V', detail: 'D' } });
    const res = await call(insuranceAdminById.PATCH, {
      method: 'PATCH', params: { id: card.id }, body: { value: 'New V' },
    });
    expect(res.status).toBe(200);
    const row = await db.insuranceCard.findUniqueOrThrow({ where: { id: card.id } });
    expect(row.value).toBe('New V');
    expect(row.label).toBe('L');
  });

  it('DELETE removes the card', async () => {
    const card = await db.insuranceCard.create({ data: { label: 'L', value: 'V', detail: 'D' } });
    const res = await call(insuranceAdminById.DELETE, { method: 'DELETE', params: { id: card.id } });
    expect(res.status).toBe(200);
    expect(await db.insuranceCard.count()).toBe(0);
  });

  it('POST answers 400, not 500, when label arrives as a number (FIXED F-14)', async () => {
    const res = await call(insuranceAdmin.POST, {
      method: 'POST', path: '/api/admin/insurance', body: { label: 42, value: 'V', detail: 'D' },
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('label');
    expect(await db.insuranceCard.count()).toBe(0);
  });

  // Rewritten for FIXED F-14: PATCH gets the same shape check, and an unknown
  // id is a 404 rather than a Prisma error in the catch-all.
  it('PATCH 400s on a wrong-typed field and 404s on an unknown id', async () => {
    const card = await db.insuranceCard.create({ data: { label: 'L', value: 'V', detail: 'D' } });
    const bad = await call(insuranceAdminById.PATCH, {
      method: 'PATCH', params: { id: card.id }, body: { value: 42 },
    });
    expect(bad.status).toBe(400);
    expect((await db.insuranceCard.findUniqueOrThrow({ where: { id: card.id } })).value).toBe('V');

    expect((await call(insuranceAdminById.PATCH, { method: 'PATCH', params: { id: 'nope' }, body: { value: 'X' } })).status).toBe(404);
  });
});
