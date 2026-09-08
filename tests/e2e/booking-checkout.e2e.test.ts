/**
 * L4 — the money path, end to end in a real browser.
 *
 * Home page → rental type → calendar day → self-pickup → customer details →
 * quote → terms dialog → confirm dialog → Stripe Checkout redirect → a signed
 * `checkout.session.completed` → booking `confirmed` with a frozen contract.
 *
 * Self-pickup on purpose: the delivery path needs Nominatim + OSRM, which would
 * make the test depend on two third-party services. `Checkout` itself is real
 * (test mode); nothing is ever paid — the redirect is asserted and abandoned,
 * and the money side is driven by the injected webhook.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUDIT_TAG, E2E_READY, acquireInstanceLock, appConfig, auditEmail, clickAria, clickText, deleteBookingCascade,
  firstFreeStartDate, goto, injectPaidWebhook, installWebhookSecret, norwegianDayLabel, openBrowser, pickMachineId,
  queryOne, releaseInstanceLock, setInput, sleep, textOf,
} from './helpers';

const EMAIL = auditEmail('checkout');
const created: string[] = [];
let restoreSecret: (() => Promise<void>) | null = null;

describe.skipIf(!E2E_READY)('L4 booking → Stripe Checkout → webhook → confirmed', () => {
  beforeAll(async () => {
    await acquireInstanceLock('booking-checkout');
    restoreSecret = await installWebhookSecret();
  }, 900_000);

  afterAll(async () => {
    for (const id of created) deleteBookingCascade(id);
    if (restoreSecret) await restoreSecret();
    releaseInstanceLock();
  }, 60_000);

  it('books a weekend through the form and confirms it from a signed webhook', async () => {
    const machineId = pickMachineId();
    const startDate = firstFreeStartDate(machineId, 'friday', Number(appConfig('minBookingDaysAhead') ?? '0') + 3, 3);
    const dayLabel = norwegianDayLabel(startDate);
    const session = await openBrowser();

    try {
      const { page } = session;
      await goto(page, '/');
      await sleep(1500);

      // The booking form's own rental-type tile, not the pricing section's.
      await clickText(page, '#booking button', 'Helg');
      await sleep(400);
      await clickAria(page, '#booking button', dayLabel);
      await sleep(600);
      await clickText(page, '#booking button', 'Hent selv');
      await sleep(300);

      await setInput(page, '#name', 'Audit 2A Checkout');
      await setInput(page, '#phone', '41200101');
      await setInput(page, '#email', EMAIL);
      await sleep(2500); // debounced /api/quote

      // The summary is driven entirely by the server's quote.
      const summary = await textOf(page, '#booking');
      expect(summary).toContain('Selvhenting');
      expect(summary).toMatch(/Totalt inkl\. mva/);

      const submit = await page.$eval('#booking button[type=submit]', (b) => ({
        text: (b as HTMLElement).innerText.trim(),
        disabled: (b as HTMLButtonElement).disabled,
      }));
      expect(submit.disabled).toBe(false);
      expect(submit.text).toBe('Bekreft booking');

      await page.evaluate(() => (document.querySelector('#booking button[type=submit]') as HTMLElement).click());
      await sleep(1200);

      // Confirmation dialog, and the pay button locked until the terms are accepted.
      const dialog = await page.evaluate(() => {
        const d = [...document.querySelectorAll('[role=dialog]')].find((x) =>
          /Bekreft din booking/.test((x as HTMLElement).innerText),
        ) as HTMLElement | undefined;
        const pay = d && [...d.querySelectorAll('button')].find((b) => /Bekreft og betal|Betal med/.test(b.innerText));
        return { open: !!d, payDisabled: pay ? (pay as HTMLButtonElement).disabled : null };
      });
      expect(dialog.open).toBe(true);
      expect(dialog.payDisabled).toBe(true);

      // Terms: open from the checkbox row, accept from the button at the bottom.
      await page.evaluate(() => {
        ([...document.querySelectorAll('[role=dialog] [role=checkbox]')][0] as HTMLElement).click();
      });
      await sleep(900);
      await page.evaluate(() => {
        const d = [...document.querySelectorAll('[role=dialog]')].find((x) =>
          /Leievilkår/.test((x as HTMLElement).innerText),
        ) as HTMLElement;
        ([...d.querySelectorAll('button')].find((b) => /Jeg godtar/.test(b.innerText)) as HTMLElement).click();
      });
      await sleep(800);

      const payEnabled = await page.evaluate(() => {
        const b = [...document.querySelectorAll('[role=dialog] button')].find((x) =>
          /Bekreft og betal|Betal med/.test((x as HTMLElement).innerText),
        ) as HTMLButtonElement | undefined;
        return b ? !b.disabled : false;
      });
      expect(payEnabled).toBe(true);

      const navigation = page
        .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60_000 })
        .catch(() => null);
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('[role=dialog] button')].find((x) =>
          /Bekreft og betal|Betal med/.test((x as HTMLElement).innerText),
        ) as HTMLElement;
        b.click();
      });
      await navigation;
      await sleep(1500);

      // Stripe-hosted Checkout, not a local page.
      expect(page.url()).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    } finally {
      await session.close();
    }

    // The booking exists, is pending, and carries the session the browser saw.
    const booking = queryOne<{ id: string; reference: string; status: string; stripeSessionId: string; totalPrice: number }>(
      'SELECT id, reference, status, stripeSessionId, totalPrice FROM Booking WHERE email = ? ORDER BY createdAt DESC LIMIT 1',
      EMAIL,
    );
    expect(booking, 'the form should have created a booking').toBeTruthy();
    created.push(booking!.id);
    expect(booking!.status).toBe('pending');
    expect(booking!.stripeSessionId).toMatch(/^cs_test_/);

    // Nothing is paid, so nothing is confirmed and no contract is frozen yet.
    expect(queryOne('SELECT id FROM AcceptedContract WHERE bookingId = ?', booking!.id)).toBeUndefined();

    expect(await injectPaidWebhook(booking!.id, booking!.stripeSessionId)).toBe(200);
    await sleep(1500);

    const paid = queryOne<{ status: string; fullyPaidAt: number | null; cancelToken: string | null; paymentProvider: string | null }>(
      'SELECT status, fullyPaidAt, cancelToken, paymentProvider FROM Booking WHERE id = ?',
      booking!.id,
    );
    expect(paid!.status).toBe('confirmed');
    expect(paid!.fullyPaidAt).toBeTruthy();
    expect(paid!.paymentProvider).toBe('stripe');
    expect(paid!.cancelToken, 'a confirmed booking gets a cancellation token').toBeTruthy();

    const contract = queryOne<{ acceptanceMethod: string; termsVersionHash: string; renderedHtml: string }>(
      'SELECT acceptanceMethod, termsVersionHash, renderedHtml FROM AcceptedContract WHERE bookingId = ?',
      booking!.id,
    );
    expect(contract, 'payment freezes the accepted contract').toBeTruthy();
    expect(contract!.termsVersionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(contract!.renderedHtml.length).toBeGreaterThan(1000);
  }, 300_000);

  it('is idempotent: replaying the same webhook does not double-confirm', async () => {
    const id = created[0];
    expect(id, 'the first test must have created a booking').toBeTruthy();
    const sessionId = queryOne<{ stripeSessionId: string }>('SELECT stripeSessionId FROM Booking WHERE id = ?', id)!
      .stripeSessionId;

    const before = queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM AcceptedContract WHERE bookingId = ?', id)!.n;
    expect(await injectPaidWebhook(id, sessionId)).toBe(200);
    await sleep(1200);
    const after = queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM AcceptedContract WHERE bookingId = ?', id)!.n;

    expect(after).toBe(before);
    expect(queryOne<{ status: string }>('SELECT status FROM Booking WHERE id = ?', id)!.status).toBe('confirmed');
  }, 120_000);

  it(`leaves no ${AUDIT_TAG} rows behind that this file did not create`, () => {
    const strays = queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM Booking WHERE email = ? AND id NOT IN (SELECT id FROM Booking WHERE id = ?)",
      EMAIL,
      created[0] ?? '',
    );
    expect(strays!.n).toBe(0);
  });
});
