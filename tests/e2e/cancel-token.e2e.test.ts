/**
 * L4 — self-service cancellation from the emailed token link.
 *
 * /booking/cancel?token=… shows the booking and the fee preview, the destructive
 * action is behind a second "Er du sikker?" step, and the token is spent once
 * the booking is cancelled.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  E2E_READY, acquireInstanceLock, appConfig, auditEmail, clickText, deleteBookingCascade, createSelfPickupBooking,
  firstFreeStartDate, goto, installWebhookSecret, openBrowser, pageText, payAndConfirm, pickMachineId, queryOne,
  releaseInstanceLock, sleep,
} from './helpers';

const EMAIL = auditEmail('cancel-token');
const created: string[] = [];
let restoreSecret: (() => Promise<void>) | null = null;
let bookingId = '';
let reference = '';
let token = '';

describe.skipIf(!E2E_READY)('L4 cancel by token', () => {
  beforeAll(async () => {
    await acquireInstanceLock('cancel-token');
    restoreSecret = await installWebhookSecret();

    // Far enough out to be inside the free-cancellation window, so the preview
    // and the confirmed fee are both deterministic.
    const minAhead = Number(appConfig('minBookingDaysAhead') ?? '0');
    const machineId = pickMachineId();
    const booking = await createSelfPickupBooking({
      name: 'Audit 2A Cancel Token',
      phone: '41200201',
      email: EMAIL,
      rentalType: 'week',
      startDate: firstFreeStartDate(machineId, 'monday', minAhead + 21, 7),
      machineId,
    });
    bookingId = booking.id;
    reference = booking.reference;
    created.push(booking.id);
    await payAndConfirm(booking.id);
    await sleep(1200);
    token = queryOne<{ cancelToken: string }>('SELECT cancelToken FROM Booking WHERE id = ?', bookingId)!.cancelToken;
    expect(token).toBeTruthy();
  }, 900_000);

  afterAll(async () => {
    for (const id of created) deleteBookingCascade(id);
    if (restoreSecret) await restoreSecret();
    releaseInstanceLock();
  }, 60_000);

  it('previews the booking and cancels it behind a second confirmation', async () => {
    const session = await openBrowser();
    try {
      const { page } = session;
      await goto(page, `/booking/cancel?token=${encodeURIComponent(token)}`);
      await sleep(2000);

      const preview = await pageText(page);
      expect(preview).toContain(reference);
      expect(preview).toContain('Audit 2A Cancel Token');
      expect(preview).toContain('Gratis avbestilling');

      // Step one is not destructive: the booking is still confirmed after it.
      await clickText(page, 'button', 'Avbestill booking');
      await sleep(800);
      const step2 = await pageText(page);
      expect(step2).toContain('Er du sikker?');
      expect(step2).toContain('Dette kan ikke angres');
      expect(queryOne<{ status: string }>('SELECT status FROM Booking WHERE id = ?', bookingId)!.status)
        .toBe('confirmed');

      await clickText(page, 'button', 'Ja, avbestill');
      await page.waitForFunction(() => /Booking avbestilt/.test(document.body.innerText), { timeout: 30_000 });
      const done = await pageText(page);
      expect(done).toContain('Booking avbestilt');
      expect(done).toContain(reference);
      expect(done).toContain('Ingen avbestillingsgebyr');
    } finally {
      await session.close();
    }

    const row = queryOne<{ status: string; cancellationFee: number | null }>(
      'SELECT status, cancellationFee FROM Booking WHERE id = ?',
      bookingId,
    );
    expect(row!.status).toBe('cancelled');
    expect(row!.cancellationFee ?? 0).toBe(0);

    // The dates are handed back to the calendar.
    expect(queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM BookingDateLock WHERE bookingId = ?', bookingId)!.n)
      .toBe(0);
  }, 180_000);

  it('spends the token: a second visit says the booking is already cancelled', async () => {
    const session = await openBrowser();
    try {
      const { page } = session;
      await goto(page, `/booking/cancel?token=${encodeURIComponent(token)}`);
      await sleep(2000);
      const text = await pageText(page);
      expect(text).toContain('Kunne ikke laste booking');
      expect(text).toContain('allerede avbestilt');
    } finally {
      await session.close();
    }
  }, 120_000);

  it('refuses an unknown token without leaking whether it ever existed', async () => {
    const session = await openBrowser();
    try {
      const { page } = session;
      await goto(page, '/booking/cancel?token=00000000-0000-4000-8000-000000000000');
      await sleep(2000);
      const text = await pageText(page);
      expect(text).toContain('Ugyldig eller utløpt lenke');
      expect(text).not.toContain(reference);
    } finally {
      await session.close();
    }
  }, 120_000);
});
