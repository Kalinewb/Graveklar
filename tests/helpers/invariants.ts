/**
 * Area-local helpers for the L3i invariant suite (phase 3 — database and
 * temporal invariants). Nothing here mocks anything; it is assertion sugar
 * over the scratch database plus a couple of raw-SQL probes that Prisma's
 * typed API deliberately hides.
 *
 * Kept out of `helpers/db.ts` on purpose: that file is shared by every layer
 * and phase 3 must not change it.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { expect } from 'vitest';

import { db } from './db';

/**
 * Run `fn` and assert it rejected with Prisma's unique-constraint error
 * (P2002). Returns the error so a caller can assert on `meta.target`.
 */
export async function expectP2002(fn: () => Promise<unknown>): Promise<Prisma.PrismaClientKnownRequestError> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  if (!caught) {
    throw new Error('expected a unique-constraint violation, but the write succeeded');
  }
  if (!(caught instanceof Prisma.PrismaClientKnownRequestError)) {
    throw new Error(
      `expected a PrismaClientKnownRequestError, got ${(caught as Error)?.name}: ${(caught as Error)?.message}`,
    );
  }
  expect(caught.code).toBe('P2002');
  return caught;
}

/** The `meta.target` of a P2002, normalised to a sorted list of column names. */
export function conflictTarget(err: Prisma.PrismaClientKnownRequestError): string[] {
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  if (Array.isArray(target)) return [...target].map(String).sort();
  if (typeof target === 'string') {
    // SQLite reports "Model_col1_col2_key" or "Model.col".
    return [target];
  }
  return [];
}

/**
 * SQLite's own storage class for one column, as `typeof()` reports it.
 * This is the assertion that pins the repo rule "never insert a DateTime via
 * the sqlite3 CLI": Prisma stores DateTime as an INTEGER (epoch ms), and a
 * hand-written `'2026-06-15'` string would read back as `text`.
 */
export async function sqliteTypeOf(
  table: string,
  column: string,
  client: PrismaClient = db,
): Promise<string[]> {
  const rows = await client.$queryRawUnsafe<{ t: string }[]>(
    `SELECT typeof("${column}") AS t FROM "${table}"`,
  );
  return rows.map((r) => r.t);
}

/** Raw integer value SQLite holds for a DateTime column (epoch milliseconds). */
export async function sqliteRawInt(
  table: string,
  column: string,
  where: string,
  client: PrismaClient = db,
): Promise<number | null> {
  const rows = await client.$queryRawUnsafe<{ v: number | bigint | null }[]>(
    `SELECT "${column}" AS v FROM "${table}" WHERE ${where} LIMIT 1`,
  );
  const v = rows[0]?.v ?? null;
  return v === null ? null : Number(v);
}

/** Every `BookingDateLock.bookingId` with no matching `Booking` row. */
export async function orphanLockBookingIds(client: PrismaClient = db): Promise<string[]> {
  const locks = await client.bookingDateLock.findMany({
    distinct: ['bookingId'],
    select: { bookingId: true },
  });
  if (locks.length === 0) return [];
  const ids = locks.map((l) => l.bookingId);
  const alive = new Set(
    (await client.booking.findMany({ where: { id: { in: ids } }, select: { id: true } })).map(
      (b) => b.id,
    ),
  );
  return ids.filter((id) => !alive.has(id));
}

/**
 * The suite-wide invariant every file in this phase ends on: a date lock only
 * ever exists for a booking that exists. `BookingDateLock` carries no foreign
 * key (by design — see `docs/audit/phase3-db-time-invariants.md`), so nothing
 * but this assertion and `runCleanup`'s sweep keeps it true.
 */
export async function expectNoOrphanLocks(client: PrismaClient = db): Promise<void> {
  expect(await orphanLockBookingIds(client)).toEqual([]);
}
