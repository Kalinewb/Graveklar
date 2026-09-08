/**
 * L4 — the proxy boundary over real HTTP.
 *
 * `tests/api/proxy-boundary.test.ts` proves what `proxy()` decides. It cannot
 * prove that Next actually *runs* it for a given request line, and that is the
 * part an attacker attacks: a path spelling that the matcher misses but the
 * router still resolves to an admin handler would be unauthenticated, because
 * almost none of those handlers re-check the session themselves (flag F-13).
 *
 * So these probes send request lines a `fetch()` or a synthetic `NextRequest`
 * would normalise away — raw `..` segments, double slashes, percent-encoded
 * letters, Unicode homoglyphs, odd methods — straight down a socket, and
 * require that not one of them reaches an admin handler without a session.
 *
 * Skipped unless AUDIT_BASE_URL points at a running instance:
 *   AUDIT_BASE_URL=http://localhost:3001 npx vitest run tests/live
 */
import http from 'node:http';

import { describe, expect, it } from 'vitest';

const BASE = process.env.AUDIT_BASE_URL;

interface RawResponse {
  status: number;
  location: string | null;
  body: string;
}

/**
 * Percent-encode only what cannot travel in a request line (non-ASCII and
 * space). Everything else — `..`, `//`, `;`, `#`, existing `%xx` — is left
 * exactly as written, which is the whole point of these probes.
 */
function wireSafe(path: string): string {
  return path.replace(/[^\x21-\x7e]/g, (ch) => encodeURIComponent(ch));
}

/** Send `path` verbatim — no URL parsing, no normalisation. */
function raw(path: string, method = 'GET', headers: Record<string, string> = {}): Promise<RawResponse> {
  const url = new URL(BASE!);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: url.hostname, port: url.port || 80, method, path: wireSafe(path), headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c.length > 4096 ? c.slice(0, 4096) : c; });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, location: res.headers.location ?? null, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Follow up to `max` redirects, returning the final response. */
async function follow(path: string, max = 5): Promise<RawResponse> {
  let current = await raw(path);
  for (let i = 0; i < max && current.location && current.status >= 300 && current.status < 400; i++) {
    current = await raw(new URL(current.location, BASE!).pathname);
  }
  return current;
}

describe.skipIf(!BASE)('live: the admin API is unreachable without a session', () => {
  // Every one of these resolves — or tries to resolve — towards
  // /api/admin/app-config, which returns the full settings table including
  // Stripe/SMTP credentials once masked. None may answer 200.
  const SPELLINGS = [
    '/api/admin/app-config',
    '/api/admin/app-config/',
    '/api/admin/app-config?x=1',
    '/api/admin/app-config?admin=true',
    '/api/admin/app-config#fragment',
    '/api/admin/app-config;x=1',
    '/api/admin/app-config%20',
    '/api/admin/app-config..',
    '/api/admin/../admin/app-config',
    '/api/admin/./app-config',
    '/api/admin//app-config',
    '/api//admin/app-config',
    '//api/admin/app-config',
    '/API/ADMIN/APP-CONFIG',
    '/Api/Admin/App-Config',
    '/api/%61dmin/app-config',
    '/api/admin/%61pp-config',
    '/api/%2561dmin/app-config',
    '/api/аdmin/app-config',          // Cyrillic а
    '/api/admin⁄app-config',          // fraction slash
    '/api/admin/app－config',          // fullwidth hyphen-minus
    '/./api/admin/app-config',
    '/x/../api/admin/app-config',
  ];

  for (const path of SPELLINGS) {
    it(`does not serve ${JSON.stringify(path)}`, async () => {
      const res = await raw(path);
      expect({ path, status: res.status }).not.toEqual({ path, status: 200 });
      expect(res.body).not.toContain('stripeSecretKey');
    });
  }

  it('lands every redirecting spelling on a 401, never on the settings table', async () => {
    for (const path of SPELLINGS) {
      const final = await follow(path);
      expect({ path, status: final.status }).not.toEqual({ path, status: 200 });
      expect(final.body).not.toContain('stripeSecretKey');
    }
  }, 60_000);

  it('normalises trailing and doubled slashes to the canonical path, which is 401', async () => {
    for (const path of ['/api/admin/app-config/', '/api//admin/app-config', '/api/admin//app-config']) {
      const res = await raw(path);
      expect(res.status).toBe(308);
      expect(new URL(res.location!, BASE!).pathname).toBe('/api/admin/app-config');
      expect((await follow(path)).status).toBe(401);
    }
  });

  it('refuses every HTTP method, not only the ones the admin UI sends', async () => {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const res = await raw('/api/admin/app-config', method);
      expect({ method, status: res.status }).toEqual({ method, status: 401 });
    }
  });

  it('fails closed on TRACE — Next refuses to build the request at all', async () => {
    // Not app code: undici rejects TRACE when the middleware adapter constructs
    // the NextRequest, so the proxy never runs and neither does the handler.
    // Recorded because "500" on an auth-gated path looks alarming in a log and
    // is worth being able to explain. A production build does not leak the
    // stack the dev server shows here.
    const res = await raw('/api/admin/app-config', 'TRACE');
    expect(res.status).toBe(500);
    expect(res.body).not.toContain('stripeSecretKey');
  });

  it('serves a forged or truncated session cookie exactly like no cookie', async () => {
    for (const cookie of [
      'graveklar_admin_session=',
      'graveklar_admin_session=garbage',
      'graveklar_admin_session=YWRtaW46OTk5OTk5OTk5OTk5OjAw',
      'graveklar_admin_session=a; graveklar_admin_session=b',
      'graveklar_admin_session',
    ]) {
      const res = await raw('/api/admin/app-config', 'GET', { cookie });
      expect({ cookie, status: res.status }).toEqual({ cookie, status: 401 });
    }
  });

  it('sends an anonymous admin page visit to the login screen', async () => {
    const res = await raw('/admin/bookinger');
    expect([307, 308]).toContain(res.status);
    const url = new URL(res.location!, BASE!);
    expect(url.pathname).toBe('/admin/login');
    expect(url.searchParams.get('from')).toBe('/admin/bookinger');
  });

  it('gates the other matcher paths too', async () => {
    expect((await raw('/api/bookings')).status).toBe(401);
    expect((await raw('/api/unavailable?month=2026-10')).status).toBe(401);
    // …and leaves the deliberately public ones open.
    expect((await raw('/api/config')).status).toBe(200);
    expect((await raw('/api/app-config')).status).toBe(200);
  });

  // Live counterpart of FIXED H-2 (tests/api/proxy-boundary.test.ts): the bare
  // `/api/admin` path is inside the matcher but used to match none of the
  // proxy's branches, so it passed through unauthenticated and answered 404 —
  // the refusal came from the router having no handler, not from the auth
  // gate. It is now refused by the gate, before the router is consulted.
  it('refuses bare /api/admin with 401, from the gate rather than the router', async () => {
    const res = await raw('/api/admin');
    expect(res.status).toBe(401);
    expect(res.body).toContain('Unauthorized');
  });

  it('does not resolve a percent-encoded or homoglyph spelling to the real route', async () => {
    // These are 404s because Next matches the route table on the raw segment,
    // so the encoding never becomes `admin`. Pinned so a future change to
    // Next's path handling shows up here rather than as a silent bypass.
    for (const path of ['/api/%61dmin/app-config', '/api/аdmin/app-config']) {
      expect((await raw(path)).status).toBe(404);
    }
  });
});
