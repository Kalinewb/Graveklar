/**
 * L4 — Innstillinger: the two halves of the settings gate.
 *
 * A non-sensitive group (Innhold) must save without a second factor and the
 * value must survive a reload; a sensitive group (Behovsundersøkelse) must be
 * refused with `requiresTotp` and leave the change pending in the form, so the
 * admin can see that nothing was written. Nothing here enrols TOTP — the
 * refusal path *is* the assertion, and the enrollment modal is cancelled.
 *
 * Also pins the unsaved-changes guard: `beforeunload` is prevented exactly
 * while the SaveBar reports a dirty field.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'puppeteer-core';

import {
  LIVE, adminSession, clickByText, clickInDialog, hasText, launchBrowser,
  newPage, openAdmin, openTab, seenMark, setInputByLabel, settle, sqlValue, waitForApi,
  waitForElementWithText, waitForOverlaysDismissed, type SeenResponse,
} from './admin-helpers';

// Unique per run: a value identical to what the field already holds produces
// no dirty state, and a leftover from an aborted run would silently do exactly
// that.
const MARKER = `AUDIT2B e2e SEO-beskrivelse ${Date.now()}`;
const MARKER_PREFIX = 'AUDIT2B e2e SEO';

describe.skipIf(!LIVE)('admin settings save + 2FA refusal (L4)', { timeout: 90_000 }, () => {
  let browser: Browser;
  let page: Page & { seen: SeenResponse[] };
  let originalSeo = '';

  beforeAll(async () => {
    browser = await launchBrowser();
    page = await newPage(browser);
    await adminSession(page);
    const stored = sqlValue(`SELECT value FROM AppConfig WHERE key='seoDescription'`) ?? '';
    // Never adopt a leftover marker as "the value this instance had".
    originalSeo = stored.startsWith(MARKER_PREFIX) ? '' : stored;
  }, 90_000);

  afterAll(async () => {
    // Self-cleaning: put back whatever the instance had, through the app's own
    // endpoint so the config cache is invalidated the way the UI would.
    if (page && !page.isClosed()) {
      await page.evaluate(async (value: string) => {
        await fetch('/api/admin/app-config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          // The route takes a bare array — `{updates: […]}` is answered 400
          // and the restore would silently not happen.
          body: JSON.stringify([{ key: 'seoDescription', value }]),
        });
      }, originalSeo);
    }
    await browser?.close();
  }, 60_000);

  /** Open Innstillinger → one group in the left sidebar. */
  async function openSettingsGroup(p: Page, group: string): Promise<void> {
    await openAdmin(p as Page & { seen: SeenResponse[] });
    await openTab(p, 'Innstillinger', '2FA er ikke satt opp');
    await p.waitForSelector('aside button');
    await clickByText(p, 'aside button', group);
    await settle(p);
  }

  it('saves a non-sensitive group without 2FA and the value survives a reload', async () => {
    await openSettingsGroup(page, 'Innhold');

    await setInputByLabel(page, 'SEO-beskrivelse', MARKER);

    await waitForElementWithText(page, 'span', '1 endring ikke lagret');

    // The unsaved-changes guard is armed exactly while the form is dirty.
    const preventedWhileDirty = await page.evaluate(() => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    });
    expect(preventedWhileDirty).toBe(true);

    const savedMark = seenMark(page);
    await clickByText(page, 'button', 'Lagre');
    await waitForElementWithText(page, 'span', 'Lagret');

    expect((await waitForApi(page, '/api/admin/app-config', 'POST', { since: savedMark })).status)
      .toBe(200);
    expect(sqlValue(`SELECT value FROM AppConfig WHERE key='seoDescription'`)).toBe(MARKER);

    // The public config endpoint serves the new value after a reload — i.e.
    // the write reached the cache the customer site reads, not just the row.
    await page.reload({ waitUntil: 'domcontentloaded' });
    const served = await page.evaluate(async () => {
      const r = await fetch('/api/app-config');
      return (await r.json()).seoDescription as string;
    });
    expect(served).toBe(MARKER);
  });

  it('refuses a sensitive group with requiresTotp and keeps the change unsaved', async () => {
    const before = sqlValue(`SELECT value FROM AppConfig WHERE key='surveyLeadDiscountPercent'`);

    await openSettingsGroup(page, 'Behovsundersøkelse');
    expect(await hasText(page, 'Sensitiv')).toBe(true);

    // Bump the lead-discount stepper by one. Any field in the group is gated.
    await page.evaluate(() => {
      const label = [...document.querySelectorAll('label')]
        .find((l) => (l.textContent || '').includes('Rabattprosent'));
      const input = document.getElementById(label!.getAttribute('for')!);
      const inc = input!.parentElement!.querySelector('button[aria-label="Øk"]');
      (inc as HTMLButtonElement).click();
    });
    await waitForElementWithText(page, 'span', '1 endring ikke lagret');

    const mark = seenMark(page);
    await clickByText(page, 'button', 'Lagre');
    // Wait for the save itself, not for the words "Sett opp 2FA": the security
    // banner on this tab carries that label all the time.
    const save = await waitForApi(page, '/api/admin/app-config', 'POST', { since: mark });
    expect(save.status).toBe(401);
    await page.waitForFunction(
      () => [...document.querySelectorAll('[role="dialog"][data-state="open"]')]
        .some((d) => (d.textContent || '').includes('Sett opp 2FA')),
    );

    // NEVER enrol. Back out: the edit must still be pending, the row untouched,
    // and the panel must say so rather than looking saved.
    await clickInDialog(page, 'Sett opp 2FA', 'Avbryt');
    await waitForElementWithText(page, 'div', 'Ikke lagret');

    expect(await hasText(page, 'krever 2FA')).toBe(true);
    expect(await hasText(page, '1 endring ikke lagret')).toBe(true);
    expect(sqlValue(`SELECT value FROM AppConfig WHERE key='surveyLeadDiscountPercent'`)).toBe(before);
    expect(sqlValue('SELECT count(*) FROM AdminTotp')).toBe('0');

    // FIXED P-8, first half: the banner belongs to the group whose save was
    // refused. Switching group used to carry it along to a panel it said
    // nothing true about.
    // The cancelled modal has to be fully out of the way first: Radix leaves
    // `pointer-events: none` on <body> until its exit animation ends, and a
    // click that lands before then hits nothing and reports success.
    await waitForOverlaysDismissed(page);

    // Waits for the panel to have switched — a fixed pause is not enough on a
    // loaded dev server, and sampling mid-switch would read the old panel.
    await clickByText(page, 'aside button', 'Innhold');
    await waitForElementWithText(page, 'label', 'SEO-beskrivelse');
    expect(await hasText(page, 'Ikke lagret')).toBe(false);

    // Back on the gated group the edit is still pending — clearing the banner
    // must not have cleared the change with it.
    await clickByText(page, 'aside button', 'Behovsundersøkelse');
    await waitForElementWithText(page, 'label', 'Rabattprosent');
    expect(await hasText(page, '1 endring ikke lagret')).toBe(true);

    // Forkast puts the panel back in sync with the server.
    await clickByText(page, 'button', 'Forkast endringer');
    await waitForElementWithText(page, 'span', 'Alt er lagret');
    expect(sqlValue(`SELECT value FROM AppConfig WHERE key='surveyLeadDiscountPercent'`)).toBe(before);

    // FIXED P-8, second half: the SaveBar says everything is saved and the
    // banner above it no longer claims otherwise. The two halves of the panel
    // used to disagree until the page was reloaded.
    expect(await hasText(page, 'Ikke lagret')).toBe(false);
    expect(await hasText(page, 'krever 2FA')).toBe(false);
  });

  it('never enrolled a second factor', () => {
    expect(sqlValue('SELECT count(*) FROM AdminTotp')).toBe('0');
  });
});
