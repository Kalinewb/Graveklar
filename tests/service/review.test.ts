import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { booking, db, ensureSchema, resetDb, seedConfigDefaults } from '../helpers/db';

// L3 — src/lib/review.ts. Post-rental review request → submission → the
// public/admin read paths, below HTTP.

let ensureReviewRequest: typeof import('@/lib/review').ensureReviewRequest;
let getApprovedReviews: typeof import('@/lib/review').getApprovedReviews;
let getReviewAggregate: typeof import('@/lib/review').getReviewAggregate;
let getReviewByToken: typeof import('@/lib/review').getReviewByToken;
let submitReview: typeof import('@/lib/review').submitReview;
let ReviewError: typeof import('@/lib/review').ReviewError;

beforeAll(async () => {
  await ensureSchema();
  const mod = await import('@/lib/review');
  ({ ensureReviewRequest, getApprovedReviews, getReviewAggregate, getReviewByToken, submitReview, ReviewError } = mod);
});

beforeEach(async () => {
  await resetDb();
  await seedConfigDefaults();
});

describe('ensureReviewRequest', () => {
  it('creates a pending review and returns its token', async () => {
    const b = await booking('completed');
    const result = await ensureReviewRequest(b.id);
    expect(result?.token).toBeTruthy();
    const row = await db.review.findUniqueOrThrow({ where: { bookingId: b.id } });
    expect(row.status).toBe('pending');
    expect(row.token).toBe(result?.token);
  });

  it('returns null (no re-send) when a review already exists for the booking', async () => {
    const b = await booking('completed');
    await ensureReviewRequest(b.id);
    const second = await ensureReviewRequest(b.id);
    expect(second).toBeNull();
    expect(await db.review.count({ where: { bookingId: b.id } })).toBe(1);
  });

  it('is race-safe: two concurrent calls for the same booking only ever create one row', async () => {
    const b = await booking('completed');
    const [a, c] = await Promise.all([ensureReviewRequest(b.id), ensureReviewRequest(b.id)]);
    const tokens = [a, c].filter(Boolean);
    expect(tokens).toHaveLength(1); // exactly one caller got a token back
    expect(await db.review.count({ where: { bookingId: b.id } })).toBe(1);
  });
});

describe('getReviewByToken', () => {
  it('returns null for an empty token without touching the database', async () => {
    expect(await getReviewByToken('')).toBeNull();
  });

  it('returns null for an unknown token', async () => {
    expect(await getReviewByToken('does-not-exist')).toBeNull();
  });

  it('includes the booking name and reference', async () => {
    const b = await booking('completed', { name: 'Ola Nordmann' });
    const { token } = (await ensureReviewRequest(b.id))!;
    const row = await getReviewByToken(token);
    expect(row?.booking).toMatchObject({ name: 'Ola Nordmann', reference: b.reference });
  });
});

describe('submitReview', () => {
  async function pendingReview(overrides: { name?: string } = {}) {
    const b = await booking('completed', { name: overrides.name ?? 'Test Testesen', skipLocks: true });
    const { token } = (await ensureReviewRequest(b.id))!;
    return { booking: b, token };
  }

  it('throws ReviewError on an unknown token', async () => {
    await expect(submitReview({ token: 'nope', rating: 5, comment: '' })).rejects.toThrow(ReviewError);
  });

  it('throws when the review is not pending (already submitted)', async () => {
    const { token } = await pendingReview();
    await submitReview({ token, rating: 4, comment: 'Bra!' });
    await expect(submitReview({ token, rating: 5, comment: 'igjen' })).rejects.toThrow(
      /allerede sendt inn/,
    );
  });

  it('rejects a rating outside 1…5, and a non-numeric rating', async () => {
    for (const bad of [0, 6, -1, NaN, 'abc']) {
      const { token } = await pendingReview();
      await expect(submitReview({ token, rating: bad as number, comment: 'x' })).rejects.toThrow(ReviewError);
    }
  });

  it('rounds a fractional rating to the nearest integer', async () => {
    const { token, booking: b } = await pendingReview();
    await submitReview({ token, rating: 4.4, comment: '' });
    const row = await db.review.findUniqueOrThrow({ where: { bookingId: b.id } });
    expect(row.rating).toBe(4);
  });

  it('accepts every integer rating 1…5', async () => {
    for (let r = 1; r <= 5; r++) {
      const { token, booking: b } = await pendingReview();
      await submitReview({ token, rating: r, comment: '' });
      const row = await db.review.findUniqueOrThrow({ where: { bookingId: b.id } });
      expect(row.rating).toBe(r);
    }
  });

  it('truncates the comment to 2000 characters', async () => {
    const { token, booking: b } = await pendingReview();
    await submitReview({ token, rating: 5, comment: 'x'.repeat(3000) });
    const row = await db.review.findUniqueOrThrow({ where: { bookingId: b.id } });
    expect(row.comment).toHaveLength(2000);
  });

  it('a blank comment is stored as null, not an empty string', async () => {
    const { token, booking: b } = await pendingReview();
    await submitReview({ token, rating: 5, comment: '   ' });
    const row = await db.review.findUniqueOrThrow({ where: { bookingId: b.id } });
    expect(row.comment).toBeNull();
  });

  it('defaults reviewerName to the first name on the booking', async () => {
    const { token, booking: b } = await pendingReview({ name: 'Kari Nordmann' });
    await submitReview({ token, rating: 5, comment: '' });
    const row = await db.review.findUniqueOrThrow({ where: { bookingId: b.id } });
    expect(row.reviewerName).toBe('Kari');
  });

  it('an explicit reviewerName is reduced to its first token too', async () => {
    const { token, booking: b } = await pendingReview();
    await submitReview({ token, rating: 5, comment: '', reviewerName: 'Anne Berit Olsen' });
    const row = await db.review.findUniqueOrThrow({ where: { bookingId: b.id } });
    expect(row.reviewerName).toBe('Anne');
  });

  it('sets status to submitted and stamps submittedAt', async () => {
    const { token, booking: b } = await pendingReview();
    await submitReview({ token, rating: 5, comment: '' });
    const row = await db.review.findUniqueOrThrow({ where: { bookingId: b.id } });
    expect(row.status).toBe('submitted');
    expect(row.submittedAt).toBeInstanceOf(Date);
  });

  // FIXED N-1: unlike `comment` (explicitly sliced to 2000 chars),
  // `reviewerName` had no length cap at all. `firstName()` only splits on
  // whitespace, so a SINGLE unbroken token of any length — an attacker's
  // payload, or just no spaces — passed straight through to the public
  // reviews list. It is now sliced to 40 characters inside `firstName()`.
  it('reviewerName is capped at a sane display length', async () => {
    const { token, booking: b } = await pendingReview();
    const longName = 'A'.repeat(500); // one token, no whitespace to split on
    await submitReview({ token, rating: 5, comment: '', reviewerName: longName });
    const row = await db.review.findUniqueOrThrow({ where: { bookingId: b.id } });
    expect(row.reviewerName!.length).toBeLessThanOrEqual(40);
  });

  // Rewritten for FIXED N-1: the cap applies to the name derived from the
  // booking too, not only to a name the reviewer typed.
  it('caps the name taken from the booking as well', async () => {
    const { token, booking: b } = await pendingReview({ name: 'B'.repeat(500) });
    await submitReview({ token, rating: 5, comment: '' });
    const row = await db.review.findUniqueOrThrow({ where: { bookingId: b.id } });
    expect(row.reviewerName).toHaveLength(40);
  });
});

describe('getApprovedReviews', () => {
  async function approvedReview(rating: number, overrides: Record<string, unknown> = {}) {
    const b = await booking('completed', { email: `r-${Math.random()}@example.com`, skipLocks: true });
    return db.review.create({
      data: {
        bookingId: b.id,
        token: `tok-${Math.random().toString(36).slice(2)}`,
        status: 'approved',
        rating,
        reviewerName: 'Test',
        submittedAt: new Date(),
        ...overrides,
      },
    });
  }

  it('only returns approved reviews, newest first', async () => {
    const older = await approvedReview(3, { submittedAt: new Date('2027-01-01') });
    const b = await booking('completed', { skipLocks: true });
    await db.review.create({
      data: { bookingId: b.id, token: 'tok-pending', status: 'pending' },
    });
    const newest = await approvedReview(5, { submittedAt: new Date('2027-02-01') });

    const rows = await getApprovedReviews();
    expect(rows.map((r) => r.id)).toEqual([newest.id, older.id]);
  });

  it('respects the limit', async () => {
    for (let i = 0; i < 5; i++) await approvedReview(5);
    expect(await getApprovedReviews(2)).toHaveLength(2);
  });

  it('defaults an empty reviewerName to "Anonym"', async () => {
    await approvedReview(4, { reviewerName: '' });
    const rows = await getApprovedReviews();
    expect(rows[0].reviewerName).toBe('Anonym');
  });
});

describe('getReviewAggregate', () => {
  async function approvedReview(rating: number) {
    const b = await booking('completed', { email: `r-${Math.random()}@example.com`, skipLocks: true });
    return db.review.create({
      data: { bookingId: b.id, token: `tok-${Math.random().toString(36).slice(2)}`, status: 'approved', rating, submittedAt: new Date() },
    });
  }

  it('is zero with no reviews', async () => {
    expect(await getReviewAggregate()).toEqual({ count: 0, average: 0 });
  });

  it('rounds the average to 1 decimal place (13×5 + 7×4 → mean 4.65 → 4.7)', async () => {
    // 13×5 + 7×4 = 65 + 28 = 93; 93/20 = 4.65 exactly. Math.round(46.5) = 47
    // (round-half-up), so the documented 4.65 case lands on 4.7, not 4.6.
    for (let i = 0; i < 13; i++) await approvedReview(5);
    for (let i = 0; i < 7; i++) await approvedReview(4);
    const agg = await getReviewAggregate();
    expect(agg.count).toBe(20);
    expect(agg.average).toBe(4.7);
  });

  it('ignores pending and rejected reviews', async () => {
    await approvedReview(5);
    const b = await booking('completed', { skipLocks: true });
    await db.review.create({ data: { bookingId: b.id, token: 'tok-rej', status: 'rejected', rating: 1 } });
    const agg = await getReviewAggregate();
    expect(agg.count).toBe(1);
    expect(agg.average).toBe(5);
  });
});
