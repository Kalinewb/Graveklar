/**
 * L4 — FAQ CRUD from the Innhold tab.
 *
 * The FAQ is the one piece of customer-facing copy the owner edits most often,
 * and it is plain CRUD with no second factor in front of it — so the thing
 * worth pinning is that each of the four operations reaches the database and
 * that the list reflects it without a manual reload.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'puppeteer-core';

import {
  LIVE, adminSession, apiFromPage, clickByExactText, launchBrowser, newPage,
  openAdmin, openTab, q, seenMark, setInput, sqlRows, sqlValue, waitForApi, waitForGone,
  type SeenResponse,
} from './admin-helpers';

const QUESTION = 'AUDIT2B e2e — hva skjer med dette spørsmålet?';
const QUESTION2 = 'AUDIT2B e2e — redigert spørsmål';
const ANSWER = 'Det blir opprettet, redigert, deaktivert og slettet av tests/e2e/admin-faq.e2e.test.ts.';

describe.skipIf(!LIVE)('admin FAQ CRUD (L4)', { timeout: 90_000 }, () => {
  let browser: Browser;
  let page: Page & { seen: SeenResponse[] };
  let faqId = '';

  beforeAll(async () => {
    browser = await launchBrowser();
    page = await newPage(browser);
    await adminSession(page);
    // Purge leftovers from an aborted run so the row lookups stay unambiguous.
    for (const [id] of sqlRows(
      `SELECT id FROM FaqItem WHERE question IN (${q(QUESTION)}, ${q(QUESTION2)})`,
    )) {
      await apiFromPage(page, `/api/admin/faq/${id}`, 'DELETE');
    }
    await openAdmin(page);
    await openTab(page, 'Innhold', 'FAQ');
  }, 90_000);

  afterAll(async () => {
    if (page && !page.isClosed() && faqId) {
      await apiFromPage(page, `/api/admin/faq/${faqId}`, 'DELETE');
    }
    await browser?.close();
  }, 60_000);

  /**
   * Click a button inside the FAQ card — the Innhold tab also holds Vilkår and
   * Forsikring cards with identically labelled buttons — optionally narrowed to
   * the row for one question.
   */
  async function clickInFaqCard(
    p: Page, buttonSelector: string, opts: { text?: string; rowText?: string } = {},
  ): Promise<void> {
    const ok = await p.evaluate(
      (sel: string, txt: string | null, rowText: string | null) => {
        const title = [...document.querySelectorAll('div')]
          .find((d) => (d.textContent || '').trim() === 'FAQ');
        let header: HTMLElement | null = title as HTMLElement | null;
        while (header && !header.querySelector('button')) header = header.parentElement;
        const card = header?.parentElement ?? null;
        if (!card) return false;

        let scope: HTMLElement | null = card;
        if (rowText) {
          // The *innermost* div that holds both the question and the control:
          // an outer match would be the whole card, whose first "Rediger"
          // belongs to somebody else's FAQ entry.
          const matches = [...card.querySelectorAll('div')].filter(
            (d) => (d.textContent || '').includes(rowText) && !!d.querySelector(sel),
          ) as HTMLElement[];
          scope = matches.find((m) => !matches.some((o) => o !== m && m.contains(o))) ?? null;
        }
        if (!scope) return false;

        const el = [...scope.querySelectorAll(sel)].find(
          (c) => !txt || (c.textContent || '').trim() === txt,
        ) as HTMLElement | undefined;
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      },
      buttonSelector, opts.text ?? null, opts.rowText ?? null,
    );
    if (!ok) throw new Error(`no ${buttonSelector} (${opts.text ?? 'any'}) in the FAQ card`);
  }

  it('creates a FAQ item', async () => {
    await clickInFaqCard(page, 'button', { text: 'Legg til' });
    await page.waitForFunction(() => document.body.innerText.includes('Legg til FAQ'));

    await setInput(page, '[role="dialog"][data-state="open"] input', QUESTION);
    await setInput(page, '[role="dialog"][data-state="open"] textarea', ANSWER);
    await clickByExactText(page, '[role="dialog"][data-state="open"] button', 'Legg til');
    await waitForGone(page, 'Legg til FAQ');

    faqId = sqlValue(`SELECT id FROM FaqItem WHERE question=${q(QUESTION)}`) ?? '';
    expect(faqId).not.toBe('');
    expect(sqlValue(`SELECT answer FROM FaqItem WHERE id=${q(faqId)}`)).toBe(ANSWER);
    expect(sqlValue(`SELECT isActive FROM FaqItem WHERE id=${q(faqId)}`)).toBe('1');

    // The list refreshes itself — no reload needed to see the new row.
    const listed = await page
      .waitForFunction((t: string) => document.body.innerText.includes(t), { timeout: 15_000 }, QUESTION)
      .then(() => true).catch(() => false);
    expect(listed).toBe(true);
  });

  it('edits the question', async () => {
    await clickInFaqCard(page, 'button', { text: 'Rediger', rowText: QUESTION });
    await page.waitForFunction(() => document.body.innerText.includes('Rediger FAQ'));
    await setInput(page, '[role="dialog"][data-state="open"] input', QUESTION2);
    await clickByExactText(page, '[role="dialog"][data-state="open"] button', 'Lagre');
    await waitForGone(page, 'Rediger FAQ');

    expect(sqlValue(`SELECT question FROM FaqItem WHERE id=${q(faqId)}`)).toBe(QUESTION2);
    // Editing one field must not blank the others.
    expect(sqlValue(`SELECT answer FROM FaqItem WHERE id=${q(faqId)}`)).toBe(ANSWER);
    const relisted = await page
      .waitForFunction((t: string) => document.body.innerText.includes(t), { timeout: 15_000 }, QUESTION2)
      .then(() => true).catch(() => false);
    expect(relisted).toBe(true);
  });

  it('deactivates the item without deleting it', async () => {
    const mark = seenMark(page);
    await clickInFaqCard(page, 'button[role="switch"]', { rowText: QUESTION2 });
    // Wait for the toggle's own PATCH rather than a fixed pause.
    expect((await waitForApi(page, `/api/admin/faq/${faqId}`, 'PATCH', { since: mark })).status)
      .toBe(200);
    expect(sqlValue(`SELECT isActive FROM FaqItem WHERE id=${q(faqId)}`)).toBe('0');
    expect(sqlValue(`SELECT count(*) FROM FaqItem WHERE id=${q(faqId)}`)).toBe('1');
  });

  it('deletes the item after the confirm', async () => {
    await clickInFaqCard(page, 'button.text-destructive', { rowText: QUESTION2 });
    await page.waitForFunction(
      (txt: string) => !document.body.innerText.includes(txt),
      { timeout: 20_000 }, QUESTION2,
    );
    expect(sqlValue(`SELECT count(*) FROM FaqItem WHERE id=${q(faqId)}`)).toBe('0');
    faqId = '';
  });
});
