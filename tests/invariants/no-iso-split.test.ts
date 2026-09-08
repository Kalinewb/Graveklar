/**
 * L0 — a lint-style guard over the source text. Executes nothing.
 *
 * The rule: a calendar date in this product is an **Oslo-local** day.
 * `new Date().toISOString().split('T')[0]` (and its `.slice(0, 10)` twin) take
 * the UTC day instead, which is the *previous* day for the first one or two
 * hours of every Oslo day — 22:00–00:00 in summer, 23:00–00:00 in winter.
 * `src/lib/dates.ts` exists precisely so nobody has to reach for it, and
 * `validateBookingInput` carries a comment saying so.
 *
 * Every match is listed with `file:line` so a finding can name it exactly.
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../setup';

const SRC = path.join(REPO_ROOT, 'src');
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

/** Both spellings of "take the UTC calendar date". */
const PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["toISOString().split('T')[0]", /toISOString\(\)\s*\.\s*split\(\s*['"`]T['"`]\s*\)\s*\[\s*0\s*\]/],
  ['toISOString().slice(0, 10)', /toISOString\(\)\s*\.\s*slice\(\s*0\s*,\s*10\s*\)/],
  ['toISOString().substring(0, 10)', /toISOString\(\)\s*\.\s*substring\(\s*0\s*,\s*10\s*\)/],
];

interface Match {
  file: string;
  line: number;
  pattern: string;
  text: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(full, out);
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

function scan(files: string[]): Match[] {
  const matches: Match[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      for (const [name, re] of PATTERNS) {
        if (re.test(text)) {
          matches.push({
            file: path.relative(REPO_ROOT, file),
            line: i + 1,
            pattern: name,
            text: text.trim(),
          });
        }
      }
    });
  }
  return matches;
}

const ALL_FILES = walk(SRC);
const format = (m: Match) => `${m.file}:${m.line} — ${m.pattern} — ${m.text}`;

describe('no UTC-date extraction anywhere a booking date is derived', () => {
  it('finds source files to scan at all (the guard must not pass vacuously)', () => {
    expect(ALL_FILES.length).toBeGreaterThan(100);
    expect(ALL_FILES.some((f) => f.endsWith(path.join('lib', 'dates.ts')))).toBe(true);
  });

  it('is clean across every server module — lib, api routes and the proxy', () => {
    // This is the half that decides what gets written to the database and what
    // an availability query compares against. It must stay at zero.
    const server = ALL_FILES.filter(
      (f) =>
        f.startsWith(path.join(SRC, 'lib')) ||
        f.startsWith(path.join(SRC, 'app', 'api')) ||
        f === path.join(SRC, 'proxy.ts'),
    );
    expect(server.length).toBeGreaterThan(50);
    expect(scan(server).map(format)).toEqual([]);
  });

  it('never mixes the two date semantics inside a server module', () => {
    // A file that already imports the local-date helpers and *also* reaches for
    // toISOString() is the mixed-semantics case that produces off-by-one days.
    // On the server that combination does not occur at all.
    const mixed = ALL_FILES.filter((f) => {
      if (f.startsWith(path.join(SRC, 'app')) && !f.startsWith(path.join(SRC, 'app', 'api'))) {
        return false; // client components — covered by the whole-src check below
      }
      return /from '@\/lib\/dates'/.test(fs.readFileSync(f, 'utf8'));
    });
    expect(mixed.length).toBeGreaterThan(0);
    expect(scan(mixed).map(format)).toEqual([]);
  });

  // FIXED V-1: the last match was the admin CSV export filename,
  // `bookinger-${new Date().toISOString().split('T')[0]}.csv`, which filed an
  // export run between local midnight and 02:00 Oslo under yesterday's date.
  // It now uses `toDateStr(new Date())` — the same local-date helper the rest
  // of the file already imports — so the rule holds across the whole of src/.
  it('the pattern appears nowhere in src/', () => {
    expect(scan(ALL_FILES).map(format)).toEqual([]);
  });

  it('names the admin CSV export from the local calendar date (V-1)', () => {
    // The filename is the one place a reader would have copied the banned
    // pattern from, so pin the replacement rather than only its absence.
    const admin = fs.readFileSync(path.join(SRC, 'app', 'admin', 'page.tsx'), 'utf8');
    const download = admin.match(/a\.download = `bookinger-\$\{([^}]+)\}\.csv`/);
    expect(download).not.toBeNull();
    expect(download![1]).toBe('toDateStr(new Date())');
  });
});
