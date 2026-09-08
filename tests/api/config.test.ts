import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, DEFAULT_CONFIGS } from '@/lib/config-defaults';

import { db, ensureSchema, invalidateCaches, resetDb, seedConfigDefaults } from '../helpers/db';
import { adminCookieJar, call, matcherMatches, proxyCall } from '../helpers/route';

// L2 — /api/config. GET is the public pricing feed the booking form reads;
// POST is the revenue-affecting save, gated by the proxy (admin session) and
// then by TOTP inside the handler.

let GET: typeof import('@/app/api/config/route').GET;
let POST: typeof import('@/app/api/config/route').POST;

beforeAll(async () => {
  await ensureSchema();
  ({ GET, POST } = await import('@/app/api/config/route'));
});

beforeEach(async () => {
  await resetDb();
  await seedConfigDefaults();
});

describe('GET /api/config', () => {
  it('returns the stored rows and the merged values map', async () => {
    const res = await call(GET, { path: '/api/config' });
    expect(res.status).toBe(200);
    expect(res.json.values.weekdayHourly).toBe(249);
    expect(res.json.values.mvaRate).toBe(25);
    expect(res.json.values.pricesIncludeMva).toBe(1);
    expect(res.json.configs).toHaveLength(DEFAULT_CONFIGS.length);
    expect(Object.keys(res.json.values).sort()).toEqual(Object.keys(DEFAULT_CONFIG).sort());
  });

  it('self-seeds a missing PricingConfig row rather than reporting a hole', async () => {
    await db.pricingConfig.delete({ where: { key: 'overtimeRate' } });
    invalidateCaches();
    const res = await call(GET, { path: '/api/config' });
    expect(res.json.values.overtimeRate).toBe(199);
    expect(await db.pricingConfig.count({ where: { key: 'overtimeRate' } })).toBe(1);
  });

  it('drops a stale key that is no longer in DEFAULT_CONFIGS', async () => {
    await db.pricingConfig.create({
      data: { key: 'legacyDayPrice', value: 1, label: 'legacy', group: 'rental' },
    });
    invalidateCaches();
    const res = await call(GET, { path: '/api/config' });
    expect(res.json.configs.map((c: { key: string }) => c.key)).not.toContain('legacyDayPrice');
    expect(await db.pricingConfig.count({ where: { key: 'legacyDayPrice' } })).toBe(0);
  });

  it('reflects an admin price change on the next read', async () => {
    await db.pricingConfig.update({ where: { key: 'weekdayHourly' }, data: { value: 299 } });
    invalidateCaches();
    const res = await call(GET, { path: '/api/config' });
    expect(res.json.values.weekdayHourly).toBe(299);
  });

  // FLAG F-12 (documented, not a defect to fix blindly): src/proxy.ts only
  // demands an admin session for `/api/config` when the method is POST, so the
  // whole price list — including maxDeliveryRadius and the MVA settings — is
  // readable by anyone. That is the same data the public booking form needs.
  it('is public: the proxy lets an unauthenticated GET through (flag F-12)', async () => {
    expect(matcherMatches('/api/config')).toBe(true);
    const res = await proxyCall('/api/config', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });
});

describe('POST /api/config — proxy gate', () => {
  it('401s an unauthenticated POST before the handler runs', async () => {
    const res = await proxyCall('/api/config', { method: 'POST' });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('lets a POST with a valid admin session reach the handler', async () => {
    const res = await proxyCall('/api/config', { method: 'POST', cookies: await adminCookieJar() });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });
});

describe('POST /api/config — handler', () => {
  it('400s when `configs` is missing or not an array — before the TOTP gate', async () => {
    for (const body of [{}, { configs: null }, { configs: 'weekdayHourly=300' }, { configs: { weekdayHourly: 300 } }]) {
      const res = await call(POST, { method: 'POST', path: '/api/config', body });
      expect(res.status).toBe(400);
      expect(res.json).toEqual({ error: 'configs array is required' });
    }
  });

  it('401s with requiresTotp AND requiresTotpEnrollment when 2FA is not enrolled', async () => {
    expect(await db.adminTotp.count()).toBe(0);
    const res = await call(POST, {
      method: 'POST',
      path: '/api/config',
      body: { configs: [{ key: 'weekdayHourly', value: 999 }] },
    });
    expect(res.status).toBe(401);
    expect(res.json).toEqual({
      error: 'Aktivér 2FA før du endrer priser.',
      requiresTotp: true,
      requiresTotpEnrollment: true,
    });
  });

  it('writes nothing and logs nothing when the TOTP gate refuses', async () => {
    await call(POST, {
      method: 'POST',
      path: '/api/config',
      body: { configs: [{ key: 'weekdayHourly', value: 999 }] },
    });
    const row = await db.pricingConfig.findUniqueOrThrow({ where: { key: 'weekdayHourly' } });
    expect(row.value).toBe(249);
    expect(await db.adminAuditLog.count()).toBe(0);
  });

  it('a supplied but unverifiable TOTP header still fails on enrolment first', async () => {
    const res = await call(POST, {
      method: 'POST',
      path: '/api/config',
      body: { configs: [{ key: 'weekdayHourly', value: 999 }] },
      headers: { 'x-admin-totp': '123456' },
    });
    expect(res.status).toBe(401);
    expect(res.json.requiresTotpEnrollment).toBe(true);
  });

  it('an empty configs array is accepted by the shape check and stopped by TOTP', async () => {
    const res = await call(POST, { method: 'POST', path: '/api/config', body: { configs: [] } });
    expect(res.status).toBe(401);
    expect(res.json.requiresTotp).toBe(true);
  });

  it('500s on an unparseable body rather than leaking the parse error', async () => {
    const res = await call(POST, {
      method: 'POST',
      path: '/api/config',
      body: '{ not json',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(500);
    expect(res.json).toEqual({ error: 'Kunne ikke lagre innstillinger' });
  });
});
