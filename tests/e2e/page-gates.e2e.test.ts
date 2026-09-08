/**
 * L4 — the flag-gated public pages and the footer that links to them.
 *
 * `/kontakt` is on when `contactFormEnabled` is not 'false'; `/bedrift` is off
 * unless `b2bEnabled` is 'true' (it is off by design). The footer link to
 * /kontakt has to appear and disappear with the page, and the "page is off"
 * answer has to be an actual 404 — a link checker or a crawler only sees the
 * status line.
 *
 * The 404 status codes are the regression guard for Q-6: they only hold while
 * no Suspense boundary sits above these segments. Re-adding `src/app/loading.tsx`
 * would stream a 200 shell before the page's `notFound()` could run and turn
 * these three assertions red again.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONFIG_CACHE_MS, E2E_READY, acquireInstanceLock, appConfig, goto, openBrowser, pageText, releaseInstanceLock,
  setAppConfig, sleep, BASE_URL,
} from './helpers';

let previousContact = '';

async function status(pathname: string): Promise<number> {
  const res = await fetch(BASE_URL + pathname, { redirect: 'manual' });
  await res.text();
  return res.status;
}

async function footerLinks(): Promise<string[]> {
  const session = await openBrowser();
  try {
    await goto(session.page, '/');
    await sleep(2000);
    // `await` before the finally block closes the browser — returning the
    // promise itself would let session.close() race the evaluation.
    const links = await session.page.evaluate(() =>
      [...document.querySelectorAll('footer a')].map((a) => a.getAttribute('href') ?? ''),
    );
    return links;
  } finally {
    await session.close();
  }
}

describe.skipIf(!E2E_READY)('L4 public page gates', () => {
  beforeAll(async () => {
    await acquireInstanceLock('page-gates');
    previousContact = appConfig('contactFormEnabled') ?? 'true';
  }, 900_000);

  afterAll(async () => {
    setAppConfig('contactFormEnabled', previousContact);
    await sleep(CONFIG_CACHE_MS);
    releaseInstanceLock();
  }, 60_000);

  it('serves /vilkar without the Bedrift tab while b2bEnabled is off', async () => {
    // FIXED Q-14 — the Bedrift tab states "Gjelder ved utleie til
    // næringsdrivende (B2B)" while /bedrift is a 404 and the insurance cover is
    // consumer-only. src/app/vilkar/page.tsx now sends no business terms when
    // b2bEnabled is off, which is what hides the tab.
    expect(appConfig('b2bEnabled'), 'B2B is off by design; the audit never turns it on').toBe('false');

    const session = await openBrowser();
    try {
      const { page } = session;
      await goto(page, '/vilkar');
      await sleep(1500);
      const tabs = await page.evaluate(() =>
        [...document.querySelectorAll('button')].map((b) => b.innerText.trim()).filter(Boolean),
      );
      expect(tabs).toEqual(expect.arrayContaining(['Privat', 'Manualer']));
      expect(tabs).not.toContain('Bedrift');
      const text = await pageText(page);
      expect(text).toContain('Leievilkår – privat');
      expect(text).not.toContain('Gjelder ved utleie til næringsdrivende');

      // FIXED W-6 — the clause numbers were `text-muted-foreground/50`, which
      // composites to 2.99:1 on the dark page ground. Full-strength muted only.
      const clauseClasses = await page.evaluate(() =>
        [...document.querySelectorAll('li > span.font-mono')].map((s) => s.className),
      );
      expect(clauseClasses.length).toBeGreaterThan(0);
      expect(clauseClasses.every((c) => c.includes('text-muted-foreground'))).toBe(true);
      expect(clauseClasses.some((c) => c.includes('text-muted-foreground/'))).toBe(false);
    } finally {
      await session.close();
    }
  }, 120_000);

  it('serves /personvern', async () => {
    const session = await openBrowser();
    try {
      await goto(session.page, '/personvern');
      await sleep(1200);
      expect(await pageText(session.page)).toContain('Personvernerklæring');
    } finally {
      await session.close();
    }
  }, 120_000);

  it('shows the contact form and the footer link while contactFormEnabled is on', async () => {
    setAppConfig('contactFormEnabled', 'true');
    await sleep(CONFIG_CACHE_MS);

    const session = await openBrowser();
    try {
      const { page } = session;
      await goto(page, '/kontakt');
      await sleep(1500);
      const fields = await page.evaluate(() =>
        [...document.querySelectorAll('input, textarea')].map((i) => ({
          id: (i as HTMLInputElement).id,
          name: (i as HTMLInputElement).name,
          required: (i as HTMLInputElement).required,
          visible: !!((i as HTMLElement).offsetParent || i.getClientRects().length),
        })),
      );
      // The honeypot is present, unnamed to a human, and never rendered.
      const honeypot = fields.find((f) => f.name === 'website');
      expect(honeypot, 'the contact form carries a honeypot').toBeTruthy();
      expect(honeypot!.visible).toBe(false);
      expect(fields.filter((f) => f.visible && f.required).map((f) => f.id).sort())
        .toEqual(['k-email', 'k-message', 'k-name']);
    } finally {
      await session.close();
    }

    expect(await footerLinks()).toContain('/kontakt');
  }, 240_000);

  it('hides both the page and the footer link while contactFormEnabled is off', async () => {
    setAppConfig('contactFormEnabled', 'false');
    await sleep(CONFIG_CACHE_MS);

    const session = await openBrowser();
    try {
      await goto(session.page, '/kontakt');
      await sleep(1500);
      const text = await pageText(session.page);
      expect(text).toContain('Siden finnes ikke');
      expect(text).not.toContain('Send oss en melding');
    } finally {
      await session.close();
    }

    expect(await footerLinks()).not.toContain('/kontakt');

    // FIXED Q-6 — a page turned off with notFound() answers a real 404, not a
    // 200 with the 404 body.
    expect(await status('/kontakt')).toBe(404);
    expect(await status('/finnes-ikke-audit-2a')).toBe(404);
  }, 240_000);

  it('404s /bedrift while b2bEnabled is off, and never enables it', async () => {
    expect(appConfig('b2bEnabled'), 'B2B is off by design; the audit never turns it on').toBe('false');

    const session = await openBrowser();
    try {
      await goto(session.page, '/bedrift');
      await sleep(1500);
      const text = await pageText(session.page);
      expect(text).toContain('Siden finnes ikke');
      expect(text).not.toContain('Leie til bedrift');
    } finally {
      await session.close();
    }

    // FIXED Q-6 again: the body is the 404 page and so is the status line —
    // for the flag-gated page and for an unresolvable offer token.
    expect(await status('/bedrift')).toBe(404);
    expect(await status('/tilbud/audit2a-ikke-en-token')).toBe(404);
  }, 180_000);

  it('rejects a contact submission that fills the honeypot', async () => {
    setAppConfig('contactFormEnabled', 'true');
    await sleep(CONFIG_CACHE_MS);
    const res = await fetch(BASE_URL + '/api/kontakt', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.77.77.77' },
      body: JSON.stringify({
        name: 'Bot', email: 'bot@example.invalid', message: 'lang nok melding her',
        website: 'http://spam.example',
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Ugyldig forespørsel');
  }, 120_000);
});
