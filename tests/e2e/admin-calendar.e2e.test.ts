/**
 * L4 — blocking and unblocking a date from the calendar, and the month-change
 * race underneath it.
 *
 * Unblocking is the reason this file exists. `DELETE /api/unavailable` once
 * resolved the date at UTC midnight while the row was written at Oslo midnight
 * (phase 1b, C-4), so a blocked day could be created from the UI and then
 * refused removal from the same UI — the owner's only escape being the
 * database. The round trip below is what that defect would break.
 *
 * The last two tests are the other half: `fetchData` is keyed on
 * `calendarMonth` and used to start a second run over the first with no
 * sequence guard, so a slower earlier month could overwrite the month on
 * screen (P-17) and, once that had happened, the next dialog or sheet the
 * admin opened took the panel down to "Noe gikk galt" (P-16). Both drive the
 * trigger deliberately rather than hoping to catch it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, HTTPRequest, Page } from 'puppeteer-core';

import {
  BASE, LIVE, adminSession, apiFromPage, changeMonthDuringLoad, clickByExactText,
  clickInDialog, hopMonths, lastCall, launchBrowser, newPage, openAdmin,
  MONTH_NAMES_NB, panelCrashed, q, setInput, settle, shownMonth, sqlRows, sqlValue,
  waitForApi, waitForGone, waitForHydration, waitForQuiet,
  type SeenResponse,
} from './admin-helpers';

const REASON = 'AUDIT2B e2e vedlikehold';

const monthParam = (year: number, month: number) =>
  `${year}-${String(month + 1).padStart(2, '0')}`;

/**
 * The last free day in a given month.
 *
 * Free because the API silently *skips* a date that is already booked, which
 * would otherwise look exactly like a successful block.
 */
function freeDayIn(year: number, month: number): { date: string; day: number; month: string } {
  const now = new Date();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth();
  const earliest = isCurrentMonth ? now.getDate() + 1 : 1;
  const iso = (d: number) =>
    `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  const taken = new Set<string>(
    sqlRows(`SELECT date(date/1000,'unixepoch','localtime') FROM UnavailableDate`).map((r) => r[0]),
  );
  // Bookings store only a start date; the longest rental plus its turnaround
  // is well under nine days, so block out that window rather than recomputing
  // the rental calendar here.
  for (const [from] of sqlRows(
    `SELECT date(startDate/1000,'unixepoch','localtime')
     FROM Booking WHERE status IN ('pending','confirmed','completed')`,
  )) {
    const start = new Date(`${from}T00:00:00`);
    for (let i = 0; i < 9; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      taken.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
  }

  // Latest first: the further out, the less it can disturb anything looking at
  // the next few days while this runs.
  for (let d = daysInMonth; d >= earliest; d--) {
    if (!taken.has(iso(d))) {
      return { date: iso(d), day: d, month: `${year}-${String(month + 1).padStart(2, '0')}` };
    }
  }
  throw new Error(`no free day left in ${MONTH_NAMES_NB[month]} ${year} to block`);
}

describe.skipIf(!LIVE)('admin calendar block / unblock (L4)', { timeout: 120_000 }, () => {
  let browser: Browser;
  let page: Page & { seen: SeenResponse[] };
  let target = '';            // YYYY-MM-DD
  let targetDay = 0;
  let targetMonthParam = '';  // YYYY-MM, for GET /api/unavailable

  beforeAll(async () => {
    browser = await launchBrowser();
    page = await newPage(browser);
    await adminSession(page);

    // The panel decides which month it opens on, so read it before choosing.
    await openAdmin(page);
    const shown = await shownMonth(page);
    const free = freeDayIn(shown.year, shown.month);
    target = free.date;
    targetDay = free.day;
    targetMonthParam = free.month;
  }, 90_000);

  afterAll(async () => {
    // Self-cleaning, and by reason rather than by date: a run that failed
    // between blocking and unblocking would otherwise leave the day blocked on
    // an instance somebody else is still using. The ids come from the database
    // because the list endpoint is scoped to one month.
    if (page && !page.isClosed()) {
      const ids = sqlRows(`SELECT id FROM UnavailableDate WHERE reason=${q(REASON)}`).map((r) => r[0]);
      if (ids.length) await apiFromPage(page, '/api/unavailable', 'DELETE', { ids });
    }
    await browser?.close();
  }, 60_000);

  /** Step the panel to `target` (YYYY-MM), one month per click. */
  async function stepToMonth(p: Page, target: string, maxHops = 24): Promise<void> {
    for (let i = 0; i <= maxHops; i++) {
      const { year, month } = await shownMonth(p);
      if (monthParam(year, month) === target) return;
      await hopMonths(p, 1);
    }
    throw new Error(`the calendar never reached ${target}`);
  }

  const stepToTargetMonth = (p: Page) => stepToMonth(p, targetMonthParam);

  /** Click the day cell showing `day` in the month grid. */
  async function clickDay(p: Page, day: number): Promise<void> {
    const ok = await p.evaluate((n: number) => {
      const grids = [...document.querySelectorAll('div.grid.grid-cols-7')];
      const grid = grids.find((g) => g.querySelector('button'));
      const btn = [...(grid?.querySelectorAll('button') ?? [])].find(
        (b) => b.querySelector('span.leading-none')?.textContent?.trim() === String(n),
      ) as HTMLButtonElement | undefined;
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    }, day);
    if (!ok) throw new Error(`no selectable day cell for ${day}`);
  }

  it('blocks a date with a reason', async () => {
    // Retried only against a loaded dev server, not against P-16: the panel
    // used to change month by itself while its first fetch was still running,
    // and the next overlay opened after that took the page down to "Noe gikk
    // galt". The crash is asserted absent on every attempt now.
    let opened = false;
    for (let attempt = 0; attempt < 3 && !opened; attempt++) {
      await openAdmin(page);
      await waitForQuiet(page);
      expect(await panelCrashed(page)).toBe(false);

      // The panel picks its own month (it advances to the next month that has
      // a booking), and it can pick a different one on a later load — so read
      // it back and choose the day from what is actually on screen.
      const shown = await shownMonth(page);
      const free = freeDayIn(shown.year, shown.month);
      target = free.date;
      targetDay = free.day;
      targetMonthParam = free.month;

      // The day is free, so a "skipped (already booked)" warning cannot
      // masquerade as a successful block.
      expect(sqlValue(
        `SELECT count(*) FROM UnavailableDate WHERE date(date/1000,'unixepoch','localtime')=${q(target)}`,
      )).toBe('0');

      await clickDay(page, targetDay);
      await page.waitForFunction(() => document.body.innerText.includes('1 dato valgt'));
      await setInput(page, 'input[placeholder^="Årsak"]', REASON);
      await clickByExactText(page, 'button', 'Marker utilgjengelig');
      opened = await page
        .waitForFunction(() => document.body.innerText.includes('Bekreft blokkering'), { timeout: 8_000 })
        .then(() => true)
        .catch(() => false);
      // Whatever else may have gone slowly, the panel must still be alive.
      expect(await panelCrashed(page)).toBe(false);
    }
    expect(opened).toBe(true);

    await clickInDialog(page, 'Bekreft blokkering', 'Blokker datoer');
    await waitForGone(page, 'Bekreft blokkering');

    // 200 alone is not success: the route answers 200 with the date in
    // `skipped` when something already occupies it.
    expect(lastCall(page, '/api/unavailable', 'POST')?.status).toBe(200);
    expect(await page.evaluate(() => document.body.innerText.includes('hoppet over'))).toBe(false);

    // The row exists and, read back through the app, is the day the admin
    // clicked — not its UTC neighbour.
    const listed = await apiFromPage(page, `/api/unavailable?month=${targetMonthParam}`, 'GET');
    const rows = (listed.json as { unavailableDates: { date: string; reason: string | null }[] })
      .unavailableDates.filter((r) => r.date === target);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe(REASON);
    expect(sqlValue(
      `SELECT count(*) FROM UnavailableDate WHERE date(date/1000,'unixepoch','localtime')=${q(target)}`,
    )).toBe('1');
  });

  it('shows the date as blocked in the calendar', async () => {
    await openAdmin(page);
    await waitForQuiet(page);
    expect(await panelCrashed(page)).toBe(false);
    await stepToTargetMonth(page);
    // The month's unavailable dates are fetched with the page, so
    // poll rather than sampling the first paint.
    const blocked = await page.waitForFunction((n: number) => {
      const grids = [...document.querySelectorAll('div.grid.grid-cols-7')];
      const grid = grids.find((g) => g.querySelector('button'));
      const btn = [...(grid?.querySelectorAll('button') ?? [])].find(
        (b) => b.querySelector('span.leading-none')?.textContent?.trim() === String(n),
      );
      return !!btn && (btn as HTMLElement).className.includes('line-through');
    }, { timeout: 20_000 }, targetDay).then(() => true).catch(() => false);
    expect(blocked).toBe(true);
  });

  it('unblocks the same date from the same calendar', async () => {
    await waitForQuiet(page);
    await stepToTargetMonth(page);
    await clickDay(page, targetDay);
    await clickByExactText(page, 'button', 'Fjern blokkering');
    await page.waitForFunction(
      () => !document.body.innerText.includes('Fjern blokkering'),
      { timeout: 20_000 },
    );

    expect(lastCall(page, '/api/unavailable', 'DELETE')?.status).toBe(200);
    expect(sqlValue(
      `SELECT count(*) FROM UnavailableDate WHERE date(date/1000,'unixepoch','localtime')=${q(target)}`,
    )).toBe('0');

    const listed = await apiFromPage(page, `/api/unavailable?month=${targetMonthParam}`, 'GET');
    const rows = (listed.json as { unavailableDates: { date: string }[] })
      .unavailableDates.filter((r) => r.date === target);
    expect(rows).toHaveLength(0);
  });

  /**
   * FIXED P-16 — changing month during the initial load no longer poisons the
   * panel.
   *
   * `changeMonthDuringLoad` does exactly what the finding describes: load
   * /admin and start clicking the next-month chevron without waiting for the
   * first `GET /api/bookings` / `GET /api/unavailable` pair to come back. The
   * panel then had two `fetchData` runs writing over each other, and the next
   * overlay opened after that hit an infinite update loop inside radix's
   * `usePresence` and fell through to the error boundary. Both overlay kinds
   * are exercised — the finding recorded the Dialog *and* the Sheet going down
   * the same way, so a fix that only covered one would not be a fix.
   *
   * Nothing here writes: the block dialog is cancelled and the test-booking
   * sheet is closed.
   */
  it('still opens its dialogs and sheets after a month change during the load (P-16)', async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await changeMonthDuringLoad(page, 4);
      // Let the overlapping fetches finish before touching anything: the
      // question is whether the panel survives them, not whether it survives
      // being clicked during them.
      await waitForApi(page, '/api/unavailable', 'GET', { timeoutMs: 30_000 });
      await waitForQuiet(page);
      expect(await panelCrashed(page)).toBe(false);

      // Four months out, so every cell is in the future and selectable.
      const { year, month } = await shownMonth(page);
      const free = freeDayIn(year, month);
      await clickDay(page, free.day);
      await page.waitForFunction(() => document.body.innerText.includes('1 dato valgt'));

      await clickByExactText(page, 'button', 'Marker utilgjengelig');
      await page.waitForFunction(
        () => [...document.querySelectorAll('[role="dialog"][data-state="open"]')]
          .some((d) => (d.textContent || '').includes('Bekreft blokkering')),
        { timeout: 15_000 },
      );
      expect(await panelCrashed(page)).toBe(false);
      await clickInDialog(page, 'Bekreft blokkering', 'Avbryt');
      await waitForGone(page, 'Bekreft blokkering');
      expect(sqlValue(
        `SELECT count(*) FROM UnavailableDate WHERE date(date/1000,'unixepoch','localtime')=${q(free.date)}`,
      )).toBe('0');

      // The Sheet, which the finding showed going down the same way.
      await clickByExactText(page, 'button', 'Opprett testbooking');
      await page.waitForFunction(
        () => [...document.querySelectorAll('[role="dialog"][data-state="open"]')]
          .some((d) => (d.textContent || '').includes('Opprett testbooking')),
        { timeout: 15_000 },
      );
      expect(await panelCrashed(page)).toBe(false);
      await clickInDialog(page, 'Opprett testbooking', 'Avbryt');
      await waitForGone(page, 'Opprett testbooking');
    }
  });

  /**
   * FIXED P-17 — a slower earlier month cannot overwrite the month on screen.
   *
   * Every `/api/unavailable` answer except the target month's is held back by
   * two and a half seconds, so the months the admin hops *through* answer
   * after the month they land on. A day is blocked in the target month first,
   * so the assertion is concrete: the struck-through cell must appear and then
   * still be there once the stale answers have had time to land.
   *
   * Without the sequence guard in `fetchData` the last answer won, and the
   * calendar quietly went back to showing another month's blocked days under
   * the target month's header.
   */
  it('a slower earlier month does not overwrite the month being viewed (P-17)', async () => {
    const now = new Date();
    const aim = new Date(now.getFullYear(), now.getMonth() + 5, 1);
    const aimParam = monthParam(aim.getFullYear(), aim.getMonth());
    const free = freeDayIn(aim.getFullYear(), aim.getMonth());

    const created = await apiFromPage(page, '/api/unavailable', 'POST', {
      dates: [free.date], reason: REASON,
    });
    expect(created.status).toBe(200);
    expect((created.json as { created: unknown[] }).created).toHaveLength(1);

    const slowOthers = (req: HTTPRequest) => {
      const url = req.url();
      const stale = url.includes('/api/unavailable?month=') && !url.includes(`month=${aimParam}`);
      if (stale) {
        setTimeout(() => { void req.continue().catch(() => {}); }, 2_500);
        return;
      }
      void req.continue().catch(() => {});
    };

    try {
      await page.setRequestInterception(true);
      page.on('request', slowOthers);

      page.seen.length = 0;
      await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
      await waitForHydration(page);
      // No waiting between hops: the months passed through must still be in
      // flight when the target month answers.
      await stepToMonth(page, aimParam);

      const isStruck = () => page.evaluate((n: number) => {
        const grid = [...document.querySelectorAll('div.grid.grid-cols-7')]
          .find((g) => g.querySelector('button'));
        const btn = [...(grid?.querySelectorAll('button') ?? [])].find(
          (b) => b.querySelector('span.leading-none')?.textContent?.trim() === String(n),
        );
        return !!btn && (btn as HTMLElement).className.includes('line-through');
      }, free.day);

      await page.waitForFunction((n: number) => {
        const grid = [...document.querySelectorAll('div.grid.grid-cols-7')]
          .find((g) => g.querySelector('button'));
        const btn = [...(grid?.querySelectorAll('button') ?? [])].find(
          (b) => b.querySelector('span.leading-none')?.textContent?.trim() === String(n),
        );
        return !!btn && (btn as HTMLElement).className.includes('line-through');
      }, { timeout: 30_000 }, free.day);

      // Past the artificial delay: every held-back month has answered by now.
      await settle(page, 4_000);
      const after = await shownMonth(page);
      expect(monthParam(after.year, after.month)).toBe(aimParam);
      expect(await isStruck()).toBe(true);
      expect(await panelCrashed(page)).toBe(false);
    } finally {
      page.off('request', slowOthers);
      await page.setRequestInterception(false).catch(() => {});
      const ids = sqlRows(
        `SELECT id FROM UnavailableDate WHERE date(date/1000,'unixepoch','localtime')=${q(free.date)}`,
      ).map((r) => r[0]);
      if (ids.length) await apiFromPage(page, '/api/unavailable', 'DELETE', { ids });
    }
  });

});
