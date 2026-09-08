/**
 * Database harness — schema provisioning, truncation, isolated clients and
 * typed factories for the scratch SQLite database created by tests/setup.ts.
 *
 * Nothing here can reach the live database: every path is derived from
 * TEST_DB_DIR and re-checked by `assertScratchDatabase`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient, type Prisma } from '@prisma/client';

import {
  REPO_ROOT,
  TEST_DB_DIR,
  TEST_DB_FILE,
  WORKER_KEY,
  assertScratchDatabase,
} from '../setup';
import { buildTemplate as buildTemplateWith, prepareWorkerDb, removeSqliteSidecars } from './db-prepare';

import { db } from '@/lib/db';
import { APP_CONFIG_DEFAULTS } from '@/lib/app-config-defaults';
import { DEFAULT_CONFIGS } from '@/lib/config-defaults';
import { invalidateAppConfigCache } from '@/lib/app-config';
import { invalidateConfigCache } from '@/lib/config-server';
import { dateToDbMidnight, getRentalDateRange } from '@/lib/availability';
import { toDateStr } from '@/lib/dates';
import type { RentalType } from '@/lib/pricing';

export { db };


/**
 * Tables in FK-safe deletion order (children before parents). Kept explicit
 * rather than derived so truncation never depends on a per-connection
 * `PRAGMA foreign_keys` that Prisma's pool may not honour. Any table present
 * in the database but missing from this list is deleted afterwards, and
 * tests/harness.smoke.test.ts asserts the list stays complete.
 */
export const TRUNCATE_ORDER = [
  'ChecklistSubmission',
  'ChecklistItem',
  'CampaignRedemption',
  'ReferralRedemption',
  'AcceptedContract',
  'Review',
  'MachineDocument',
  'BookingDateLock',
  'RepeatDiscountCode',
  'Booking',
  'QuoteRequest',
  'ChecklistPhase',
  'CampaignDiscountCode',
  'ReferralCode',
  'Machine',
  'UnavailableDate',
  'PricingConfig',
  'AppConfig',
  'TermsSection',
  'FaqItem',
  'InsuranceCard',
  'SystemState',
  'WebhookEvent',
  'SurveyResponse',
  'SurveyQuestion',
  'AdminTotp',
  'AdminAuditLog',
] as const;

// ── Schema provisioning ──────────────────────────────────────────────────────
//
// The worker database is provisioned SYNCHRONOUSLY in tests/setup.ts, before
// any test module (and therefore src/lib/db.ts) is imported — see
// tests/helpers/db-prepare.ts for why. Nothing in this module may disconnect
// the app's shared client or copy a file over the database it has open: that
// raced the fire-and-forget PRAGMAs in src/lib/db.ts and failed a random test
// file per full-suite run (audit finding H-1).

const PREPARE_OPTS = {
  repoRoot: REPO_ROOT,
  testDbDir: TEST_DB_DIR,
  testDbFile: TEST_DB_FILE,
  assertScratchDatabase,
};

function buildTemplate(): string {
  return buildTemplateWith(PREPARE_OPTS);
}

/**
 * Make sure this worker's database carries the current schema. Normally a
 * no-op — setup.ts already did the work — and kept as the safety net for a
 * worker file that vanished mid-run. Never touches an open connection.
 */
export async function ensureSchema(): Promise<void> {
  prepareWorkerDb(PREPARE_OPTS);
}

// ── Truncation ───────────────────────────────────────────────────────────────

async function tableNames(client: PrismaClient): Promise<string[]> {
  const rows = await client.$queryRawUnsafe<{ name: string }[]>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'`,
  );
  return rows.map((r) => r.name);
}

/**
 * Empty every table. Deletes in FK-safe order, so it works whether or not the
 * connection has foreign keys enforced. This is a scratch database — raw
 * DELETE is deliberate.
 */
export async function resetDb(client: PrismaClient = db): Promise<void> {
  await ensureSchema();
  const present = new Set(await tableNames(client));

  // No PRAGMA foreign_keys toggling here: the pragma is per connection and
  // Prisma pools connections, so an OFF and its closing ON need not land on
  // the same one — which left random connections with cascades disabled for
  // the rest of the worker's life (audit finding U-6). TRUNCATE_ORDER deletes
  // children before parents precisely so no toggle is needed.
  for (const table of TRUNCATE_ORDER) {
    if (!present.delete(table)) continue;
    await client.$executeRawUnsafe(`DELETE FROM "${table}"`);
  }
  // Anything the order list doesn't know about (a new model added to the
  // schema without updating TRUNCATE_ORDER).
  for (const table of present) {
    await client.$executeRawUnsafe(`DELETE FROM "${table}"`);
  }

  invalidateCaches();
}

/** Drop the app's in-memory config caches so the next read hits the DB. */
export function invalidateCaches(): void {
  invalidateAppConfigCache();
  invalidateConfigCache();
}

// ── Isolated clients ─────────────────────────────────────────────────────────

let freshCounter = 0;

export interface FreshDb {
  client: PrismaClient;
  file: string;
  url: string;
  dispose: () => Promise<void>;
}

/**
 * A PrismaClient on its own brand-new database file. For concurrency tests
 * that need two writers that genuinely cannot see each other's data, or that
 * want to provoke SQLITE_BUSY without disturbing the worker database.
 */
export async function freshDb(): Promise<FreshDb> {
  const template = buildTemplate();
  const file = path.join(
    TEST_DB_DIR,
    `fresh-${WORKER_KEY}-${process.pid}-${Date.now()}-${++freshCounter}.db`,
  );
  const url = `file:${file}`;
  assertScratchDatabase(url);

  removeSqliteSidecars(file);
  fs.copyFileSync(template, file);

  const client = new PrismaClient({ datasourceUrl: url, log: ['error'] });
  await client.$queryRawUnsafe('PRAGMA busy_timeout = 5000').catch(() => {});

  return {
    client,
    file,
    url,
    dispose: async () => {
      await client.$disconnect().catch(() => {});
      removeSqliteSidecars(file);
      fs.rmSync(file, { force: true });
    },
  };
}

/**
 * Two clients pointed at the SAME file — the shape a concurrency test needs
 * when it wants real write-lock contention rather than isolation.
 */
export async function sharedDbClient(): Promise<{ client: PrismaClient; dispose: () => Promise<void> }> {
  await ensureSchema();
  const url = `file:${TEST_DB_FILE}`;
  assertScratchDatabase(url);
  const client = new PrismaClient({ datasourceUrl: url, log: ['error'] });
  await client.$queryRawUnsafe('PRAGMA busy_timeout = 5000').catch(() => {});
  return { client, dispose: async () => { await client.$disconnect().catch(() => {}); } };
}

// ── Seeds ────────────────────────────────────────────────────────────────────

/** Write src/lib/config-defaults.ts DEFAULT_CONFIGS into PricingConfig. */
export async function seedPricingDefaults(client: PrismaClient = db): Promise<void> {
  await ensureSchema();
  await client.pricingConfig.createMany({
    data: DEFAULT_CONFIGS.map((c) => ({
      key: c.key,
      value: c.value,
      label: c.label,
      group: c.group,
    })),
  });
  invalidateCaches();
}

/**
 * Write APP_CONFIG_DEFAULTS into AppConfig. `hint` is presentation-only
 * metadata on AppConfigItem with no matching column — the same strip
 * `loadAppConfig()` does when it self-seeds.
 *
 * `overrides` is a key → value map applied on top (unknown keys are inserted
 * with sensible metadata so tests can seed keys the defaults don't carry).
 */
export async function seedAppConfigDefaults(
  overrides: Record<string, string> = {},
  client: PrismaClient = db,
): Promise<void> {
  await ensureSchema();
  const rows = APP_CONFIG_DEFAULTS.map(({ hint: _hint, ...row }) => ({
    ...row,
    value: overrides[row.key] ?? row.value,
  }));
  const known = new Set(rows.map((r) => r.key));
  for (const [key, value] of Object.entries(overrides)) {
    if (known.has(key)) continue;
    rows.push({ key, value, label: key, group: 'system', type: 'text', isPublic: false, sortOrder: 99 });
  }
  await client.appConfig.createMany({ data: rows });
  invalidateCaches();
}

/** Both config tables at once — the usual precondition for a route test. */
export async function seedConfigDefaults(
  overrides: Record<string, string> = {},
  client: PrismaClient = db,
): Promise<void> {
  await seedPricingDefaults(client);
  await seedAppConfigDefaults(overrides, client);
}

// ── Factories ────────────────────────────────────────────────────────────────

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(++seq).toString(36)}${WORKER_KEY}`;

export type MachineOverrides = Partial<Prisma.MachineUncheckedCreateInput>;

export async function machine(
  overrides: MachineOverrides = {},
  client: PrismaClient = db,
) {
  await ensureSchema();
  return client.machine.create({
    data: {
      name: 'Testgraver 1,8 t',
      category: 'minigraver',
      model: 'TB216',
      year: '2024',
      description: 'Testmaskin opprettet av testharnesset.',
      isActive: true,
      sortOrder: 0,
      quantity: 1,
      ...overrides,
    },
  });
}

// Same alphabet and shape as booking-service.ts generateBookingReference so
// anything that parses or displays a reference sees a realistic value.
const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function refSuffix(): string {
  return Array.from(crypto.randomBytes(5), (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('');
}

export function bookingReference(n = ++seq): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  return `GK-${yy}${mm}-${String(n).padStart(3, '0')}-${refSuffix()}`;
}

export type BookingStatus = 'pending' | 'confirmed' | 'cancelled' | 'completed';

export interface BookingOverrides extends Partial<Prisma.BookingUncheckedCreateInput> {
  /** Start date as YYYY-MM-DD; stored as Oslo local midnight. Wins over `startDate`. */
  startDateStr?: string;
  /** Skip BookingDateLock creation. Locks are created by default, as
   *  booking-service.createPendingBooking does. */
  skipLocks?: boolean;
}

/** Tomorrow, as YYYY-MM-DD in the (Oslo) local calendar. */
export function tomorrowStr(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return toDateStr(d);
}

/**
 * A valid Booking plus its BookingDateLock rows — the same shape
 * `createPendingBooking` commits, minus payment side effects.
 *
 * A machine is created on demand when neither `machineId` nor an existing
 * machine is available, because the date locks are per-machine.
 */
export async function booking(
  status: BookingStatus = 'pending',
  overrides: BookingOverrides = {},
  client: PrismaClient = db,
) {
  await ensureSchema();
  const { startDateStr, skipLocks, ...rest } = overrides;

  let machineId = rest.machineId ?? null;
  if (!machineId) {
    const existing = await client.machine.findFirst({ orderBy: { createdAt: 'asc' } });
    machineId = existing?.id ?? (await machine({}, client)).id;
  }

  const dateStr = startDateStr ?? tomorrowStr();
  const rentalType = (rest.rentalType as RentalType) ?? 'day';
  const customDays = (rest.customDays as number | null | undefined) ?? null;

  const created = await client.booking.create({
    data: {
      reference: bookingReference(),
      name: 'Test Testesen',
      phone: '+4740000000',
      email: 'test@example.com',
      deliveryAddress: 'Testveien 1, 8000 Bodø',
      selfPickup: false,
      rentalType,
      startDate: dateToDbMidnight(dateStr),
      customDays,
      deliveryDistance: 12.5,
      deliveryFee: 0,
      basePrice: 2490,
      totalPrice: 2490,
      includedHours: 10,
      extraHours: 0,
      extraHoursCost: 0,
      totalHours: 10,
      status,
      customerType: 'consumer',
      termsAcceptedAt: new Date(),
      machineId,
      ...rest,
    },
  });

  if (!skipLocks) {
    const range = getRentalDateRange(dateStr, rentalType, customDays);
    await client.bookingDateLock.createMany({
      data: range.map((d) => ({
        bookingId: created.id,
        machineId: machineId!,
        date: dateToDbMidnight(d),
        slot: 0,
      })),
    });
  }

  return created;
}

export type CampaignCodeOverrides = Partial<Prisma.CampaignDiscountCodeUncheckedCreateInput>;

export async function campaignCode(
  overrides: CampaignCodeOverrides = {},
  client: PrismaClient = db,
) {
  await ensureSchema();
  return client.campaignDiscountCode.create({
    data: {
      code: `KAMPANJE-${uniq().toUpperCase()}`,
      percent: 10,
      maxUses: null,
      usedCount: 0,
      isActive: true,
      ...overrides,
    },
  });
}

export type RepeatCodeOverrides = Partial<Prisma.RepeatDiscountCodeUncheckedCreateInput>;

export async function repeatCode(
  overrides: RepeatCodeOverrides = {},
  client: PrismaClient = db,
) {
  await ensureSchema();
  return client.repeatDiscountCode.create({
    data: {
      code: `RETUR-${uniq().toUpperCase()}`,
      email: 'test@example.com',
      ...overrides,
    },
  });
}

export interface ChecklistItemSeed extends Partial<Prisma.ChecklistItemUncheckedCreateInput> {
  label: string;
}

export interface ChecklistPhaseOverrides
  extends Omit<Partial<Prisma.ChecklistPhaseUncheckedCreateInput>, 'items'> {
  /** Items to create in the phase. Two default items when omitted. */
  items?: ChecklistItemSeed[];
}

export async function checklistPhase(
  overrides: ChecklistPhaseOverrides = {},
  client: PrismaClient = db,
) {
  await ensureSchema();
  const { items, ...rest } = overrides;
  const phase = await client.checklistPhase.create({
    data: {
      name: 'Levering',
      sortOrder: 0,
      isActive: true,
      appliesTo: 'all',
      isCompletionTrigger: false,
      audience: 'operator',
      intervalMode: 'once',
      ...rest,
    },
  });

  const seeds: ChecklistItemSeed[] = items ?? [
    { label: 'Maskinen er rengjort' },
    { label: 'Timeteller avlest', answerType: 'measurement', unit: 't', statKey: 'timeteller' },
  ];
  await client.checklistItem.createMany({
    data: seeds.map((item, i) => ({
      phaseId: phase.id,
      answerType: 'checkbox',
      sortOrder: i,
      isActive: true,
      ...item,
    })),
  });

  return client.checklistPhase.findUniqueOrThrow({
    where: { id: phase.id },
    include: { items: { orderBy: { sortOrder: 'asc' } } },
  });
}

/** Block a single calendar day (YYYY-MM-DD). Stored as local midnight. */
export async function unavailableDate(
  dateStr: string,
  reason = 'Testblokkering',
  client: PrismaClient = db,
) {
  await ensureSchema();
  return client.unavailableDate.create({
    data: { date: dateToDbMidnight(dateStr), reason },
  });
}
