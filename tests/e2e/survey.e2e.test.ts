/**
 * L4 — the needs survey at /undersokelse.
 *
 * Each section is one wizard step; "Neste" refuses to advance while a required
 * question in the step is unanswered, and the e-mail step is gated on the
 * consent checkbox once an address is typed. A completed run writes one
 * SurveyResponse row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'puppeteer-core';
import {
  E2E_READY, acquireInstanceLock, auditEmail, clickText, exec, goto, openBrowser, pageText, queryAll,
  releaseInstanceLock, sleep,
} from './helpers';

const EMAIL = auditEmail('survey');
const createdIds: string[] = [];

/** Answer every question rendered in the current step. */
async function answerStep(page: Page, opts: { email?: string; consent?: boolean } = {}): Promise<void> {
  // One click on the first option of every option group (radio / check / likert).
  await page.evaluate(() => {
    const nav = /^(Neste|Tilbake|Send inn|Start|Sender)/;
    const buttons = [...document.querySelectorAll('button')].filter((b) => !nav.test(b.innerText.trim()));
    const groups = new Map<Element, HTMLElement[]>();
    for (const b of buttons) {
      const parent = b.parentElement;
      if (!parent) continue;
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent)!.push(b as HTMLElement);
    }
    for (const [, arr] of groups) arr[0].click();
  });
  await sleep(250);

  // Free-text, numeric and range answers go through React's own value setter;
  // assigning `.value` directly leaves React's change tracker unaware.
  await page.evaluate((email) => {
    const setInputValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    const setAreaValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    document.querySelectorAll('textarea').forEach((t) => {
      setAreaValue.call(t, 'Audit 2A e2e');
      t.dispatchEvent(new Event('input', { bubbles: true }));
    });
    document.querySelectorAll<HTMLInputElement>('input[type=range]').forEach((r) => {
      // Deliberately different from the pre-positioned midpoint so this helper
      // exercises the ordinary drag. (A midpoint answer is accepted too since
      // Q-15 — that path has its own test below.)
      setInputValue.call(r, String(Number(r.max)));
      r.dispatchEvent(new Event('input', { bubbles: true }));
      r.dispatchEvent(new Event('change', { bubbles: true }));
    });
    document.querySelectorAll<HTMLInputElement>('input').forEach((i) => {
      if (['checkbox', 'radio', 'range'].includes(i.type)) return;
      if (i.type === 'email') {
        if (!email) return;
        setInputValue.call(i, email);
      } else {
        setInputValue.call(i, /post/i.test(i.id) ? '8006' : 'Audit 2A');
      }
      i.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }, opts.email ?? '');
  await sleep(250);

  if (opts.consent) {
    await page.evaluate(() => {
      document.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((c) => {
        if (!c.checked) c.click();
      });
    });
    await sleep(250);
  }
}

async function runWizard(page: Page, opts: { email?: string; consent?: boolean } = {}): Promise<void> {
  await goto(page, '/undersokelse');
  await sleep(1500);
  await clickText(page, 'button', 'Start');
  await sleep(700);

  for (let step = 0; step < 20; step++) {
    const last = await page.evaluate(() =>
      !![...document.querySelectorAll('button')].find((b) => /Send inn/.test(b.innerText)),
    );
    await answerStep(page, last ? opts : {});
    await clickText(page, 'button', last ? 'Send inn' : 'Neste');
    await sleep(1200);
    const state = await page.evaluate(() => ({
      error: [...document.querySelectorAll('.text-destructive')].map((e) => (e as HTMLElement).innerText.trim())[0] ?? null,
      done: /Tusen takk/.test(document.body.innerText),
    }));
    if (state.error) throw new Error(`survey blocked at step ${step + 1}: ${state.error}`);
    if (state.done) return;
  }
  throw new Error('survey never reached the thank-you screen');
}

function surveyRows() {
  return queryAll<{ id: string; email: string | null; data: string }>(
    "SELECT id, email, data FROM SurveyResponse WHERE data LIKE '%Audit 2A e2e%' OR email = ?",
    EMAIL,
  );
}

describe.skipIf(!E2E_READY)('L4 needs survey', () => {
  beforeAll(async () => {
    await acquireInstanceLock('survey');
  }, 900_000);

  afterAll(() => {
    for (const id of createdIds) exec('DELETE FROM SurveyResponse WHERE id = ?', id);
    releaseInstanceLock();
  });

  it('refuses to advance past a step whose required questions are unanswered', async () => {
    const session = await openBrowser();
    try {
      const { page } = session;
      await goto(page, '/undersokelse');
      await sleep(1500);
      expect(await pageText(page)).toContain('Hjelp oss å forme');

      await clickText(page, 'button', 'Start');
      await sleep(700);
      const before = await page.evaluate(() => document.body.innerText.match(/Steg (\d+) av (\d+)/)?.[0] ?? null);
      expect(before).toMatch(/^Steg 1 av /);

      await clickText(page, 'button', 'Neste');
      await sleep(800);
      // FIXED Q-15 — the refusal names the questions it is waiting for and
      // marks each one, instead of one generic "svar på spørsmålene" with no
      // marker anywhere on a five-question step.
      const after = await page.evaluate(() => {
        const labels = [...document.querySelectorAll('label')]
          .map((l) => l.innerText.replace(/\s+/g, ' ').trim())
          .filter((t) => t.endsWith('Mangler svar'))
          .map((t) => t.replace(/ ?Mangler svar$/, '').trim());
        return {
          step: document.body.innerText.match(/Steg (\d+) av (\d+)/)?.[0] ?? null,
          generic: /Vennligst svar på spørsmålene før du går videre/.test(document.body.innerText),
          summary: [...document.querySelectorAll('p.text-destructive, .text-destructive p')]
            .map((e) => (e as HTMLElement).innerText.trim())
            .find((t) => t.startsWith('Mangler svar:')) ?? null,
          markedLabels: labels,
        };
      });
      expect(after.step, 'an empty step must not advance').toBe(before);
      expect(after.generic, 'the anonymous catch-all message is gone').toBe(false);
      expect(after.markedLabels.length, 'every blocking question is marked in place').toBeGreaterThan(0);
      expect(after.summary, 'the message names the questions').toBeTruthy();
      for (const label of after.markedLabels) {
        expect(after.summary!).toContain(label);
      }
    } finally {
      await session.close();
    }
  }, 180_000);

  it('accepts a range answer left at the pre-positioned midpoint', async () => {
    const session = await openBrowser();
    try {
      const { page } = session;
      await goto(page, '/undersokelse');
      await sleep(1500);
      await clickText(page, 'button', 'Start');
      await sleep(700);

      // Walk forward until a step carries a slider, answering everything else.
      let found = false;
      for (let step = 0; step < 20; step++) {
        found = await page.evaluate(() => document.querySelectorAll('input[type=range]').length > 0);
        if (found) break;
        await answerStep(page);
        await clickText(page, 'button', 'Neste');
        await sleep(1100);
      }
      expect(found, 'the survey has at least one range question').toBe(true);

      // FIXED Q-15 — the thumb starts at the midpoint, and a range input fires
      // no change event when it is already where the respondent wants it, so a
      // respondent whose answer *is* the midpoint had to drag away and back.
      // Any deliberate interaction now commits the value on screen, and the
      // untouched state says so in words rather than looking answered.
      const before = await page.evaluate(() => {
        const r = document.querySelector('input[type=range]') as HTMLInputElement;
        return { value: r.value, text: (r.parentElement as HTMLElement).innerText };
      });
      expect(before.text).toContain('Ikke besvart');

      await page.evaluate(() => {
        const r = document.querySelector('input[type=range]') as HTMLInputElement;
        r.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      });
      await sleep(400);

      const after = await page.evaluate(() => {
        const r = document.querySelector('input[type=range]') as HTMLInputElement;
        return { value: r.value, text: (r.parentElement as HTMLElement).innerText };
      });
      expect(after.value, 'the midpoint itself is the answer').toBe(before.value);
      expect(after.text).not.toContain('Ikke besvart');
    } finally {
      await session.close();
    }
  }, 300_000);

  it('gates the optional e-mail on the consent checkbox', async () => {
    const session = await openBrowser();
    try {
      const { page } = session;
      // Typing an address without ticking consent must NOT submit.
      await expect(runWizard(page, { email: EMAIL, consent: false })).rejects.toThrow(/blocked at step/);
      const stillOnForm = await pageText(page);
      expect(stillOnForm).not.toContain('Tusen takk');
      // FIXED Q-15 — the last step's blocker is an unticked consent box beside
      // an explicitly optional e-mail. It used to produce "Vennligst svar på
      // spørsmålene", pointing at no required question the respondent could
      // see. The refusal now says what is actually missing, and the e-mail
      // question itself carries the marker.
      expect(stillOnForm).toContain('Kryss av for samtykke');
      expect(stillOnForm).not.toContain('Vennligst svar på spørsmålene');
      expect(
        await page.evaluate(() =>
          [...document.querySelectorAll('label')].some((l) => /Mangler samtykke/.test(l.innerText)),
        ),
      ).toBe(true);
    } finally {
      await session.close();
    }
    expect(surveyRows().length).toBe(createdIds.length);
  }, 300_000);

  it('submits anonymously and stores exactly one response', async () => {
    const before = surveyRows().length;
    const session = await openBrowser();
    try {
      await runWizard(session.page);
      expect(await pageText(session.page)).toContain('Tusen takk');
    } finally {
      await session.close();
    }
    await sleep(800);
    const rows = surveyRows();
    expect(rows.length).toBe(before + 1);
    const row = rows[rows.length - 1];
    createdIds.push(row.id);
    expect(row.email ?? '').toBe('');
    const answers = JSON.parse(row.data) as Record<string, unknown>;
    expect(Object.keys(answers).length).toBeGreaterThan(5);
  }, 300_000);

  it('stores the e-mail when consent is given', async () => {
    const before = surveyRows().length;
    const session = await openBrowser();
    try {
      await runWizard(session.page, { email: EMAIL, consent: true });
      expect(await pageText(session.page)).toContain('Tusen takk');
    } finally {
      await session.close();
    }
    await sleep(800);
    const rows = surveyRows();
    expect(rows.length).toBe(before + 1);
    const row = rows[rows.length - 1];
    createdIds.push(row.id);
    expect(row.email).toBe(EMAIL);
  }, 300_000);
});
