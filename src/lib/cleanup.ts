import { readdir, stat, unlink } from 'fs/promises';
import path from 'path';
import { db } from '@/lib/db';
import { updateBookingStatus } from '@/lib/booking-service';

// In-process lazy cleanup. Avoids needing an external cron scheduler on a
// self-hosted Next.js server — we just piggy-back on natural traffic. The
// admin booking list, /api/availability, and the home page all call
// `runCleanupIfDue()` at the start of their handler. A `lastRan` guard
// ensures we don't hammer the DB on every single request.

// 60 min matches the default Stripe Checkout session lifetime + the
// `paymentDeadline` we set when a booking is created. Only a tail of
// legacy bookings that pre-date that change ever fall into this branch.
const STALE_PENDING_MS = 60 * 60 * 1000;
const CLEANUP_THROTTLE_MS = 60 * 1000;            // at most once per minute
// Orphan-upload sweep is heavier (scans bookings + submissions), so it runs
// far less often than the booking/lock sweep.
const ORPHAN_SWEEP_THROTTLE_MS = 6 * 60 * 60 * 1000; // at most every 6 hours
// Don't touch freshly written files — a photo may be uploaded seconds before
// the checklist row that references it is saved. Only files older than this
// are eligible for deletion.
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

let lastRan = 0;
let lastOrphanSweep = 0;
let inFlight = false;

export async function runCleanupIfDue(): Promise<{ ran: boolean; cancelled: number; orphanLocksReleased: number; tokensSwept: number; orphanUploadsRemoved: number }> {
  const now = Date.now();
  if (inFlight || now - lastRan < CLEANUP_THROTTLE_MS) {
    return { ran: false, cancelled: 0, orphanLocksReleased: 0, tokensSwept: 0, orphanUploadsRemoved: 0 };
  }
  // Set lastRan *before* the run so a slow cleanup doesn't extend the
  // throttle window past 60 s. inFlight already blocks overlap.
  lastRan = now;
  inFlight = true;
  try {
    return await runCleanup();
  } finally {
    inFlight = false;
  }
}

/** Same logic as the /api/cron/cleanup route, refactored so it can be called
 *  in-process. Cancels expired pending bookings + sweeps orphan locks +
 *  clears stale cancel-tokens. */
export async function runCleanup(): Promise<{ ran: true; cancelled: number; orphanLocksReleased: number; tokensSwept: number; orphanUploadsRemoved: number }> {
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - STALE_PENDING_MS);

  const candidates = await db.booking.findMany({
    where: {
      status: 'pending',
      OR: [
        { paymentDeadline: { lt: now } },
        { paymentDeadline: null, createdAt: { lt: staleCutoff } },
      ],
    },
    select: { id: true },
  });

  // Always sweep orphan date locks (pointing at non-existent bookings).
  const allLockBookingIds = await db.bookingDateLock.findMany({
    distinct: ['bookingId'],
    select: { bookingId: true },
  });
  const existingBookingIds = new Set(
    (
      await db.booking.findMany({
        where: { id: { in: allLockBookingIds.map((l) => l.bookingId) } },
        select: { id: true },
      })
    ).map((b) => b.id)
  );
  const orphanIds = allLockBookingIds
    .map((l) => l.bookingId)
    .filter((id) => !existingBookingIds.has(id));
  const orphanLocksReleased =
    orphanIds.length > 0
      ? (await db.bookingDateLock.deleteMany({ where: { bookingId: { in: orphanIds } } })).count
      : 0;

  // Clear cancel tokens whose 30-day window has lapsed. The booking row stays
  // intact; only the token is wiped so the row count for expired tokens
  // doesn't grow without bound.
  const tokenSweep = await db.booking.updateMany({
    where: { cancelTokenExpiry: { lt: now } },
    data: { cancelToken: null, cancelTokenExpiry: null },
  });

  const orphanUploadsRemoved = await sweepOrphanUploadsIfDue();

  if (candidates.length === 0) {
    return { ran: true, cancelled: 0, orphanLocksReleased, tokensSwept: tokenSweep.count, orphanUploadsRemoved };
  }

  // Route each expiry through updateBookingStatus so the customer-facing
  // "your booking expired" email fires (and the audit log records the
  // transition). Previously this was a bulk updateMany that silently
  // flipped the status — customers got no signal that their booking
  // vanished.
  let cancelled = 0;
  for (const { id } of candidates) {
    try {
      await updateBookingStatus(id, 'cancelled');
      cancelled++;
    } catch (err) {
      console.error(`[cleanup] failed to cancel ${id}:`, err);
    }
  }

  return { ran: true, cancelled, orphanLocksReleased, tokensSwept: tokenSweep.count, orphanUploadsRemoved };
}

// Resolve the on-disk uploads directory. Mirrors the logic in the upload +
// serve routes so all three agree on where files live.
function getUploadDir(): string {
  const dbUrl = process.env.DATABASE_URL || '';
  const match = dbUrl.match(/file:(.+)/);
  // The upload directory is derived from DATABASE_URL at runtime, so the
  // path is not statically known. Without the ignore hint Turbopack's file
  // trace treats the dynamic resolve as "could be anything under the
  // project" and copies the entire checkout into the server output (W-2).
  if (match) return path.join(path.dirname(path.resolve(/*turbopackIgnore: true*/ match[1])), 'uploads');
  return path.join(/*turbopackIgnore: true*/ process.cwd(), 'uploads');
}

const UPLOAD_REF_RE = /\/api\/uploads\/([A-Za-z0-9._-]+)/g;

async function sweepOrphanUploadsIfDue(): Promise<number> {
  const now = Date.now();
  if (now - lastOrphanSweep < ORPHAN_SWEEP_THROTTLE_MS) return 0;
  lastOrphanSweep = now;
  try {
    return await cleanupOrphanUploads();
  } catch (err) {
    console.error('[cleanup] orphan upload sweep failed:', err);
    return 0;
  }
}

/** Delete uploaded files that no DB record references any longer. Scans every
 *  column that can hold an `/api/uploads/<file>` URL (machine images, manual
 *  PDFs, operator + renter checklist photos, app-config logo, the frozen
 *  contract HTML and review comments). Files newer
 *  than ORPHAN_GRACE_MS are skipped so an in-flight upload isn't deleted
 *  before its owning row is persisted. Exported so a cron/admin action can
 *  trigger it directly. */
export async function cleanupOrphanUploads(): Promise<number> {
  const uploadDir = getUploadDir();
  let files: string[];
  try {
    files = await readdir(/*turbopackIgnore: true*/ uploadDir);
  } catch {
    return 0; // dir doesn't exist yet → nothing to do
  }
  if (files.length === 0) return 0;

  const referenced = new Set<string>();
  const collect = (value: string | null | undefined) => {
    if (!value) return;
    for (const m of value.matchAll(UPLOAD_REF_RE)) referenced.add(m[1]);
  };

  const [machines, docs, bookings, submissions, configs, contracts, reviews] = await Promise.all([
    db.machine.findMany({ select: { imageUrl: true } }),
    db.machineDocument.findMany({ select: { fileUrl: true } }),
    db.booking.findMany({ select: { checklistData: true } }),
    db.checklistSubmission.findMany({ select: { data: true } }),
    db.appConfig.findMany({ select: { value: true } }),
    // The frozen contract snapshot and a customer's review can each embed an
    // upload URL. Both are historical records the sweep exists to protect, and
    // neither was consulted — so a photo referenced ONLY from a signed
    // contract (or a published review) was deleted out from under it the
    // moment it passed the 24 h grace period.
    db.acceptedContract.findMany({ select: { renderedHtml: true } }),
    db.review.findMany({ select: { comment: true } }),
  ]);
  machines.forEach((m) => collect(m.imageUrl));
  docs.forEach((d) => collect(d.fileUrl));
  bookings.forEach((b) => collect(b.checklistData));
  submissions.forEach((s) => collect(s.data));
  configs.forEach((c) => collect(c.value));
  contracts.forEach((c) => collect(c.renderedHtml));
  reviews.forEach((r) => collect(r.comment));

  const now = Date.now();
  let removed = 0;
  for (const file of files) {
    if (referenced.has(file)) continue;
    const full = path.join(uploadDir, file);
    try {
      const info = await stat(/*turbopackIgnore: true*/ full);
      if (!info.isFile()) continue;
      if (now - info.mtimeMs < ORPHAN_GRACE_MS) continue; // too fresh to judge
      await unlink(/*turbopackIgnore: true*/ full);
      removed++;
    } catch {
      // file vanished or permission issue — skip
    }
  }
  return removed;
}
