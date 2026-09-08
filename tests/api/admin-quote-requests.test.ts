import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// `isAdminAuthenticated()` reads the AMBIENT cookie store (`cookies()` from
// next/headers), not the request it was handed, so an in-process handler call
// throws "`cookies` was called outside a request scope" unless that ambient
// store is provided. Same shape as tests/api/admin-discount-codes.test.ts.
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

import { db, ensureSchema, machine, resetDb, seedConfigDefaults } from '../helpers/db';
import { emailMock } from '../helpers/mocks';
import { waitFor } from '../helpers/payments';
import { COOKIE_NAME, adminSessionToken, call, matcherMatches, proxyCall, type RouteHandler } from '../helpers/route';

// L2 — GET /api/admin/quote-requests, PATCH+DELETE /api/admin/quote-requests/[id].
// The admin side of the B2B lead → offer thread: send/revise an offer, edit
// the note, set an admin-settable status, delete.

vi.mock('@/lib/email', async () => (await import('../helpers/mocks')).mockEmail());

let list: typeof import('@/app/api/admin/quote-requests/route');
let byId: { PATCH: RouteHandler; DELETE: RouteHandler };

async function signIn(): Promise<void> {
  store.jar = { [COOKIE_NAME]: await adminSessionToken() };
}
function signOut(): void {
  store.jar = {};
}

async function seedQuote(overrides: Record<string, unknown> = {}) {
  const m = await machine();
  return db.quoteRequest.create({
    data: {
      reference: `BQ-TEST-${Math.random().toString(36).slice(2, 8)}`,
      company: 'Testfirma AS',
      orgNumber: '999888777',
      contactName: 'Kari Nordmann',
      email: 'kari@testfirma.no',
      phone: '+4740000001',
      machineId: m.id,
      startDate: new Date('2027-06-07T00:00:00+02:00'),
      rentalType: 'day',
      trainingConfirmed: true,
      status: 'ny',
      ...overrides,
    },
  });
}

function patch(id: string, body: Record<string, unknown>) {
  return call(byId.PATCH, { method: 'PATCH', path: `/api/admin/quote-requests/${id}`, params: { id }, body });
}

beforeAll(async () => {
  await ensureSchema();
  list = await import('@/app/api/admin/quote-requests/route');
  byId = (await import('@/app/api/admin/quote-requests/[id]/route')) as unknown as typeof byId;
});

beforeEach(async () => {
  await resetDb();
  await seedConfigDefaults();
  emailMock.reset();
  await signIn();
});

describe('auth', () => {
  it('the proxy 401s /api/admin/quote-requests without a session', async () => {
    expect(matcherMatches('/api/admin/quote-requests')).toBe(true);
    expect(matcherMatches('/api/admin/quote-requests/abc')).toBe(true);
    expect((await proxyCall('/api/admin/quote-requests')).status).toBe(401);
  });

  it('each handler 401s on its own when the session is missing', async () => {
    signOut();
    const q = await seedQuote();
    expect((await call(list.GET, { path: '/api/admin/quote-requests' })).status).toBe(401);
    expect((await patch(q.id, { action: 'note' })).status).toBe(401);
    expect((await call(byId.DELETE, { method: 'DELETE', params: { id: q.id } })).status).toBe(401);
    expect(await db.quoteRequest.count()).toBe(1); // nothing touched
  });
});

describe('GET /api/admin/quote-requests', () => {
  it('lists every quote, newest first, with the machine attached', async () => {
    const a = await seedQuote({ email: 'a@testfirma.no' });
    await new Promise((r) => setTimeout(r, 5));
    const b = await seedQuote({ email: 'b@testfirma.no' });

    const res = await call(list.GET, { path: '/api/admin/quote-requests' });
    expect(res.status).toBe(200);
    expect(res.json.requests).toHaveLength(2);
    expect(res.json.requests[0].id).toBe(b.id);
    expect(res.json.requests[1].id).toBe(a.id);
    expect(res.json.requests[0].machine).toMatchObject({ name: expect.any(String) });
  });
});

describe('PATCH — send_offer', () => {
  it('requires a positive offerAmount', async () => {
    const q = await seedQuote();
    for (const bad of [0, -100, NaN, 'abc', undefined]) {
      const res = await patch(q.id, { action: 'send_offer', offerAmount: bad, rentalType: 'day' });
      expect(res.status, `offerAmount ${String(bad)}`).toBe(400);
    }
  });

  it('an out-of-whitelist rentalType is silently dropped rather than refused, leaving the prior value', async () => {
    const q = await seedQuote({ rentalType: 'week' });
    const res = await patch(q.id, {
      action: 'send_offer', offerAmount: 5000, rentalType: 'fortnight', customDays: 3,
    });
    expect(res.status).toBe(200);
    expect(res.json.request.rentalType).toBe('week');
  });

  it('sends an offer, mints an acceptToken, moves status to tilbud_sendt, and emails the customer', async () => {
    const q = await seedQuote();
    const res = await patch(q.id, {
      action: 'send_offer', offerAmount: 8500, paymentMode: 'invoice', rentalType: 'week', customDays: 400,
    });
    expect(res.status).toBe(200);
    expect(res.json.request.status).toBe('tilbud_sendt');
    expect(res.json.request.offerAmount).toBe(8500);
    expect(res.json.request.acceptToken).toBeTruthy();
    // customDays is only ever consulted for 'custom' at conversion time; a
    // 'week' patch clears it rather than leaving a stale value behind.
    expect(res.json.request.customDays).toBeNull();

    await waitFor(() => emailMock.by('sendQuoteOfferEmail').length >= 1);
  });

  it('clamps customDays to 1…365 when rentalType is custom', async () => {
    const q = await seedQuote();
    const res = await patch(q.id, { action: 'send_offer', offerAmount: 8500, rentalType: 'custom', customDays: 900 });
    expect(res.json.request.customDays).toBe(365);

    const res2 = await patch(q.id, { action: 'send_offer', offerAmount: 8500, rentalType: 'custom', customDays: -5 });
    expect(res2.json.request.customDays).toBe(1);
  });

  it('reuses the existing acceptToken on a revision instead of minting a new one', async () => {
    const q = await seedQuote();
    const first = await patch(q.id, { action: 'send_offer', offerAmount: 5000 });
    const token = first.json.request.acceptToken;
    const second = await patch(q.id, { action: 'send_offer', offerAmount: 6000 });
    expect(second.json.request.acceptToken).toBe(token);
  });

  it('defaults offerValidUntil to +14 days and acceptTokenExpiry to validUntil +7 days', async () => {
    const q = await seedQuote();
    const before = Date.now();
    const res = await patch(q.id, { action: 'send_offer', offerAmount: 5000 });
    const validUntil = new Date(res.json.request.offerValidUntil).getTime();
    const tokenExpiry = new Date(res.json.request.acceptTokenExpiry).getTime();
    expect(validUntil - before).toBeGreaterThan(13 * 24 * 3600 * 1000);
    expect(validUntil - before).toBeLessThan(15 * 24 * 3600 * 1000);
    expect(tokenExpiry - validUntil).toBe(7 * 24 * 3600 * 1000);
  });

  it('an invalid offerValidUntil string falls back to the +14-day default instead of 400ing', async () => {
    const q = await seedQuote();
    const res = await patch(q.id, { action: 'send_offer', offerAmount: 5000, offerValidUntil: 'not-a-date' });
    expect(res.status).toBe(200);
    expect(res.json.request.offerValidUntil).toBeTruthy();
  });

  it('404s on an unknown id', async () => {
    const res = await patch('does-not-exist', { action: 'send_offer', offerAmount: 5000 });
    expect(res.status).toBe(404);
  });
});

describe('PATCH — note', () => {
  it('sets and clears the admin note', async () => {
    const q = await seedQuote();
    const res = await patch(q.id, { action: 'note', adminNote: 'Ring tilbake fredag' });
    expect(res.json.request.adminNote).toBe('Ring tilbake fredag');

    const cleared = await patch(q.id, { action: 'note', adminNote: null });
    expect(cleared.json.request.adminNote).toBeNull();
  });
});

describe('PATCH — set_status', () => {
  it('accepts every admin-settable status', async () => {
    for (const status of ['ny', 'tilbud_sendt', 'avslatt', 'utlopt', 'trukket']) {
      const q = await seedQuote({ email: `${status}@testfirma.no` });
      const res = await patch(q.id, { action: 'set_status', status });
      expect(res.status, status).toBe(200);
      expect(res.json.request.status).toBe(status);
    }
  });

  it('refuses akseptert and konvertert — those are only reached through the accept flow', async () => {
    for (const status of ['akseptert', 'konvertert']) {
      const q = await seedQuote({ email: `${status}@testfirma.no` });
      const res = await patch(q.id, { action: 'set_status', status });
      expect(res.status, status).toBe(400);
    }
  });

  it('refuses a status outside QUOTE_STATUSES entirely', async () => {
    const q = await seedQuote();
    const res = await patch(q.id, { action: 'set_status', status: 'kanselert' });
    expect(res.status).toBe(400);
  });
});

describe('PATCH — unknown action', () => {
  it('400s', async () => {
    const q = await seedQuote();
    const res = await patch(q.id, { action: 'do_a_backflip' });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/admin/quote-requests/[id]', () => {
  it('removes the row', async () => {
    const q = await seedQuote();
    const res = await call(byId.DELETE, { method: 'DELETE', params: { id: q.id } });
    expect(res.status).toBe(200);
    expect(await db.quoteRequest.count()).toBe(0);
  });

  // FIXED F-10: the handler called `db.quoteRequest.delete()` with no
  // existence check and no try/catch, so an unknown id threw Prisma's P2025
  // straight out of the handler (a bare 500 in production) instead of the 404
  // its siblings give — DELETE /api/admin/discount-codes/[id] checks first,
  // DELETE /api/admin/reviews/[id] catches and ignores.
  it('404s on an unknown id instead of throwing', async () => {
    const res = await call(byId.DELETE, { method: 'DELETE', params: { id: 'does-not-exist' } });
    expect(res.status).toBe(404);
  });

  // Rewritten for FIXED F-10: nothing escapes the handler any more.
  it('does not throw for an unknown id, and leaves the table alone', async () => {
    const q = await seedQuote();
    const res = await call(byId.DELETE, { method: 'DELETE', params: { id: 'does-not-exist' } });
    expect(res.status).toBe(404);
    expect(await db.quoteRequest.count({ where: { id: q.id } })).toBe(1);
  });
});
