import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { booking, db, ensureSchema, resetDb, seedConfigDefaults } from '../helpers/db';
import { call, type RouteHandler } from '../helpers/route';

// L2 — POST /api/omtale/[token]. The public review-submission page.

// The handler declares `params: Promise<{ token: string }>`; the harness
// hands over the generic RouteParams shape (same cast as
// tests/api/admin-discount-codes.test.ts).
let POST: RouteHandler;

let ipSeq = 0;
function ip(): Record<string, string> {
  return { 'x-forwarded-for': `10.3.0.${++ipSeq}` };
}

async function pendingReview(name = 'Test Testesen') {
  const b = await booking('completed', { name, skipLocks: true });
  const { ensureReviewRequest } = await import('@/lib/review');
  const { token } = (await ensureReviewRequest(b.id))!;
  return { booking: b, token };
}

async function submit(token: string, body: unknown, headers: Record<string, string> = ip()) {
  return call(POST, {
    method: 'POST',
    path: `/api/omtale/${token}`,
    params: { token },
    headers,
    body,
  });
}

beforeAll(async () => {
  await ensureSchema();
  ({ POST } = (await import('@/app/api/omtale/[token]/route')) as unknown as { POST: RouteHandler });
});

beforeEach(async () => {
  await resetDb();
  await seedConfigDefaults();
});

describe('POST /api/omtale/[token]', () => {
  it('accepts a valid submission', async () => {
    const { token } = await pendingReview();
    const res = await submit(token, { rating: 5, comment: 'Kjempebra!' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ success: true });
    const row = await db.review.findUniqueOrThrow({ where: { token } });
    expect(row.status).toBe('submitted');
  });

  it('400s on the honeypot field', async () => {
    const { token } = await pendingReview();
    const res = await submit(token, { rating: 5, comment: '', website: 'http://spam.example' });
    expect(res.status).toBe(400);
    const row = await db.review.findUniqueOrThrow({ where: { token } });
    expect(row.status).toBe('pending'); // untouched
  });

  it('400s on malformed JSON', async () => {
    const { token } = await pendingReview();
    const res = await call(POST, {
      method: 'POST',
      path: `/api/omtale/${token}`,
      params: { token },
      headers: { ...ip(), 'content-type': 'application/json' },
      body: '{ not json',
    });
    expect(res.status).toBe(400);
  });

  it('a ReviewError (unknown token, out-of-range rating) answers 400 with its message', async () => {
    const res = await submit('does-not-exist', { rating: 5, comment: '' });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/Ugyldig lenke/);
  });

  it('a second submission on the same token is rejected (already submitted)', async () => {
    const { token } = await pendingReview();
    const first = await submit(token, { rating: 5, comment: 'Først' });
    expect(first.status).toBe(200);
    const second = await submit(token, { rating: 1, comment: 'Overskriv?' });
    expect(second.status).toBe(400);
    expect(second.json.error).toMatch(/allerede sendt inn/);

    const row = await db.review.findUniqueOrThrow({ where: { token } });
    expect(row.rating).toBe(5); // the first submission stands
  });

  it('rejects an out-of-range rating with 400', async () => {
    const { token } = await pendingReview();
    const res = await submit(token, { rating: 9, comment: '' });
    expect(res.status).toBe(400);
  });

  it('passes reviewerName through when supplied', async () => {
    const { token } = await pendingReview('Kari Nordmann');
    const res = await submit(token, { rating: 5, comment: '', reviewerName: 'Egendefinert' });
    expect(res.status).toBe(200);
    const row = await db.review.findUniqueOrThrow({ where: { token } });
    expect(row.reviewerName).toBe('Egendefinert');
  });

  it('rate-limits at 10 requests per identity per 15 minutes', async () => {
    const headers = ip();
    const tokens: string[] = [];
    for (let i = 0; i < 10; i++) {
      const { token } = await pendingReview(`Kunde ${i}`);
      tokens.push(token);
      const res = await submit(token, { rating: 5, comment: '' }, headers);
      expect(res.status, `request ${i + 1}`).not.toBe(429);
    }
    const { token: eleventhToken } = await pendingReview('Kunde 11');
    const eleventh = await submit(eleventhToken, { rating: 5, comment: '' }, headers);
    expect(eleventh.status).toBe(429);
  });
});
