/**
 * L2 — the admin authentication endpoints.
 *
 * These are the routes an unauthenticated attacker can actually reach:
 * `/api/admin/login` and `/api/admin/logout` are exempted from the proxy's 401
 * by design, and the rest are reachable with nothing but a stolen session
 * cookie. So the assertions here are about refusal: wrong password, wrong
 * code, replayed code, missing confirmation string, and the budgets that cap
 * how fast any of those can be guessed.
 *
 * `isAdminAuthenticated()` reads `next/headers`, which throws outside a Next
 * request scope — the mock below supplies the request-scoped cookie jar the
 * server would, so the audit-log route can be exercised at all.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const headerJar = vi.hoisted(() => ({ current: {} as Record<string, string> }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name in headerJar.current ? { name, value: headerJar.current[name] } : undefined,
  }),
}));

import { COOKIE_NAME, hashPassword, verifySessionToken } from '@/lib/admin-auth';

import { db, ensureSchema, resetDb } from '../helpers/db';
import { adminCookieJar, adminSessionToken, call, totpHeader } from '../helpers/route';
import { mockClock } from '../helpers/mocks';
import {
  TEST_TOTP_SECRET,
  hmacHex,
  seedTotpSecret,
  totpCodeFor,
} from '../helpers/auth';

const PASSWORD = 'Testadmin-2026!'; // tests/setup.ts sets ADMIN_PASSWORD to this
const FROZEN = '2026-09-06T12:00:05.000Z';

/** Each test gets its own rate-limit bucket — the limiters are module state. */
let ipSeq = 0;
const freshIp = () => ({ 'x-forwarded-for': `10.9.${Math.floor(ipSeq / 250)}.${++ipSeq % 250}` });

function parseSetCookie(raw: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const [i, part] of raw.split(';').entries()) {
    const [k, ...v] = part.trim().split('=');
    out[i === 0 ? 'name' : k.toLowerCase()] = i === 0 ? k : v.join('=');
    if (i === 0) out.value = v.join('=');
  }
  return out;
}

/** A legacy `<saltHex>:<hmacHex>` password hash — the format login upgrades. */
async function legacyHash(password: string, saltHex = 'aabbccddeeff00112233445566778899') {
  return `${saltHex}:${await hmacHex(password, saltHex)}`;
}

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetDb();
  headerJar.current = {};
});

// ── /api/admin/login ─────────────────────────────────────────────────────────

describe('POST /api/admin/login', () => {
  const login = async (body: unknown, headers: Record<string, string> = {}) => {
    const { POST } = await import('@/app/api/admin/login/route');
    return call(POST, { method: 'POST', path: '/api/admin/login', body, headers: { ...freshIp(), ...headers } });
  };

  it('rejects a missing or non-string password with 400', async () => {
    expect((await login({})).status).toBe(400);
    expect((await login({ password: '' })).status).toBe(400);
    expect((await login({ password: 12345 })).status).toBe(400);
    expect((await login({ password: { $ne: null } })).status).toBe(400);
  });

  it('rejects the wrong password with 401 and records it in the audit log', async () => {
    const res = await login({ password: 'feil-passord' });
    expect(res.status).toBe(401);
    expect(res.json.error).toBe('Feil passord');
    expect(res.headers.get('set-cookie')).toBeNull();

    const rows = await db.adminAuditLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('auth.login_failed');
    expect(rows[0].changes).toContain('invalid_password');
  });

  it('issues a working session cookie for the right password', async () => {
    const res = await login({ password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ success: true, mustChangePassword: false });

    const cookie = parseSetCookie(res.headers.get('set-cookie'));
    expect(cookie.name).toBe(COOKIE_NAME);
    expect(await verifySessionToken(cookie.value)).toBe(true);
    expect(res.headers.get('set-cookie')).toContain('HttpOnly');
    expect(res.headers.get('set-cookie')).toContain('SameSite=lax');
    expect(cookie.path).toBe('/');
    expect(cookie['max-age']).toBe(String(7 * 24 * 60 * 60));
  });

  it('marks the cookie Secure only when the request arrived over HTTPS', async () => {
    const plain = await login({ password: PASSWORD }, { host: 'localhost:3001' });
    expect(plain.headers.get('set-cookie')).not.toContain('Secure');

    const tls = await login({ password: PASSWORD }, { 'x-forwarded-proto': 'https' });
    expect(tls.headers.get('set-cookie')).toContain('Secure');
  });

  it('reports mustChangePassword while the default password is still in place', async () => {
    const original = process.env.ADMIN_PASSWORD;
    try {
      process.env.ADMIN_PASSWORD = 'admin';
      const res = await login({ password: 'admin' });
      expect(res.status).toBe(200);
      expect(res.json.mustChangePassword).toBe(true);
    } finally {
      process.env.ADMIN_PASSWORD = original;
    }
  });

  it('prefers the stored hash over the environment password once one exists', async () => {
    await db.appConfig.create({
      data: {
        key: 'adminPasswordHash', value: await hashPassword('Lagret-passord-9'),
        label: 'Admin-passord (hash)', group: 'system', type: 'hidden', isPublic: false, sortOrder: 99,
      },
    });
    expect((await login({ password: 'Lagret-passord-9' })).status).toBe(200);
    // The env password is no longer a way in.
    expect((await login({ password: PASSWORD })).status).toBe(401);
  }, 30_000);

  it('accepts a legacy salted-HMAC hash and upgrades it to PBKDF2 in the background', async () => {
    const stored = await legacyHash('Gammelt-passord-7');
    await db.appConfig.create({
      data: {
        key: 'adminPasswordHash', value: stored,
        label: 'Admin-passord (hash)', group: 'system', type: 'hidden', isPublic: false, sortOrder: 99,
      },
    });

    expect((await login({ password: 'Gammelt-passord-7' })).status).toBe(200);

    // The upgrade is deliberately fire-and-forget so it can never block the
    // login; poll for it rather than assuming it landed synchronously.
    let value = stored;
    for (let i = 0; i < 100 && !value.startsWith('pbkdf2$'); i++) {
      await new Promise((r) => setTimeout(r, 100));
      value = (await db.appConfig.findUniqueOrThrow({ where: { key: 'adminPasswordHash' } })).value;
    }
    expect(value.startsWith('pbkdf2$600000$')).toBe(true);
    expect((await login({ password: 'Gammelt-passord-7' })).status).toBe(200);
  }, 40_000);

  it('does not upgrade the stored hash after a failed login', async () => {
    const stored = await legacyHash('Gammelt-passord-7');
    await db.appConfig.create({
      data: {
        key: 'adminPasswordHash', value: stored,
        label: 'Admin-passord (hash)', group: 'system', type: 'hidden', isPublic: false, sortOrder: 99,
      },
    });
    expect((await login({ password: 'feil' })).status).toBe(401);
    await new Promise((r) => setTimeout(r, 200));
    expect((await db.appConfig.findUniqueOrThrow({ where: { key: 'adminPasswordHash' } })).value).toBe(stored);
  });

  it('caps attempts at 10 per IP per 15 minutes, correct password included', async () => {
    const ip = { 'x-forwarded-for': '203.0.113.77' };
    const { POST } = await import('@/app/api/admin/login/route');
    const attempt = (password: string) =>
      call(POST, { method: 'POST', path: '/api/admin/login', body: { password }, headers: ip });

    for (let i = 0; i < 10; i++) expect((await attempt('feil')).status).toBe(401);

    const blocked = await attempt('feil');
    expect(blocked.status).toBe(429);
    expect(blocked.json.error).toContain('15 minutter');

    // The budget is not a password oracle: the right password is refused too.
    expect((await attempt(PASSWORD)).status).toBe(429);
  });

  it('demands the second factor once a secret is enrolled', async () => {
    await seedTotpSecret();
    const clock = mockClock(FROZEN);
    try {
      const noCode = await login({ password: PASSWORD });
      expect(noCode.status).toBe(401);
      expect(noCode.json).toMatchObject({ requiresTotp: true });
      expect(noCode.headers.get('set-cookie')).toBeNull();

      const wrongCode = await login({ password: PASSWORD, code: '000000' });
      expect(wrongCode.status).toBe(401);
      expect(wrongCode.json).toMatchObject({ requiresTotp: true });

      const ok = await login({ password: PASSWORD, code: await totpCodeFor() });
      expect(ok.status).toBe(200);
      expect(await verifySessionToken(parseSetCookie(ok.headers.get('set-cookie')).value)).toBe(true);
    } finally {
      clock.restore();
    }
  });

  it('checks the password before the second factor, so a valid code alone is useless', async () => {
    await seedTotpSecret();
    const clock = mockClock(FROZEN);
    try {
      const res = await login({ password: 'feil', code: await totpCodeFor() });
      expect(res.status).toBe(401);
      expect(res.json.error).toBe('Feil passord');
      // The code was never consumed, so it is still usable with the right password.
      expect((await login({ password: PASSWORD, code: await totpCodeFor() })).status).toBe(200);
    } finally {
      clock.restore();
    }
  });

  it('refuses a replayed TOTP code inside the same step', async () => {
    await seedTotpSecret();
    const clock = mockClock(FROZEN);
    try {
      const code = await totpCodeFor();
      expect((await login({ password: PASSWORD, code })).status).toBe(200);
      const replay = await login({ password: PASSWORD, code });
      expect(replay.status).toBe(401);
      expect(replay.json.error).toBe('Ugyldig 2FA-kode.');
    } finally {
      clock.restore();
    }
  });

  // FIXED H-3: a malformed request body used to be reported as a 500
  // "Innlogging feilet" — `await request.json()` threw inside the try and the
  // catch-all turned every failure into a server error, so a client mistake
  // was indistinguishable from a real outage in the logs and in monitoring.
  // The body is now parsed in its own try/catch that answers 400.
  it('FIXED H-3: answers 400 for a body that is not JSON', async () => {
    const { POST } = await import('@/app/api/admin/login/route');
    const res = await call(POST, {
      method: 'POST',
      path: '/api/admin/login',
      body: 'not json at all',
      headers: { ...freshIp(), 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });
});

// ── /api/admin/logout ────────────────────────────────────────────────────────

describe('POST /api/admin/logout', () => {
  const logout = async (headers: Record<string, string> = {}) => {
    const { POST } = await import('@/app/api/admin/logout/route');
    return call(POST, { method: 'POST', path: '/api/admin/logout', headers });
  };

  it('clears the session cookie with the attributes it was set with', async () => {
    const res = await logout();
    expect(res.status).toBe(200);
    const raw = res.headers.get('set-cookie')!;
    const cookie = parseSetCookie(raw);
    expect(cookie.name).toBe(COOKIE_NAME);
    expect(cookie.value).toBe('');
    expect(cookie['max-age']).toBe('0');
    expect(cookie.path).toBe('/');
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=lax');
  });

  it('matches the Secure flag to the request, so the clear lands on the same cookie', async () => {
    expect((await logout({ host: 'localhost:3001' })).headers.get('set-cookie')).not.toContain('Secure');
    expect((await logout({ 'x-forwarded-proto': 'https' })).headers.get('set-cookie')).toContain('Secure');
  });

  it('succeeds without a session — logging out twice is not an error', async () => {
    expect((await logout()).status).toBe(200);
  });
});

// ── /api/admin/change-password ───────────────────────────────────────────────

describe('POST /api/admin/change-password', () => {
  const change = async (body: unknown, headers: Record<string, string> = {}) => {
    const { POST } = await import('@/app/api/admin/change-password/route');
    return call(POST, {
      method: 'POST', path: '/api/admin/change-password', body,
      headers: { ...freshIp(), ...headers }, cookies: await adminCookieJar(),
    });
  };

  it('requires both passwords', async () => {
    expect((await change({})).status).toBe(400);
    expect((await change({ currentPassword: PASSWORD })).status).toBe(400);
    expect((await change({ newPassword: 'nytt-passord-1' })).status).toBe(400);
  });

  it('requires the new password to be at least 8 characters', async () => {
    const res = await change({ currentPassword: PASSWORD, newPassword: 'kort' });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('8 tegn');
    expect(await db.appConfig.count({ where: { key: 'adminPasswordHash' } })).toBe(0);
  });

  it('rejects the wrong current password and logs the attempt', async () => {
    const res = await change({ currentPassword: 'feil', newPassword: 'nytt-passord-1' });
    expect(res.status).toBe(401);
    const rows = await db.adminAuditLog.findMany();
    expect(rows.map((r) => r.action)).toEqual(['admin.password_change_failed']);
    expect(await db.appConfig.count({ where: { key: 'adminPasswordHash' } })).toBe(0);
  });

  it('stores a PBKDF2 hash and logs the change without the password in it', async () => {
    const res = await change({ currentPassword: PASSWORD, newPassword: 'nytt-passord-1' });
    expect(res.status).toBe(200);

    const row = await db.appConfig.findUniqueOrThrow({ where: { key: 'adminPasswordHash' } });
    expect(row.value.startsWith('pbkdf2$600000$')).toBe(true);
    expect(row.type).toBe('hidden');
    expect(row.isPublic).toBe(false);

    const audit = await db.adminAuditLog.findFirstOrThrow({ where: { action: 'admin.password_change' } });
    expect(audit.changes).not.toContain('nytt-passord-1');
    expect(audit.changes).not.toContain(PASSWORD);

    // The new password is the one that works from now on.
    const { POST: login } = await import('@/app/api/admin/login/route');
    expect(
      (await call(login, { method: 'POST', path: '/api/admin/login', body: { password: 'nytt-passord-1' }, headers: freshIp() })).status,
    ).toBe(200);
  }, 40_000);

  it('caps attempts at 10 per IP per 15 minutes', async () => {
    const ip = { 'x-forwarded-for': '203.0.113.78' };
    for (let i = 0; i < 10; i++) {
      expect((await change({ currentPassword: 'feil', newPassword: 'nytt-passord-1' }, ip)).status).toBe(401);
    }
    const blocked = await change({ currentPassword: 'feil', newPassword: 'nytt-passord-1' }, ip);
    expect(blocked.status).toBe(429);
  }, 30_000);

  // FIXED H-4: changing the admin password used to need no second factor even
  // when TOTP was enrolled, so a stolen session could set a new password and
  // lock the real admin out. The route now runs `requireTotp()` on the same
  // terms as DELETE /api/admin/totp/setup — `not-enrolled` still passes, so
  // the forced-change flow at first login is untouched.
  it('FIXED H-4: refuses a password change without a TOTP code when 2FA is enrolled', async () => {
    await seedTotpSecret();
    const res = await change({ currentPassword: PASSWORD, newPassword: 'kapret-passord-1' });
    expect(res.status).toBe(401);
  }, 40_000);
});

// ── /api/admin/totp/status ───────────────────────────────────────────────────

describe('GET /api/admin/totp/status', () => {
  it('reports enrollment state', async () => {
    const { GET } = await import('@/app/api/admin/totp/status/route');
    expect((await call(GET, { path: '/api/admin/totp/status' })).json).toEqual({ enrolled: false });
    await seedTotpSecret();
    expect((await call(GET, { path: '/api/admin/totp/status' })).json).toEqual({ enrolled: true });
  });
});

// ── /api/admin/totp/setup ────────────────────────────────────────────────────

describe('/api/admin/totp/setup', () => {
  const setupGet = async () => {
    const { GET } = await import('@/app/api/admin/totp/setup/route');
    return call(GET, { path: '/api/admin/totp/setup' });
  };
  const setupDelete = async (body: unknown, headers: Record<string, string> = {}) => {
    const { DELETE } = await import('@/app/api/admin/totp/setup/route');
    return call(DELETE, { method: 'DELETE', path: '/api/admin/totp/setup', body, headers });
  };

  it('hands out a fresh secret and QR without persisting anything', async () => {
    const res = await setupGet();
    expect(res.status).toBe(200);
    expect(res.json.secret).toMatch(/^[A-Z2-7]+=*$/);
    expect(res.json.otpauthUri.startsWith('otpauth://totp/')).toBe(true);
    expect(res.json.qrDataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(res.json.accountLabel).toBe('admin');
    // Nothing is enrolled by looking at the enrollment screen.
    expect(await db.adminTotp.count()).toBe(0);

    const second = await setupGet();
    expect(second.json.secret).not.toBe(res.json.secret);
  });

  it('refuses to hand out a new secret while one is enrolled', async () => {
    await seedTotpSecret();
    const res = await setupGet();
    expect(res.status).toBe(409);
    expect((await db.adminTotp.findFirstOrThrow()).secret).toBe(TEST_TOTP_SECRET);
  });

  it('requires the password even when nothing is enrolled', async () => {
    expect((await setupDelete({})).status).toBe(400);
    expect((await setupDelete({ password: 'feil' })).status).toBe(401);
    expect((await setupDelete({ password: PASSWORD })).status).toBe(200);

    const failures = await db.adminAuditLog.findMany({ where: { action: 'admin.totp_remove_failed' } });
    expect(failures).toHaveLength(1);
  });

  it('requires BOTH a valid code and the password to remove an enrolled secret', async () => {
    const clock = mockClock(FROZEN);
    try {
      await seedTotpSecret();
      expect((await setupDelete({ password: PASSWORD })).status).toBe(401);           // code missing
      expect((await setupDelete({ password: PASSWORD }, totpHeader('000000'))).status).toBe(401); // code wrong
      expect(await db.adminTotp.count()).toBe(1);

      // Valid code, wrong password — still refused, and the secret survives.
      clock.advance(30_000);
      expect(
        (await setupDelete({ password: 'feil' }, totpHeader(await totpCodeFor()))).status,
      ).toBe(401);
      expect(await db.adminTotp.count()).toBe(1);

      // Both correct — the enrollment is removed and the removal is audited.
      clock.advance(30_000);
      const ok = await setupDelete({ password: PASSWORD }, totpHeader(await totpCodeFor()));
      expect(ok.status).toBe(200);
      expect(await db.adminTotp.count()).toBe(0);
      expect(await db.adminAuditLog.count({ where: { action: 'admin.totp_remove' } })).toBe(1);
    } finally {
      clock.restore();
    }
  });
});

// ── /api/admin/totp/verify ───────────────────────────────────────────────────

describe('POST /api/admin/totp/verify', () => {
  const verify = async (body: unknown, headers: Record<string, string> = {}) => {
    const { POST } = await import('@/app/api/admin/totp/verify/route');
    return call(POST, { method: 'POST', path: '/api/admin/totp/verify', body, headers: { ...freshIp(), ...headers } });
  };

  it('requires a string code', async () => {
    expect((await verify({})).status).toBe(400);
    expect((await verify({ code: 123456 })).status).toBe(400);
  });

  it('refuses to re-enrol over an existing secret', async () => {
    await seedTotpSecret();
    const res = await verify({ secret: 'NEWSECRET234567', code: '123456', password: PASSWORD });
    expect(res.status).toBe(409);
    expect((await db.adminTotp.findFirstOrThrow()).secret).toBe(TEST_TOTP_SECRET);
  });

  it('requires password re-entry to finalise an enrollment', async () => {
    const clock = mockClock(FROZEN);
    try {
      const secret = TEST_TOTP_SECRET;
      const code = await totpCodeFor(secret);

      expect((await verify({ secret, code })).status).toBe(400);                       // no password
      expect((await verify({ secret, code, password: 'feil' })).status).toBe(401);     // wrong password
      expect(await db.adminTotp.count()).toBe(0);

      const failures = await db.adminAuditLog.findMany({ where: { action: 'admin.totp_enroll_failed' } });
      expect(failures).toHaveLength(1);

      // Right password but a code that does not match the secret: still refused,
      // still nothing persisted. (The success path is deliberately not
      // exercised — this suite never enrols 2FA.)
      const res = await verify({ secret, code: '000000', password: PASSWORD });
      expect(res.status).toBe(400);
      expect(res.json.error).toContain('Koden stemmer ikke');
      expect(await db.adminTotp.count()).toBe(0);
    } finally {
      clock.restore();
    }
  });

  it('verifies a code against the enrolled secret, once', async () => {
    await seedTotpSecret();
    const clock = mockClock(FROZEN);
    try {
      const code = await totpCodeFor();
      expect((await verify({ code })).json).toEqual({ success: true });
      const replay = await verify({ code });
      expect(replay.status).toBe(400);
      expect(await db.adminAuditLog.count({ where: { action: 'admin.totp_verify_failed' } })).toBe(1);
    } finally {
      clock.restore();
    }
  });

  it('refuses every code when nothing is enrolled', async () => {
    const clock = mockClock(FROZEN);
    try {
      expect((await verify({ code: await totpCodeFor() })).status).toBe(400);
    } finally {
      clock.restore();
    }
  });

  it('caps code guesses at 10 per IP per 5 minutes', async () => {
    await seedTotpSecret();
    const ip = { 'x-forwarded-for': '203.0.113.79' };
    for (let i = 0; i < 10; i++) expect((await verify({ code: '000000' }, ip)).status).toBe(400);
    expect((await verify({ code: '000000' }, ip)).status).toBe(429);
  });
});

// ── /api/admin/reset ─────────────────────────────────────────────────────────

describe('POST /api/admin/reset', () => {
  const reset = async (body: unknown, headers: Record<string, string> = {}) => {
    const { POST } = await import('@/app/api/admin/reset/route');
    return call(POST, { method: 'POST', path: '/api/admin/reset', body, headers: { ...freshIp(), ...headers } });
  };

  it('needs the literal confirmation string', async () => {
    for (const confirm of [undefined, '', 'slett alt', 'SLETT  ALT', 'DELETE ALL', 'SLETT ALT ']) {
      const res = await reset(confirm === undefined ? {} : { confirm });
      expect(res.status).toBe(400);
      expect(res.json.error).toContain('SLETT ALT');
    }
  });

  it('is fail-closed when 2FA has never been enrolled — no bypass for a fresh install', async () => {
    const res = await reset({ confirm: 'SLETT ALT' });
    expect(res.status).toBe(401);
    expect(res.json).toMatchObject({ requiresTotp: true, requiresTotpEnrollment: true });
  });

  it('needs a valid code once 2FA is enrolled', async () => {
    await seedTotpSecret();
    const clock = mockClock(FROZEN);
    try {
      const missing = await reset({ confirm: 'SLETT ALT' });
      expect(missing.status).toBe(401);
      expect(missing.json).toMatchObject({ requiresTotp: true, requiresTotpEnrollment: false });

      const invalid = await reset({ confirm: 'SLETT ALT' }, totpHeader('000000'));
      expect(invalid.status).toBe(401);
      expect(invalid.json.error).toBe('Ugyldig 2FA-kode.');
    } finally {
      clock.restore();
    }
  });

  it('wipes bookings, locks, contracts and blocked dates, and audits the counts', async () => {
    const { booking, unavailableDate } = await import('../helpers/db');
    await booking('pending', { startDateStr: '2026-11-02' });
    await booking('confirmed', { startDateStr: '2026-11-10' });
    await unavailableDate('2026-10-02');
    await seedTotpSecret();

    const clock = mockClock(FROZEN);
    try {
      const res = await reset({ confirm: 'SLETT ALT' }, totpHeader(await totpCodeFor()));
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ success: true, deletedBookings: 2, totpEnforced: true });
    } finally {
      clock.restore();
    }

    expect(await db.booking.count()).toBe(0);
    expect(await db.bookingDateLock.count()).toBe(0);
    expect(await db.unavailableDate.count()).toBe(0);
    // The machine the bookings referenced is deliberately NOT deleted.
    expect(await db.machine.count()).toBeGreaterThan(0);

    const audit = await db.adminAuditLog.findFirstOrThrow({ where: { action: 'data.reset' } });
    expect(JSON.parse(audit.changes)).toEqual(
      expect.arrayContaining([{ key: 'bookings', from: 2, to: 0 }]),
    );
  });

  it('caps the endpoint at 3 attempts per IP per hour', async () => {
    const ip = { 'x-forwarded-for': '203.0.113.80' };
    for (let i = 0; i < 3; i++) expect((await reset({ confirm: 'nei' }, ip)).status).toBe(400);
    const blocked = await reset({ confirm: 'SLETT ALT' }, ip);
    expect(blocked.status).toBe(429);
    expect(blocked.json.error).toContain('en time');
  });
});

// ── /api/admin/audit-log ─────────────────────────────────────────────────────

describe('GET /api/admin/audit-log', () => {
  const auditLog = async (searchParams: Record<string, string> = {}) => {
    const { GET } = await import('@/app/api/admin/audit-log/route');
    return call(GET, { path: '/api/admin/audit-log', searchParams });
  };

  const seedRows = async (n: number, action = 'config.update') => {
    for (let i = 0; i < n; i++) {
      await db.adminAuditLog.create({
        data: {
          actor: i % 2 === 0 ? 'admin' : 'cron',
          action: i % 3 === 0 ? 'auth.login' : action,
          changes: JSON.stringify([{ key: `k${i}`, from: null, to: i }]),
          ip: '203.0.113.1',
          createdAt: new Date(Date.UTC(2026, 8, 1, 0, i)),
        },
      });
    }
  };

  it('re-checks the session itself rather than trusting the proxy alone', async () => {
    await seedRows(1);
    const anon = await auditLog();
    expect(anon.status).toBe(401);

    headerJar.current[COOKIE_NAME] = await adminSessionToken();
    expect((await auditLog()).status).toBe(200);

    headerJar.current[COOKIE_NAME] = 'forged';
    expect((await auditLog()).status).toBe(401);
  });

  it('defaults to 50 rows, newest first, with the distinct action list', async () => {
    await seedRows(60);
    headerJar.current[COOKIE_NAME] = await adminSessionToken();
    const res = await auditLog();
    expect(res.status).toBe(200);
    expect(res.json.limit).toBe(50);
    expect(res.json.rows).toHaveLength(50);
    expect(res.json.total).toBe(60);
    expect(res.json.actions).toEqual(['auth.login', 'config.update']);
    const times = res.json.rows.map((r: { createdAt: string }) => Date.parse(r.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(res.json.rows[0].changes).toBeInstanceOf(Array);
  });

  it('clamps limit into 1..200 and falls back to 50 for nonsense', async () => {
    await seedRows(5);
    headerJar.current[COOKIE_NAME] = await adminSessionToken();
    for (const [limit, expected] of [
      ['0', 1], ['-5', 1], ['1', 1], ['200', 200], ['9999', 200],
      ['abc', 50], ['', 50], ['3.9', 3],
    ] as const) {
      const res = await auditLog({ limit: String(limit) });
      expect({ limit, got: res.json.limit }).toEqual({ limit, got: expected });
    }
  });

  it('filters by action, actor and time range', async () => {
    await seedRows(30);
    headerJar.current[COOKIE_NAME] = await adminSessionToken();

    const byAction = await auditLog({ action: 'auth.login' });
    expect(byAction.json.total).toBe(10);
    expect(byAction.json.rows.every((r: { action: string }) => r.action.includes('auth'))).toBe(true);

    const byActor = await auditLog({ actor: 'cron' });
    expect(byActor.json.total).toBe(15);

    const since = await auditLog({ since: new Date(Date.UTC(2026, 8, 1, 0, 20)).toISOString() });
    expect(since.json.total).toBe(10);

    const window = await auditLog({
      since: new Date(Date.UTC(2026, 8, 1, 0, 10)).toISOString(),
      before: new Date(Date.UTC(2026, 8, 1, 0, 20)).toISOString(),
    });
    expect(window.json.total).toBe(10);
  });

  it('ignores an unparseable date instead of returning nothing', async () => {
    await seedRows(5);
    headerJar.current[COOKIE_NAME] = await adminSessionToken();
    const res = await auditLog({ since: 'not-a-date' });
    expect(res.status).toBe(200);
    expect(res.json.total).toBe(5);
  });

  it('returns the change payload as JSON, and the raw string when it is not JSON', async () => {
    await db.adminAuditLog.create({
      data: { actor: 'admin', action: 'x.y', changes: 'not json', ip: null },
    });
    headerJar.current[COOKIE_NAME] = await adminSessionToken();
    const res = await auditLog();
    expect(res.json.rows[0].changes).toBe('not json');
  });
});

// ── F-7: rate-limit identity ─────────────────────────────────────────────────

describe('F-7 — an unauthenticated client cannot choose its own rate-limit identity', () => {
  it('honours CF-Connecting-IP above everything else', async () => {
    // Pins the precedence every caller in the app shares (src/lib/client-ip.ts),
    // so the assertions below are about the choice of headers rather than an
    // accident of one route. Behind Cloudflare, CF-Connecting-IP is the one
    // value the client cannot write.
    const { POST } = await import('@/app/api/admin/login/route');
    const attempt = (headers: Record<string, string>) =>
      call(POST, { method: 'POST', path: '/api/admin/login', body: { password: 'feil' }, headers });

    // Exhaust the bucket keyed on CF-Connecting-IP, varying x-forwarded-for
    // under it the whole way.
    for (let i = 0; i < 10; i++) {
      await attempt({ 'cf-connecting-ip': '198.51.100.10', 'x-forwarded-for': `198.51.100.9${i}` });
    }
    expect((await attempt({ 'cf-connecting-ip': '198.51.100.10', 'x-forwarded-for': 'anything' })).status).toBe(429);

    // None of the forwarded values that rode along were ever charged.
    expect((await attempt({ 'x-forwarded-for': '198.51.100.90' })).status).toBe(401);
  });

  // FIXED H-5: the key is the LAST x-forwarded-for hop — the element a proxy
  // appends, or the socket peer Next fills in when the client sent none. The
  // first hop is whatever the client typed.
  it('keys on the LAST x-forwarded-for hop, and treats a header-less client as `unknown`', async () => {
    const { POST } = await import('@/app/api/admin/login/route');
    const attempt = (headers: Record<string, string>) =>
      call(POST, { method: 'POST', path: '/api/admin/login', body: { password: 'feil' }, headers });

    for (let i = 0; i < 10; i++) {
      await attempt({ 'x-forwarded-for': `198.51.100.2${i}, 10.0.0.1, 10.0.0.2` });
    }
    // Same last hop, different leading hops → same bucket.
    expect((await attempt({ 'x-forwarded-for': '172.16.0.1, 10.0.0.2' })).status).toBe(429);
    // Same values, different last hop → a fresh bucket.
    expect((await attempt({ 'x-forwarded-for': '10.0.0.2, 198.51.100.20' })).status).toBe(401);

    // Whitespace is trimmed, and an empty trailing element is skipped rather
    // than becoming the key.
    expect((await attempt({ 'x-forwarded-for': '10.0.0.1,   10.0.0.2   ' })).status).toBe(429);
    expect((await attempt({ 'x-forwarded-for': '10.0.0.2, ' })).status).toBe(429);
    // A header-less client shares the `unknown` bucket — and is charged for it.
    expect((await attempt({})).status).toBe(401);
  });

  // FIXED H-5 (F-7): the identity used to be read from `x-real-ip`, a header
  // the client sends and nothing in front of Next overwrites, so an attacker
  // picked a fresh identity per request and the 10-attempts-per-15-minutes
  // login budget never engaged. `clientIdentity()` reads CF-Connecting-IP or
  // the last forwarded hop only, so 40 rotating x-real-ip guesses now share
  // the `unknown` bucket and the budget bites after 10.
  it('FIXED H-5: rotating x-real-ip does not defeat the login budget', async () => {
    const { POST } = await import('@/app/api/admin/login/route');
    let refused = 0;
    for (let i = 0; i < 40; i++) {
      const res = await call(POST, {
        method: 'POST',
        path: '/api/admin/login',
        body: { password: `guess-${i}` },
        headers: { 'x-real-ip': `192.0.2.${i}` },
      });
      if (res.status === 429) refused++;
    }
    // At most the 10-request budget can reach the password check, however the
    // header varies. (`unknown` is a shared bucket, so an earlier test in this
    // file may already have spent part of it — hence the bound rather than an
    // exact count.)
    expect(40 - refused).toBeLessThanOrEqual(10);
    expect(refused).toBeGreaterThanOrEqual(30);
  }, 30_000);

  it('a client rotating its own x-forwarded-for still bypasses — by design, behind Cloudflare', async () => {
    // The residual risk documented in src/lib/client-ip.ts: on a DIRECTLY
    // exposed origin the forwarded chain is forgeable, and nothing a handler
    // can read tells that apart from a real proxy hop. The control is
    // operational — the origin must accept only Cloudflare traffic (R-7) —
    // so this records the shape rather than pretending code closed it.
    const { POST } = await import('@/app/api/admin/login/route');
    const statuses = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const res = await call(POST, {
        method: 'POST',
        path: '/api/admin/login',
        body: { password: `guess-${i}` },
        headers: { 'x-forwarded-for': `192.0.2.1${String(i).padStart(2, '0')}` },
      });
      statuses.add(res.status);
    }
    expect([...statuses]).toEqual([401]);
  }, 30_000);
});
