/**
 * Proves the Phase 0 harness works end to end: the database guard, schema
 * provisioning, the factories, the route caller, the proxy caller, the Stripe
 * signature helper and per-test database isolation.
 *
 * If this file fails, no other DB-touching test can be trusted.
 */
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  LIVE_DB_FILE,
  REPO_ROOT,
  TEST_DB_DIR,
  TEST_DB_FILE,
  WORKER_DIR,
  assertScratchDatabase,
  envFileDatabaseUrl,
  prismaUrlToPath,
} from './setup';
import {
  TRUNCATE_ORDER,
  booking,
  campaignCode,
  checklistPhase,
  db,
  ensureSchema,
  freshDb,
  machine,
  repeatCode,
  resetDb,
  seedAppConfigDefaults,
  seedPricingDefaults,
  unavailableDate,
} from './helpers/db';
import { adminCookieJar, call, matcherMatches, proxyCall, renterBearer, totpHeader } from './helpers/route';
import { extractBearerToken, verifyRenterSessionToken } from '@/lib/renter-checklist-session';
import { signedEvent, stripeEventPayload, stripeMock } from './helpers/mocks';
import { PASSWORD_MASK } from '@/lib/app-config';
import { getUploadDir } from '@/lib/upload-store';
import { verifyStripeWebhook } from '@/lib/stripe';
import { toDateStr } from '@/lib/dates';

const WEBHOOK_SECRET = 'whsec_harness_smoke';

/** Next occurrence of `weekday` (1 = Monday) strictly in the future. */
function nextWeekday(weekday: number): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  do {
    d.setDate(d.getDate() + 1);
  } while (((d.getDay() + 6) % 7) + 1 !== weekday);
  return toDateStr(d);
}

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDb();
});

describe('database guard', () => {
  it('points DATABASE_URL at this worker’s scratch file', () => {
    expect(process.env.GRAVEKLAR_TEST_DB).toBe('1');
    const file = prismaUrlToPath(process.env.DATABASE_URL ?? '');
    expect(file).toBe(TEST_DB_FILE);
    expect(path.relative(TEST_DB_DIR, file).startsWith('..')).toBe(false);
  });

  it('keeps this worker’s uploads directory out of every other worker’s', () => {
    // `getUploadDir()` resolves to `<dir holding the database>/uploads`, so a
    // flat scratch layout gave all workers one shared directory. The three
    // upload-touching files then deleted each other's files mid-run — ENOENT,
    // ENOTEMPTY, and assertions reading a neighbour's uploads. Nesting the
    // database one directory deeper is what keeps them apart, and it is
    // invisible from those tests, so assert it here.
    const uploadDir = getUploadDir();
    expect(uploadDir).toBe(path.join(WORKER_DIR, 'uploads'));
    expect(path.dirname(uploadDir)).not.toBe(TEST_DB_DIR);
    expect(path.relative(WORKER_DIR, uploadDir).startsWith('..')).toBe(false);
  });

  it('is nowhere near the repository or the live database', () => {
    const file = prismaUrlToPath(process.env.DATABASE_URL ?? '');
    expect(file).not.toBe(LIVE_DB_FILE);
    expect(path.relative(REPO_ROOT, file).startsWith('..')).toBe(true);
  });

  it('refuses any database that is not a scratch file', () => {
    expect(() => assertScratchDatabase(`file:${LIVE_DB_FILE}`)).toThrow(/refusing to run/);
    expect(() => assertScratchDatabase('file:./prisma/db/custom.db')).toThrow(/refusing to run/);
    expect(() => assertScratchDatabase(envFileDatabaseUrl() ?? 'file:/nope.db')).toThrow(/refusing to run/);
    expect(() => assertScratchDatabase('file:')).toThrow(/empty or unparseable/);
    // …and accepts the one it created.
    expect(() => assertScratchDatabase(`file:${TEST_DB_FILE}`)).not.toThrow();
  });

  it('stubs the deterministic test secrets and timezone', () => {
    expect(process.env.ADMIN_PASSWORD).toBe('Testadmin-2026!');
    expect(process.env.ADMIN_SESSION_SECRET).toBeTruthy();
    expect(process.env.RENTER_SESSION_SECRET).toBeTruthy();
    expect(process.env.CRON_SECRET).toBeTruthy();
    expect(process.env.TZ).toBe('Europe/Oslo');
  });
});

describe('schema + truncation', () => {
  it('knows every table in the schema', async () => {
    const rows = await db.$queryRawUnsafe<{ name: string }[]>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'`,
    );
    const missing = rows.map((r) => r.name).filter((n) => !TRUNCATE_ORDER.includes(n as never));
    expect(missing, 'add new models to TRUNCATE_ORDER in tests/helpers/db.ts').toEqual([]);
  });

  it('leaves every table empty after resetDb()', async () => {
    await machine();
    await resetDb();
    expect(await db.machine.count()).toBe(0);
    expect(await db.booking.count()).toBe(0);
    expect(await db.appConfig.count()).toBe(0);
  });
});

describe('factories', () => {
  it('seeds pricing defaults and reads them back', async () => {
    await seedPricingDefaults();
    const row = await db.pricingConfig.findUnique({ where: { key: 'weekdayHourly' } });
    expect(row?.value).toBe(249);
    expect(await db.pricingConfig.count()).toBeGreaterThan(10);
  });

  it('creates a machine, a pending booking and its date locks', async () => {
    const m = await machine({ name: 'Kubota U17-3' });
    const b = await booking('pending', { machineId: m.id, rentalType: 'weekend', startDateStr: '2026-10-02' });

    const stored = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(stored.status).toBe('pending');
    expect(stored.reference).toMatch(/^GK-\d{4}-\d{3}-[A-Z2-9]{5}$/);
    expect(stored.rentalType).toBe('weekend');
    // Oslo local midnight, not UTC midnight.
    expect(stored.startDate.getHours()).toBe(0);
    expect(toDateStr(stored.startDate)).toBe('2026-10-02');

    const locks = await db.bookingDateLock.findMany({ where: { bookingId: b.id } });
    expect(locks).toHaveLength(3); // weekend = 3 days
    expect(locks.every((l) => l.machineId === m.id)).toBe(true);
  });

  it('creates discount codes, a checklist phase with items and a blocked day', async () => {
    const campaign = await campaignCode({ percent: 15, maxUses: 5 });
    expect(campaign.percent).toBe(15);
    expect(await db.campaignDiscountCode.count()).toBe(1);

    const repeat = await repeatCode({ email: 'retur@example.com' });
    expect(repeat.code).toMatch(/^RETUR-/);
    expect(repeat.redeemedByBookingId).toBeNull();

    const phase = await checklistPhase({
      name: 'Retur',
      isCompletionTrigger: true,
      items: [{ label: 'Tank fylt' }, { label: 'Nøkkel levert' }, { label: 'Skader?', answerType: 'yesno' }],
    });
    expect(phase.isCompletionTrigger).toBe(true);
    expect(phase.items.map((i) => i.label)).toEqual(['Tank fylt', 'Nøkkel levert', 'Skader?']);

    await unavailableDate('2026-12-24', 'Julaften');
    const blocked = await db.unavailableDate.findFirstOrThrow();
    expect(toDateStr(blocked.date)).toBe('2026-12-24');
    expect(blocked.date.getHours()).toBe(0);
  });
});

describe('route caller', () => {
  it('prices a real quote through POST /api/quote', async () => {
    await seedPricingDefaults();
    await seedAppConfigDefaults();
    await machine();

    const { POST } = await import('@/app/api/quote/route');
    const res = await call(POST, {
      method: 'POST',
      path: '/api/quote',
      body: { rentalType: 'week', startDate: nextWeekday(1), selfPickup: true },
    });

    expect(res.status).toBe(200);
    expect(res.json.totalPrice).toBeGreaterThan(0);
    expect(res.json.bookable).toBe(true);
  });

  it('masks password fields on GET /api/admin/app-config', async () => {
    await seedAppConfigDefaults({
      stripeSecretKey: 'sk_test_harness',
      stripeWebhookSecret: WEBHOOK_SECRET,
      smtpPassword: 'hunter2',
    });

    const { GET } = await import('@/app/api/admin/app-config/route');
    const res = await call(GET, { path: '/api/admin/app-config' });

    expect(res.status).toBe(200);
    const rows = res.json as { key: string; value: string; type: string }[];
    const secret = rows.find((r) => r.key === 'stripeSecretKey');
    expect(secret?.type).toBe('password');
    expect(secret?.value).toBe(PASSWORD_MASK);
    expect(rows.some((r) => r.value === 'sk_test_harness')).toBe(false);
  });

  it('mints a renter bearer token that the product verifies', async () => {
    const header = await renterBearer('bk_test_1', '+4740000000');
    const payload = await verifyRenterSessionToken(extractBearerToken(header));
    expect(payload).toMatchObject({ bookingId: 'bk_test_1', phone: '+4740000000' });
    expect(totpHeader('123456')).toEqual({ 'x-admin-totp': '123456' });
  });
});

describe('proxy caller', () => {
  it('401s an admin API request with no session cookie', async () => {
    const res = await proxyCall('/api/admin/app-config');
    expect(res.status).toBe(401);
    await expect(res.clone().json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('passes through with a real admin session cookie', async () => {
    const res = await proxyCall('/api/admin/app-config', { cookies: await adminCookieJar() });
    expect(res.status).not.toBe(401);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('reproduces the exported matcher', () => {
    expect(matcherMatches('/admin')).toBe(true);
    expect(matcherMatches('/admin/bookinger')).toBe(true);
    expect(matcherMatches('/api/admin/app-config')).toBe(true);
    expect(matcherMatches('/api/bookings')).toBe(true);
    expect(matcherMatches('/api/bookings/abc123')).toBe(true);
    expect(matcherMatches('/api/quote')).toBe(false);
    expect(matcherMatches('/api/config/extra')).toBe(false);
  });
});

describe('stripe signatures', () => {
  it('signedEvent() verifies against the real verifyStripeWebhook', async () => {
    await seedAppConfigDefaults({
      stripeEnabled: 'true',
      stripeSecretKey: 'sk_test_harness',
      stripeWebhookSecret: WEBHOOK_SECRET,
    });

    const payload = stripeEventPayload('checkout.session.completed', {
      id: 'cs_test_harness',
      metadata: { bookingId: 'bk_test' },
    });
    const event = await verifyStripeWebhook(payload, signedEvent(payload, WEBHOOK_SECRET));

    expect(event?.type).toBe('checkout.session.completed');
    expect((event?.data.object as { id: string }).id).toBe('cs_test_harness');
    // Importing helpers/mocks must NOT mock anything on its own — if a
    // `vi.mock` ever leaks back into that module, vitest hoists it into every
    // importer and this file would silently be running against a fake Stripe.
    expect(stripeMock.calls).toEqual([]);
  });

  it('rejects a payload signed with the wrong secret', async () => {
    await seedAppConfigDefaults({
      stripeEnabled: 'true',
      stripeSecretKey: 'sk_test_harness',
      stripeWebhookSecret: WEBHOOK_SECRET,
    });
    const payload = stripeEventPayload('checkout.session.completed', { id: 'cs_test_harness' });
    expect(await verifyStripeWebhook(payload, signedEvent(payload, 'whsec_wrong'))).toBeNull();
  });
});

describe('freshDb isolation', () => {
  it('gives two independent databases', async () => {
    const a = await freshDb();
    const b = await freshDb();
    try {
      expect(a.file).not.toBe(b.file);

      await a.client.machine.create({ data: { name: 'A', model: 'A' } });
      await b.client.machine.create({ data: { name: 'B1', model: 'B' } });
      await b.client.machine.create({ data: { name: 'B2', model: 'B' } });

      expect(await a.client.machine.count()).toBe(1);
      expect(await b.client.machine.count()).toBe(2);
      // …and neither leaks into the worker database.
      expect(await db.machine.count()).toBe(0);
    } finally {
      await a.dispose();
      await b.dispose();
    }
  });
});
