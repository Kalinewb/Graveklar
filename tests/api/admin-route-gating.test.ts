/**
 * L0 — the drift guard behind flag F-13.
 *
 * Only seven `/api/admin/*` handlers call `isAdminAuthenticated()` themselves.
 * Every other one — app-config, machines, upload, reset, totp/*,
 * change-password, bookings/[id]/* — has no session check in its own body and
 * is protected solely by `src/proxy.ts` refusing the request before Next
 * dispatches to it. Phase 1d's verdict was that the model is sound (the router
 * is the only entry point, and the proxy's decision table is exhaustively
 * covered) but structurally fragile: it rests on `config.matcher` selecting
 * every path that reaches an admin handler, and that matcher is a hand-written
 * list, not something derived from the route tree. Nothing fails when the two
 * drift apart — finding H-2 was exactly that drift in miniature.
 *
 * So this file derives the paths from the file system instead of trusting a
 * list, and asserts, for every admin route that exists on disk:
 *
 *   1. `config.matcher` selects its pathname, so the proxy runs at all, and
 *   2. an anonymous request to it is refused with 401 by the proxy.
 *
 * Add a new `src/app/api/admin/**\/route.ts` and this test covers it the
 * moment it lands. The exceptions are the two deliberately public endpoints,
 * `/api/admin/login` and `/api/admin/logout`.
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { adminCookieJar, matcherMatches, proxyCall } from '../helpers/route';

const ADMIN_API_DIR = path.join(process.cwd(), 'src/app/api/admin');

/** Deliberately reachable without a session — the proxy exempts both. */
const PUBLIC_ADMIN_API = new Set(['/api/admin/login', '/api/admin/logout']);

/** Every `route.ts` under src/app/api/admin, as a repo-relative path. */
function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeFiles(full));
    else if (entry.name === 'route.ts' || entry.name === 'route.tsx') out.push(full);
  }
  return out.sort();
}

/**
 * The pathname Next serves a route file at. Dynamic segments (`[id]`,
 * `[...slug]`) get a concrete sample value, since the matcher and the proxy
 * both reason about a request path rather than a template. Route groups
 * (`(group)`) contribute no segment.
 */
function pathnameFor(file: string): string {
  const segments = path
    .relative(path.join(process.cwd(), 'src/app'), path.dirname(file))
    .split(path.sep)
    .filter((s) => s && !(s.startsWith('(') && s.endsWith(')')))
    .map((s) => {
      if (s.startsWith('[[...') && s.endsWith(']]')) return 'sample';
      if (s.startsWith('[...') && s.endsWith(']')) return 'sample';
      if (s.startsWith('[') && s.endsWith(']')) return 'sample-id';
      return s;
    });
  return `/${segments.join('/')}`;
}

const ROUTES = routeFiles(ADMIN_API_DIR).map((file) => ({
  file: path.relative(process.cwd(), file),
  pathname: pathnameFor(file),
}));

describe('every admin API route is gated by the proxy', () => {
  it('finds the admin route tree at all (a moved directory must not silently pass)', () => {
    expect(fs.existsSync(ADMIN_API_DIR)).toBe(true);
    expect(ROUTES.length).toBeGreaterThanOrEqual(10);
    // The derivation itself: a known nested + dynamic route resolves sensibly.
    expect(ROUTES.map((r) => r.pathname)).toContain('/api/admin/app-config');
    expect(ROUTES.map((r) => r.pathname)).toContain('/api/admin/totp/setup');
    expect(ROUTES.every((r) => r.pathname.startsWith('/api/admin'))).toBe(true);
  });

  it('is selected by config.matcher, so the proxy runs for it', () => {
    for (const { file, pathname } of ROUTES) {
      expect({ file, matched: matcherMatches(pathname) }).toEqual({ file, matched: true });
    }
  });

  it('answers 401 to an anonymous caller (login and logout excepted)', async () => {
    for (const { file, pathname } of ROUTES) {
      if (PUBLIC_ADMIN_API.has(pathname)) continue;
      for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
        const res = await proxyCall(pathname, { method });
        expect({ file, method, status: res.status }).toEqual({ file, method, status: 401 });
        expect(await res.json()).toEqual({ error: 'Unauthorized' });
      }
    }
  });

  it('lets the same paths through once a session is presented', async () => {
    const cookies = await adminCookieJar();
    for (const { file, pathname } of ROUTES) {
      const res = await proxyCall(pathname, { cookies });
      // NextResponse.next() — 200 carrying the internal continue marker.
      expect({ file, next: res.headers.get('x-middleware-next') }).toEqual({ file, next: '1' });
    }
  });

  it('exempts exactly login and logout, and both exist', () => {
    const pathnames = new Set(ROUTES.map((r) => r.pathname));
    for (const exempt of PUBLIC_ADMIN_API) {
      expect({ exempt, exists: pathnames.has(exempt) }).toEqual({ exempt, exists: true });
    }
  });

  it('the bare collection path is gated too (regression guard for H-2)', async () => {
    expect(matcherMatches('/api/admin')).toBe(true);
    expect((await proxyCall('/api/admin', { method: 'GET' })).status).toBe(401);
  });
});
