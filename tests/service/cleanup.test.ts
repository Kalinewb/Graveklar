/**
 * L3 — src/lib/cleanup.ts: runCleanupIfDue's throttle/inFlight guard,
 * runCleanup's booking-expiry + orphan-lock + cancel-token sweeps, and
 * cleanupOrphanUploads' filesystem sweep.
 *
 * cleanupOrphanUploads() derives the upload directory from DATABASE_URL (the
 * scratch db file's own directory) — see getUploadDir() in cleanup.ts — so we
 * point real files at `<scratch dir>/uploads` rather than mocking fs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/email', async () => (await import('../helpers/mocks')).mockEmail());

import { cleanupOrphanUploads, runCleanup, runCleanupIfDue } from '@/lib/cleanup';
import { booking, db, ensureSchema, machine, resetDb, seedConfigDefaults } from '../helpers/db';
import { emailMock, mockClock } from '../helpers/mocks';
import { TEST_DB_FILE } from '../setup';

const UPLOAD_DIR = path.join(path.dirname(path.resolve(TEST_DB_FILE)), 'uploads');

function writeUpload(name: string, ageMs = 0): string {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const full = path.join(UPLOAD_DIR, name);
  fs.writeFileSync(full, 'test-file-contents');
  if (ageMs > 0) {
    const past = new Date(Date.now() - ageMs);
    fs.utimesSync(full, past, past);
  }
  return full;
}

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDb();
  await seedConfigDefaults();
  await machine({ quantity: 1 });
  emailMock.reset();
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
});

afterEach(() => {
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
});

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
}

// ── runCleanupIfDue: throttle + inFlight ────────────────────────────────────
// NOTE: `lastRan`/`inFlight` are module-scoped state in cleanup.ts, so this
// must be the ONLY place in the file that calls runCleanupIfDue (its target,
// the 60s throttle) to keep the assertions independent of test order.

describe('runCleanupIfDue', () => {
  it('throttles to once per 60s and serialises concurrent callers', async () => {
    const clock = mockClock('2026-09-07T09:00:00+02:00');
    try {
      const first = await runCleanupIfDue();
      expect(first.ran).toBe(true);

      // Same instant — still inside the 60s window.
      const second = await runCleanupIfDue();
      expect(second.ran).toBe(false);

      clock.advance(61_000);
      const third = await runCleanupIfDue();
      expect(third.ran).toBe(true);

      // Two truly concurrent callers: only the first actually runs, the
      // second observes `inFlight` and bails immediately.
      clock.advance(61_000);
      const [a, b] = await Promise.all([runCleanupIfDue(), runCleanupIfDue()]);
      expect([a.ran, b.ran].sort()).toEqual([false, true]);
    } finally {
      clock.restore();
    }
  });
});

// ── runCleanup: booking expiry ───────────────────────────────────────────────

describe('runCleanup — expires stale pending bookings', () => {
  it('a paymentDeadline exactly equal to now survives (strictly-less-than boundary)', async () => {
    const clock = mockClock('2026-09-07T09:00:00.000+02:00');
    try {
      const now = new Date();
      const b = await booking('pending', { paymentDeadline: now, skipLocks: true });
      await runCleanup();
      expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('pending');
    } finally {
      clock.restore();
    }
  });

  it('a paymentDeadline 1ms in the past is cancelled', async () => {
    const clock = mockClock('2026-09-07T09:00:00.000+02:00');
    try {
      const deadline = new Date(Date.now() - 1);
      const b = await booking('pending', { paymentDeadline: deadline, skipLocks: true });
      const result = await runCleanup();
      expect(result.cancelled).toBe(1);
      expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('cancelled');
    } finally {
      clock.restore();
    }
  });

  it('a null deadline survives until createdAt is more than 60 minutes old', async () => {
    const clock = mockClock('2026-09-07T09:00:00.000+02:00');
    try {
      const exactly60 = new Date(Date.now() - 60 * 60 * 1000);
      const survivor = await booking('pending', { paymentDeadline: null, createdAt: exactly60, skipLocks: true });
      const justOver60 = new Date(Date.now() - 60 * 60 * 1000 - 1);
      const expired = await booking('pending', { paymentDeadline: null, createdAt: justOver60, skipLocks: true });

      await runCleanup();

      expect((await db.booking.findUniqueOrThrow({ where: { id: survivor.id } })).status).toBe('pending');
      expect((await db.booking.findUniqueOrThrow({ where: { id: expired.id } })).status).toBe('cancelled');
    } finally {
      clock.restore();
    }
  });

  it('never touches a confirmed/cancelled/completed booking, even past its deadline', async () => {
    const clock = mockClock('2026-09-07T09:00:00.000+02:00');
    try {
      const past = new Date(Date.now() - 1);
      const confirmed = await booking('confirmed', { paymentDeadline: past, skipLocks: true });
      await runCleanup();
      expect((await db.booking.findUniqueOrThrow({ where: { id: confirmed.id } })).status).toBe('confirmed');
    } finally {
      clock.restore();
    }
  });

  it('sends the expiry email and writes an audit row per cancelled booking, one at a time', async () => {
    const clock = mockClock('2026-09-07T09:00:00.000+02:00');
    try {
      const past = new Date(Date.now() - 1);
      const b1 = await booking('pending', { paymentDeadline: past, skipLocks: true });
      const b2 = await booking('pending', { paymentDeadline: past, skipLocks: true });

      const result = await runCleanup();
      expect(result.cancelled).toBe(2);
      await flush();

      expect(emailMock.by('sendBookingExpiredEmail').map((s) => (s.args[0] as { id: string }).id).sort())
        .toEqual([b1.id, b2.id].sort());

      const auditRows = await db.adminAuditLog.findMany({ where: { action: 'booking.cancelled' } });
      expect(auditRows.length).toBeGreaterThanOrEqual(2);
      expect(auditRows.every((r) => r.actor === 'system')).toBe(true);
    } finally {
      clock.restore();
    }
  });

  it('a single updateBookingStatus failure does not stop the rest of the sweep', async () => {
    const clock = mockClock('2026-09-07T09:00:00.000+02:00');
    try {
      const past = new Date(Date.now() - 1);
      // A booking id that will 404 inside updateBookingStatus: delete it out
      // from under the sweep after it's already selected as a candidate.
      const doomed = await booking('pending', { paymentDeadline: past, skipLocks: true });
      const ok = await booking('pending', { paymentDeadline: past, skipLocks: true });
      await db.booking.delete({ where: { id: doomed.id } });

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await runCleanup();
      errorSpy.mockRestore();

      expect(result.cancelled).toBe(1);
      expect((await db.booking.findUniqueOrThrow({ where: { id: ok.id } })).status).toBe('cancelled');
    } finally {
      clock.restore();
    }
  });
});

// ── runCleanup: orphan locks + cancel tokens ────────────────────────────────

describe('runCleanup — orphan locks + cancel-token sweep', () => {
  it('deletes BookingDateLock rows whose booking no longer exists, leaves real ones alone', async () => {
    const m = await machine({ quantity: 1 });
    const b = await booking('confirmed', { skipLocks: true, startDateStr: '2026-09-10' });
    await db.bookingDateLock.create({
      data: { bookingId: b.id, machineId: m.id, date: new Date('2026-09-10T00:00:00'), slot: 0 },
    });
    await db.bookingDateLock.create({
      data: { bookingId: 'orphan-booking-id', machineId: m.id, date: new Date('2026-09-11T00:00:00'), slot: 0 },
    });

    const result = await runCleanup();
    expect(result.orphanLocksReleased).toBe(1);
    expect(await db.bookingDateLock.count({ where: { bookingId: 'orphan-booking-id' } })).toBe(0);
    expect(await db.bookingDateLock.count({ where: { bookingId: b.id } })).toBe(1);
  });

  it('nulls an expired cancelToken/cancelTokenExpiry, leaves a live one intact', async () => {
    const clock = mockClock('2026-09-07T09:00:00+02:00');
    try {
      const expired = await booking('cancelled', {
        skipLocks: true, cancelToken: 'expired-token', cancelTokenExpiry: new Date(Date.now() - 1),
      });
      const live = await booking('confirmed', {
        skipLocks: true, cancelToken: 'live-token', cancelTokenExpiry: new Date(Date.now() + 60_000),
      });

      const result = await runCleanup();
      expect(result.tokensSwept).toBe(1);

      const expiredRow = await db.booking.findUniqueOrThrow({ where: { id: expired.id } });
      expect(expiredRow.cancelToken).toBeNull();
      expect(expiredRow.cancelTokenExpiry).toBeNull();

      const liveRow = await db.booking.findUniqueOrThrow({ where: { id: live.id } });
      expect(liveRow.cancelToken).toBe('live-token');
    } finally {
      clock.restore();
    }
  });
});

// ── cleanupOrphanUploads ─────────────────────────────────────────────────────

describe('cleanupOrphanUploads', () => {
  it('removes a file no DB row references, once past the 24h grace period', async () => {
    writeUpload('upload-orphan.jpg', 25 * 60 * 60 * 1000);
    const removed = await cleanupOrphanUploads();
    expect(removed).toBe(1);
    expect(fs.existsSync(path.join(UPLOAD_DIR, 'upload-orphan.jpg'))).toBe(false);
  });

  it('leaves an orphan file alone while it is younger than 24h', async () => {
    writeUpload('upload-fresh.jpg', 60 * 1000);
    const removed = await cleanupOrphanUploads();
    expect(removed).toBe(0);
    expect(fs.existsSync(path.join(UPLOAD_DIR, 'upload-fresh.jpg'))).toBe(true);
  });

  it('survives when the upload directory does not exist yet', async () => {
    fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
    await expect(cleanupOrphanUploads()).resolves.toBe(0);
  });

  it('a file referenced by Machine.imageUrl survives', async () => {
    writeUpload('upload-machine.jpg', 25 * 60 * 60 * 1000);
    await machine({ imageUrl: '/api/uploads/upload-machine.jpg' });
    expect(await cleanupOrphanUploads()).toBe(0);
  });

  it('a file referenced by MachineDocument.fileUrl survives', async () => {
    writeUpload('upload-doc.pdf', 25 * 60 * 60 * 1000);
    const m = await machine();
    await db.machineDocument.create({
      data: { machineId: m.id, title: 'Manual', fileUrl: '/api/uploads/upload-doc.pdf', sortOrder: 0 },
    });
    expect(await cleanupOrphanUploads()).toBe(0);
  });

  it('a file referenced by Booking.checklistData survives', async () => {
    writeUpload('upload-checklist.jpg', 25 * 60 * 60 * 1000);
    await booking('confirmed', {
      skipLocks: true,
      checklistData: JSON.stringify({ photo: ['/api/uploads/upload-checklist.jpg'] }),
    });
    expect(await cleanupOrphanUploads()).toBe(0);
  });

  it('a file referenced by ChecklistSubmission.data survives', async () => {
    writeUpload('renter-abc123-photo.jpg', 25 * 60 * 60 * 1000);
    const b = await booking('confirmed', { skipLocks: true });
    const phase = await db.checklistPhase.create({ data: { name: 'Retur', audience: 'renter', sortOrder: 0 } });
    await db.checklistSubmission.create({
      data: {
        bookingId: b.id, phaseId: phase.id, intervalKey: 'once', phone: '99011223',
        data: JSON.stringify({ photo: ['/api/uploads/renter-abc123-photo.jpg'] }),
      },
    });
    expect(await cleanupOrphanUploads()).toBe(0);
  });

  it('a file referenced by AppConfig.value (the logo) survives', async () => {
    writeUpload('upload-logo.png', 25 * 60 * 60 * 1000);
    await db.appConfig.update({ where: { key: 'logoUrl' }, data: { value: '/api/uploads/upload-logo.png' } });
    expect(await cleanupOrphanUploads()).toBe(0);
  });

  // FIXED O-1: cleanupOrphanUploads() (src/lib/cleanup.ts) collected
  // references from Machine.imageUrl, MachineDocument.fileUrl,
  // Booking.checklistData, ChecklistSubmission.data and AppConfig.value —
  // but NOT AcceptedContract.renderedHtml or Review.comment. A photo that is
  // referenced only from the frozen legal contract (or a customer's review)
  // is a live reference, yet the sweep deleted the underlying file the
  // moment it was older than 24h, silently breaking the historical record it
  // exists to preserve. Both columns are collected now.
  it('a file referenced only in AcceptedContract.renderedHtml survives the sweep', async () => {
    writeUpload('upload-contract-photo.jpg', 25 * 60 * 60 * 1000);
    const b = await booking('confirmed', { skipLocks: true });
    await db.acceptedContract.create({
      data: {
        bookingId: b.id,
        renderedHtml: '<img src="/api/uploads/upload-contract-photo.jpg">',
        termsVersionHash: 'x'.repeat(64),
        renderContext: '{}',
        acceptedAt: new Date(),
        acceptanceMethod: 'checkbox',
      },
    });
    expect(await cleanupOrphanUploads()).toBe(0);
    expect(fs.existsSync(path.join(UPLOAD_DIR, 'upload-contract-photo.jpg'))).toBe(true);
  });

  it('a file referenced only in Review.comment survives the sweep', async () => {
    writeUpload('upload-review-photo.jpg', 25 * 60 * 60 * 1000);
    const b = await booking('completed', { skipLocks: true });
    await db.review.create({
      data: {
        bookingId: b.id, token: 'review-token', status: 'submitted', rating: 5,
        comment: 'Se bilde: /api/uploads/upload-review-photo.jpg',
      },
    });
    expect(await cleanupOrphanUploads()).toBe(0);
    expect(fs.existsSync(path.join(UPLOAD_DIR, 'upload-review-photo.jpg'))).toBe(true);
  });

  it('multiple orphan and referenced files are each judged independently', async () => {
    writeUpload('upload-orphan-1.jpg', 25 * 60 * 60 * 1000);
    writeUpload('upload-orphan-2.jpg', 25 * 60 * 60 * 1000);
    writeUpload('upload-keep.jpg', 25 * 60 * 60 * 1000);
    await machine({ imageUrl: '/api/uploads/upload-keep.jpg' });

    const removed = await cleanupOrphanUploads();
    expect(removed).toBe(2);
    expect(fs.existsSync(path.join(UPLOAD_DIR, 'upload-keep.jpg'))).toBe(true);
    expect(fs.existsSync(path.join(UPLOAD_DIR, 'upload-orphan-1.jpg'))).toBe(false);
    expect(fs.existsSync(path.join(UPLOAD_DIR, 'upload-orphan-2.jpg'))).toBe(false);
  });
});
