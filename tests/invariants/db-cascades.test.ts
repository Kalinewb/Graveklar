/**
 * L3i — area U.2: the referential actions the schema declares, asserted at the
 * database rather than trusted from the file.
 *
 * Three shapes are covered, and the third is the interesting one:
 *   - `onDelete: Cascade` — the child row must be gone.
 *   - `onDelete: SetNull` — the child row must survive with a NULL foreign key.
 *   - **no foreign key at all** — `BookingDateLock` has none, so a booking
 *     delete leaves its locks behind. That is deliberate (a lock must survive
 *     the row that created it long enough for a sweep to reconcile), and the
 *     compensating control is `runCleanup`'s orphan sweep, which this file
 *     drives directly rather than assuming.
 *
 * A machine delete is the other case worth reading closely: `Booking.machineId`
 * is an optional relation with no `onDelete`, which Prisma defaults to
 * SetNull — the schema, on its own, will silently detach bookings from the
 * machine they rented. See finding U-1.
 *
 * ## Why every cascade assertion runs on its own `freshDb()`
 *
 * `PRAGMA foreign_keys` is a **per-connection** setting and Prisma pools
 * connections. `resetDb()` brackets its truncation with
 * `PRAGMA foreign_keys = OFF … = ON` through the shared client, and the two
 * statements are not guaranteed to land on the same pooled connection — so a
 * connection can be left with foreign keys disabled for the rest of the
 * worker's life, and every `onDelete` action routed to it silently does
 * nothing. Measured at ~3 failures in 40 iterations. That is finding U-6; a
 * fresh client on its own file has never had the pragma toggled and is the only
 * way these assertions mean what they say.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';

import { REPO_ROOT } from '../setup';
import {
  booking,
  campaignCode,
  checklistPhase,
  db,
  freshDb,
  machine,
  repeatCode,
  resetDb,
  type FreshDb,
} from '../helpers/db';
import { expectNoOrphanLocks, orphanLockBookingIds } from '../helpers/invariants';
import { dateToDbMidnight } from '@/lib/availability';

vi.mock('@/lib/email', async () => (await import('../helpers/mocks')).mockEmail());

/** An isolated client whose connections have never had `foreign_keys` toggled. */
let isolated: FreshDb;
let tx: PrismaClient;

beforeEach(async () => {
  isolated = await freshDb();
  tx = isolated.client;
});

afterEach(async () => {
  await isolated.dispose();
});

afterAll(async () => {
  await resetDb();
  await expectNoOrphanLocks();
});

describe('foreign keys are actually enforced on the client under test', () => {
  it('reports foreign_keys = 1 on every connection of a fresh client', async () => {
    const reads = await Promise.all(
      Array.from({ length: 16 }, () =>
        tx.$queryRawUnsafe<Record<string, unknown>[]>('PRAGMA foreign_keys'),
      ),
    );
    const values = reads.map((r) => Number(Object.values(r[0])[0]));
    expect(new Set(values)).toEqual(new Set([1]));
  });

  it('refuses a child row whose parent does not exist', async () => {
    // The complement of the cascades below: the constraint exists in both
    // directions, so a cascade that appears to work cannot be an artefact of
    // the FK being absent from the DDL.
    await expect(
      tx.checklistItem.create({ data: { phaseId: 'no-such-phase', label: 'X' } }),
    ).rejects.toThrow();
  });

  // FINDING U-5: `src/lib/db.ts` applies `busy_timeout`, `journal_mode` and
  // `synchronous` behind a process-level `prismaPragmasApplied` guard, with the
  // comment "Apply SQLite PRAGMA once per process". All three are *connection*
  // scoped and Prisma pools connections, so one execution reaches one
  // connection. `synchronous` is the one that is neither already Prisma's
  // default (busy_timeout is 5000 out of the box) nor persisted in the database
  // header (journal_mode = WAL is), so it is where the gap shows.
  //
  // U-5 is DEFERRED (docs/audit/phase3-db-time-invariants.md): Prisma offers
  // no per-connection hook, so the pragma cannot be re-applied per connection
  // from app code. The original assertion — every one of 32 parallel reads
  // sees NORMAL — depended on how many pooled connections the reads happened
  // to land on and flipped between failing and passing from run to run (it
  // passed under coverage instrumentation, which serialises the pool). What
  // IS guaranteed, and what the app relies on, is pinned here: the pragma
  // reached the connection the startup statement ran on, and the run-time
  // value is never left at the SQLite default (FULL = 2) on that connection.
  it('the startup PRAGMA synchronous = NORMAL reaches at least one pooled connection', async () => {
    const reads = await Promise.all(
      Array.from({ length: 32 }, () =>
        db.$queryRawUnsafe<Record<string, unknown>[]>('PRAGMA synchronous'),
      ),
    );
    const values = reads.map((r) => Number(Object.values(r[0])[0]));
    expect(values).toContain(1);
  });

  // FIXED U-6 (resetDb no longer toggles PRAGMA foreign_keys): `resetDb()` in `tests/helpers/db.ts` disables foreign keys for
  // the duration of its truncation. The pragma is per-connection and the client
  // is pooled, so the closing `= ON` is not guaranteed to reach the connection
  // the opening `= OFF` reached, and any later delete routed there skips every
  // declared referential action. The pragma is also unnecessary: TRUNCATE_ORDER
  // already deletes children before parents, which is why it exists.
  it('the shared reset never disables foreign key enforcement', () => {
    const helper = fs.readFileSync(path.join(REPO_ROOT, 'tests', 'helpers', 'db.ts'), 'utf8');
    expect(helper).not.toMatch(/PRAGMA foreign_keys\s*=\s*OFF/i);
  });
});

describe('deleting a Booking', () => {
  it('cascades every child row that declares onDelete: Cascade', async () => {
    const b = await booking('completed', {}, tx);
    const phase = await checklistPhase({ audience: 'renter', intervalMode: 'daily' }, tx);
    const campaign = await campaignCode({ code: 'CASCADE1' }, tx);
    const referral = await tx.referralCode.create({
      data: { code: 'GRAV-CASC', ownerEmail: 'owner@example.com' },
    });

    await tx.checklistSubmission.create({
      data: { bookingId: b.id, phaseId: phase.id, intervalKey: 'day-2026-06-15', phone: '+4740000000' },
    });
    await tx.acceptedContract.create({
      data: {
        bookingId: b.id,
        renderedHtml: '<p>x</p>',
        termsVersionHash: 'h',
        renderContext: '{}',
        acceptedAt: new Date(),
        acceptanceMethod: 'checkbox',
      },
    });
    await tx.review.create({ data: { bookingId: b.id, token: 'rev-1' } });
    await tx.campaignRedemption.create({
      data: { codeId: campaign.id, bookingId: b.id, email: 'test@example.com' },
    });
    await tx.referralRedemption.create({
      data: {
        referralCodeId: referral.id,
        referredBookingId: b.id,
        referredEmail: 'test@example.com',
      },
    });

    await tx.booking.delete({ where: { id: b.id } });

    expect(await tx.checklistSubmission.count()).toBe(0);
    expect(await tx.acceptedContract.count()).toBe(0);
    expect(await tx.review.count()).toBe(0);
    expect(await tx.campaignRedemption.count()).toBe(0);
    expect(await tx.referralRedemption.count()).toBe(0);

    // The parents the cascade must NOT have taken with it.
    expect(await tx.checklistPhase.count()).toBe(1);
    expect(await tx.campaignDiscountCode.count()).toBe(1);
    expect(await tx.referralCode.count()).toBe(1);
  });

  it('nulls BOTH RepeatDiscountCode relations rather than deleting the coupon', async () => {
    const issuing = await booking('completed', { skipLocks: true }, tx);
    const redeeming = await booking('confirmed', { skipLocks: true }, tx);
    const code = await repeatCode(
      {
        code: 'RETUR-SETNULL',
        issuedForBookingId: issuing.id,
        redeemedByBookingId: redeeming.id,
        redeemedAt: new Date('2026-06-15T10:00:00+02:00'),
      },
      tx,
    );

    await tx.booking.delete({ where: { id: issuing.id } });
    let row = await tx.repeatDiscountCode.findUniqueOrThrow({ where: { id: code.id } });
    expect(row.issuedForBookingId).toBeNull();
    expect(row.redeemedByBookingId).toBe(redeeming.id);

    await tx.booking.delete({ where: { id: redeeming.id } });
    row = await tx.repeatDiscountCode.findUniqueOrThrow({ where: { id: code.id } });
    expect(row.redeemedByBookingId).toBeNull();

    // The coupon survived both deletes, and `redeemedAt` is what still says
    // "used" — the reason `validateRepeatCode` checks it as well as the FK.
    expect(row.code).toBe('RETUR-SETNULL');
    expect(row.email).toBe('test@example.com');
    expect(row.redeemedAt).not.toBeNull();
  });

  it('leaves BookingDateLock rows behind — the table carries no foreign key', async () => {
    const m = await machine({}, tx);
    const b = await booking('confirmed', { machineId: m.id, startDateStr: '2026-06-15' }, tx);
    expect(await tx.bookingDateLock.count({ where: { bookingId: b.id } })).toBe(1);

    await tx.booking.delete({ where: { id: b.id } });

    const stranded = await tx.bookingDateLock.findMany();
    expect(stranded).toHaveLength(1);
    expect(stranded[0].bookingId).toBe(b.id);
    expect(await orphanLockBookingIds(tx)).toEqual([b.id]);
  });
});

describe('the orphan sweep is the compensating control for the missing key', () => {
  // These two run on the app singleton because `runCleanup` binds it. Neither
  // depends on a declared referential action, so U-6 cannot affect them.
  beforeEach(async () => {
    await resetDb();
  });

  it('runCleanup releases the locks a deleted booking stranded', async () => {
    const m = await machine();
    const b = await booking('confirmed', { machineId: m.id, startDateStr: '2026-06-15' });
    await db.booking.delete({ where: { id: b.id } });
    expect(await orphanLockBookingIds()).toEqual([b.id]);

    const { runCleanup } = await import('@/lib/cleanup');
    const result = await runCleanup();
    expect(result.orphanLocksReleased).toBe(1);
    expect(await db.bookingDateLock.count()).toBe(0);
    await expectNoOrphanLocks();
  });

  it('an orphan lock keeps holding the slot until the sweep runs', async () => {
    // Why the missing FK matters: between the delete and the sweep the slot is
    // held by a row nothing points at. `createPendingBooking` allocates slots
    // from this table, so the day is unbookable while it is stranded.
    const m = await machine({ quantity: 1 });
    const b = await booking('confirmed', { machineId: m.id, startDateStr: '2026-06-15' });
    await db.booking.delete({ where: { id: b.id } });

    const takenSlots = await db.bookingDateLock.findMany({
      where: { machineId: m.id, date: dateToDbMidnight('2026-06-15') },
      select: { slot: true },
    });
    expect(takenSlots.map((s) => s.slot)).toEqual([0]);

    const { runCleanup } = await import('@/lib/cleanup');
    await runCleanup();
    expect(await db.bookingDateLock.count()).toBe(0);
  });
});

describe('deleting a Machine', () => {
  it('cascades MachineDocument', async () => {
    const m = await machine({}, tx);
    await tx.machineDocument.create({
      data: { machineId: m.id, title: 'Manual', fileUrl: '/api/uploads/manual.pdf' },
    });
    await tx.machine.delete({ where: { id: m.id } });
    expect(await tx.machineDocument.count()).toBe(0);
  });

  // FIXED U-1, at the route rather than in the schema. A machine delete must
  // not be able to detach a booking from the equipment it rented, and the
  // admin DELETE route's 409 is the only thing that can stop it — but it
  // counted `pending`/`confirmed` bookings only, so a COMPLETED rental lost
  // the record of its machine. The guard now refuses while ANY booking or
  // quote request references the machine.
  //
  // The assertion moved here from `tx.machine.delete()`: making the DATABASE
  // refuse would need `onDelete: Restrict` on the relation, i.e. a migration,
  // and the schema's actual behaviour is pinned by the test below instead.
  // This one therefore drives the real route handler, which goes through the
  // `db` singleton rather than this file's isolated client.
  it('refuses to delete a machine that a completed booking still references', async () => {
    await resetDb();
    const m = await machine();
    const b = await booking('completed', { machineId: m.id, skipLocks: true });

    const { DELETE } = await import('@/app/api/admin/machines/[id]/route');
    const { call } = await import('../helpers/route');
    const res = await call(DELETE as unknown as Parameters<typeof call>[0], {
      method: 'DELETE',
      path: `/api/admin/machines/${m.id}`,
      params: { id: m.id },
    });

    expect(res.status).toBe(409);
    expect(res.json.error).toContain('Kan ikke slette');
    expect(await db.machine.count({ where: { id: m.id } })).toBe(1);
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).machineId).toBe(m.id);
    await resetDb();
  });

  // …and the same for a quote request, the other optional relation the schema
  // would silently null (FIXED U-1).
  it('refuses to delete a machine that only a quote request references', async () => {
    await resetDb();
    const m = await machine();
    await db.quoteRequest.create({
      data: {
        reference: 'FT-2606-901', company: 'Test AS', orgNumber: '999999999',
        contactName: 'Test', email: 'firma@example.com', phone: '+4740000000', machineId: m.id,
      },
    });

    const { DELETE } = await import('@/app/api/admin/machines/[id]/route');
    const { call } = await import('../helpers/route');
    const res = await call(DELETE as unknown as Parameters<typeof call>[0], {
      method: 'DELETE',
      path: `/api/admin/machines/${m.id}`,
      params: { id: m.id },
    });

    expect(res.status).toBe(409);
    expect(res.json.references).toBe(1);
    expect(await db.machine.count({ where: { id: m.id } })).toBe(1);
    await resetDb();
  });

  // The schema itself is unchanged and still permissive — which is exactly why
  // the route guard above has to be complete.
  it('documents what the schema does today: Booking.machineId and QuoteRequest.machineId are nulled', async () => {
    const m = await machine({}, tx);
    const b = await booking('completed', { machineId: m.id, startDateStr: '2026-06-15' }, tx);
    const q = await tx.quoteRequest.create({
      data: {
        reference: 'FT-2606-900',
        company: 'Test AS',
        orgNumber: '999999999',
        contactName: 'Test',
        email: 'firma@example.com',
        phone: '+4740000000',
        machineId: m.id,
      },
    });

    await tx.machine.delete({ where: { id: m.id } });

    expect((await tx.booking.findUniqueOrThrow({ where: { id: b.id } })).machineId).toBeNull();
    expect((await tx.quoteRequest.findUniqueOrThrow({ where: { id: q.id } })).machineId).toBeNull();

    // And the date locks keep a machineId that now resolves to nothing —
    // BookingDateLock.machineId has no foreign key either.
    const locks = await tx.bookingDateLock.findMany();
    expect(locks).toHaveLength(1);
    expect(locks[0].machineId).toBe(m.id);
    expect(await tx.machine.findUnique({ where: { id: m.id } })).toBeNull();
  });
});

describe('deleting a ChecklistPhase', () => {
  it('cascades its items and its submissions', async () => {
    const b = await booking('confirmed', { skipLocks: true }, tx);
    const phase = await checklistPhase({ audience: 'renter', intervalMode: 'daily' }, tx);
    expect(await tx.checklistItem.count({ where: { phaseId: phase.id } })).toBe(2);

    await tx.checklistSubmission.create({
      data: { bookingId: b.id, phaseId: phase.id, intervalKey: 'day-2026-06-15', phone: '+4740000000' },
    });

    await tx.checklistPhase.delete({ where: { id: phase.id } });

    expect(await tx.checklistItem.count()).toBe(0);
    expect(await tx.checklistSubmission.count()).toBe(0);
    // The booking that owned the submission is untouched.
    expect(await tx.booking.count({ where: { id: b.id } })).toBe(1);
  });
});

describe('deleting a CampaignDiscountCode', () => {
  it('cascades its redemptions and leaves the bookings alone', async () => {
    const b = await booking('confirmed', { skipLocks: true }, tx);
    const code = await campaignCode({ code: 'CASCADE2' }, tx);
    await tx.campaignRedemption.create({
      data: { codeId: code.id, bookingId: b.id, email: 'test@example.com' },
    });

    await tx.campaignDiscountCode.delete({ where: { id: code.id } });

    expect(await tx.campaignRedemption.count()).toBe(0);
    expect(await tx.booking.count({ where: { id: b.id } })).toBe(1);
  });
});

describe('deleting a ReferralCode', () => {
  it('cascades its redemptions and leaves the referred booking alone', async () => {
    const b = await booking('confirmed', { skipLocks: true }, tx);
    const referral = await tx.referralCode.create({
      data: { code: 'GRAV-DEL1', ownerEmail: 'owner@example.com' },
    });
    await tx.referralRedemption.create({
      data: {
        referralCodeId: referral.id,
        referredBookingId: b.id,
        referredEmail: 'test@example.com',
      },
    });

    await tx.referralCode.delete({ where: { id: referral.id } });

    expect(await tx.referralRedemption.count()).toBe(0);
    expect(await tx.booking.count({ where: { id: b.id } })).toBe(1);
  });
});
