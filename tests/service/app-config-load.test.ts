/**
 * L3 — `loadAppConfig()` end to end against the database.
 *
 * It is not a getter. On every cache miss it self-heals the table: seeds keys
 * the code declares and the DB lacks, deletes rows for keys the code no longer
 * declares (with one deliberate exception), and runs the one-time
 * cancelFreeHours split. Everything downstream — every page, every route, the
 * contract renderer — reads what this function decides, so the seeding,
 * pruning and caching behaviour is load-bearing.
 *
 * The module keeps two pieces of process-local state: a 2-second value cache
 * and a `migrationsApplied` latch. Tests that care about either reset the
 * module registry rather than relying on file ordering.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { APP_CONFIG_DEFAULTS } from '@/lib/app-config-defaults';

import { db, ensureSchema, invalidateCaches, resetDb, seedAppConfigDefaults } from '../helpers/db';
import { mockClock } from '../helpers/mocks';

/** A fresh copy of the module — clean cache, unlatched migrations. */
async function freshAppConfig() {
  vi.resetModules();
  return import('@/lib/app-config');
}

const DEFAULT_KEYS = APP_CONFIG_DEFAULTS.map((d) => d.key);

beforeAll(() => ensureSchema());
beforeEach(() => resetDb());

describe('seeding', () => {
  it('creates every declared key on an empty database', async () => {
    const { loadAppConfig } = await freshAppConfig();
    const values = await loadAppConfig();

    expect(Object.keys(values).sort()).toEqual([...DEFAULT_KEYS].sort());
    expect(await db.appConfig.count()).toBe(APP_CONFIG_DEFAULTS.length);

    // Seeded rows carry the code's metadata, including the `isPublic` flag the
    // anonymous route filters on. `hint` is presentation-only and has no column.
    const row = await db.appConfig.findUniqueOrThrow({ where: { key: 'stripeSecretKey' } });
    expect(row).toMatchObject({ group: 'stripe', type: 'password', isPublic: false });
  });

  it('fills in only the missing keys and never overwrites a stored value', async () => {
    await seedAppConfigDefaults({ businessName: 'Graveklar AS' });
    await db.appConfig.deleteMany({ where: { key: { in: ['siteUrl', 'contactPhone'] } } });
    invalidateCaches();

    const { loadAppConfig } = await freshAppConfig();
    const values = await loadAppConfig();

    expect(values.businessName).toBe('Graveklar AS');
    expect(values.siteUrl).toBe('');
    expect(await db.appConfig.count()).toBe(APP_CONFIG_DEFAULTS.length);
  });
});

describe('pruning', () => {
  it('deletes rows for keys the code no longer declares', async () => {
    await seedAppConfigDefaults({ someRetiredKey: 'old value', anotherOne: 'x' });
    expect(await db.appConfig.count({ where: { key: 'someRetiredKey' } })).toBe(1);

    const { loadAppConfig } = await freshAppConfig();
    const values = await loadAppConfig();

    expect(values.someRetiredKey).toBeUndefined();
    expect(await db.appConfig.count({ where: { key: { in: ['someRetiredKey', 'anotherOne'] } } })).toBe(0);
  });

  it('keeps adminPasswordHash, which is stored here but not declared in the defaults', async () => {
    await seedAppConfigDefaults();
    await db.appConfig.create({
      data: {
        key: 'adminPasswordHash', value: 'pbkdf2$600000$aa$bb', label: 'Admin-passord (hash)',
        group: 'system', type: 'hidden', isPublic: false, sortOrder: 99,
      },
    });

    const { loadAppConfig } = await freshAppConfig();
    const values = await loadAppConfig();

    expect(values.adminPasswordHash).toBe('pbkdf2$600000$aa$bb');
    expect(await db.appConfig.count({ where: { key: 'adminPasswordHash' } })).toBe(1);
  });
});

describe('the cancelFreeHours → weeks + days migration', () => {
  it('splits the legacy value and drops the legacy row', async () => {
    await seedAppConfigDefaults();
    await db.appConfig.deleteMany({ where: { key: { in: ['cancelFreeWeeks', 'cancelFreeDays'] } } });
    await db.appConfig.create({
      data: {
        key: 'cancelFreeHours', value: '192', label: 'Gratis avbestilling (timer)',
        group: 'terms', type: 'number', isPublic: true, sortOrder: 0,
      },
    });

    const { loadAppConfig } = await freshAppConfig();
    const values = await loadAppConfig();

    // 192 h = 1 week (168 h) + 1 day.
    expect(values.cancelFreeWeeks).toBe('1');
    expect(values.cancelFreeDays).toBe('1');
    // The legacy key is not declared, so the same pass prunes it.
    expect(values.cancelFreeHours).toBeUndefined();
    expect(await db.appConfig.count({ where: { key: 'cancelFreeHours' } })).toBe(0);
  });

  it('handles a sub-day legacy value and a non-numeric one', async () => {
    for (const [hours, weeks, days] of [
      ['48', '0', '2'],
      ['0', '0', '0'],
      ['tull', '0', '0'],
      ['336', '2', '0'],
    ] as const) {
      await resetDb();
      await seedAppConfigDefaults();
      await db.appConfig.deleteMany({ where: { key: { in: ['cancelFreeWeeks', 'cancelFreeDays'] } } });
      await db.appConfig.create({
        data: {
          key: 'cancelFreeHours', value: hours, label: 'legacy',
          group: 'terms', type: 'number', isPublic: true, sortOrder: 0,
        },
      });

      const { loadAppConfig } = await freshAppConfig();
      const values = await loadAppConfig();
      expect({ hours, weeks: values.cancelFreeWeeks, days: values.cancelFreeDays })
        .toEqual({ hours, weeks, days });
    }
  });

  it('does not overwrite values the admin has already set', async () => {
    await seedAppConfigDefaults({ cancelFreeWeeks: '3', cancelFreeDays: '4' });
    await db.appConfig.create({
      data: {
        key: 'cancelFreeHours', value: '192', label: 'legacy',
        group: 'terms', type: 'number', isPublic: true, sortOrder: 0,
      },
    });

    const { loadAppConfig } = await freshAppConfig();
    const values = await loadAppConfig();
    expect(values.cancelFreeWeeks).toBe('3');
    expect(values.cancelFreeDays).toBe('4');
  });

  it('is a no-op when the legacy key was never there', async () => {
    await seedAppConfigDefaults({ cancelFreeWeeks: '1', cancelFreeDays: '2' });
    const { loadAppConfig } = await freshAppConfig();
    const values = await loadAppConfig();
    expect(values.cancelFreeWeeks).toBe('1');
    expect(values.cancelFreeDays).toBe('2');
  });
});

describe('caching', () => {
  it('serves from cache for 2 seconds and re-reads after', async () => {
    await seedAppConfigDefaults({ businessName: 'Før' });
    const { loadAppConfig } = await freshAppConfig();

    const clock = mockClock('2026-09-06T12:00:00.000Z');
    try {
      expect((await loadAppConfig()).businessName).toBe('Før');

      // Change the row behind the cache's back.
      await db.appConfig.update({ where: { key: 'businessName' }, data: { value: 'Etter' } });

      clock.advance(1_999);
      expect((await loadAppConfig()).businessName).toBe('Før');

      clock.advance(2);
      expect((await loadAppConfig()).businessName).toBe('Etter');
    } finally {
      clock.restore();
    }
  });

  it('is dropped immediately by invalidateAppConfigCache()', async () => {
    await seedAppConfigDefaults({ businessName: 'Før' });
    const mod = await freshAppConfig();

    const clock = mockClock('2026-09-06T12:00:00.000Z');
    try {
      await mod.loadAppConfig();
      await db.appConfig.update({ where: { key: 'businessName' }, data: { value: 'Etter' } });
      mod.invalidateAppConfigCache();
      expect((await mod.loadAppConfig()).businessName).toBe('Etter');
    } finally {
      clock.restore();
    }
  });

  // FIXED I-5: `loadAppConfig()` used to hand out the cached object itself, so
  // a caller that wrote into the returned map rewrote the cache for every
  // other reader in the process until the 2-second TTL expired.
  // `src/app/page.tsx` did exactly that (`appConfig['bookingCount'] =
  // String(completedCount)`), leaking a homepage-derived value into whatever
  // the admin API, the terms renderer or a PDF read next. The loader now
  // returns a copy on both the hit and the miss path, and page.tsx builds a
  // derived object instead of mutating.
  it('FIXED I-5: a caller mutating the returned map cannot poison the cache', async () => {
    await seedAppConfigDefaults({ bookingCount: '10' });
    const { loadAppConfig } = await freshAppConfig();

    const clock = mockClock('2026-09-06T12:00:00.000Z');
    try {
      const first = await loadAppConfig();
      first.bookingCount = '999';                 // what page.tsx does
      const second = await loadAppConfig();       // any other reader, same tick
      expect(second.bookingCount).toBe('10');
    } finally {
      clock.restore();
    }
  });

  it('hands every caller its own object, on the cache-hit path as well as the miss', async () => {
    // Rewritten for FIXED I-5. Two readers inside one TTL window must not
    // share an identity: the first read fills the cache, the second is served
    // from it, and neither may be the cached object itself.
    await seedAppConfigDefaults({ bookingCount: '10' });
    const { loadAppConfig } = await freshAppConfig();

    const clock = mockClock('2026-09-06T12:00:00.000Z');
    try {
      const miss = await loadAppConfig();
      const hit = await loadAppConfig();
      expect(hit).not.toBe(miss);
      expect(hit).toEqual(miss);

      miss.bookingCount = '999';
      hit.businessName = 'Poisoned';
      const third = await loadAppConfig();
      expect(third.bookingCount).toBe('10');
      expect(third.businessName).not.toBe('Poisoned');

      // …and the value on disk is still what a post-TTL read returns.
      clock.advance(2_001);
      expect((await loadAppConfig()).bookingCount).toBe('10');
    } finally {
      clock.restore();
    }
  });
});

describe('concurrency', () => {
  it('survives parallel first-loads on an empty table without duplicate rows', async () => {
    const { loadAppConfig } = await freshAppConfig();
    const results = await Promise.all([loadAppConfig(), loadAppConfig(), loadAppConfig()]);
    for (const values of results) {
      expect(Object.keys(values).sort()).toEqual([...DEFAULT_KEYS].sort());
    }
    expect(await db.appConfig.count()).toBe(APP_CONFIG_DEFAULTS.length);
  });
});
