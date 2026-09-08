/**
 * L2 — application settings: the public read, the admin read/write, and the
 * test-email trigger hanging off it.
 *
 * Three separate things decide what may leave this table, and they disagree:
 *
 *   - `publicAppConfig()` filters against the code's `isPublic` list and is
 *     fail-closed for anything it does not recognise;
 *   - `GET /api/admin/app-config` re-applies the code metadata and masks
 *     password/hidden values;
 *   - `GET /api/app-config` — the anonymous one — queries `where isPublic:true`
 *     straight off the DB rows, trusting a stored flag the code never re-syncs.
 *
 * The third is the leak (finding I-1). The rest of the file pins the
 * sensitive-save 2FA gate, the boolean write normalisation, and the
 * AppConfig-holds-intent / SystemState-holds-derived-state split.
 */
import { beforeEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/email', async () => (await import('../helpers/mocks')).mockEmail());
vi.mock('@/lib/geocode', async (orig) =>
  (await import('../helpers/mocks')).mockGeocode((await orig()) as Record<string, unknown>));

import { PASSWORD_MASK, loadAppConfig, publicAppConfig } from '@/lib/app-config';
import { APP_CONFIG_DEFAULTS, SENSITIVE_GROUPS } from '@/lib/app-config-defaults';
import { getDeliveryOrigin } from '@/lib/system-state';

import { db, ensureSchema, invalidateCaches, resetDb, seedConfigDefaults } from '../helpers/db';
import { call, totpHeader } from '../helpers/route';
import { emailMock, geocodeMock } from '../helpers/mocks';
import { seedTotpSecret, totpCodeFor } from '../helpers/auth';
import { mockClock } from '../helpers/mocks';

const FROZEN = '2026-09-06T12:00:05.000Z';

type Update = { key: string; value: string | boolean };

async function publicGet() {
  const { GET } = await import('@/app/api/app-config/route');
  return call(GET, { path: '/api/app-config' });
}

async function adminGet() {
  const { GET } = await import('@/app/api/admin/app-config/route');
  return call(GET, { path: '/api/admin/app-config' });
}

async function adminPost(updates: Update[] | unknown, headers: Record<string, string> = {}) {
  const { POST } = await import('@/app/api/admin/app-config/route');
  return call(POST, { method: 'POST', path: '/api/admin/app-config', body: updates, headers });
}

async function testEmail(template?: string) {
  const { POST } = await import('@/app/api/admin/app-config/test-email/route');
  return call(POST, {
    method: 'POST',
    path: '/api/admin/app-config/test-email',
    searchParams: template === undefined ? {} : { template },
  });
}

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetDb();
  emailMock.reset();
  geocodeMock.reset();
});

// ── GET /api/app-config (anonymous) ──────────────────────────────────────────

describe('GET /api/app-config', () => {
  it('seeds the defaults on an empty database and returns only the public ones', async () => {
    const res = await publicGet();
    expect(res.status).toBe(200);

    const publicKeys = new Set(APP_CONFIG_DEFAULTS.filter((d) => d.isPublic).map((d) => d.key));
    expect(new Set(Object.keys(res.json))).toEqual(publicKeys);
    expect(await db.appConfig.count()).toBe(APP_CONFIG_DEFAULTS.length);
  });

  it('never carries a credential from a default-shaped database', async () => {
    await seedConfigDefaults({
      stripeSecretKey: 'sk_live_LEAK',
      stripeWebhookSecret: 'whsec_LEAK',
      smtpPass: 'hunter2',
      vippsClientSecret: 'vipps-LEAK',
      adminEmail: 'admin@example.com',
      baseAddress: 'Eksempelveien 1',
    });
    const res = await publicGet();
    const body = JSON.stringify(res.json);
    for (const secret of ['sk_live_LEAK', 'whsec_LEAK', 'hunter2', 'vipps-LEAK', 'admin@example.com', 'Eksempelveien 1']) {
      expect(body).not.toContain(secret);
    }
  });

  // FIXED I-1: the public route used to filter on the DB row's `isPublic`
  // column rather than on the code's public list. `loadAppConfig()` never
  // re-syncs metadata onto existing rows — it only inserts missing keys and
  // deletes unknown ones — so a row whose flag was true under an older
  // APP_CONFIG_DEFAULTS (or was written by any other path) kept publishing its
  // value anonymously for ever. The route now goes through the fail-closed
  // `publicAppConfig()` helper the rest of the app already used.
  it('FIXED I-1: a DB row with isPublic=true cannot publish a secret key', async () => {
    await seedConfigDefaults({ stripeSecretKey: 'sk_live_DRIFTED' });
    await db.appConfig.update({ where: { key: 'stripeSecretKey' }, data: { isPublic: true } });
    invalidateCaches();

    const res = await publicGet();
    expect(res.json.stripeSecretKey).toBeUndefined();
  });

  it('takes the code list as the source of truth in both directions', async () => {
    // Rewritten for FIXED I-1: the route's answer now depends on
    // APP_CONFIG_DEFAULTS alone, so a drifted DB flag changes nothing either
    // way — a public key with the column set false is still published…
    await seedConfigDefaults({ businessName: 'Graveklar AS' });
    await db.appConfig.update({ where: { key: 'businessName' }, data: { isPublic: false } });
    invalidateCaches();

    expect((await publicGet()).json.businessName).toBe('Graveklar AS');
    expect(publicAppConfig(await loadAppConfig()).businessName).toBe('Graveklar AS');
  });

  it('drops an unknown key entirely rather than guessing (publicAppConfig is fail-closed)', () => {
    const filtered = publicAppConfig({
      businessName: 'Graveklar',
      someKeyNobodyDeclared: 'value',
      adminPasswordHash: 'pbkdf2$600000$aa$bb',
    });
    expect(filtered).toEqual({ businessName: 'Graveklar' });
  });
});

// ── GET /api/admin/app-config ────────────────────────────────────────────────

describe('GET /api/admin/app-config', () => {
  it('masks password- and hidden-type values, and only those with a value set', async () => {
    await seedConfigDefaults({ stripeSecretKey: 'sk_live_SECRET', smtpPass: '', businessName: 'Graveklar AS' });
    await db.appConfig.create({
      data: {
        key: 'adminPasswordHash', value: 'pbkdf2$600000$aa$bb', label: 'Admin-passord (hash)',
        group: 'system', type: 'hidden', isPublic: false, sortOrder: 99,
      },
    });

    const rows: { key: string; value: string; type: string }[] = (await adminGet()).json;
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));

    expect(byKey.stripeSecretKey.value).toBe(PASSWORD_MASK);
    expect(byKey.adminPasswordHash.value).toBe(PASSWORD_MASK);
    expect(byKey.smtpPass.value).toBe('');           // empty stays empty, not masked
    expect(byKey.businessName.value).toBe('Graveklar AS');

    expect(JSON.stringify(rows)).not.toContain('sk_live_SECRET');
    expect(JSON.stringify(rows)).not.toContain('pbkdf2$600000$aa$bb');
  });

  it('re-applies the code metadata over whatever the row stored', async () => {
    await seedConfigDefaults();
    await db.appConfig.update({
      where: { key: 'stripeSecretKey' },
      data: {
        value: 'sk_live_DRIFTED',
        label: 'stale label', group: 'business', type: 'text', isPublic: true, sortOrder: 0,
      },
    });
    invalidateCaches();

    const rows = (await adminGet()).json as { key: string; group: string; isPublic: boolean; type: string }[];
    const row = rows.find((r) => r.key === 'stripeSecretKey')!;
    expect(row.group).toBe('stripe');
    expect(row.type).toBe('password');
    expect(row.isPublic).toBe(false);
    // …and because the code metadata wins here, the value is masked again.
    expect((row as unknown as { value: string }).value).toBe(PASSWORD_MASK);
  });

  it('sorts by group then sortOrder', async () => {
    await seedConfigDefaults();
    const rows = (await adminGet()).json as { group: string; sortOrder: number }[];
    const sorted = [...rows].sort((a, b) => a.group.localeCompare(b.group) || a.sortOrder - b.sortOrder);
    expect(rows.map((r) => `${r.group}/${r.sortOrder}`)).toEqual(sorted.map((r) => `${r.group}/${r.sortOrder}`));
  });
});

// ── POST /api/admin/app-config ───────────────────────────────────────────────

describe('POST /api/admin/app-config — the sensitive-save gate', () => {
  beforeEach(() => seedConfigDefaults());

  it('rejects a well-formed body that is not an array', async () => {
    for (const body of [{}, 42, { key: 'businessName', value: 'x' }]) {
      const res = await adminPost(body);
      expect(res.status).toBe(400);
      expect(res.json.error).toBe('Ugyldig format');
    }
  });

  // FIXED I-3: a body that is not JSON used to be answered 500 "Lagring
  // feilet" — `await request.json()` threw inside the try and the catch-all
  // mapped every failure to a server error, so the admin UI could not tell
  // "your browser sent nonsense" from "the database is down". The body is now
  // parsed before the catch-all, and an unparseable one is a 400.
  it('FIXED I-3: answers 400 for a body that is not JSON', async () => {
    const { POST } = await import('@/app/api/admin/app-config/route');
    const res = await call(POST, {
      method: 'POST',
      path: '/api/admin/app-config',
      body: 'not json at all',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });

  it('saves a non-sensitive key with no second factor', async () => {
    const res = await adminPost([{ key: 'businessName', value: 'Graveklar AS' }]);
    expect(res.status).toBe(200);
    expect(res.json.totpEnforced).toBe(false);
    expect((await db.appConfig.findUniqueOrThrow({ where: { key: 'businessName' } })).value).toBe('Graveklar AS');
  });

  it('refuses a CHANGED sensitive key when 2FA is not enrolled', async () => {
    const res = await adminPost([{ key: 'stripeSecretKey', value: 'sk_test_new' }]);
    expect(res.status).toBe(401);
    expect(res.json).toMatchObject({
      requiresTotp: true,
      requiresTotpEnrollment: true,
      sensitiveKeys: ['stripeSecretKey'],
    });
    expect((await db.appConfig.findUniqueOrThrow({ where: { key: 'stripeSecretKey' } })).value).toBe('');
  });

  it('lets an UNCHANGED sensitive key through — echoing the form back is not a change', async () => {
    await db.appConfig.update({ where: { key: 'stripeSecretKey' }, data: { value: 'sk_test_existing' } });
    invalidateCaches();

    const res = await adminPost([
      { key: 'stripeSecretKey', value: 'sk_test_existing' },
      { key: 'businessName', value: 'Graveklar AS' },
    ]);
    expect(res.status).toBe(200);
    expect(res.json.totpEnforced).toBe(false);
  });

  it('treats a masked echo as no change, and never writes the mask over the secret', async () => {
    await db.appConfig.update({ where: { key: 'stripeSecretKey' }, data: { value: 'sk_test_existing' } });
    invalidateCaches();

    const res = await adminPost([
      { key: 'stripeSecretKey', value: PASSWORD_MASK },
      { key: 'businessName', value: 'Graveklar AS' },
    ]);
    expect(res.status).toBe(200);
    expect(res.json.totpEnforced).toBe(false);
    expect((await db.appConfig.findUniqueOrThrow({ where: { key: 'stripeSecretKey' } })).value).toBe('sk_test_existing');
  });

  it('covers every sensitive group, and no non-sensitive one', async () => {
    // One representative key per group, so a group silently leaving
    // SENSITIVE_GROUPS shows up here rather than in production.
    const sample = new Map<string, string>();
    for (const d of APP_CONFIG_DEFAULTS) if (!sample.has(d.group)) sample.set(d.group, d.key);

    for (const [group, key] of sample) {
      const def = APP_CONFIG_DEFAULTS.find((d) => d.key === key)!;
      const changed = def.type === 'boolean'
        ? (def.value === 'true' ? 'false' : 'true')
        : `${def.value}-endret`;
      const res = await adminPost([{ key, value: changed }]);
      const expected = SENSITIVE_GROUPS.has(group) ? 401 : 200;
      expect({ group, key, status: res.status }).toEqual({ group, key, status: expected });
      await resetDb();
      await seedConfigDefaults();
    }
  }, 30_000);

  it('accepts a changed sensitive key with a valid code and audits it with the secret redacted', async () => {
    await seedTotpSecret();
    const clock = mockClock(FROZEN);
    try {
      const res = await adminPost(
        [{ key: 'stripeSecretKey', value: 'sk_test_brand_new' }],
        totpHeader(await totpCodeFor()),
      );
      expect(res.status).toBe(200);
      expect(res.json.totpEnforced).toBe(true);
    } finally {
      clock.restore();
    }

    expect((await db.appConfig.findUniqueOrThrow({ where: { key: 'stripeSecretKey' } })).value)
      .toBe('sk_test_brand_new');

    const audit = await db.adminAuditLog.findFirstOrThrow({ where: { action: 'config.update' } });
    expect(audit.changes).not.toContain('sk_test_brand_new');
    expect(JSON.parse(audit.changes)).toEqual([
      { key: 'stripeSecretKey', from: null, to: PASSWORD_MASK },
    ]);
  });

  it('refuses an invalid code and leaves every value untouched', async () => {
    await seedTotpSecret();
    const res = await adminPost([{ key: 'stripeSecretKey', value: 'sk_test_x' }], totpHeader('000000'));
    expect(res.status).toBe(401);
    expect(res.json).toMatchObject({ requiresTotp: true, requiresTotpEnrollment: false });
    expect((await db.appConfig.findUniqueOrThrow({ where: { key: 'stripeSecretKey' } })).value).toBe('');
  });

  it('refuses the whole batch when any one key in it is a sensitive change', async () => {
    const res = await adminPost([
      { key: 'businessName', value: 'Graveklar AS' },
      { key: 'maintenanceMode', value: true },
    ]);
    expect(res.status).toBe(401);
    // The harmless key in the same batch is not written either.
    expect((await db.appConfig.findUniqueOrThrow({ where: { key: 'businessName' } })).value).toBe('Graveklar');
  });
});

describe('POST /api/admin/app-config — write normalisation', () => {
  beforeEach(() => seedConfigDefaults());

  it('normalises boolean fields to the literal strings read paths compare against', async () => {
    for (const [input, stored] of [
      [true, 'true'], ['true', 'true'],
      [false, 'false'], ['false', 'false'],
      ['1', 'false'], ['yes', 'false'], ['', 'false'], ['TRUE', 'false'],
    ] as const) {
      const res = await adminPost([{ key: 'logoInHeader', value: input as string | boolean }]);
      expect(res.status).toBe(200);
      const row = await db.appConfig.findUniqueOrThrow({ where: { key: 'logoInHeader' } });
      expect({ input, stored: row.value }).toEqual({ input, stored });
    }
  });

  it('stringifies non-boolean values rather than storing them raw', async () => {
    await adminPost([{ key: 'bookingCount', value: 42 as unknown as string }]);
    expect((await db.appConfig.findUniqueOrThrow({ where: { key: 'bookingCount' } })).value).toBe('42');
  });

  it('creates an unknown key with fail-closed metadata', async () => {
    await adminPost([{ key: 'someBrandNewKey', value: 'x' }]);
    const row = await db.appConfig.findUniqueOrThrow({ where: { key: 'someBrandNewKey' } });
    expect(row.isPublic).toBe(false);
    expect(row.group).toBe('system');
    expect(row.type).toBe('text');
    // …and loadAppConfig prunes it on the next read, because it is not a
    // declared key. Nothing undeclared survives.
    await loadAppConfig();
    expect(await db.appConfig.count({ where: { key: 'someBrandNewKey' } })).toBe(0);
  });

  // FIXED I-2: the mask string was a sentinel with no escape hatch. The write
  // loop skipped ANY update whose value equalled `PASSWORD_MASK`, not just
  // those on a password-type key, so saving a text field whose content happened
  // to be `●●●●●●` was silently discarded while the request still answered 200.
  // The sentinel is now honoured only for the password/hidden types that are
  // actually masked on the way out.
  it('FIXED I-2: saves a text field whose value equals the password mask', async () => {
    const res = await adminPost([{ key: 'businessName', value: PASSWORD_MASK }]);
    expect(res.status).toBe(200);
    expect((await db.appConfig.findUniqueOrThrow({ where: { key: 'businessName' } })).value).toBe(PASSWORD_MASK);
  });
});

describe('POST /api/admin/app-config — baseAddress geocoding', () => {
  beforeEach(() => seedConfigDefaults());

  it('writes the resolved coordinates to SystemState and never to AppConfig', async () => {
    await seedTotpSecret();
    const clock = mockClock(FROZEN);
    try {
      const res = await adminPost(
        [{ key: 'baseAddress', value: '  Eksempelveien   1, 9999 Eksempelby ' }],
        totpHeader(await totpCodeFor()),
      );
      expect(res.status).toBe(200);
      expect(res.json.deliveryOrigin).toEqual({
        displayName: geocodeMock.fixture.displayName,
        lat: geocodeMock.fixture.lat,
        lng: geocodeMock.fixture.lng,
      });
    } finally {
      clock.restore();
    }

    // Derived state lives in SystemState…
    const origin = await getDeliveryOrigin();
    expect(origin).toMatchObject({ lat: geocodeMock.fixture.lat, lng: geocodeMock.fixture.lng });
    expect(origin!.address).toBe('Eksempelveien 1, 9999 Eksempelby'); // whitespace-normalised

    // …and AppConfig holds only the admin's intent. No coordinate key appears.
    const rows = await db.appConfig.findMany();
    for (const row of rows) {
      expect(row.key).not.toMatch(/^(lat|lng|latitude|longitude)$/i);
      expect(row.value).not.toContain(String(geocodeMock.fixture.lat));
    }
    // The stored value is the raw admin input, not the normalised/geocoded one.
    expect((await db.appConfig.findUniqueOrThrow({ where: { key: 'baseAddress' } })).value)
      .toBe('  Eksempelveien   1, 9999 Eksempelby ');
  });

  it('does not re-geocode when the normalised address is unchanged', async () => {
    await seedTotpSecret();
    const clock = mockClock(FROZEN);
    try {
      await adminPost([{ key: 'baseAddress', value: 'Eksempelveien 1' }], totpHeader(await totpCodeFor()));
      clock.advance(30_000);
      const again = await adminPost(
        [{ key: 'baseAddress', value: 'Eksempelveien    1' }],  // same after normalisation
        totpHeader(await totpCodeFor()),
      );
      expect(again.status).toBe(200);
      expect(again.json.deliveryOrigin).toBeUndefined();
    } finally {
      clock.restore();
    }
  });
});

// ── POST /api/admin/app-config/test-email ────────────────────────────────────

describe('POST /api/admin/app-config/test-email', () => {
  it('refuses when no admin address is configured', async () => {
    const originalEnv = process.env.ADMIN_EMAIL;
    try {
      delete process.env.ADMIN_EMAIL;
      await seedConfigDefaults({ adminEmail: '' });
      const res = await testEmail();
      expect(res.status).toBe(400);
      expect(res.json.error).toContain('Admin-e-post');
      expect(emailMock.sent).toHaveLength(0);
    } finally {
      if (originalEnv === undefined) delete process.env.ADMIN_EMAIL;
      else process.env.ADMIN_EMAIL = originalEnv;
    }
  });

  it('routes each whitelisted template to its own sender, always to the admin address', async () => {
    await seedConfigDefaults({ adminEmail: 'drift@example.com', siteUrl: 'https://graveklar.no' });
    const expected: [string, string][] = [
      ['test', 'sendTestEmail'],
      ['new-booking-admin', 'sendNewBookingAdminNotification'],
      ['confirmed', 'sendBookingStatusEmail'],
      ['cancelled', 'sendBookingStatusEmail'],
      ['reminder', 'sendBookingReminderEmail'],
      ['payment-retry', 'sendPaymentRetryEmail'],
    ];
    for (const [template, sender] of expected) {
      emailMock.reset();
      const res = await testEmail(template);
      expect({ template, status: res.status }).toEqual({ template, status: 200 });
      expect(res.json).toEqual({ success: true, template, to: 'drift@example.com' });
      expect(emailMock.sent.map((s) => s.fn)).toEqual([sender]);
    }
  });

  it('falls back to the plain test template for anything off the whitelist', async () => {
    await seedConfigDefaults({ adminEmail: 'drift@example.com' });
    for (const template of ['', 'bogus', 'sendBookingStatusEmail', '../etc/passwd', 'TEST']) {
      emailMock.reset();
      const res = await testEmail(template);
      expect(res.json.template).toBe('test');
      expect(emailMock.sent.map((s) => s.fn)).toEqual(['sendTestEmail']);
    }
  });

  it('reports a sender failure as a 500 with the reason, not a silent success', async () => {
    await seedConfigDefaults({ adminEmail: 'drift@example.com' });
    const email = await import('@/lib/email');
    (email.sendTestEmail as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('SMTP-tilkobling nektet'),
    );
    const res = await testEmail('test');
    expect(res.status).toBe(500);
    expect(res.json.error).toContain('SMTP-tilkobling nektet');
  });
});
