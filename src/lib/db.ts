import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  prismaPragmasApplied: boolean | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

// Apply SQLite PRAGMA once per process. `busy_timeout` makes Prisma wait
// up to 5 s for the write lock instead of failing immediately with
// SQLITE_BUSY — eliminates the "two concurrent writes both fail" pattern
// the audit flagged for cron + webhook + admin overlap.
//
// WAL mode + synchronous=NORMAL is Prisma's SQLite default since 5.x but we
// set it explicitly so behaviour doesn't drift on upgrade.
if (!globalForPrisma.prismaPragmasApplied) {
  globalForPrisma.prismaPragmasApplied = true
  ;(async () => {
    try {
      // $queryRawUnsafe — SQLite's PRAGMA statements return the new value
      // as a row, which $executeRawUnsafe refuses with "Execute returned
      // results". $queryRawUnsafe accepts the result and discards it.
      await db.$queryRawUnsafe('PRAGMA busy_timeout = 5000')
      await db.$queryRawUnsafe('PRAGMA journal_mode = WAL')
      await db.$queryRawUnsafe('PRAGMA synchronous = NORMAL')
    } catch (err) {
      console.error('[db] failed to apply SQLite pragmas', err)
    }
  })()
}

/**
 * SQLite contention policy:
 *   `busy_timeout = 5000` (set above) is the baseline protection for every
 *   query. It blocks for up to 5 s waiting for the write lock — enough to
 *   absorb routine contention from concurrent cron/webhook/admin writes.
 *
 *   `withSqliteRetry` is reserved for user-facing flows where retrying
 *   silently is preferable to returning an error to the caller. Wrapping
 *   every write by default is the wrong move — admin saves and audit
 *   writes should surface failures, not hide them behind exponential
 *   backoff. Currently used by:
 *     - createPendingBooking transaction (customer is mid-checkout)
 *     - Stripe webhook claim insert (Stripe will retry anyway)
 *
 *   When the SQLITE_BUSY log lines start appearing in a NEW location,
 *   that's the signal to either wrap that callsite or migrate to
 *   Postgres — not to blanket-wrap the whole app.
 *
 * Defaults: 3 attempts with exponential backoff starting at 50 ms.
 */
export async function withSqliteRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number; label?: string } = {}
): Promise<T> {
  const attempts = opts.attempts ?? 3
  const baseDelayMs = opts.baseDelayMs ?? 50
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const message = (err as { message?: string }).message ?? ''
      const code = (err as { code?: string }).code ?? ''
      const isBusy =
        message.includes('database is locked') ||
        message.includes('SQLITE_BUSY') ||
        code === 'SQLITE_BUSY' ||
        code === 'P2034' // Prisma's "Transaction failed due to a write conflict"
      if (!isBusy || i === attempts - 1) throw err
      const delay = baseDelayMs * Math.pow(2, i) + Math.floor(Math.random() * 25)
      if (opts.label) {
        console.warn(`[db] ${opts.label}: SQLITE_BUSY attempt ${i + 1}/${attempts}, retrying in ${delay}ms`)
      }
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastErr
}
