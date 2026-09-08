/**
 * L4 — the booking drawer's status actions, on a booking this test owns.
 *
 * mark-paid (skips Stripe) → cancel with a required reason → delete. The four
 * together are the operator's whole recovery path when a customer pays by
 * bank transfer, then calls to cancel.
 *
 * The last two steps are the ones that used to be impossible from the UI:
 * cancelling closed the drawer *and* dropped the booking out of the only list
 * the panel rendered, so the "Slett" button the code exposes for cancelled
 * bookings could never be reached (P-1). The list now hides cancelled rows
 * behind a switch instead of losing them, and the delete below goes through
 * the drawer rather than the API to prove it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'puppeteer-core';

import {
  LIVE, adminSession, apiFromPage, clickByExactText, clickByText, clickInDialog,
  createMockBooking, hasText, lastCall, launchBrowser, newPage, openAdmin, q,
  seenMark, setInput, sqlExec, sqlRows, sqlValue, waitForApi, waitForGone,
  type SeenResponse,
} from './admin-helpers';

const NAME = '[TESTBOOKING] AUDIT2B e2e statusflyt';
const REASON = 'AUDIT2B e2e — kunden avbestilte';

function farFutureDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 205);
  return d.toISOString().slice(0, 10);
}

describe.skipIf(!LIVE)('admin booking status actions (L4)', { timeout: 90_000 }, () => {
  let browser: Browser;
  let page: Page & { seen: SeenResponse[] };
  let bookingId = '';
  let reference = '';
  let bookingEmail = '';
  let goodwillCodeId = '';
  const runStart = Date.now();

  beforeAll(async () => {
    browser = await launchBrowser();
    page = await newPage(browser);
    await adminSession(page);
    // Purge leftovers from an aborted run.
    for (const [id] of sqlRows(`SELECT id FROM Booking WHERE name=${q(NAME)}`)) {
      await apiFromPage(page, `/api/bookings/${id}`, 'PATCH', {
        status: 'cancelled', reason: 'AUDIT2B e2e opprydding',
      });
      await apiFromPage(page, `/api/bookings/${id}`, 'DELETE');
    }
    const created = await createMockBooking(page, {
      startDate: farFutureDate(), name: NAME, status: 'pending',
    });
    bookingId = created.bookingId;
    reference = created.reference;
    bookingEmail = sqlValue(`SELECT email FROM Booking WHERE id=${q(bookingId)}`) ?? '';
  }, 90_000);

  afterAll(async () => {
    if (page && !page.isClosed() && bookingId) {
      await apiFromPage(page, `/api/bookings/${bookingId}`, 'PATCH', {
        status: 'cancelled', reason: 'AUDIT2B e2e opprydding',
      });
      await apiFromPage(page, `/api/bookings/${bookingId}`, 'DELETE');
    }
    // The cancellation mints an email-bound goodwill code, and there is no
    // admin endpoint for those, so the test that caused it removes it. By
    // email and run window rather than by id: a run that fails before the code
    // is captured would otherwise leave one behind every time.
    if (goodwillCodeId) sqlExec(`DELETE FROM RepeatDiscountCode WHERE id=${q(goodwillCodeId)}`);
    if (bookingEmail) {
      sqlExec(
        `DELETE FROM RepeatDiscountCode WHERE email=${q(bookingEmail)} AND createdAt >= ${runStart}`,
      );
    }
    await browser?.close();
  }, 60_000);

  /**
   * Search for this booking and open its drawer.
   *
   * Retried as a whole. The panel re-renders its list whenever a fetch
   * resolves, and against a dev server several agents are reloading, the row
   * can be replaced between "it is there" and "click it" — which surfaces as a
   * missing element rather than as the timing problem it is.
   */
  async function openDrawer(p: Page): Promise<void> {
    const search = 'input[placeholder^="Søk bookinger"]';
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await openAdmin(p as Page & { seen: SeenResponse[] });
        // The result rows are labelled with the customer name, not the reference.
        await setInput(p, search, NAME);
        await p.waitForFunction(
          (name: string) => [...document.querySelectorAll('button')]
            .some((b) => (b.textContent || '').includes(name)),
          { timeout: 20_000 }, NAME,
        );
        await clickByText(p, 'button', NAME);
        await p.waitForFunction(
          (ref: string) => [...document.querySelectorAll('[role="dialog"][data-state="open"]')]
            .some((d) => (d.textContent || '').includes(ref)),
          { timeout: 20_000 }, reference,
        );
        return;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  it('marks a pending booking as paid, skipping Stripe', async () => {
    expect(sqlValue(`SELECT status FROM Booking WHERE id=${q(bookingId)}`)).toBe('pending');
    await openDrawer(page);

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      clickByText(page, '[role="dialog"][data-state="open"] button', 'Marker som betalt'),
    ]);

    expect(sqlValue(`SELECT status FROM Booking WHERE id=${q(bookingId)}`)).toBe('confirmed');
    expect(sqlValue(`SELECT fullyPaidAt IS NOT NULL FROM Booking WHERE id=${q(bookingId)}`)).toBe('1');
    // Confirming clears the payment deadline — the booking has stopped racing
    // the expiry sweep.
    expect(sqlValue(`SELECT paymentDeadline IS NULL FROM Booking WHERE id=${q(bookingId)}`)).toBe('1');

    // FIXED P-13: the button's own confirm text says it skips Stripe and the
    // route records no payment method at all, so the timeline must not name a
    // gateway that never ran.
    expect(sqlValue(
      `SELECT paymentMethod IS NULL OR paymentMethod='' FROM Booking WHERE id=${q(bookingId)}`,
    )).toBe('1');
    await openDrawer(page);
    expect(await hasText(page, 'Betalt via Stripe')).toBe(false);
    expect(await hasText(page, 'Betalt — registrert manuelt')).toBe(true);
  });

  it('requires a reason before it will cancel', async () => {
    await openDrawer(page);
    await clickByText(page, '[role="dialog"][data-state="open"] button', 'Kanseller');
    await page.waitForSelector('#cancel-reason');

    // With the field empty the confirm button is disabled — the 400 the route
    // would return never has to happen.
    const disabledWhenEmpty = await page.evaluate(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"][data-state="open"]')]
        .find((d) => (d.textContent || '').includes('Kanseller booking'));
      const btn = [...(dialog?.querySelectorAll('button') ?? [])]
        .find((b) => (b.textContent || '').trim() === 'Kanseller booking') as HTMLButtonElement;
      return btn.disabled;
    });
    expect(disabledWhenEmpty).toBe(true);
    expect(sqlValue(`SELECT status FROM Booking WHERE id=${q(bookingId)}`)).toBe('confirmed');
  });

  it('cancels with a reason and records it on the booking', async () => {
    await setInput(page, '#cancel-reason', REASON);
    await clickInDialog(page, 'Kanseller booking', 'Kanseller booking');
    await waitForGone(page, 'Kanseller booking');

    expect(lastCall(page, `/api/bookings/${bookingId}`, 'PATCH')?.status).toBe(200);
    expect(sqlValue(`SELECT status FROM Booking WHERE id=${q(bookingId)}`)).toBe('cancelled');
    expect(sqlValue(`SELECT adminNote FROM Booking WHERE id=${q(bookingId)}`)).toBe(REASON);

    // A paid booking that gets cancelled earns a goodwill code.
    goodwillCodeId = sqlValue(
      `SELECT id FROM RepeatDiscountCode WHERE issuedForBookingId=${q(bookingId)}`,
    ) ?? '';
    expect(goodwillCodeId).not.toBe('');
    expect(sqlValue(`SELECT code FROM RepeatDiscountCode WHERE id=${q(goodwillCodeId)}`))
      .toMatch(/^RETUR-/);
  });

  it('keeps the cancelled booking reachable, behind «Vis avbestilte» (P-1)', async () => {
    // A fresh load, so the switch is back at its default. Cancelled rows are
    // hidden — they are noise in a month view — but the panel now says so
    // instead of contradicting itself: the counter used to report "1 resultat"
    // above a list saying "Ingen bookinger matcher søket", with no way back to
    // the row and therefore none to its Slett button.
    await openAdmin(page);
    await setInput(page, 'input[placeholder^="Søk bookinger"]', NAME);

    await page.waitForFunction(
      () => document.body.innerText.includes('1 avbestilt booking er skjult'),
      { timeout: 30_000 },
    );
    const hidden = await page.evaluate(() => document.body.innerText);
    expect(hidden).toContain('0 resultater');
    expect(hidden).toContain('Ingen bookinger matcher søket');

    // The switch brings it back, and the counter follows the list.
    await clickByExactText(page, 'button', 'Vis avbestilte');
    await page.waitForFunction(
      (name: string) => [...document.querySelectorAll('button')]
        .some((b) => (b.textContent || '').includes(name)),
      { timeout: 20_000 }, NAME,
    );
    const shown = await page.evaluate(() => document.body.innerText);
    expect(shown).toMatch(/(^|\s)1 resultat(?!er)/);
    expect(shown).toContain('Avbestilt');

    // …and the drawer it opens carries the Slett button the finding said was
    // unreachable.
    await clickByText(page, 'button', NAME);
    await page.waitForFunction(
      (ref: string) => [...document.querySelectorAll('[role="dialog"][data-state="open"]')]
        .some((d) => (d.textContent || '').includes(ref)),
      { timeout: 20_000 }, reference,
    );
    const hasDelete = await page.evaluate(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"][data-state="open"]')]
        .find((d) => (d.textContent || '').includes('Bookingdetaljer'));
      return [...(dialog?.querySelectorAll('button') ?? [])]
        .some((b) => (b.textContent || '').trim() === 'Slett');
    });
    expect(hasDelete).toBe(true);
  });

  it('deletes the cancelled booking from its own drawer', async () => {
    const mark = seenMark(page);
    await clickByExactText(page, '[role="dialog"][data-state="open"] button', 'Slett');
    const removed = await waitForApi(page, `/api/bookings/${bookingId}`, 'DELETE', { since: mark });
    expect(removed.status).toBe(200);
    expect(sqlValue(`SELECT count(*) FROM Booking WHERE id=${q(bookingId)}`)).toBe('0');
    bookingId = '';
  });
});
