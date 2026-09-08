/**
 * Static guard on the database wiring.
 *
 * The whole harness rests on one assumption: DATABASE_URL is the ONLY thing
 * that decides which SQLite file the app opens. That holds exactly as long as
 * no PrismaClient is constructed with a `datasources` / `datasourceUrl`
 * override, which would bypass the environment (and therefore the scratch-DB
 * guard in tests/setup.ts) entirely.
 *
 * This is an L0 test: it reads source text, it never executes the app.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from './setup';

const SCANNED_DIRS = ['src', 'scripts'];
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs']);

/**
 * The one legitimate PrismaClient in the application. Anything else under
 * src/ makes the env guard bypassable.
 *
 * Expected exceptions: none. (If a second construction site ever becomes
 * necessary — e.g. a read-replica client — add it here WITH a comment saying
 * why it may not take a datasource override.)
 */
const ALLOWED_SRC_CONSTRUCTION_SITES = ['src/lib/db.ts'];

interface Site {
  file: string;
  line: number;
  args: string;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      out.push(...walk(full));
    } else if (SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/** Text between the parentheses of `new PrismaClient(...)`, brace-balanced. */
function argumentsAt(source: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return source.slice(openParen + 1, i);
    }
  }
  return source.slice(openParen + 1);
}

function findConstructionSites(): Site[] {
  const sites: Site[] = [];
  for (const dir of SCANNED_DIRS) {
    const abs = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const file of walk(abs)) {
      const source = fs.readFileSync(file, 'utf8');
      const needle = 'new PrismaClient';
      let from = 0;
      for (;;) {
        const at = source.indexOf(needle, from);
        if (at === -1) break;
        from = at + needle.length;
        const openParen = source.indexOf('(', at + needle.length);
        if (openParen === -1) continue;
        sites.push({
          file: path.relative(REPO_ROOT, file),
          line: source.slice(0, at).split('\n').length,
          args: argumentsAt(source, openParen),
        });
      }
    }
  }
  return sites;
}

const SITES = findConstructionSites();

describe('PrismaClient construction sites', () => {
  it('finds at least the app singleton', () => {
    expect(SITES.length).toBeGreaterThan(0);
    expect(SITES.map((s) => s.file)).toContain('src/lib/db.ts');
  });

  it('never overrides the datasource, so DATABASE_URL is the only switch', () => {
    const overriding = SITES.filter((s) => /\bdatasources?\b|\bdatasourceUrl\b/.test(s.args)).map(
      (s) => `${s.file}:${s.line}`,
    );
    expect(
      overriding,
      'a datasource override bypasses the scratch-DB guard in tests/setup.ts',
    ).toEqual([]);
  });

  it('constructs a client in exactly one place under src/', () => {
    const inSrc = [...new Set(SITES.filter((s) => s.file.startsWith('src/')).map((s) => s.file))].sort();
    expect(inSrc).toEqual(ALLOWED_SRC_CONSTRUCTION_SITES);
  });

  it('lets scripts/ construct clients, but only env-driven ones', () => {
    // scripts/ are one-off maintenance tools run by hand against whatever
    // DATABASE_URL the operator exports. They may construct a client; they
    // may not hardcode a datasource (the assertion above covers both trees).
    const inScripts = [...new Set(SITES.filter((s) => s.file.startsWith('scripts/')).map((s) => s.file))];
    for (const file of inScripts) {
      const args = SITES.filter((s) => s.file === file).map((s) => s.args).join('');
      expect(args, `${file} must not pin a datasource`).not.toMatch(/datasources?\s*:|datasourceUrl/);
    }
  });
});
