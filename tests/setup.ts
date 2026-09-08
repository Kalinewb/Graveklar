/**
 * Global vitest setup — runs in every worker BEFORE any test module is
 * imported, and therefore before anything constructs a PrismaClient.
 *
 * Its one non-negotiable job: point DATABASE_URL at a per-worker scratch
 * SQLite file that lives outside the repository, and refuse to let the suite
 * start if the resolved path could possibly be the live database.
 *
 * `src/lib/db.ts` is the only PrismaClient construction site in the app and it
 * takes no `datasources` / `datasourceUrl` override (asserted by
 * tests/harness.guard.test.ts), so the environment variable set here is the
 * only thing that decides which file the tests write to.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll } from 'vitest';

import { prepareWorkerDb } from './helpers/db-prepare';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repository root (…/graveklar). */
export const REPO_ROOT = path.resolve(HERE, '..');

/** The production database. Nothing in the test suite may ever open it. */
export const LIVE_DB_FILE = path.join(REPO_ROOT, 'prisma', 'prisma', 'db', 'custom.db');

/**
 * Scratch root for every database the suite creates. Defaults to the OS temp
 * directory so the harness works on any checkout; override with
 * GRAVEKLAR_TEST_DB_DIR (it is still guarded — an override pointing inside the
 * repository is rejected).
 */
export const TEST_DB_DIR = path.resolve(
  process.env.GRAVEKLAR_TEST_DB_DIR || path.join(os.tmpdir(), 'graveklar-test-db'),
);

/** Stable per-worker key. Vitest hands each worker a 1-based pool id. */
export const WORKER_KEY = process.env.VITEST_POOL_ID || String(process.pid);

/** This worker's database file. */
export const TEST_DB_FILE = path.join(TEST_DB_DIR, `worker-${WORKER_KEY}.db`);

/** …as a Prisma connection string. */
export const TEST_DB_URL = `file:${TEST_DB_FILE}`;

/**
 * Turn a Prisma SQLite connection string into an absolute filesystem path.
 * Relative `file:./x.db` URLs resolve against the schema directory, which is
 * how Prisma itself interprets them.
 */
export function prismaUrlToPath(url: string): string {
  const trimmed = url.trim().replace(/^['"]|['"]$/g, '');
  const withoutScheme = trimmed.replace(/^file:(\/\/)?/, '');
  const withoutParams = withoutScheme.split('?')[0];
  if (!withoutParams) return '';
  return path.resolve(path.join(REPO_ROOT, 'prisma'), withoutParams);
}

/** DATABASE_URL as configured in the repo's .env — read only, never written. */
export function envFileDatabaseUrl(): string | null {
  try {
    const raw = fs.readFileSync(path.join(REPO_ROOT, '.env'), 'utf8');
    const line = raw.split(/\r?\n/).find((l) => /^\s*DATABASE_URL\s*=/.test(l));
    if (!line) return null;
    return line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '');
  } catch {
    return null;
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * The guard. Throws — loudly, before a single query runs — when the resolved
 * database file is anything other than a scratch file we own.
 */
export function assertScratchDatabase(url: string): void {
  const file = prismaUrlToPath(url);
  if (!file) throw new Error(`[test-guard] DATABASE_URL is empty or unparseable: ${url}`);

  if (!isInside(TEST_DB_DIR, file)) {
    throw new Error(
      `[test-guard] refusing to run: DATABASE_URL (${file}) is not inside the scratch directory ${TEST_DB_DIR}`,
    );
  }
  if (isInside(REPO_ROOT, file)) {
    throw new Error(`[test-guard] refusing to run: DATABASE_URL (${file}) is inside the repository`);
  }
  if (path.resolve(file) === path.resolve(LIVE_DB_FILE)) {
    throw new Error(`[test-guard] refusing to run: DATABASE_URL points at the live database ${LIVE_DB_FILE}`);
  }
  const fromEnvFile = envFileDatabaseUrl();
  if (fromEnvFile && path.resolve(prismaUrlToPath(fromEnvFile)) === path.resolve(file)) {
    throw new Error(
      `[test-guard] refusing to run: DATABASE_URL matches the DATABASE_URL configured in .env (${fromEnvFile})`,
    );
  }
}

// ── Apply ────────────────────────────────────────────────────────────────────

fs.mkdirSync(TEST_DB_DIR, { recursive: true });

assertScratchDatabase(TEST_DB_URL);

process.env.DATABASE_URL = TEST_DB_URL;

// Provision the schema NOW, synchronously, before any test module can import
// src/lib/db.ts. Copying a template over a file that a client already had
// open raced Prisma's connection (audit finding H-1); done here, the first
// connection in this worker always finds a finished file.
prepareWorkerDb({ repoRoot: REPO_ROOT, testDbDir: TEST_DB_DIR, testDbFile: TEST_DB_FILE, assertScratchDatabase });

// Marker every helper (and any product code that ever wants to know) can read.
process.env.GRAVEKLAR_TEST_DB = '1';

// Deterministic secrets. admin-auth / renter-checklist-session derive their
// HMAC keys from these; nothing here is a real credential.
process.env.ADMIN_PASSWORD = 'Testadmin-2026!';
process.env.ADMIN_SESSION_SECRET = 'test-admin-session-secret-not-for-prod';
process.env.RENTER_SESSION_SECRET = 'test-renter-session-secret-not-for-prod';
process.env.CRON_SECRET = 'test-cron-secret';

// The product treats Europe/Oslo as the business timezone (booking dates are
// stored as local midnight). Pin it so a machine in another zone gets the same
// day boundaries. Node re-reads process.env.TZ on the next Date operation.
process.env.TZ = 'Europe/Oslo';

// Vitest sets this already; make it explicit so `db.ts` doesn't pick the
// development logging branch and `admin-auth` doesn't take the production
// path. Next's global types declare NODE_ENV read-only, hence the cast.
(process.env as Record<string, string>).NODE_ENV = 'test';

// Every test file starts from an empty database — as it did when the template
// was copied per file — but by truncation, which never disturbs the open
// connection. Imported lazily so the app's client is constructed only once a
// test file actually runs.
beforeAll(async () => {
  const { resetDb } = await import('./helpers/db');
  await resetDb();
});
