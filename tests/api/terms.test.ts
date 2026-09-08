/**
 * L2 — GET /api/terms (public) + GET/POST /api/admin/terms and PATCH/DELETE
 * /api/admin/terms/[id] (admin CRUD on TermsSection). Admin auth itself is
 * gated at src/proxy.ts and covered generically by
 * tests/api/admin-route-gating.test.ts — these tests call the handlers
 * directly to exercise the route bodies.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, ensureSchema, resetDb } from '../helpers/db';
import { call, type RouteHandler } from '../helpers/route';

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDb();
});

async function publicGet(audience?: string) {
  const { GET } = await import('@/app/api/terms/route');
  return call(GET, { path: '/api/terms', searchParams: audience !== undefined ? { audience } : {} });
}

async function adminList() {
  const { GET } = await import('@/app/api/admin/terms/route');
  return call(GET, { path: '/api/admin/terms' });
}

async function adminCreate(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/admin/terms/route');
  return call(POST, { method: 'POST', path: '/api/admin/terms', body });
}

async function adminPatch(id: string, body: Record<string, unknown>) {
  const { PATCH } = await import('@/app/api/admin/terms/[id]/route');
  return call(PATCH as unknown as RouteHandler, {
    method: 'PATCH', path: `/api/admin/terms/${id}`, params: { id }, body,
  });
}

async function adminDelete(id: string) {
  const { DELETE } = await import('@/app/api/admin/terms/[id]/route');
  return call(DELETE as unknown as RouteHandler, {
    method: 'DELETE', path: `/api/admin/terms/${id}`, params: { id },
  });
}

// ── GET /api/terms (public) ─────────────────────────────────────────────────

describe('GET /api/terms', () => {
  beforeEach(async () => {
    await db.termsSection.createMany({
      data: [
        { title: 'C-second', content: 'x', sortOrder: 1, isActive: true, audience: 'consumer' },
        { title: 'C-hidden', content: 'x', sortOrder: 0, isActive: false, audience: 'consumer' },
        { title: 'C-first', content: 'x', sortOrder: 0, isActive: true, audience: 'consumer' },
        { title: 'B-only', content: 'x', sortOrder: 0, isActive: true, audience: 'business' },
      ],
    });
  });

  it('defaults to the consumer audience', async () => {
    const res = await publicGet();
    expect(res.status).toBe(200);
    expect(res.json.sections.map((s: { title: string }) => s.title)).toEqual(['C-first', 'C-second']);
  });

  it('returns the business audience only when explicitly requested', async () => {
    const res = await publicGet('business');
    expect(res.status).toBe(200);
    expect(res.json.sections.map((s: { title: string }) => s.title)).toEqual(['B-only']);
  });

  it('treats anything other than the literal "business" as consumer', async () => {
    for (const value of ['Business', 'BUSINESS', 'bedrift', '', 'consumer2']) {
      const res = await publicGet(value);
      expect(res.json.sections.map((s: { title: string }) => s.title), value).toEqual(['C-first', 'C-second']);
    }
  });

  it('never returns inactive sections', async () => {
    const res = await publicGet();
    expect(res.json.sections.map((s: { title: string }) => s.title)).not.toContain('C-hidden');
  });
});

// ── GET/POST /api/admin/terms ────────────────────────────────────────────────

describe('GET /api/admin/terms', () => {
  it('returns every section regardless of audience or active state', async () => {
    await db.termsSection.createMany({
      data: [
        { title: 'A', content: 'x', sortOrder: 0, isActive: true, audience: 'consumer' },
        { title: 'B', content: 'x', sortOrder: 1, isActive: false, audience: 'business' },
      ],
    });
    const res = await adminList();
    expect(res.status).toBe(200);
    expect(res.json.sections).toHaveLength(2);
  });
});

describe('POST /api/admin/terms', () => {
  it('creates a consumer section by default', async () => {
    const res = await adminCreate({ title: 'Ny seksjon', content: 'Innhold' });
    expect(res.status).toBe(201);
    expect(res.json.section).toMatchObject({
      title: 'Ny seksjon', content: 'Innhold', audience: 'consumer', sortOrder: 0, isActive: true,
    });
  });

  it('creates a business section only when audience is exactly "business"', async () => {
    const res = await adminCreate({ title: 'B2B', content: 'X', audience: 'business' });
    expect(res.json.section.audience).toBe('business');

    for (const value of ['Business', 'bedrift', 'BUSINESS', 42, null]) {
      const other = await adminCreate({ title: 'T', content: 'X', audience: value });
      expect(other.json.section.audience, JSON.stringify(value)).toBe('consumer');
    }
  });

  it('trims title/content and defaults empty when missing', async () => {
    const res = await adminCreate({ title: '  Padded  ', content: '  Body  ' });
    expect(res.json.section.title).toBe('Padded');
    expect(res.json.section.content).toBe('Body');

    const empty = await adminCreate({});
    expect(empty.json.section.title).toBe('');
    expect(empty.json.section.content).toBe('');
  });

  it('respects an explicit isActive:false and a custom sortOrder', async () => {
    const res = await adminCreate({ title: 'T', content: 'X', isActive: false, sortOrder: 7 });
    expect(res.json.section).toMatchObject({ isActive: false, sortOrder: 7 });
  });
});

// ── PATCH/DELETE /api/admin/terms/[id] ──────────────────────────────────────

describe('PATCH /api/admin/terms/[id]', () => {
  it('updates only the fields present in the body', async () => {
    const section = await db.termsSection.create({
      data: { title: 'Original', content: 'Original body', sortOrder: 0, isActive: true, audience: 'consumer' },
    });

    const res = await adminPatch(section.id, { content: 'Updated body' });
    expect(res.status).toBe(200);
    expect(res.json.section).toMatchObject({ title: 'Original', content: 'Updated body' });
  });

  it('the audience ternary accepts only the literal "business", everything else becomes consumer', async () => {
    const section = await db.termsSection.create({
      data: { title: 'T', content: 'X', sortOrder: 0, isActive: true, audience: 'consumer' },
    });
    const toBusiness = await adminPatch(section.id, { audience: 'business' });
    expect(toBusiness.json.section.audience).toBe('business');

    const toBedrift = await adminPatch(section.id, { audience: 'bedrift' });
    expect(toBedrift.json.section.audience).toBe('consumer');
  });

  // FIXED K-2: neither PATCH nor DELETE checked the row exists before calling
  // Prisma — a missing id threw P2025 and the catch-all turned it into a 500
  // instead of the clean 404 every other admin CRUD route gives (see the
  // matching DELETE case below).
  it('a missing section id answers 404, not the generic 500', async () => {
    const res = await adminPatch('no-such-id', { title: 'X' });
    expect(res.status).toBe(404);
  });

  // FIXED K-1: PATCH built the Prisma `data` object straight from the raw
  // request body with no type validation — `sortOrder` (Int) or `isActive`
  // (Boolean) sent as the wrong JS type reached Prisma's own validator and the
  // catch-all turned the PrismaClientValidationError into a 500 carrying
  // Prisma's internal error text. Each field is shape-checked first now.
  it('answers 400, not 500, when a field is sent with the wrong type', async () => {
    const section = await db.termsSection.create({
      data: { title: 'T', content: 'X', sortOrder: 0, isActive: true, audience: 'consumer' },
    });

    const wrongSortOrder = await adminPatch(section.id, { sortOrder: 'first' });
    expect(wrongSortOrder.status).toBe(400);

    const wrongIsActive = await adminPatch(section.id, { isActive: 'yes' });
    expect(wrongIsActive.status).toBe(400);

    const wrongContent = await adminPatch(section.id, { content: 12345 });
    expect(wrongContent.status).toBe(400);
  });
});

describe('DELETE /api/admin/terms/[id]', () => {
  it('deletes an existing section', async () => {
    const section = await db.termsSection.create({
      data: { title: 'T', content: 'X', sortOrder: 0, isActive: true, audience: 'consumer' },
    });
    const res = await adminDelete(section.id);
    expect(res.status).toBe(200);
    expect(await db.termsSection.count({ where: { id: section.id } })).toBe(0);
  });

  // FIXED K-2 (same as the PATCH case above): DELETE for an id that does not
  // exist used to throw Prisma's P2025 into the catch-all as a 500 — the same
  // missing-row case every other admin CRUD route answers with 404.
  it('answers 404 for an id that does not exist', async () => {
    const res = await adminDelete('no-such-id');
    expect(res.status).toBe(404);
  });
});
