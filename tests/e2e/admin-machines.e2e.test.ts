/**
 * L4 — Utstyr: the machine lifecycle an owner actually performs.
 *
 * create → edit a non-price field (session alone) → edit a price (second factor
 * demanded, nothing written and the drawer says so when the prompt is
 * cancelled) → move it in the fleet order → refuse deletion while a live
 * booking points at the machine (409) → delete once it does not.
 *
 * The 409 is the load-bearing one: without it, deleting a machine would take a
 * confirmed rental's equipment with it, and the route's message is all that
 * stands between an owner and that.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'puppeteer-core';

import {
  LIVE, adminSession, apiFromPage, clickByExactText, clickInDialog,
  createMockBooking, lastCall, launchBrowser, newPage, openAdmin, openTab, q, setInput,
  seenMark, sqlExec, sqlRows, waitForApi,
  sqlValue, waitForGone, type SeenResponse,
} from './admin-helpers';

const NAME = 'AUDIT2B E2E Testmaskin';
const DESC = 'Opprettet av tests/e2e/admin-machines.e2e.test.ts';
const DESC2 = 'Redigert beskrivelse — ingen 2FA nødvendig.';
const BOOKING_NAME = '[TESTBOOKING] AUDIT2B maskinsperre';

/** Far enough out that nothing else in the audit run wants the date. */
function farFutureDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 210);
  return d.toISOString().slice(0, 10);
}

/**
 * Click a control inside one machine's card. The list is ordered by sortOrder
 * then createdAt, so "the first Rediger button" is somebody else's machine.
 */
async function clickInMachineCard(page: Page, name: string, selector: string, text?: string): Promise<void> {
  const ok = await page.evaluate((n: string, sel: string, txt: string | null) => {
    const title = [...document.querySelectorAll('div')]
      .find((d) => d.className.includes('font-semibold') && d.textContent?.trim() === n);
    let node: HTMLElement | null = title as HTMLElement | null;
    while (node && !node.querySelector(sel)) node = node.parentElement;
    if (!node) return false;
    const candidates = [...node.querySelectorAll(sel)] as HTMLElement[];
    const el = txt ? candidates.find((c) => (c.textContent || '').trim() === txt) : candidates[0];
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  }, name, selector, text ?? null);
  if (!ok) throw new Error(`no ${selector}${text ? ` (${text})` : ''} in the card for ${name}`);
}

describe.skipIf(!LIVE)('admin machines CRUD + delete guard (L4)', { timeout: 90_000 }, () => {
  let browser: Browser;
  let page: Page & { seen: SeenResponse[] };
  let machineId = '';
  let bookingId = '';
  let bookingEmail = '';
  // The fleet order this instance had before the reorder test touched it.
  let originalOrder: [string, string][] = [];
  const runStart = Date.now();

  beforeAll(async () => {
    browser = await launchBrowser();
    page = await newPage(browser);
    await adminSession(page);

    // Purge anything a previous aborted run left behind, so `SELECT … WHERE
    // name = NAME` identifies exactly one row and the fixture starts clean.
    for (const [id] of sqlRows(`SELECT id FROM Booking WHERE name=${q(BOOKING_NAME)}`)) {
      await apiFromPage(page, `/api/bookings/${id}`, 'PATCH', {
        status: 'cancelled', reason: 'AUDIT2B e2e opprydding',
      });
      await apiFromPage(page, `/api/bookings/${id}`, 'DELETE');
    }
    for (const [id] of sqlRows(`SELECT id FROM Machine WHERE name=${q(NAME)}`)) {
      await apiFromPage(page, `/api/admin/machines/${id}`, 'DELETE');
    }

    originalOrder = sqlRows('SELECT id, sortOrder FROM Machine')
      .map(([id, sortOrder]) => [id, sortOrder] as [string, string]);

    await openAdmin(page);
    await openTab(page, 'Utstyr', 'Legg til utstyr');
  }, 90_000);

  afterAll(async () => {
    // Self-cleaning even if an expectation blew up halfway through.
    if (page && !page.isClosed()) {
      if (bookingId) {
        await apiFromPage(page, `/api/bookings/${bookingId}`, 'PATCH', {
          status: 'cancelled', reason: 'AUDIT2B e2e opprydding',
        });
        await apiFromPage(page, `/api/bookings/${bookingId}`, 'DELETE');
      }
      if (machineId) await apiFromPage(page, `/api/admin/machines/${machineId}`, 'DELETE');
      // Put the fleet order back exactly as it was — the customer site reads
      // it, and another agent may be looking at that while this runs.
      for (const [id, sortOrder] of originalOrder) {
        await apiFromPage(page, `/api/admin/machines/${id}`, 'PATCH', { sortOrder: Number(sortOrder) });
      }
    }
    // A mock booking is created already paid, so cancelling it mints an
    // email-bound goodwill code. There is no admin endpoint for those.
    if (bookingEmail) {
      sqlExec(
        `DELETE FROM RepeatDiscountCode WHERE email=${q(bookingEmail)} AND createdAt >= ${runStart}`,
      );
    }
    await browser?.close();
  }, 60_000);

  it('creates a machine from the drawer', async () => {
    await clickByExactText(page, 'button', 'Legg til utstyr');
    await page.waitForSelector('input[placeholder="Rippa R22-1 Pro"]');

    await setInput(page, 'input[placeholder="Rippa R22-1 Pro"]', NAME);
    await setInput(page, 'input[placeholder="r22"]', 'audit2b-e2e');
    await setInput(page, '[role="dialog"][data-state="open"] textarea', DESC);

    await clickByExactText(page, '[role="dialog"][data-state="open"] button', 'Legg til');
    await page.waitForFunction(() => document.body.innerText.includes('Utstyr opprettet'));

    // Recorded before the assertions so a failure here still cleans up.
    machineId = sqlValue(`SELECT id FROM Machine WHERE name=${q(NAME)}`) ?? '';
    expect(machineId).not.toBe('');
    expect(lastCall(page, '/api/admin/machines', 'POST')?.status).toBe(201);
    expect(sqlValue(`SELECT description FROM Machine WHERE id=${q(machineId)}`)).toBe(DESC);
    // No price was entered, so the fleet defaults keep applying.
    expect(sqlValue(`SELECT dayPrice IS NULL FROM Machine WHERE id=${q(machineId)}`)).toBe('1');
    // The create form does not ask for a position, so a new machine lands on
    // the default and sorts last by `createdAt`. Moving it is a separate act,
    // exercised below (P-7).
    expect(sqlValue(`SELECT sortOrder FROM Machine WHERE id=${q(machineId)}`)).toBe('0');
  });

  it('edits a non-price field on the session alone', async () => {
    await clickInMachineCard(page, NAME, 'button', 'Rediger');
    await page.waitForFunction(() => document.body.innerText.includes('Rediger utstyr'));
    await setInput(page, '[role="dialog"][data-state="open"] textarea', DESC2);

    await clickByExactText(page, '[role="dialog"][data-state="open"] button', 'Lagre endringer');
    await page.waitForFunction(() => document.body.innerText.includes('Utstyr oppdatert'));

    expect(lastCall(page, `/api/admin/machines/${machineId}`, 'PATCH')?.status).toBe(200);
    expect(sqlValue(`SELECT description FROM Machine WHERE id=${q(machineId)}`)).toBe(DESC2);
    expect(sqlValue('SELECT count(*) FROM AdminTotp')).toBe('0');
  });

  it('demands 2FA for a price field and writes nothing when it is cancelled', async () => {
    await clickInMachineCard(page, NAME, 'button', 'Rediger');
    await page.waitForFunction(() => document.body.innerText.includes('Rediger utstyr'));

    // The per-machine price block sits behind a <details>.
    await page.evaluate(() => {
      const summary = [...document.querySelectorAll('summary')]
        .find((s) => (s.textContent || '').includes('Bruk egen pris'));
      (summary?.parentElement as HTMLDetailsElement | undefined)?.setAttribute('open', '');
    });
    await setInput(page, '#machine-price-dayPrice', '1234');

    const mark = seenMark(page);
    await clickByExactText(page, '[role="dialog"][data-state="open"] button', 'Lagre endringer');
    const refused = await waitForApi(page, `/api/admin/machines/${machineId}`, 'PATCH', { since: mark });
    expect(refused.status).toBe(401);
    await page.waitForFunction(
      () => [...document.querySelectorAll('[role="dialog"][data-state="open"]')]
        .some((d) => (d.textContent || '').includes('Sett opp 2FA')),
    );

    // NEVER enrol — back out of the modal instead.
    await clickInDialog(page, 'Sett opp 2FA', 'Avbryt');
    await waitForGone(page, 'Sett opp 2FA');

    // FIXED P-11: the drawer stays open with the edited price still in it, and
    // now says the save did not happen — the same sentence the pricing and
    // settings panels give in exactly this situation. It used to say nothing
    // at all, which reads as "saved".
    await page.waitForFunction(
      () => [...document.querySelectorAll('[role="dialog"][data-state="open"]')]
        .some((d) => (d.textContent || '').includes('Ikke lagret — prisendringer krever 2FA')),
      { timeout: 20_000 },
    );

    expect(sqlValue(`SELECT dayPrice IS NULL FROM Machine WHERE id=${q(machineId)}`)).toBe('1');
    expect(sqlValue('SELECT count(*) FROM AdminTotp')).toBe('0');
    // A rejected price change leaves no audit entry either.
    expect(sqlValue(
      `SELECT count(*) FROM AdminAuditLog WHERE action='machine.price_change' AND changes LIKE '%${NAME}%'`,
    )).toBe('0');

    await clickInDialog(page, 'Rediger utstyr', 'Avbryt');
    await waitForGone(page, 'Rediger utstyr');
  });

  it('moves a machine in the fleet order, writing sortOrder (P-7)', async () => {
    // `GET /api/admin/machines` orders by `sortOrder, createdAt`, but nothing
    // in the panel ever wrote `sortOrder`: every row sat at 0 and the fleet —
    // on the customer site too — was frozen in creation order.
    const positions = () => new Map(
      sqlRows('SELECT id, sortOrder FROM Machine').map(([id, so]) => [id, Number(so)]),
    );
    const listed = sqlRows('SELECT id FROM Machine ORDER BY sortOrder ASC, createdAt ASC')
      .map((r) => r[0]);
    expect(listed.length).toBeGreaterThan(1);
    // Every row is still on the default, so the position the test machine
    // happens to land on is `createdAt`'s business, not ours — move it
    // whichever way the list leaves room for.
    const index = listed.indexOf(machineId);
    expect(index).toBeGreaterThanOrEqual(0);
    const up = index > 0;
    const neighbour = listed[up ? index - 1 : index + 1];

    /** True once `machineId` sits on the far side of `neighbour`. */
    const past = () => {
      const at = positions();
      const mine = at.get(machineId) ?? 0;
      const theirs = at.get(neighbour) ?? 0;
      return up ? mine < theirs : mine > theirs;
    };

    await clickInMachineCard(page, NAME, `button[title="Flytt ${up ? 'opp' : 'ned'}"]`);

    // A move is one PATCH per machine that changed position, then a refetch,
    // so poll for the finished state rather than guess how long that takes —
    // and poll for *both* halves: the new relative order, and the renumbering
    // that makes it stick. Sampling between the two PATCHes would otherwise
    // see the order already right and the numbering still half-applied.
    const renumbered = () =>
      Number(sqlValue('SELECT count(DISTINCT sortOrder) FROM Machine')) === listed.length;
    const moved = await (async () => {
      for (let i = 0; i < 80; i++) {
        if (past() && renumbered()) return true;
        await new Promise((r) => setTimeout(r, 250));
      }
      return false;
    })();
    expect(moved).toBe(true);
    // The whole list is numbered now, so the order no longer rests on
    // `createdAt` breaking a tie between identical zeroes.
    expect(sqlValue('SELECT count(*) FROM Machine WHERE sortOrder > 0'))
      .not.toBe('0');

    // …and back again, so the order this test found is the order it leaves
    // behind.
    await clickInMachineCard(page, NAME, `button[title="Flytt ${up ? 'ned' : 'opp'}"]`);
    const movedBack = await (async () => {
      for (let i = 0; i < 80; i++) {
        if (!past()) return true;
        await new Promise((r) => setTimeout(r, 250));
      }
      return false;
    })();
    expect(movedBack).toBe(true);
  });

  it('refuses deletion while a live booking references the machine (409)', async () => {
    const created = await createMockBooking(page, {
      startDate: farFutureDate(),
      name: BOOKING_NAME,
      machineId,
      status: 'confirmed',
    });
    bookingId = created.bookingId;
    bookingEmail = sqlValue(`SELECT email FROM Booking WHERE id=${q(bookingId)}`) ?? '';
    expect(sqlValue(`SELECT machineId FROM Booking WHERE id=${q(bookingId)}`)).toBe(machineId);

    const refused = await apiFromPage(page, `/api/admin/machines/${machineId}`, 'DELETE');
    expect(refused.status).toBe(409);
    const body = refused.json as { error: string; activeBookings: number };
    expect(body.activeBookings).toBe(1);
    expect(body.error).toContain('Kan ikke slette');
    // A refused delete must not be a partial one.
    expect(sqlValue(`SELECT count(*) FROM Machine WHERE id=${q(machineId)}`)).toBe('1');

    // And the refusal reaches the operator as a message, not a silent no-op.
    await clickInMachineCard(page, NAME, 'button[title="Slett"]');
    await page.waitForFunction(() => document.body.innerText.includes('Kan ikke slette'));
    expect(sqlValue(`SELECT count(*) FROM Machine WHERE id=${q(machineId)}`)).toBe('1');
  });

  it('toggles active, then deletes once the booking is gone', async () => {
    // A toggle from the list is a non-price PATCH — no second factor.
    await clickInMachineCard(page, NAME, 'button[role="switch"]');
    // Poll: the list refetches after the PATCH, and under load that takes
    // longer than any fixed pause worth writing.
    const wentInactive = await page
      .waitForFunction((n: string) => {
        const title = [...document.querySelectorAll('div')]
          .find((d) => d.className.includes('font-semibold') && d.textContent?.trim() === n);
        let node: HTMLElement | null = title as HTMLElement | null;
        while (node && !node.querySelector('button[role="switch"]')) node = node.parentElement;
        return !!node && (node.innerText || '').includes('Inaktiv');
      }, { timeout: 20_000 }, NAME)
      .then(() => true).catch(() => false);
    expect(wentInactive).toBe(true);
    expect(sqlValue(`SELECT isActive FROM Machine WHERE id=${q(machineId)}`)).toBe('0');

    // Cancelling then deleting the booking clears the reference…
    const cancelled = await apiFromPage(page, `/api/bookings/${bookingId}`, 'PATCH', {
      status: 'cancelled', reason: 'AUDIT2B e2e opprydding',
    });
    expect(cancelled.status).toBe(200);
    const removed = await apiFromPage(page, `/api/bookings/${bookingId}`, 'DELETE');
    expect(removed.status).toBe(200);
    bookingId = '';

    // …and only then does the delete go through.
    const gone = await apiFromPage(page, `/api/admin/machines/${machineId}`, 'DELETE');
    expect(gone.status).toBe(200);
    expect(sqlValue(`SELECT count(*) FROM Machine WHERE id=${q(machineId)}`)).toBe('0');
    machineId = '';
  });
});
