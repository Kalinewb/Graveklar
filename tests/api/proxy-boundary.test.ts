/**
 * L2 — the request proxy is the ONLY auth gate most admin routes have.
 *
 * `src/proxy.ts` runs before any handler and is what turns a missing session
 * cookie into a redirect (pages) or a 401 (APIs). Most `/api/admin/*` handlers
 * do not re-check the session themselves (flag F-13), so two things have to be
 * true and stay true: the decision table below, and the matcher actually
 * selecting every path that decision table covers. A path the matcher misses
 * never reaches `proxy()` at all — it is simply public.
 *
 * The live counterpart (tests/live/proxy-matcher-probes.test.ts) attacks the
 * matcher over real HTTP with the encodings a synthetic NextRequest normalises
 * away.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIGS } from '@/lib/config-defaults';
import { APP_CONFIG_DEFAULTS, SENSITIVE_GROUPS } from '@/lib/app-config-defaults';

import { PROXY_MATCHER, adminCookieJar, matcherMatches, proxyCall } from '../helpers/route';

type Verdict = 'pass' | '401' | 'redirect';

async function verdict(
  path: string,
  method: string,
  cookies?: Record<string, string>,
): Promise<{ verdict: Verdict; location: string | null; status: number }> {
  const res = await proxyCall(path, { method, cookies });
  const location = res.headers.get('location');
  if (res.status >= 300 && res.status < 400 && location) {
    return { verdict: 'redirect', location, status: res.status };
  }
  if (res.status === 401) return { verdict: '401', location, status: res.status };
  // NextResponse.next() — 200 carrying the internal continue marker.
  expect(res.headers.get('x-middleware-next')).toBe('1');
  return { verdict: 'pass', location, status: res.status };
}

const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;

describe('proxy decision table — no session', () => {
  const cases: [string, string, Verdict][] = [
    // Admin pages redirect to the login screen, carrying `from`.
    ['/admin', 'GET', 'redirect'],
    ['/admin/bookings', 'GET', 'redirect'],
    ['/admin/innstillinger/2fa', 'GET', 'redirect'],
    ['/admin/login', 'GET', 'pass'],

    // Admin APIs answer 401 as JSON — except the two that must stay reachable
    // so an admin can obtain (or drop) a session in the first place.
    ['/api/admin/app-config', 'GET', '401'],
    ['/api/admin/app-config', 'POST', '401'],
    ['/api/admin/machines', 'POST', '401'],
    ['/api/admin/audit-log', 'GET', '401'],
    ['/api/admin/reset', 'POST', '401'],
    ['/api/admin/totp/status', 'GET', '401'],
    ['/api/admin/upload', 'POST', '401'],
    ['/api/admin/login', 'POST', 'pass'],
    ['/api/admin/logout', 'POST', 'pass'],

    // Bookings: the public form POSTs here, the admin list GETs here.
    ['/api/bookings', 'POST', 'pass'],
    ['/api/bookings', 'GET', '401'],
    ['/api/bookings/abc123', 'GET', '401'],
    ['/api/bookings/abc123', 'PATCH', '401'],
    ['/api/bookings/abc123', 'DELETE', '401'],

    // Pricing config: the public site reads it, only an admin may write it.
    ['/api/config', 'GET', 'pass'],
    ['/api/config', 'POST', '401'],

    // Blocked dates are admin-only in both directions.
    ['/api/unavailable', 'GET', '401'],
    ['/api/unavailable', 'POST', '401'],
    ['/api/unavailable', 'DELETE', '401'],
    ['/api/unavailable/2026-10-02', 'GET', '401'],
  ];

  for (const [path, method, expected] of cases) {
    it(`${method} ${path} → ${expected}`, async () => {
      const got = await verdict(path, method);
      expect(got.verdict).toBe(expected);
    });
  }

  it('sends admin page visitors to /admin/login with a `from` hint', async () => {
    const got = await verdict('/admin/bookings', 'GET');
    const url = new URL(got.location!);
    expect(url.pathname).toBe('/admin/login');
    expect(url.searchParams.get('from')).toBe('/admin/bookings');
  });

  it('answers admin APIs with a JSON 401, not an HTML redirect', async () => {
    const res = await proxyCall('/api/admin/app-config', { method: 'GET' });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('refuses every method on an admin API, not just the ones the UI uses', async () => {
    for (const method of METHODS) {
      expect((await verdict('/api/admin/machines/abc', method)).verdict).toBe('401');
    }
  });

  it('refuses a forged or expired cookie exactly like a missing one', async () => {
    for (const value of ['', 'garbage', 'YWRtaW46MTox', 'A'.repeat(400)]) {
      const got = await verdict('/api/admin/app-config', 'GET', { graveklar_admin_session: value });
      expect(got.verdict).toBe('401');
    }
  });
});

describe('proxy decision table — valid session', () => {
  it('lets every gated path through', async () => {
    const cookies = await adminCookieJar();
    const paths: [string, string][] = [
      ['/admin', 'GET'],
      ['/admin/bookings', 'GET'],
      ['/api/admin/app-config', 'GET'],
      ['/api/admin/app-config', 'POST'],
      ['/api/admin/machines', 'POST'],
      ['/api/bookings', 'GET'],
      ['/api/bookings/abc123', 'PATCH'],
      ['/api/config', 'POST'],
      ['/api/unavailable', 'POST'],
      ['/api/unavailable/2026-10-02', 'DELETE'],
    ];
    for (const [path, method] of paths) {
      const got = await verdict(path, method, cookies);
      expect({ path, method, verdict: got.verdict }).toEqual({ path, method, verdict: 'pass' });
    }
  });

  it('bounces an authenticated visitor away from the login page', async () => {
    const got = await verdict('/admin/login', 'GET', await adminCookieJar());
    expect(got.verdict).toBe('redirect');
    expect(new URL(got.location!).pathname).toBe('/admin');
  });

  it('still lets logout through with a session (that is the point of it)', async () => {
    expect((await verdict('/api/admin/logout', 'POST', await adminCookieJar())).verdict).toBe('pass');
  });
});

describe('matcher coverage', () => {
  it('is exactly the seven patterns the decision table assumes', () => {
    expect(PROXY_MATCHER).toEqual([
      '/admin/:path*',
      '/api/admin/:path*',
      '/api/bookings',
      '/api/bookings/:path*',
      '/api/config',
      '/api/unavailable',
      '/api/unavailable/:path*',
    ]);
  });

  it('selects every path the proxy makes a decision about', () => {
    for (const path of [
      '/admin',
      '/admin/login',
      '/admin/bookings',
      '/admin/innstillinger/2fa',
      '/api/admin',
      '/api/admin/login',
      '/api/admin/app-config',
      '/api/admin/bookings/abc/timeline',
      '/api/bookings',
      '/api/bookings/abc123',
      '/api/config',
      '/api/unavailable',
      '/api/unavailable/2026-10-02',
    ]) {
      expect({ path, matched: matcherMatches(path) }).toEqual({ path, matched: true });
    }
  });

  it('does not select unrelated neighbours', () => {
    for (const path of [
      '/',
      '/adminx',
      '/administration',
      '/api/adminx',
      '/api/bookingsx',
      '/api/booking/cancel',
      '/api/configs',
      '/api/config/extra',        // /api/config is a bare literal, not a prefix
      '/api/unavailables',
      '/api/quote',
      '/api/app-config',
      '/api/uploads/upload-1.jpg',
    ]) {
      expect({ path, matched: matcherMatches(path) }).toEqual({ path, matched: false });
    }
  });

  // FIXED H-2: `/api/admin` (no trailing slash) is inside the matcher, so the
  // proxy runs — but every branch tested `startsWith('/api/admin/')`, so the
  // request fell through to `NextResponse.next()` and would have been served
  // without a session the moment anyone added `src/app/api/admin/route.ts`.
  // The bare collection path is now gated like the rest.
  it('FIXED H-2: refuses GET /api/admin without a session', async () => {
    expect((await verdict('/api/admin', 'GET')).verdict).toBe('401');
  });

  it('gates the bare /api/admin path for every method, and lets a session through', async () => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      expect({ method, v: (await verdict('/api/admin', method)).verdict }).toEqual({ method, v: '401' });
    }
    expect((await verdict('/api/admin', 'GET', await adminCookieJar())).verdict).toBe('pass');
  });
});

describe('F-12 — the public read side of /api/config', () => {
  it('exposes only pricing keys: PricingConfig shares no key with a sensitive AppConfig group', () => {
    // GET /api/config is deliberately public (the booking form prices from it)
    // and returns every PricingConfig row. The invariant that makes that safe
    // is that PricingConfig only ever holds prices — no credential key may be
    // added to it, and no key may be shared with a sensitive AppConfig group.
    const sensitiveAppConfigKeys = new Set(
      APP_CONFIG_DEFAULTS.filter((d) => SENSITIVE_GROUPS.has(d.group) && !d.isPublic).map((d) => d.key),
    );
    for (const cfg of DEFAULT_CONFIGS) {
      expect(sensitiveAppConfigKeys.has(cfg.key)).toBe(false);
      expect(cfg.key).not.toMatch(/secret|password|token|apikey|api_key|hash/i);
    }
  });
});
