/**
 * Synchronous schema provisioning for the scratch database.
 *
 * Deliberately free of any Prisma *client* import so tests/setup.ts can run it
 * before a single test module — and therefore before src/lib/db.ts — loads.
 * The app's client is cached on globalThis for the life of the worker and
 * applies its SQLite PRAGMAs in a fire-and-forget promise at import; anything
 * that disconnects it or copies a file over its open database races that
 * (audit finding H-1: "Engine is not yet connected" on a random test file at
 * full-suite scale). So: provision first, connect later, never the reverse.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface TemplateOptions {
  repoRoot: string;
  testDbDir: string;
  assertScratchDatabase: (url: string) => void;
}

export interface PrepareOptions extends TemplateOptions {
  testDbFile: string;
}

export function schemaHash(repoRoot: string): string {
  const schema = path.join(repoRoot, 'prisma', 'schema.prisma');
  return crypto.createHash('sha256').update(fs.readFileSync(schema)).digest('hex').slice(0, 12);
}

export function removeSqliteSidecars(file: string): void {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    fs.rmSync(file + suffix, { force: true });
  }
}

/**
 * `prisma db push` is slow relative to a test, so it runs at most once per
 * schema revision per machine and produces a template file that workers copy.
 * The push runs with cwd + --schema inside the scratch directory, so the
 * Prisma CLI cannot pick up the repository's .env even by accident.
 */
export function buildTemplate(opts: TemplateOptions): string {
  const hash = schemaHash(opts.repoRoot);
  const template = path.join(opts.testDbDir, `template-${hash}.db`);
  if (fs.existsSync(template)) return template;

  const scratchSchema = path.join(opts.testDbDir, `schema-${hash}.prisma`);
  fs.copyFileSync(path.join(opts.repoRoot, 'prisma', 'schema.prisma'), scratchSchema);

  // Unique per process so two workers racing to build the template can't
  // write into the same file; the rename at the end is atomic.
  const staging = path.join(opts.testDbDir, `.staging-${hash}-${process.pid}.db`);
  removeSqliteSidecars(staging);
  fs.rmSync(staging, { force: true });

  const url = `file:${staging}`;
  opts.assertScratchDatabase(url);

  const result = spawnSync(
    path.join(opts.repoRoot, 'node_modules', '.bin', 'prisma'),
    ['db', 'push', '--schema', scratchSchema, '--skip-generate', '--accept-data-loss'],
    {
      cwd: opts.testDbDir,
      env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `[test-db] prisma db push failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  }

  removeSqliteSidecars(staging);
  fs.renameSync(staging, template);
  return template;
}

/**
 * Give this worker's database file the current schema. A marker file next to
 * it records which schema revision it carries, so on every run after the
 * first this is a stat and a read — no copy, and nothing that could disturb a
 * client that already has the file open. Rows left over from a previous file
 * or run are cleared by `resetDb()`, which tests/setup.ts calls before every
 * test file.
 */
export function prepareWorkerDb(opts: PrepareOptions): string {
  const template = buildTemplate(opts);
  const hash = schemaHash(opts.repoRoot);
  const marker = `${opts.testDbFile}.schema`;
  const current = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : '';
  if (current === hash && fs.existsSync(opts.testDbFile)) return opts.testDbFile;

  removeSqliteSidecars(opts.testDbFile);
  fs.copyFileSync(template, opts.testDbFile);
  fs.writeFileSync(marker, hash);
  return opts.testDbFile;
}
