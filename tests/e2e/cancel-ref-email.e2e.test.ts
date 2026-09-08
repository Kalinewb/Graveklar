/**
 * L4 — cancellation for a customer who lost the token link and types their
 * reference and e-mail instead. A wrong e-mail must not reveal the booking.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  E2E_READY, acquireInstanceLock, appConfig, auditEmail, clickText, createSelfPickupBooking, deleteBookingCascade,
  firstFreeStartDate, goto, installWebhookSecret, openBrowser, pageText, payAndConfirm, pickMachineId, queryOne,
  releaseInstanceLock, setInput, sleep,
} from './helpers';

const EMAIL = auditEmail('cancel-ref');
const created: string[] = [];
let restoreSecret: (() => Promise<void>) | null = null;
let bookingId = '';
let reference = '';

describe.skipIf(!E2E_READY)('L4 cancel by reference + e-mail', () => {
  beforeAll(async () => {
    await acquireInstanceLock('cancel-ref-email');
    restoreSecret = await installWebhookSecret();
    const machineId = pickMachineId();
    const booking = await createSelfPickupBooking({
      name: 'Audit 2A Cancel Ref',
      phone: '41200202',
      email: EMAIL,
      rentalType: 'week',
      startDate: firstFreeStartDate(machineId, 'monday', Number(appConfig('minBookingDaysAhead') ?? '0') + 28, 7),
      machineId,
    });
    bookingId = booking.id;
    reference = booking.reference;
    created.push(booking.id);
    await payAndConfirm(booking.id);
    await sleep(1200);
  }, 900_000);

  afterAll(async () => {
    for (const id of created) deleteBookingCascade(id);
    if (restoreSecret) await restoreSecret();
    releaseInstanceLock();
  }, 60_000);

  it('refuses a wrong e-mail, then cancels with the right one', async () => {
    const session = await openBrowser();
    try {
      const { page } = session;
      await goto(page, '/booking/cancel');
      await sleep(1500);

      await setInput(page, '#ref', reference);
      await setInput(page, '#email', 'someone-else@example.invalid');
      await clickText(page, 'button', 'Finn booking');
      await sleep(2500);

      const refused = await pageText(page);
      expect(refused).toContain('Fant ingen booking med denne referansen og e-postadressen');
      // Nothing about the real booking leaks on the refusal.
      expect(refused).not.toContain('Audit 2A Cancel Ref');
      expect(queryOne<{ status: string }>('SELECT status FROM Booking WHERE id = ?', bookingId)!.status)
        .toBe('confirmed');

      await setInput(page, '#email', EMAIL);
      await clickText(page, 'button', 'Finn booking');
      await page.waitForFunction(() => /Bookingdetaljer/.test(document.body.innerText), { timeout: 30_000 });

      const found = await pageText(page);
      expect(found).toContain(reference);
      expect(found).toContain('Audit 2A Cancel Ref');

      await clickText(page, 'button', 'Avbestill booking');
      await sleep(800);
      expect(await pageText(page)).toContain('Er du sikker?');
      await clickText(page, 'button', 'Ja, avbestill');
      await page.waitForFunction(() => /Booking avbestilt/.test(document.body.innerText), { timeout: 30_000 });
    } finally {
      await session.close();
    }

    expect(queryOne<{ status: string }>('SELECT status FROM Booking WHERE id = ?', bookingId)!.status)
      .toBe('cancelled');
  }, 180_000);

  it('answers an unknown reference the same way as a wrong e-mail', async () => {
    const session = await openBrowser();
    try {
      const { page } = session;
      await goto(page, '/booking/cancel');
      await sleep(1500);
      await setInput(page, '#ref', 'GK-0000-000-XXXXX');
      await setInput(page, '#email', EMAIL);
      await clickText(page, 'button', 'Finn booking');
      await sleep(2500);
      expect(await pageText(page)).toContain('Fant ingen booking med denne referansen og e-postadressen');
    } finally {
      await session.close();
    }
  }, 120_000);
});
