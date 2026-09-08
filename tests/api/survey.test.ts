import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Ambient cookie store for isAdminAuthenticated() — same shape as
// tests/api/admin-discount-codes.test.ts.
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

vi.mock('@/lib/email', async () => (await import('../helpers/mocks')).mockEmail());

import { surveyDefaults } from '@/lib/survey-defaults';
import {
  campaignCode,
  db,
  ensureSchema,
  invalidateCaches,
  resetDb,
  seedConfigDefaults,
} from '../helpers/db';
import { emailMock } from '../helpers/mocks';
import { waitFor } from '../helpers/payments';
import { COOKIE_NAME, adminSessionToken, call, matcherMatches, proxyCall, type RouteHandler } from '../helpers/route';

// L2 — public GET /api/survey/questions, POST /api/survey; admin
// GET /api/admin/survey (+ DELETE [id]) and the admin question builder
// (GET/POST/PUT /api/admin/survey/questions, PATCH/DELETE [id]).

let questionsGET: typeof import('@/app/api/survey/questions/route').GET;
let surveyPOST: typeof import('@/app/api/survey/route').POST;
let adminSurveyList: typeof import('@/app/api/admin/survey/route');
let adminSurveyById: { DELETE: RouteHandler };
let adminQuestionsList: typeof import('@/app/api/admin/survey/questions/route');
let adminQuestionById: { PATCH: RouteHandler; DELETE: RouteHandler };

async function signIn(): Promise<void> {
  store.jar = { [COOKIE_NAME]: await adminSessionToken() };
}
function signOut(): void {
  store.jar = {};
}

let ipSeq = 0;
function ip(): Record<string, string> {
  return { 'x-forwarded-for': `10.4.0.${++ipSeq}` };
}

async function submitSurvey(body: unknown, headers: Record<string, string> = ip()) {
  return call(surveyPOST, { method: 'POST', path: '/api/survey', body, headers });
}

/** POST /api/survey only accepts keys that are questions this survey asks
 *  (plus the reserved `epost`/`samtykke`) — see FIXED F-6. Tests that answer a
 *  made-up question register it first. */
async function askQuestion(key: string): Promise<void> {
  await db.surveyQuestion.create({
    data: { key, type: 'text', section: 'S', label: key, required: false, isActive: true, sortOrder: 10 },
  });
}

beforeAll(async () => {
  await ensureSchema();
  ({ GET: questionsGET } = await import('@/app/api/survey/questions/route'));
  ({ POST: surveyPOST } = await import('@/app/api/survey/route'));
  adminSurveyList = await import('@/app/api/admin/survey/route');
  adminSurveyById = (await import('@/app/api/admin/survey/[id]/route')) as unknown as typeof adminSurveyById;
  adminQuestionsList = await import('@/app/api/admin/survey/questions/route');
  adminQuestionById = (await import('@/app/api/admin/survey/questions/[id]/route')) as unknown as typeof adminQuestionById;
});

beforeEach(async () => {
  await resetDb();
  await seedConfigDefaults();
  emailMock.reset();
  await signIn();
});

describe('GET /api/survey/questions (public)', () => {
  it('seeds and returns the full default question set', async () => {
    const res = await call(questionsGET, { path: '/api/survey/questions' });
    expect(res.status).toBe(200);
    expect(res.json.questions).toHaveLength(surveyDefaults.length);
    expect(res.json.questions[0].key).toBe(surveyDefaults[0].key);
  });

  it('needs no session — it is a public GET', async () => {
    signOut();
    const res = await call(questionsGET, { path: '/api/survey/questions' });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/survey', () => {
  it('stores the submission and echoes ok:true with no discount', async () => {
    await askQuestion('hatt');
    const res = await submitSurvey({ hatt: 'ja', epost: 'kunde@example.com', samtykke: false });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, discountCode: null, discountPercent: undefined });

    const row = await db.surveyResponse.findFirstOrThrow();
    expect(row.email).toBe('kunde@example.com');
    expect(JSON.parse(row.data)).toMatchObject({ hatt: 'ja', samtykke: false });
  });

  it('extracts email from body.epost, and stores null when absent/blank', async () => {
    await askQuestion('hatt');
    await submitSurvey({ hatt: 'ja' });
    const row = await db.surveyResponse.findFirstOrThrow();
    expect(row.email).toBeNull();
  });

  it('400s on malformed JSON', async () => {
    const res = await call(surveyPOST, {
      method: 'POST',
      path: '/api/survey',
      headers: { ...ip(), 'content-type': 'application/json' },
      body: '{ not json',
    });
    expect(res.status).toBe(400);
  });

  it('rate-limits at 10 requests per identity per 15 minutes', async () => {
    const headers = ip();
    for (let i = 0; i < 10; i++) {
      const res = await submitSurvey({ samtykke: i % 2 === 0 }, headers);
      expect(res.status, `request ${i + 1}`).toBe(200);
    }
    expect((await submitSurvey({ samtykke: true }, headers)).status).toBe(429);
  });

  // FIXED F-6: the handler stored `JSON.stringify(body)` verbatim with no size
  // cap and no key whitelist — an anonymous, rate-limited-only endpoint
  // (10/15 min per IP, easily spread across identities) that persisted an
  // arbitrarily large payload into SurveyResponse.data on every request. The
  // body is now bounded three ways: 64 KB, known keys only, scalar values.
  it('refuses a payload above a sane size cap (e.g. 64 KB)', async () => {
    const res = await submitSurvey({ epost: 'x@example.com', blob: 'x'.repeat(70_000) });
    expect(res.status).toBe(400);
    expect(await db.surveyResponse.count()).toBe(0);
  });

  it('refuses a key that is not a question this survey asks', async () => {
    await askQuestion('kjent');
    const ok = await submitSurvey({ kjent: 'ja' });
    expect(ok.status).toBe(200);

    const res = await submitSurvey({ kjent: 'ja', ukjent_felt: 'noe' });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('ukjent_felt');
    expect(await db.surveyResponse.count()).toBe(1); // only the accepted one
  });

  it('accepts a retired (inactive) question key, so an answer in flight is not lost', async () => {
    await db.surveyQuestion.create({
      data: { key: 'pensjonert', type: 'text', section: 'S', label: 'X', isActive: false, sortOrder: 10 },
    });
    expect((await submitSurvey({ pensjonert: 'ja' })).status).toBe(200);
  });

  it('refuses a value that is not a scalar or a list of strings', async () => {
    await askQuestion('svar');
    expect((await submitSurvey({ svar: { nested: true } })).status).toBe(400);
    expect((await submitSurvey({ svar: [1, 2, 3] })).status).toBe(400);
    expect((await submitSurvey({ svar: 'x'.repeat(2001) })).status).toBe(400);
    // …and the shapes the wizard really sends are all fine.
    expect((await submitSurvey({ svar: ['a', 'b'] })).status).toBe(200);
    expect((await submitSurvey({ svar: 4 })).status).toBe(200);
    expect((await submitSurvey({ svar: null })).status).toBe(200);
  });

  it('refuses a body that is not a JSON object', async () => {
    const res = await call(surveyPOST, {
      method: 'POST', path: '/api/survey', headers: { ...ip(), 'content-type': 'application/json' },
      body: '["a","b"]',
    });
    expect(res.status).toBe(400);
  });

  describe('lead discount', () => {
    async function enableDiscount(code: string): Promise<void> {
      await db.appConfig.update({ where: { key: 'surveyLeadDiscountEnabled' }, data: { value: 'true' } });
      await db.appConfig.update({ where: { key: 'surveyLeadDiscountCode' }, data: { value: code } });
      invalidateCaches();
    }

    it('hands out the configured code when enabled + consented + a valid campaign code', async () => {
      const c = await campaignCode({ code: 'SURVEY-2027', percent: 12 });
      await enableDiscount(c.code);

      const res = await submitSurvey({ epost: 'lead@example.com', samtykke: true });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ ok: true, discountCode: 'SURVEY-2027', discountPercent: 12 });

      await waitFor(() => emailMock.by('sendSurveyDiscountEmail').length >= 1);
      expect(emailMock.by('sendSurveyDiscountEmail')[0].args).toEqual(['lead@example.com', 'SURVEY-2027', 12]);
    });

    it('withholds the code when samtykke is not exactly true', async () => {
      const c = await campaignCode({ code: 'SURVEY-2027' });
      await enableDiscount(c.code);
      for (const consent of [false, 'true', 1, undefined]) {
        const res = await submitSurvey({ epost: 'lead2@example.com', samtykke: consent });
        expect(res.json.discountCode, `samtykke ${String(consent)}`).toBeNull();
      }
    });

    it('withholds the code when the email is missing or invalid', async () => {
      const c = await campaignCode({ code: 'SURVEY-2027' });
      await enableDiscount(c.code);
      expect((await submitSurvey({ samtykke: true })).json.discountCode).toBeNull();
      expect((await submitSurvey({ epost: 'not-an-email', samtykke: true })).json.discountCode).toBeNull();
    });

    it('withholds the code when the configured value is not a valid campaign code', async () => {
      await enableDiscount('DOES-NOT-EXIST');
      const res = await submitSurvey({ epost: 'lead3@example.com', samtykke: true });
      expect(res.json.discountCode).toBeNull();
      expect(emailMock.by('sendSurveyDiscountEmail')).toHaveLength(0);
    });

    it('withholds the code when a REPEAT (email-bound) code is configured instead of a campaign code', async () => {
      const { repeatCode } = await import('../helpers/db');
      const r = await repeatCode({ code: 'RETUR-ABCDEFGH', email: 'someone-else@example.com' });
      await enableDiscount(r.code);
      const res = await submitSurvey({ epost: 'lead4@example.com', samtykke: true });
      expect(res.json.discountCode).toBeNull();
    });

    it('withholds the code entirely when the feature is disabled (the default)', async () => {
      const c = await campaignCode({ code: 'SURVEY-2027' });
      await db.appConfig.update({ where: { key: 'surveyLeadDiscountCode' }, data: { value: c.code } });
      invalidateCaches(); // surveyLeadDiscountEnabled stays 'false' (default)
      const res = await submitSurvey({ epost: 'lead5@example.com', samtykke: true });
      expect(res.json.discountCode).toBeNull();
    });
  });
});

describe('admin auth', () => {
  it('the proxy 401s every /api/admin/survey* path without a session', async () => {
    expect(matcherMatches('/api/admin/survey')).toBe(true);
    expect(matcherMatches('/api/admin/survey/abc')).toBe(true);
    expect(matcherMatches('/api/admin/survey/questions')).toBe(true);
    expect((await proxyCall('/api/admin/survey')).status).toBe(401);
    expect((await proxyCall('/api/admin/survey/questions')).status).toBe(401);
  });

  it('each handler 401s on its own', async () => {
    signOut();
    expect((await call(adminSurveyList.GET, { path: '/api/admin/survey' })).status).toBe(401);
    expect((await call(adminSurveyById.DELETE, { method: 'DELETE', params: { id: 'x' } })).status).toBe(401);
    expect((await call(adminQuestionsList.GET, { path: '/api/admin/survey/questions' })).status).toBe(401);
    expect(
      (await call(adminQuestionsList.POST, { method: 'POST', path: '/api/admin/survey/questions', body: {} })).status,
    ).toBe(401);
    expect(
      (await call(adminQuestionsList.PUT, { method: 'PUT', path: '/api/admin/survey/questions', body: { ids: [] } }))
        .status,
    ).toBe(401);
    expect((await call(adminQuestionById.PATCH, { method: 'PATCH', params: { id: 'x' }, body: {} })).status).toBe(401);
    expect((await call(adminQuestionById.DELETE, { method: 'DELETE', params: { id: 'x' } })).status).toBe(401);
  });
});

describe('GET /api/admin/survey', () => {
  it('returns rows and a total, newest first', async () => {
    await db.surveyResponse.create({ data: { data: JSON.stringify({ n: 1 }) } });
    await db.surveyResponse.create({ data: { data: JSON.stringify({ n: 2 }) } });
    const res = await call(adminSurveyList.GET, { path: '/api/admin/survey' });
    expect(res.status).toBe(200);
    expect(res.json.total).toBe(2);
    expect(res.json.rows).toHaveLength(2);
  });
});

describe('DELETE /api/admin/survey/[id]', () => {
  it('removes the row', async () => {
    const row = await db.surveyResponse.create({ data: { data: '{}' } });
    const res = await call(adminSurveyById.DELETE, { method: 'DELETE', params: { id: row.id } });
    expect(res.status).toBe(200);
    expect(await db.surveyResponse.count()).toBe(0);
  });

  // FIXED N-3: same shape as F-10 on /api/admin/quote-requests/[id] — there
  // was no existence check and no try/catch, so Prisma's P2025 escaped the
  // handler unhandled instead of answering 404.
  it('404s on an unknown id instead of throwing', async () => {
    const res = await call(adminSurveyById.DELETE, { method: 'DELETE', params: { id: 'does-not-exist' } });
    expect(res.status).toBe(404);
  });

  // Rewritten for FIXED N-3: nothing escapes the handler, and the other rows
  // are untouched.
  it('leaves existing rows alone when the id is unknown', async () => {
    const row = await db.surveyResponse.create({ data: { data: '{}' } });
    const res = await call(adminSurveyById.DELETE, { method: 'DELETE', params: { id: 'does-not-exist' } });
    expect(res.status).toBe(404);
    expect(await db.surveyResponse.count({ where: { id: row.id } })).toBe(1);
  });
});

describe('GET /api/admin/survey/questions', () => {
  // NOTE: does not assert "seeds an empty table" here — the process-local
  // `seeded` guard in src/lib/survey-service.ts means whether that happens
  // depends on whether an earlier test in this file already triggered it
  // (see FINDING N-2, demonstrated in tests/service/survey-service.test.ts).
  // This test seeds its own rows so it is independent of that.
  it('serializes every field, options/config parsed from JSON', async () => {
    await db.surveyQuestion.create({
      data: {
        key: 'med_valg', type: 'radio', section: 'S', label: 'L', hint: 'H',
        options: JSON.stringify(['a', 'b']), config: JSON.stringify({ max: 2 }),
        required: true, isActive: true, sortOrder: 10,
      },
    });
    const res = await call(adminQuestionsList.GET, { path: '/api/admin/survey/questions' });
    expect(res.status).toBe(200);
    expect(res.json.questions).toHaveLength(1);
    expect(res.json.questions[0]).toMatchObject({
      key: 'med_valg', type: 'radio', options: ['a', 'b'], config: { max: 2 },
    });
  });
});

describe('POST /api/admin/survey/questions', () => {
  function create(body: Record<string, unknown>) {
    return call(adminQuestionsList.POST, { method: 'POST', path: '/api/admin/survey/questions', body });
  }

  it('creates a question and assigns sortOrder = max + 10', async () => {
    const res = await create({ key: 'ny_test', type: 'text', section: 'Test', label: 'Ny testspørsmål' });
    expect(res.status).toBe(200);
    const max = await db.surveyQuestion.aggregate({ _max: { sortOrder: true } });
    expect(res.json.question.sortOrder).toBe(max._max.sortOrder);
  });

  it('rejects a key outside ^[a-z0-9_]+$', async () => {
    // Note: the key is lowercased before the regex runs, so 'HAS_CAPS' alone
    // would pass (covered by the "lowercases and trims" test below).
    for (const key of ['Has-Dash', 'has space', 'a!b', '']) {
      const res = await create({ key, type: 'text', section: 'S', label: 'L' });
      expect(res.status, key).toBe(400);
    }
  });

  it('lowercases and trims the key before validating', async () => {
    const res = await create({ key: '  MinNokkel  ', type: 'text', section: 'S', label: 'L' });
    expect(res.status).toBe(200);
    expect(res.json.question.key).toBe('minnokkel');
  });

  it('rejects a type outside the whitelist', async () => {
    const res = await create({ key: 'unik_type', type: 'not-a-type', section: 'S', label: 'L' });
    expect(res.status).toBe(400);
  });

  it('requires section and label', async () => {
    expect((await create({ key: 'a1', type: 'text', section: '', label: 'L' })).status).toBe(400);
    expect((await create({ key: 'a2', type: 'text', section: 'S', label: '' })).status).toBe(400);
  });

  it('409s on a duplicate key', async () => {
    await create({ key: 'dobbel', type: 'text', section: 'S', label: 'L' });
    const res = await create({ key: 'dobbel', type: 'text', section: 'S', label: 'L2' });
    expect(res.status).toBe(409);
  });

  it('required and isActive default true unless explicitly false', async () => {
    const res = await create({ key: 'flagg_test', type: 'text', section: 'S', label: 'L' });
    expect(res.json.question.required).toBe(true);
    expect(res.json.question.isActive).toBe(true);
    const res2 = await create({ key: 'flagg_test2', type: 'text', section: 'S', label: 'L', required: false, isActive: false });
    expect(res2.json.question.required).toBe(false);
    expect(res2.json.question.isActive).toBe(false);
  });
});

describe('PUT /api/admin/survey/questions (reorder)', () => {
  function put(body: Record<string, unknown>) {
    return call(adminQuestionsList.PUT, { method: 'PUT', path: '/api/admin/survey/questions', body });
  }

  it('rewrites sortOrder to (index + 1) * 10 in the given order', async () => {
    const a = await db.surveyQuestion.create({ data: { key: 'a', type: 'text', section: 'S', label: 'A', sortOrder: 5 } });
    const b = await db.surveyQuestion.create({ data: { key: 'b', type: 'text', section: 'S', label: 'B', sortOrder: 15 } });
    const res = await put({ ids: [b.id, a.id] });
    expect(res.status).toBe(200);
    const rows = await db.surveyQuestion.findMany({ orderBy: { sortOrder: 'asc' } });
    expect(rows.map((r) => r.id)).toEqual([b.id, a.id]);
    expect(rows.map((r) => r.sortOrder)).toEqual([10, 20]);
  });

  it('400s when ids is not an array', async () => {
    const res = await put({ ids: 'not-an-array' });
    expect(res.status).toBe(400);
  });

  // FIXED N-4: `db.$transaction(ids.map(...update...))` had no try/catch, so
  // one bad id in the array threw Prisma's P2025 straight out of the handler —
  // an all-or-nothing transaction where a single stale id (a question deleted
  // in another tab) 500'd the whole reorder instead of answering a clean 400.
  // The ids are checked up front now.
  it('an unknown id in the list fails cleanly (400), not with an unhandled throw', async () => {
    const a = await db.surveyQuestion.create({ data: { key: 'a2', type: 'text', section: 'S', label: 'A' } });
    const res = await put({ ids: [a.id, 'does-not-exist'] });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('does-not-exist');
  });

  // Rewritten for FIXED N-4: a refused reorder must reorder nothing.
  it('writes no sortOrder at all when one id in the list is unknown', async () => {
    const a = await db.surveyQuestion.create({ data: { key: 'a3', type: 'text', section: 'S', label: 'A', sortOrder: 5 } });
    const b = await db.surveyQuestion.create({ data: { key: 'b3', type: 'text', section: 'S', label: 'B', sortOrder: 15 } });
    expect((await put({ ids: [b.id, a.id, 'does-not-exist'] })).status).toBe(400);
    const rows = await db.surveyQuestion.findMany({ orderBy: { key: 'asc' } });
    expect(rows.map((r) => r.sortOrder)).toEqual([5, 15]);
  });
});

describe('PATCH /api/admin/survey/questions/[id]', () => {
  function patch(id: string, body: Record<string, unknown>) {
    return call(adminQuestionById.PATCH, { method: 'PATCH', params: { id }, body });
  }

  it('updates only the fields present in the body', async () => {
    const q = await db.surveyQuestion.create({ data: { key: 'edit_me', type: 'text', section: 'S', label: 'Old' } });
    const res = await patch(q.id, { label: 'New label' });
    expect(res.status).toBe(200);
    const row = await db.surveyQuestion.findUniqueOrThrow({ where: { id: q.id } });
    expect(row.label).toBe('New label');
    expect(row.section).toBe('S'); // untouched
  });

  it('400s on an empty patch', async () => {
    const q = await db.surveyQuestion.create({ data: { key: 'empty_patch', type: 'text', section: 'S', label: 'L' } });
    const res = await patch(q.id, {});
    expect(res.status).toBe(400);
  });

  it('rejects a type outside the whitelist', async () => {
    const q = await db.surveyQuestion.create({ data: { key: 'bad_type', type: 'text', section: 'S', label: 'L' } });
    const res = await patch(q.id, { type: 'nope' });
    expect(res.status).toBe(400);
  });

  it('404s on an unknown id (this one DOES fail cleanly)', async () => {
    const res = await patch('does-not-exist', { label: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/admin/survey/questions/[id]', () => {
  it('removes the row, and is a graceful no-op on an unknown id', async () => {
    const q = await db.surveyQuestion.create({ data: { key: 'del_me', type: 'text', section: 'S', label: 'L' } });
    const res = await call(adminQuestionById.DELETE, { method: 'DELETE', params: { id: q.id } });
    expect(res.status).toBe(200);
    expect(await db.surveyQuestion.count()).toBe(0);

    const res2 = await call(adminQuestionById.DELETE, { method: 'DELETE', params: { id: 'does-not-exist' } });
    expect(res2.status).toBe(200);
  });
});
