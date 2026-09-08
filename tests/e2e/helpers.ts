/**
 * Shared plumbing for the L4 browser tests (audit phase 2a — customer surface).
 *
 * These tests drive a REAL browser against the running scratch instance
 * (`AUDIT_BASE_URL`, normally http://localhost:3001) and assert against both
 * the DOM and that instance's own SQLite file (`AUDIT_DB_FILE`).
 *
 * They deliberately do NOT import `tests/helpers/db.ts`: that module opens the
 * per-vitest-worker scratch database, which is a different file from the one
 * the running instance is serving. Everything here talks to the instance's DB
 * through `node:sqlite` instead, read-mostly, and cleans up its own rows.
 *
 * Never point AUDIT_DB_FILE at prisma/prisma/db/custom.db — `openAuditDb()`
 * refuses it.
 */
import { createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

export const CHROMIUM = process.env.AUDIT_CHROMIUM ?? '/usr/bin/chromium';
export const BASE_URL = (process.env.AUDIT_BASE_URL ?? '').replace(/\/+$/, '');
export const DB_FILE = process.env.AUDIT_DB_FILE ?? '';

/** Both env vars must be present for the e2e suite to mean anything. */
export const E2E_READY = Boolean(BASE_URL && DB_FILE);

/** Webhook secret these tests install into the instance's AppConfig. */
export const TEST_WEBHOOK_SECRET = 'whsec_audit_test_secret';

/** loadAppConfig() caches for 2 s; wait it out after writing AppConfig. */
export const CONFIG_CACHE_MS = 2500;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── database ────────────────────────────────────────────────────────────────

const LIVE_DB = path.resolve(process.cwd(), 'prisma', 'prisma', 'db', 'custom.db');

export function openAuditDb(): DatabaseSync {
  if (!DB_FILE) throw new Error('AUDIT_DB_FILE is not set');
  const resolved = path.resolve(DB_FILE);
  if (resolved === LIVE_DB) throw new Error(`refusing to open the live database: ${resolved}`);
  if (resolved.startsWith(path.resolve(process.cwd()) + path.sep)) {
    throw new Error(`refusing to open a database inside the repository: ${resolved}`);
  }
  return new DatabaseSync(resolved);
}

/** Run `fn` with a short-lived handle on the instance's database. */
export function withDb<T>(fn: (db: DatabaseSync) => T): T {
  const db = openAuditDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function queryOne<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
  return withDb((db) => db.prepare(sql).get(...(params as never[])) as T | undefined);
}

export function queryAll<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  return withDb((db) => db.prepare(sql).all(...(params as never[])) as T[]);
}

export function exec(sql: string, ...params: unknown[]): void {
  withDb((db) => db.prepare(sql).run(...(params as never[])));
}

export function appConfig(key: string): string | undefined {
  return queryOne<{ value: string }>('SELECT value FROM AppConfig WHERE key = ?', key)?.value;
}

export function setAppConfig(key: string, value: string): void {
  exec('UPDATE AppConfig SET value = ? WHERE key = ?', value, key);
}

/**
 * Delete every row a booking owns, then the booking — plus the idempotency
 * claims this file's injected webhooks left behind (they are keyed by event id,
 * not by booking, so they have to be swept by their `evt_audit2a_` prefix).
 * Safe to call twice.
 */
export function deleteBookingCascade(bookingId: string): void {
  withDb((db) => {
    try {
      db.prepare("DELETE FROM WebhookEvent WHERE provider = 'stripe' AND eventId LIKE 'evt_audit2a\\_%' ESCAPE '\\'").run();
    } catch {
      /* the table may not exist in every schema revision */
    }
    for (const sql of [
      'DELETE FROM BookingDateLock WHERE bookingId = ?',
      'DELETE FROM AcceptedContract WHERE bookingId = ?',
      'DELETE FROM ChecklistSubmission WHERE bookingId = ?',
      'DELETE FROM Review WHERE bookingId = ?',
      'DELETE FROM CampaignRedemption WHERE bookingId = ?',
      'DELETE FROM Booking WHERE id = ?',
    ]) {
      try {
        db.prepare(sql).run(bookingId);
      } catch {
        /* table may not carry a bookingId in every schema revision */
      }
    }
  });
}

// ── HTTP ────────────────────────────────────────────────────────────────────

/**
 * A fresh per-caller rate-limit identity.
 *
 * Every limited route keys on `x-real-ip || x-forwarded-for[0]` — a header the
 * client picks (phase-1d finding H-5). Sending a random one keeps a re-run from
 * inheriting the previous run's budget; without it the second pass of these
 * tests trips 429 on /api/booking/cancel and /api/checklist/lookup.
 */
export function freshIp(): string {
  const oct = () => 1 + Math.floor(Math.random() * 250);
  return `10.${oct()}.${oct()}.${oct()}`;
}

export async function api<T = Record<string, unknown>>(
  pathname: string,
  init: RequestInit & { ip?: string } = {},
): Promise<{ status: number; body: T }> {
  const { ip, ...rest } = init;
  const res = await fetch(BASE_URL + pathname, {
    ...rest,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ip ?? freshIp(),
      ...(rest.headers as Record<string, string> | undefined),
    },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body: body as T };
}

// ── booking fixtures (through the product's own endpoints) ──────────────────

export interface BookingFixture {
  id: string;
  reference: string;
  totalPrice: number;
}

/** POST /api/quote → POST /api/bookings. Self-pickup, so no geocoder is hit. */
export async function createSelfPickupBooking(input: {
  name: string;
  phone: string;
  email: string;
  rentalType: 'weekend' | 'week';
  startDate: string;
  machineId: string;
  extraHours?: number;
}): Promise<BookingFixture> {
  const shared = {
    rentalType: input.rentalType,
    startDate: input.startDate,
    machineId: input.machineId,
    selfPickup: true,
    deliveryDistance: 0,
    deliveryFee: 0,
    extraHours: input.extraHours ?? 0,
  };
  const quote = await api<{ totalPrice: number; bookable: boolean; blockedReason: string | null }>(
    '/api/quote',
    { method: 'POST', body: JSON.stringify({ ...shared, email: input.email, phone: input.phone }) },
  );
  if (quote.status !== 200 || !quote.body.bookable) {
    throw new Error(`quote not bookable: ${quote.status} ${JSON.stringify(quote.body)}`);
  }
  const created = await api<{ booking: BookingFixture; error?: string }>('/api/bookings', {
    method: 'POST',
    body: JSON.stringify({
      ...shared,
      name: input.name,
      phone: input.phone,
      email: input.email,
      deliveryAddress: 'Selvhenting',
      termsAccepted: true,
      website: '',
      expectedTotalKr: quote.body.totalPrice,
    }),
  });
  if (created.status !== 201 && created.status !== 200) {
    throw new Error(`booking failed: ${created.status} ${JSON.stringify(created.body)}`);
  }
  return created.body.booking;
}

/** Open a Checkout session for a pending booking; returns its session id. */
export async function createCheckoutSession(bookingId: string): Promise<string> {
  const res = await api<{ sessionId?: string; url?: string; error?: string }>('/api/payment/stripe/create', {
    method: 'POST',
    body: JSON.stringify({ bookingId }),
  });
  if (!res.body.sessionId) throw new Error(`no Checkout session: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.sessionId;
}

/** Stripe's own signature scheme: `t=<unix>,v1=<hmac-sha256 of "t.payload">`. */
export function signedEvent(payload: string, secret: string, timestampSec?: number): string {
  const t = timestampSec ?? Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
}

/**
 * POST a signed `checkout.session.completed` to the instance's webhook.
 * Requires `stripeWebhookSecret` to be TEST_WEBHOOK_SECRET (see installWebhookSecret).
 */
export async function injectPaidWebhook(bookingId: string, sessionId: string): Promise<number> {
  const payload = JSON.stringify({
    id: `evt_audit2a_${randomUUID()}`,
    object: 'event',
    api_version: '2026-04-22',
    created: Math.floor(Date.now() / 1000),
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId,
        object: 'checkout.session',
        payment_status: 'paid',
        payment_intent: null,
        metadata: { bookingId },
      },
    },
  });
  const res = await fetch(BASE_URL + '/api/payment/stripe/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signedEvent(payload, TEST_WEBHOOK_SECRET),
    },
    body: payload,
  });
  return res.status;
}

/**
 * Point the instance at a known webhook secret and hand back a restore fn.
 * Always call the restore fn in afterAll — the value is shared with whatever
 * else is using the instance.
 */
export async function installWebhookSecret(): Promise<() => Promise<void>> {
  const previous = appConfig('stripeWebhookSecret') ?? '';
  setAppConfig('stripeWebhookSecret', TEST_WEBHOOK_SECRET);
  await sleep(CONFIG_CACHE_MS);
  return async () => {
    setAppConfig('stripeWebhookSecret', previous);
    await sleep(CONFIG_CACHE_MS);
  };
}

/** Confirm a pending booking the way a real card payment does. */
export async function payAndConfirm(bookingId: string): Promise<string> {
  const sessionId = await createCheckoutSession(bookingId);
  const status = await injectPaidWebhook(bookingId, sessionId);
  if (status !== 200) throw new Error(`webhook rejected with ${status}`);
  return sessionId;
}

// ── browser ─────────────────────────────────────────────────────────────────

export interface Session {
  browser: Browser;
  page: Page;
  close: () => Promise<void>;
}

export async function openBrowser(
  opts: { viewport?: { width: number; height: number; isMobile?: boolean; hasTouch?: boolean } } = {},
): Promise<Session> {
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport(opts.viewport ?? { width: 1440, height: 1000 });
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': freshIp() });
  return { browser, page, close: () => browser.close() };
}

export async function goto(page: Page, pathname: string): Promise<void> {
  await page.goto(BASE_URL + pathname, { waitUntil: 'networkidle2', timeout: 90_000 });
}

/** Whole-page text, whitespace-collapsed. */
export function pageText(page: Page): Promise<string> {
  return page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').trim());
}

/** Text of one element, whitespace-collapsed. */
export function textOf(page: Page, selector: string): Promise<string> {
  return page.evaluate(
    (s) => ((document.querySelector(s) as HTMLElement | null)?.innerText || '').replace(/\s+/g, ' ').trim(),
    selector,
  );
}

/**
 * Click by visible text.
 *
 * Dispatches a DOM click rather than a synthetic mouse click: several sections
 * scroll-animate into place, and a coordinate click computed before the scroll
 * settles lands on the wrong element.
 */
export async function clickText(page: Page, selector: string, text: string): Promise<void> {
  const ok = await page.evaluate(
    (sel, needle) => {
      const el = [...document.querySelectorAll(sel)].find((e) =>
        ((e as HTMLElement).innerText || '').replace(/\s+/g, ' ').includes(needle),
      ) as HTMLElement | undefined;
      if (!el) return false;
      el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
      el.click();
      return true;
    },
    selector,
    text,
  );
  if (!ok) throw new Error(`no ${selector} containing text ${JSON.stringify(text)}`);
}

/** Click by aria-label substring. */
export async function clickAria(page: Page, selector: string, aria: string): Promise<void> {
  const ok = await page.evaluate(
    (sel, needle) => {
      const el = [...document.querySelectorAll(sel)].find((e) =>
        (e.getAttribute('aria-label') || '').includes(needle),
      ) as HTMLElement | undefined;
      if (!el) return false;
      el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
      el.click();
      return true;
    },
    selector,
    aria,
  );
  if (!ok) throw new Error(`no ${selector} with aria-label containing ${JSON.stringify(aria)}`);
}

/**
 * Replace a React-controlled field's value.
 *
 * `page.type` appends, and Backspace does nothing useful against a controlled
 * input, so select-all first and verify the result. (A previous audit run
 * mis-filed the resulting "wrong@example.coaudit@..." as a product bug.)
 */
export async function setInput(page: Page, selector: string, value: string): Promise<void> {
  await page.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement | null;
    el?.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
  }, selector);
  await page.focus(selector);
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.type(selector, value, { delay: 10 });
  const got = await page.$eval(selector, (el) => (el as HTMLInputElement).value);
  if (got !== value) throw new Error(`setInput(${selector}): got ${JSON.stringify(got)}, want ${JSON.stringify(value)}`);
}

/** First Friday / Monday at least `minAhead` days out, as YYYY-MM-DD (Oslo). */
export function nextStartDate(weekday: 'friday' | 'monday', minAhead = 10): string {
  const want = weekday === 'friday' ? 5 : 1;
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + minAhead);
  while (d.getDay() !== want) d.setDate(d.getDate() + 1);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * The first `weekday` at least `minAhead` days out whose whole rental span is
 * free of `BookingDateLock` rows for `machineId`.
 *
 * The lock table — not the availability endpoint — is what actually refuses a
 * booking, so fixture creation reads the constraint rather than the calendar.
 * Q-4 (locks surviving a `completed` transition, which made the calendar offer
 * days the insert then rejected) is fixed: `releaseBookingDateLocks` now runs
 * for `completed` as well as `cancelled`. Reading the lock table is still the
 * right source here — it is the row that decides — but it is no longer working
 * around a defect.
 */
export function firstFreeStartDate(
  machineId: string,
  weekday: 'friday' | 'monday',
  minAhead: number,
  spanDays: number,
): string {
  const locked = new Set(
    queryAll<{ date: number }>('SELECT date FROM BookingDateLock WHERE machineId = ?', machineId).map((r) => {
      const d = new Date(Number(r.date));
      const p = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }),
  );
  const iso = (d: Date) => {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const start = new Date(nextStartDate(weekday, minAhead) + 'T12:00:00');
  for (let week = 0; week < 60; week++) {
    const candidate = new Date(start);
    candidate.setDate(candidate.getDate() + week * 7);
    let free = true;
    for (let i = 0; i < spanDays; i++) {
      const day = new Date(candidate);
      day.setDate(day.getDate() + i);
      if (locked.has(iso(day))) {
        free = false;
        break;
      }
    }
    if (free) return iso(candidate);
  }
  throw new Error(`no free ${weekday} start date within a year for ${machineId}`);
}

/** Norwegian long-form label the calendar uses in its aria-labels. */
export function norwegianDayLabel(isoDate: string): string {
  const d = new Date(isoDate + 'T12:00:00');
  return d.toLocaleDateString('nb-NO', { weekday: 'long', day: 'numeric', month: 'long' });
}

/** An active machine id from the instance, preferring the configured default. */
export function pickMachineId(): string {
  const preferred = appConfig('defaultMachineId');
  const rows = queryAll<{ id: string }>('SELECT id FROM Machine WHERE isActive = 1 ORDER BY sortOrder, createdAt');
  if (rows.length === 0) throw new Error('no active machines on the instance');
  if (preferred && rows.some((r) => r.id === preferred)) return preferred;
  return rows[0].id;
}

/** A machine that is NOT the given one, when the instance has more than one. */
export function pickOtherMachineId(notThis: string): string {
  const rows = queryAll<{ id: string }>('SELECT id FROM Machine WHERE isActive = 1 AND id <> ?', notThis);
  return rows[0]?.id ?? notThis;
}

/** Unique-ish marker so a failed run's rows are easy to spot and delete. */
export const AUDIT_TAG = 'audit2a-e2e';
export const auditEmail = (slug: string) => `${AUDIT_TAG}+${slug}@example.invalid`;

// ── instance lock ───────────────────────────────────────────────────────────

/**
 * Vitest runs test FILES in parallel, but these tests share one running app and
 * one database: the maintenance-mode file blanks the site for everyone, the
 * page-gate file flips `contactFormEnabled`, and several routes are rate
 * limited per identity. A cross-file advisory lock (an exclusively-created file
 * in the OS temp dir) makes the e2e directory run one file at a time without
 * touching vitest.config.ts.
 *
 * A crashed run leaves the file behind, so a lock older than STALE_MS is taken
 * over rather than waited on forever.
 */
const LOCK_FILE = path.join(os.tmpdir(), 'graveklar-audit-e2e.lock');
const LOCK_STALE_MS = 10 * 60 * 1000;

export async function acquireInstanceLock(label: string): Promise<void> {
  const deadline = Date.now() + 15 * 60 * 1000;
  for (;;) {
    try {
      fs.writeFileSync(LOCK_FILE, `${label} ${process.pid} ${Date.now()}`, { flag: 'wx' });
      return;
    } catch {
      let age = Infinity;
      try {
        age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
      } catch {
        continue; // vanished between the failed create and the stat — retry
      }
      if (age > LOCK_STALE_MS) {
        try {
          fs.unlinkSync(LOCK_FILE);
        } catch {
          /* someone else won the steal */
        }
        continue;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for the e2e instance lock (${label})`);
      await sleep(250);
    }
  }
}

export function releaseInstanceLock(): void {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    /* already gone */
  }
}
