import { randomUUID } from 'crypto';
import { db } from '@/lib/db';

export class ReviewError extends Error {}

/** Longest reviewer name we store. `firstName()` only splits on whitespace, so
 *  without a cap a single unbroken token of any length reaches the public
 *  reviews list verbatim — unlike `comment`, which has always been sliced
 *  (finding N-1). 40 characters is well past any real Norwegian first name. */
const MAX_REVIEWER_NAME = 40;

function firstName(full: string): string {
  return ((full || '').trim().split(/\s+/)[0] || '').slice(0, MAX_REVIEWER_NAME);
}

/** Idempotently create a pending review request for a completed booking and
 *  return its token. Returns null if a review row already exists (so the
 *  caller doesn't re-send the request email). */
export async function ensureReviewRequest(bookingId: string): Promise<{ token: string } | null> {
  const existing = await db.review.findUnique({ where: { bookingId } });
  if (existing) return null;
  try {
    const review = await db.review.create({
      data: { bookingId, token: randomUUID(), status: 'pending' },
      select: { token: true },
    });
    return review;
  } catch {
    // Unique race — another caller created it first. Treat as "already sent".
    return null;
  }
}

export interface PublicReview {
  id: string;
  rating: number;
  comment: string | null;
  reviewerName: string;
  submittedAt: Date;
}

export async function getApprovedReviews(limit = 20): Promise<PublicReview[]> {
  const rows = await db.review.findMany({
    where: { status: 'approved', rating: { not: null }, submittedAt: { not: null } },
    orderBy: { submittedAt: 'desc' },
    take: limit,
  });
  return rows.map((r) => ({
    id: r.id,
    rating: r.rating as number,
    comment: r.comment,
    reviewerName: r.reviewerName || 'Anonym',
    submittedAt: r.submittedAt as Date,
  }));
}

export interface ReviewAggregate {
  count: number;
  average: number; // 0 when no reviews
}

export async function getReviewAggregate(): Promise<ReviewAggregate> {
  const agg = await db.review.aggregate({
    where: { status: 'approved', rating: { not: null } },
    _avg: { rating: true },
    _count: { _all: true },
  });
  return {
    count: agg._count._all,
    average: agg._avg.rating ? Math.round(agg._avg.rating * 10) / 10 : 0,
  };
}

/** Load a review by its public token. Used by the submit page to decide what
 *  to render (form vs. "already submitted" vs. invalid). */
export async function getReviewByToken(token: string) {
  if (!token) return null;
  return db.review.findUnique({
    where: { token },
    include: { booking: { select: { name: true, reference: true } } },
  });
}

export async function submitReview(input: {
  token: string;
  rating: number;
  comment: string;
  reviewerName?: string;
}): Promise<void> {
  const review = await db.review.findUnique({
    where: { token: input.token },
    include: { booking: { select: { name: true } } },
  });
  if (!review) throw new ReviewError('Ugyldig lenke.');
  if (review.status !== 'pending') throw new ReviewError('Denne anmeldelsen er allerede sendt inn.');

  const rating = Math.round(Number(input.rating));
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    throw new ReviewError('Velg en vurdering mellom 1 og 5 stjerner.');
  }
  const comment = (input.comment || '').trim().slice(0, 2000);
  const name = (input.reviewerName || '').trim() || firstName(review.booking.name);

  await db.review.update({
    where: { token: input.token },
    data: {
      rating,
      comment: comment || null,
      reviewerName: firstName(name),
      status: 'submitted',
      submittedAt: new Date(),
    },
  });
}
