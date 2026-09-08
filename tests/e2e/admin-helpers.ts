/**
 * Shared harness for the admin L4 flows (`tests/e2e/admin-*.e2e.test.ts`).
 *
 * These drive a real Chromium against the *neutralised audit instance*, not a
 * synthetic request. Two environment variables switch them on; without both,
 * every admin e2e file skips itself:
 *
 *   AUDIT_BASE_URL   http://localhost:3001
 *   AUDIT_DB_FILE    …/scratchpad/testdb/audit.db
 *
 * The database is only ever *read* through the `sqlite3` CLI — no PrismaClient
 * is constructed here, and `tests/helpers/db.ts` is deliberately not imported,
 * because that helper is bound to the per-worker scratch database while these
 * tests must observe the very rows the running instance writes.
 *
 * Writes to the audit database happen exclusively through the app's own HTTP
 * surface, so nothing here can leave rows the app itself could not have made.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import puppeteer, {
  type Browser, type BrowserContext, type ElementHandle, type Page,
} from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

export const BASE = (process.env.AUDIT_BASE_URL || '').replace(/\/+$/, '');
export const DB_FILE = process.env.AUDIT_DB_FILE || '';
export const ADMIN_PASSWORD = process.env.AUDIT_ADMIN_PASSWORD || 'Testadmin-2026!';
export const CHROMIUM = process.env.AUDIT_CHROMIUM || '/usr/bin/chromium';

/** Both switches present → the admin e2e files run. */
export const LIVE = Boolean(BASE && DB_FILE);

/**
 * The same refusal `tests/setup.ts` applies to Prisma, applied to the sqlite3
 * CLI: the audit copy lives in a scratch directory and never in the repo.
 */
function assertScratchDb(file: string): void {
  const abs = path.resolve(file);
  if (abs.startsWith(REPO_ROOT + path.sep)) {
    throw new Error(`AUDIT_DB_FILE must live outside the repository, got ${abs}`);
  }
  if (abs.endsWith(path.join('prisma', 'prisma', 'db', 'custom.db'))) {
    throw new Error('AUDIT_DB_FILE points at the production database');
  }
}

if (LIVE) assertScratchDb(DB_FILE);

// ── database (read-only, through the CLI) ────────────────────────────────────

/** One `sqlite3` invocation. Returns raw stdout, trimmed. */
export function sql(query: string): string {
  return execFileSync('sqlite3', [DB_FILE, query], { encoding: 'utf8' }).trim();
}

/** Rows split on the default `|` separator; empty result → `[]`. */
export function sqlRows(query: string): string[][] {
  const out = sql(query);
  if (!out) return [];
  return out.split('\n').map((line) => line.split('|'));
}

/** First column of the first row, or `null` when nothing matched. */
export function sqlValue(query: string): string | null {
  const rows = sqlRows(query);
  return rows.length ? rows[0][0] : null;
}

/** SQL string literal with quotes doubled. */
export function q(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// ── browser ──────────────────────────────────────────────────────────────────

export async function launchBrowser(): Promise<Browser> {
  return puppeteer.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
}

/**
 * A page wired for this app: desktop viewport, native `confirm()` accepted
 * (several admin destructive actions gate on it), and every response status
 * recorded so a test can assert on the status the UI actually received.
 *
 * Pass a `BrowserContext` instead of the browser when a test needs its own
 * cookie jar — pages from `browser.newPage()` share one, so a session another
 * test established would answer for a page that is supposed to have none.
 */
export async function newPage(
  target: Browser | BrowserContext,
): Promise<Page & { seen: SeenResponse[] }> {
  const page = (await target.newPage()) as Page & { seen: SeenResponse[] };
  await page.setViewport({ width: 1440, height: 1600 });
  // Generous: six of these drive one dev server at once, and a route it has
  // not compiled yet can take a while on its first hit.
  page.setDefaultTimeout(45_000);
  page.on('dialog', (d) => { void d.accept(); });
  page.seen = [];
  page.on('response', (res) => {
    const url = res.url();
    if (url.includes('/api/')) {
      page.seen.push({ url, method: res.request().method(), status: res.status(), at: Date.now() });
    }
  });
  return page;
}

export interface SeenResponse { url: string; method: string; status: number; at: number }

/** The most recent recorded response whose URL contains `fragment`. */
export function lastCall(page: { seen: SeenResponse[] }, fragment: string, method?: string) {
  for (let i = page.seen.length - 1; i >= 0; i--) {
    const r = page.seen[i];
    if (r.url.includes(fragment) && (!method || r.method === method)) return r;
  }
  return undefined;
}

/** The current length of `page.seen`, to wait for responses *after* this point. */
export function seenMark(page: { seen: SeenResponse[] }): number {
  return page.seen.length;
}

/**
 * Wait until a response matching `fragment`/`method` has been recorded, and
 * return it. Asserting on `lastCall` directly races the request: under load the
 * assertion can run before the fetch the click started comes back — and worse,
 * it can match an *earlier* call to the same endpoint and quietly assert on the
 * wrong one. Pass `since: seenMark(page)` taken before the click to exclude it.
 */
export async function waitForApi(
  page: { seen: SeenResponse[] },
  fragment: string,
  method?: string,
  opts: { since?: number; timeoutMs?: number } = {},
): Promise<SeenResponse> {
  const since = opts.since ?? 0;
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  for (;;) {
    for (let i = page.seen.length - 1; i >= since; i--) {
      const r = page.seen[i];
      if (r.url.includes(fragment) && (!method || r.method === method)) return r;
    }
    if (Date.now() > deadline) {
      throw new Error(`no ${method ?? 'response'} to ${fragment} was seen`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ── session ──────────────────────────────────────────────────────────────────

const SESSION_CACHE = LIVE
  ? path.join(path.dirname(DB_FILE), '.audit-admin-session.json')
  : path.join(os.tmpdir(), 'audit-admin-session.json');

/** Mirrors `COOKIE_NAME` in `src/lib/admin-auth.ts` (7-day session). */
export const SESSION_COOKIE = 'graveklar_admin_session';

interface CachedCookie { name: string; value: string; domain: string; path: string }

function readCachedCookie(): CachedCookie | null {
  try {
    const raw = fs.readFileSync(SESSION_CACHE, 'utf8');
    const parsed = JSON.parse(raw) as CachedCookie;
    return parsed && parsed.value ? parsed : null;
  } catch {
    return null;
  }
}

function writeCachedCookie(c: CachedCookie): void {
  try {
    const tmp = `${SESSION_CACHE}.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(c));
    fs.renameSync(tmp, SESSION_CACHE);
  } catch {
    /* cache is an optimisation, never a requirement */
  }
}

/**
 * A real password login through the form. Every call spends one slot of the
 * 10-per-15-minutes budget on `POST /api/admin/login`, which is why the rest of
 * the suite reuses the cookie this leaves behind.
 */
export async function loginWithPassword(
  page: Page & { seen: SeenResponse[] }, password = ADMIN_PASSWORD,
): Promise<SeenResponse> {
  await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });

  // Retried as a unit. A password typed before React hydrates is discarded,
  // and a submit clicked before hydration posts nothing at all — the page then
  // just sits there, which reads like a broken login rather than an early
  // click. A retry that made no request costs nothing from the login budget.
  let response: SeenResponse | null = null;
  for (let attempt = 0; attempt < 5 && !response; attempt++) {
    const mark = seenMark(page);
    await setInput(page, 'input[type="password"]', password);
    await page.click('button[type="submit"]');
    response = await waitForApi(page, '/api/admin/login', 'POST', { since: mark, timeoutMs: 5_000 })
      .catch(() => null);
  }
  if (!response) throw new Error('the login form never posted anything');

  if (response.status === 429) {
    throw new Error(
      'POST /api/admin/login is rate limited (10 attempts / 15 min, one bucket for all of localhost). '
      + 'Wait for the window to drain before re-running the admin e2e suite.',
    );
  }
  // Let the page settle on whatever the answer was: /admin, or the error.
  await page.waitForFunction(
    () => location.pathname === '/admin' || !!document.querySelector('form + p, .text-destructive'),
    { timeout: 20_000 },
  ).catch(() => {});
  return response;
}

/** Authenticated on `/admin`, reusing a cached session cookie when possible. */
export async function adminSession(page: Page & { seen: SeenResponse[] }): Promise<void> {
  const cached = readCachedCookie();
  if (cached) {
    await page.setCookie({ ...cached, url: BASE });
    await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
    if (new URL(page.url()).pathname === '/admin') {
      await page.waitForSelector('input[placeholder^="Søk bookinger"]');
      return;
    }
  }
  await loginWithPassword(page);
  await page.waitForFunction(() => location.pathname === '/admin');
  const cookies = await page.cookies(BASE);
  const session = cookies.find((c) => c.name === SESSION_COOKIE);
  if (session) {
    writeCachedCookie({
      name: session.name, value: session.value, domain: session.domain, path: session.path,
    });
  }
  await page.waitForSelector('input[placeholder^="Søk bookinger"]');
}

/**
 * Load /admin and wait until it has its data.
 *
 * `domcontentloaded` is not enough: the panel mounts, fetches its bookings,
 * and re-renders — and a search box written before that second render silently
 * snaps back to empty. Waiting for the fetch the page itself makes is the only
 * signal that React state will survive.
 */
export async function openAdmin(page: Page & { seen: SeenResponse[] }): Promise<void> {
  page.seen.length = 0;
  await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[placeholder^="Søk bookinger"]');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (page.seen.some((r) => r.url.includes('/api/bookings') && r.method === 'GET')) {
      await new Promise((r) => setTimeout(r, 250));
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('/admin never fetched its bookings');
}

/**
 * Step the calendar forward `hops` months as fast as the panel will accept the
 * clicks, waiting for nothing in between.
 *
 * Each hop starts a fresh `GET /api/bookings` + `GET /api/unavailable?month=…`
 * pair on top of the one already in flight. `fetchData` carries a request
 * sequence guard now, so only the newest month writes state; before it, a
 * slower earlier month could overwrite the month on screen (P-17) and the
 * overlapping commits left the panel unable to open any dialog or sheet
 * afterwards (P-16).
 */
export async function hopMonths(page: Page, hops: number): Promise<void> {
  for (let i = 0; i < hops; i++) {
    const stepped = await page.evaluate(() => {
      const label = [...document.querySelectorAll('span.font-semibold')]
        .find((s) => /\d{4}$/.test((s.textContent || '').trim()));
      const next = label?.nextElementSibling as HTMLButtonElement | undefined;
      if (!next) return false;
      next.click();
      return true;
    });
    if (!stepped) throw new Error('the calendar has no next-month control to click');
    await new Promise((r) => setTimeout(r, 60));
  }
}

/**
 * Wait until React has hydrated the admin panel.
 *
 * The server-rendered HTML carries every button before any of them does
 * anything: a click that lands first is swallowed silently, which reads like a
 * broken control rather than an early click. Same signal `setInput` uses —
 * React's own props on a node that only the client tree carries.
 */
export async function waitForHydration(
  page: Page, selector = 'input[placeholder^="Søk bookinger"]',
): Promise<void> {
  await page.waitForSelector(selector);
  await page.waitForFunction(
    (sel: string) => {
      const el = document.querySelector(sel);
      return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
    },
    { timeout: 30_000 }, selector,
  );
}

/**
 * Load `/admin` and change month while its first fetch is still in flight —
 * the P-16 trigger, performed deliberately.
 *
 * Waits for hydration and nothing else. Waiting for the panel's own requests
 * the way `openAdmin` does would defeat the point; not waiting for hydration
 * at all would too, because the chevron clicks would land on dead markup and
 * no month change would happen.
 */
export async function changeMonthDuringLoad(
  page: Page & { seen: SeenResponse[] }, hops = 4,
): Promise<void> {
  page.seen.length = 0;
  await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  await hopMonths(page, hops);
}

/** Whether the panel has fallen back to its error boundary (P-16). */
export async function panelCrashed(page: Page): Promise<boolean> {
  return page.evaluate(() => document.body.innerText.includes('Noe gikk galt'));
}

/** The calendar month the panel is showing, read from its own header. */
export const MONTH_NAMES_NB = [
  'januar', 'februar', 'mars', 'april', 'mai', 'juni',
  'juli', 'august', 'september', 'oktober', 'november', 'desember',
] as const;

export async function shownMonth(page: Page): Promise<{ year: number; month: number }> {
  const label = await page.evaluate(() => {
    const el = [...document.querySelectorAll('span.font-semibold')]
      .find((s) => /\d{4}$/.test((s.textContent || '').trim()));
    return (el?.textContent || '').trim();
  });
  const [name, year] = label.split(' ');
  const month = MONTH_NAMES_NB.indexOf(name as typeof MONTH_NAMES_NB[number]);
  if (month < 0 || !year) {
    throw new Error(`could not read the calendar month from ${JSON.stringify(label)}`);
  }
  return { year: Number(year), month };
}

// ── DOM helpers ──────────────────────────────────────────────────────────────

/** Wait until some element matching `selector` has exactly/loosely this text. */
export async function waitForElementWithText(
  page: Page, selector: string, text: string, timeout = 20_000,
): Promise<void> {
  await page.waitForFunction(
    (sel: string, txt: string) =>
      [...document.querySelectorAll(sel)].some((e) => (e.textContent || '').includes(txt)),
    { timeout }, selector, text,
  );
}

/** Click the first *visible* element matching `selector` whose text contains `text`. */
export async function clickByText(page: Page, selector: string, text: string): Promise<void> {
  await waitForElementWithText(page, selector, text);
  const handle = await page.evaluateHandle(
    (sel: string, txt: string) =>
      [...document.querySelectorAll(sel)].find(
        (e) => (e.textContent || '').includes(txt) && (e as HTMLElement).offsetParent !== null,
      ) ?? [...document.querySelectorAll(sel)].find((e) => (e.textContent || '').includes(txt)),
    selector, text,
  );
  const el = handle.asElement() as ElementHandle<Element> | null;
  if (!el) throw new Error(`no element ${selector} containing ${JSON.stringify(text)}`);
  await el.evaluate((e) => (e as HTMLElement).scrollIntoView({ block: 'center' }));
  try {
    await el.click();
  } catch {
    // A real click needs a clickable point, and a control inside a scrolling
    // drawer does not always have one. The DOM click reaches the same React
    // handler, which is what the test is after.
    await el.evaluate((e) => (e as HTMLElement).click());
  }
}

/**
 * Wait until the page has been quiet for `quietMs` — no `/api/` response has
 * landed in that long.
 *
 * The admin calendar refetches on every month change and has no sequence guard
 * (`src/app/admin/page.tsx:699-732`), and opening a dialog while two of those
 * overlap crashes the panel (P-16). A happy-path test wants the happy path, so
 * it waits for the page to stop moving first.
 */
export async function waitForQuiet(
  page: Page & { seen: SeenResponse[] }, quietMs = 1_500, timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const last = page.seen.length ? page.seen[page.seen.length - 1].at : 0;
    if (Date.now() - last >= quietMs) return;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * Wait until the browser is actually at `pathname`.
 *
 * Read from the frame's own URL rather than evaluated in the page: an
 * in-page poll has to survive the navigation it is waiting for, and under a
 * loaded dev server the destination can take longer to compile than the
 * default wait allows.
 */
export async function waitForPath(page: Page, pathname: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (new URL(page.url()).pathname === pathname) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`never navigated to ${pathname} (still at ${page.url()})`);
}

/**
 * Switch to one of the top-level admin tabs and wait for its panel.
 *
 * Retried: a tab click that lands before React has hydrated does nothing at
 * all, and the failure then looks like the panel is missing rather than like
 * the click was early.
 */
export async function openTab(
  page: Page, label: string, marker: string, tries = 5,
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    await clickByText(page, 'main > div > button', label);
    const shown = await page
      .waitForFunction((m: string) => document.body.innerText.includes(m), { timeout: 6_000 }, marker)
      .then(() => true)
      .catch(() => false);
    if (shown) return;
    await settle(page, 500);
  }
  throw new Error(`the ${label} tab never showed ${JSON.stringify(marker)}`);
}

/** Whether any visible element matching `selector` contains `text`. */
export async function hasText(page: Page, text: string): Promise<boolean> {
  return page.evaluate((txt: string) => document.body.innerText.includes(txt), text);
}

/**
 * Set a React-controlled input or textarea.
 *
 * Not by typing: the admin page re-renders its whole tree on every keystroke,
 * so `keyboard.type` costs the better part of a second per character against
 * the dev server and turns a 40-character field into a test timeout. Writing
 * through the native value setter and dispatching one `input` event is the
 * same thing React's onChange sees, in one render.
 */
export async function setInput(page: Page, selector: string, value: string): Promise<void> {
  await page.waitForSelector(selector);
  // Retried, and checked against React's own props rather than the DOM value.
  // Before hydration the element has no React props at all: writing to it
  // leaves the value sitting in the DOM, where a naive check says "it stuck",
  // while the component's state is still empty — which is how a login submit
  // ends up posting a blank password and answering 400.
  for (let attempt = 0; attempt < 8; attempt++) {
    const state = await page.evaluate((sel: string, val: string) => {
      const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
      if (!el) return 'missing';
      const propsKey = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
      if (!propsKey) return 'unhydrated';

      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
      setter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'set';
    }, selector, value);
    if (state === 'missing') throw new Error(`no element matching ${selector} to set`);

    if (state === 'set') {
      await new Promise((r) => setTimeout(r, 150));
      const accepted = await page.evaluate((sel: string, val: string) => {
        const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
        if (!el) return false;
        const propsKey = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
        const props = propsKey
          ? (el as unknown as Record<string, { value?: unknown }>)[propsKey]
          : undefined;
        // A controlled input reports the component's value; an uncontrolled one
        // has none, and the DOM value is then the whole truth.
        if (props && typeof props.value === 'string') return props.value === val;
        return el.value === val;
      }, selector, value);
      if (accepted) return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${selector} did not keep the value it was given`);
}

/** The id of the control a FieldRow-style `<label for=…>` points at. */
export async function controlIdFor(page: Page, labelText: string): Promise<string> {
  const id = await page.evaluate((txt: string) => {
    const label = [...document.querySelectorAll('label')]
      .find((l) => (l.textContent || '').includes(txt));
    return label?.getAttribute('for') ?? '';
  }, labelText);
  if (!id) throw new Error(`no label containing ${JSON.stringify(labelText)}`);
  return id;
}

/** `setInput` addressed by the control's visible label. */
export async function setInputByLabel(page: Page, labelText: string, value: string): Promise<void> {
  await setInput(page, `#${await controlIdFor(page, labelText)}`, value);
}

/** Wait for the checked animation-free state of Radix overlays to settle. */
export async function settle(page: Page, ms = 400): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** POST/PATCH/DELETE against the admin API from inside the authenticated page. */
export async function apiFromPage(
  page: Page, url: string, method: string, body?: unknown,
): Promise<{ status: number; json: unknown }> {
  return page.evaluate(
    async (u: string, m: string, b: unknown) => {
      const res = await fetch(u, {
        method: m,
        credentials: 'include',
        ...(b === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }),
      });
      let json: unknown = null;
      try { json = await res.json(); } catch { /* empty body */ }
      return { status: res.status, json };
    },
    url, method, body ?? undefined,
  );
}

/** Create a throwaway `[TESTBOOKING]` row through the app's own mock endpoint. */
export async function createMockBooking(
  page: Page,
  opts: { startDate: string; name: string; phone?: string; machineId?: string; status?: 'pending' | 'confirmed'; rentalType?: string },
): Promise<{ bookingId: string; reference: string }> {
  const res = await apiFromPage(page, '/api/admin/mock-booking', 'POST', {
    startDate: opts.startDate,
    rentalType: opts.rentalType ?? 'day',
    name: opts.name,
    phone: opts.phone ?? '99011223',
    machineId: opts.machineId,
    status: opts.status ?? 'pending',
    force: true,
  });
  const body = res.json as { booking?: { bookingId: string; reference: string }; error?: string };
  if (res.status !== 200 || !body.booking) {
    throw new Error(`mock booking failed (${res.status}): ${body.error ?? 'unknown'}`);
  }
  return body.booking;
}

/** Remove a booking created by a test, whatever state it ended in. */
export async function deleteBooking(page: Page, id: string): Promise<void> {
  await apiFromPage(page, `/api/bookings/${id}`, 'DELETE');
}

/**
 * Click the first visible element matching `selector` whose *trimmed* text is
 * exactly `text`. Needed wherever a panel holds both "Legg til" and
 * "+ Legg til rad": a substring match picks the wrong one.
 */
export async function clickByExactText(page: Page, selector: string, text: string): Promise<void> {
  await page.waitForFunction(
    (sel: string, txt: string) =>
      [...document.querySelectorAll(sel)].some((e) => (e.textContent || '').trim() === txt),
    { timeout: 20_000 }, selector, text,
  );
  const clicked = await page.evaluate(
    (sel: string, txt: string) => {
      const el = [...document.querySelectorAll(sel)].find(
        (e) => (e.textContent || '').trim() === txt && (e as HTMLElement).offsetParent !== null,
      ) as HTMLElement | undefined;
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    },
    selector, text,
  );
  if (!clicked) throw new Error(`no visible ${selector} whose text is exactly ${JSON.stringify(text)}`);
}

/**
 * Click a button inside the dialog/sheet identified by some text it contains.
 * Several overlays can be mounted at once (the machine sheet stays open behind
 * the 2FA modal), so "the first Avbryt on the page" is the wrong button.
 */
export async function clickInDialog(page: Page, dialogText: string, buttonText: string): Promise<void> {
  await page.waitForFunction(
    (dt: string) => [...document.querySelectorAll('[role="dialog"][data-state="open"]')]
      .some((d) => (d.textContent || '').includes(dt)),
    { timeout: 20_000 }, dialogText,
  );
  const clicked = await page.evaluate(
    (dt: string, bt: string) => {
      const dialog = [...document.querySelectorAll('[role="dialog"][data-state="open"]')]
        .find((d) => (d.textContent || '').includes(dt));
      const btn = [...(dialog?.querySelectorAll('button') ?? [])]
        .find((b) => (b.textContent || '').trim() === bt) as HTMLButtonElement | undefined;
      if (!btn) return false;
      btn.click();
      return true;
    },
    dialogText, buttonText,
  );
  if (!clicked) throw new Error(`no button ${JSON.stringify(buttonText)} in the dialog containing ${JSON.stringify(dialogText)}`);
}

/**
 * Wait until a dismissed overlay has finished getting out of the way.
 *
 * While a Radix Dialog is open it sets `pointer-events: none` on `<body>` and
 * only removes it once the exit animation ends. A real mouse click that lands
 * inside that window hits nothing at all and reports success — which reads as
 * a control that does not work, rather than as a click that was too early.
 * That is how a sidebar group switch silently failed to switch.
 */
export async function waitForOverlaysDismissed(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.querySelectorAll('[role="dialog"][data-state="open"]').length === 0
      && document.body.style.pointerEvents !== 'none',
    { timeout: 20_000 },
  );
}

/**
 * Wait until no *open* overlay contains `text`.
 *
 * Radix keeps a dismissed dialog mounted through its exit animation with
 * `data-state="closed"`, so "is it in the DOM" is the wrong question — and
 * a stale closed sheet is also why every dialog-scoped selector in these tests
 * carries `[data-state="open"]`.
 */
export async function waitForGone(page: Page, text: string): Promise<void> {
  await page.waitForFunction(
    (txt: string) => ![...document.querySelectorAll('[role="dialog"][data-state="open"]')]
      .some((d) => (d.textContent || '').includes(txt)),
    { timeout: 20_000 }, text,
  );
}

/**
 * A statement run against the audit copy. Reserved for removing rows a test
 * itself caused and cannot reach through the app (the goodwill discount code a
 * cancellation mints, for instance) — never for setting up state a test then
 * "verifies", and never for DateTime columns, which Prisma stores as integers.
 */
export function sqlExec(statement: string): void {
  execFileSync('sqlite3', [DB_FILE, statement], { encoding: 'utf8' });
}
