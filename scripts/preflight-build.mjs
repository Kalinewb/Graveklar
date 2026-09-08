#!/usr/bin/env node
// Preflight guard for `npm run build`.
//
// Refuses to start the build if a `next start` process is currently
// running against this directory's `.next/`. Building over the live
// .next/ silently overwrites the chunk files the running server is
// handing to customer browsers, producing ChunkLoadError on every
// active customer tab until they hard-refresh.
//
// Override: BUILD_DESPITE_RUNNING_PROD=1 npm run build
//   Use only when you intend to restart the server immediately after
//   the build (i.e. you ARE the deploy and the chunk turnover is
//   intentional).

import { execSync } from 'node:child_process';
import path from 'node:path';

if (process.env.BUILD_DESPITE_RUNNING_PROD === '1') {
  console.log('⚠️  BUILD_DESPITE_RUNNING_PROD=1 — skipping prod-running check.');
  process.exit(0);
}

const projectDir = path.resolve(process.cwd());

let psOutput = '';
try {
  // `ps -eo pid,cwd,args` exposes the cwd of each process — required to
  // disambiguate "next start" running from THIS directory vs another
  // checkout. BusyBox `ps` doesn't support `-o cwd`; fall back to args-
  // only, which means we flag any `next start` anywhere (false positives
  // on machines with multiple Next projects, but safer than missing).
  try {
    psOutput = execSync('ps -eo pid,cwd,args', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    psOutput = execSync('ps -eo pid,args', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  }
} catch {
  // Can't introspect processes (locked-down sandbox, missing ps). Don't
  // block the build — the guard is best-effort.
  process.exit(0);
}

const lines = psOutput.split('\n').slice(1);
const offending = [];
for (const raw of lines) {
  const line = raw.trim();
  if (!line) continue;
  // Match either `next start` or `npm exec next start` or `node …/next start`.
  if (!/\bnext\s+start\b/.test(line)) continue;
  // If we have a cwd column AND it's clearly outside this project, skip.
  // The cwd column is the second whitespace-separated token in `-o pid,cwd,args`.
  const tokens = line.split(/\s+/);
  const maybeCwd = tokens[1];
  if (maybeCwd && maybeCwd.startsWith('/') && !maybeCwd.startsWith(projectDir)) continue;
  offending.push(line);
}

if (offending.length === 0) {
  process.exit(0);
}

console.error('');
console.error('❌ Refusing to build — a `next start` process is running:');
for (const p of offending) console.error('   ' + p);
console.error('');
console.error('Building over the live .next/ directory replaces the chunk files');
console.error('the running server is still serving, causing ChunkLoadError on');
console.error('every active customer tab until they hard-refresh.');
console.error('');
console.error('To proceed safely, pick one:');
console.error('  1. Stop the prod server first, then build, then restart:');
console.error('       pkill -f "next start" && npm run build && sh start.sh');
console.error('  2. Verify without building (recommended for code review):');
console.error('       npm run typecheck && npm test && npm run lint');
console.error('  3. Override (only if you ARE the deploy and will restart now):');
console.error('       BUILD_DESPITE_RUNNING_PROD=1 npm run build');
console.error('');
process.exit(1);
