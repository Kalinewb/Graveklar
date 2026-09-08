/**
 * L4 — the post-rental review link at /omtale/<token>.
 *
 * A review row is minted when a booking is completed. The form refuses to send
 * without a star rating, stores the review as `submitted` (pending moderation),
 * and the link is single-use in both directions: revisiting shows the thank-you
 * state, and re-posting is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  E2E_READY, acquireInstanceLock, api, appConfig, auditEmail, clickAria, clickText, createSelfPickupBooking,
  deleteBookingCascade, firstFreeStartDate, goto, installWebhookSecret, openBrowser, pageText, payAndConfirm,
  pickMachineId, queryOne, releaseInstanceLock, setInput, sleep,
} from './helpers';

const EMAIL = auditEmail('review');
const created: string[] = [];
let restoreSecret: (() => Promise<void>) | null = null;
let bookingId = '';
let token = '';

/** Admin session cookie — the only way to walk a booking to `completed`. */
async function adminCookie(): Promise<string> {
  const res = await fetch(process.env.AUDIT_BASE_URL + '/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: process.env.AUDIT_ADMIN_PASSWORD ?? 'Testadmin-2026!' }),
  });
  const setCookie = res.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0];
  if (!cookie.startsWith('graveklar_admin_session=')) throw new Error(`admin login failed: ${res.status}`);
  return cookie;
}

describe.skipIf(!E2E_READY)('L4 review link', () => {
  beforeAll(async () => {
    await acquireInstanceLock('review');
    restoreSecret = await installWebhookSecret();

    const machineId = pickMachineId();
    const booking = await createSelfPickupBooking({
      name: 'Audit 2A Omtale',
      phone: '41200401',
      email: EMAIL,
      rentalType: 'week',
      startDate: firstFreeStartDate(machineId, 'monday', Number(appConfig('minBookingDaysAhead') ?? '0') + 35, 7),
      machineId,
    });
    bookingId = booking.id;
    created.push(booking.id);
    await payAndConfirm(booking.id);
    await sleep(1200);

    // Completing the rental is what mints the review request.
    const cookie = await adminCookie();
    const done = await api(`/api/bookings/${bookingId}`, {
      method: 'PATCH',
      headers: { cookie },
      body: JSON.stringify({ status: 'completed' }),
    });
    expect(done.status).toBe(200);
    await sleep(2000);

    token = queryOne<{ token: string }>('SELECT token FROM Review WHERE bookingId = ?', bookingId)?.token ?? '';
    expect(token, 'completing a booking creates a pending Review').toBeTruthy();
  }, 900_000);

  afterAll(async () => {
    for (const id of created) deleteBookingCascade(id);
    if (restoreSecret) await restoreSecret();
    releaseInstanceLock();
  }, 60_000);

  it('refuses an unknown token', async () => {
    const session = await openBrowser();
    try {
      const { page } = session;
      await goto(page, '/omtale/not-a-real-token');
      await sleep(1500);
      expect(await pageText(page)).toContain('Denne vurderingslenken finnes ikke eller har utløpt');
    } finally {
      await session.close();
    }
  }, 120_000);

  it('requires a star rating, then stores the review once', async () => {
    const session = await openBrowser();
    try {
      const { page } = session;
      await goto(page, `/omtale/${token}`);
      await sleep(1500);
      expect(await pageText(page)).toContain('Hvordan var leien?');

      // The honeypot is present and never shown to a human.
      const honeypot = await page.evaluate(() => {
        const el = document.querySelector('form input[type=text]') as HTMLInputElement | null;
        return el ? { hidden: !(el.offsetParent || el.getClientRects().length), tabIndex: el.tabIndex } : null;
      });
      expect(honeypot?.hidden).toBe(true);
      expect(honeypot?.tabIndex).toBe(-1);

      await clickText(page, 'button', 'Send vurdering');
      await sleep(900);
      expect(await pageText(page)).toContain('Velg en vurdering mellom 1 og 5 stjerner');
      expect(queryOne<{ status: string }>('SELECT status FROM Review WHERE token = ?', token)!.status)
        .toBe('pending');

      await clickAria(page, 'button', '4 av 5 stjerner');
      await setInput(page, '#o-comment', 'Audit 2A e2e — alt gikk fint.');
      await setInput(page, '#o-name', 'Audit');
      await clickText(page, 'button', 'Send vurdering');
      await page.waitForFunction(() => /Tusen takk/.test(document.body.innerText), { timeout: 30_000 });
    } finally {
      await session.close();
    }

    const review = queryOne<{ rating: number; comment: string; reviewerName: string; status: string; submittedAt: number }>(
      'SELECT rating, comment, reviewerName, status, submittedAt FROM Review WHERE token = ?', token,
    );
    expect(review!.rating).toBe(4);
    expect(review!.comment).toBe('Audit 2A e2e — alt gikk fint.');
    expect(review!.reviewerName).toBe('Audit');
    expect(review!.status, 'a fresh review is never auto-published').toBe('submitted');
    expect(review!.submittedAt).toBeTruthy();
  }, 240_000);

  it('is single-use: the link shows the thank-you state and a second POST is refused', async () => {
    const session = await openBrowser();
    try {
      const { page } = session;
      await goto(page, `/omtale/${token}`);
      await sleep(1500);
      const text = await pageText(page);
      expect(text).toContain('Vi har allerede registrert vurderingen din');
      expect(text).not.toContain('Send vurdering');
    } finally {
      await session.close();
    }

    const replay = await api<{ error?: string }>(`/api/omtale/${token}`, {
      method: 'POST',
      body: JSON.stringify({ rating: 1, comment: 'overwrite attempt', reviewerName: 'Bot' }),
    });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toContain('allerede sendt inn');

    const review = queryOne<{ rating: number; reviewerName: string }>(
      'SELECT rating, reviewerName FROM Review WHERE token = ?', token,
    );
    expect(review!.rating, 'the first submission stands').toBe(4);
    expect(review!.reviewerName).toBe('Audit');
  }, 180_000);

  it('rejects a submission that fills the honeypot', async () => {
    const res = await api<{ error?: string }>(`/api/omtale/${token}`, {
      method: 'POST',
      body: JSON.stringify({ rating: 5, comment: 'spam', website: 'http://spam.example' }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Ugyldig forespørsel');
  }, 60_000);
});
