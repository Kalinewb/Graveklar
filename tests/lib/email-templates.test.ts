/**
 * L1/L2 boundary — src/lib/email.ts, the 13 senders + src/lib/email-sample-booking.ts.
 *
 * This is the one place in the suite that tests the REAL email module rather
 * than `mockEmail()` (which replaces the whole module with recording stubs —
 * useless for testing the module itself). Instead we stub the transport one
 * level down: `vi.mock('nodemailer')` so `getTransporter()` gets a fake
 * `{ sendMail }`, and seed `smtp*` AppConfig keys so it is non-null. Nothing
 * ever leaves the process.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface SendMailArgs {
  from: string; to: string; subject: string; html: string; text: string; replyTo?: string;
}

const { sendMailMock, createTransportMock } = vi.hoisted(() => {
  const sendMailMock = vi.fn(async (_args: SendMailArgs) => ({ messageId: 'test' }));
  const createTransportMock = vi.fn(() => ({ sendMail: sendMailMock }));
  return { sendMailMock, createTransportMock };
});

vi.mock('nodemailer', () => ({
  default: { createTransport: createTransportMock },
  createTransport: createTransportMock,
}));

import * as email from '@/lib/email';
import { sampleBooking } from '@/lib/email-sample-booking';
import { db, ensureSchema, resetDb, seedConfigDefaults } from '../helpers/db';
import { setPricing } from '../helpers/booking';

const CONFIGURED_SMTP = {
  smtpHost: 'smtp.example.no',
  smtpPort: '587',
  smtpSecure: 'false',
  smtpUser: 'sender@example.no',
  smtpPass: 'secret',
  smtpFrom: 'Graveklar <post@graveklar.no>',
  adminEmail: 'drift@graveklar.no',
  siteUrl: 'https://graveklar.no',
  businessName: 'Graveklar',
  contactEmail: 'kontakt@graveklar.no',
  serviceArea: 'Salten',
};

const XSS = '<img src=x onerror=alert(1)>';

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDb();
  sendMailMock.mockReset();
  sendMailMock.mockResolvedValue({ messageId: 'test' });
  createTransportMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function sentHtml(callIndex = 0): string {
  return sendMailMock.mock.calls[callIndex]![0].html;
}
function sentArg(callIndex = 0): SendMailArgs {
  return sendMailMock.mock.calls[callIndex]![0];
}

// ── Every sender renders without throwing, for a full sample and an
// all-optional-fields-null booking ─────────────────────────────────────────

describe('every sender renders HTML + text without throwing', () => {
  beforeEach(async () => {
    await seedConfigDefaults(CONFIGURED_SMTP);
  });

  const nullish = sampleBooking({
    deliveryAddress: '',
    selfPickup: true,
    customDays: null,
    preferredTime: null,
    notes: null,
    discountKr: null,
    discountLabel: null,
    paymentMethod: null,
    machineId: null,
    cancellationFee: null,
    adminNote: null,
  });

  for (const [label, b] of [['sample', sampleBooking()], ['all-optional-fields-null', nullish]] as const) {
    it(`sendBookingStatusEmail confirmed — ${label}`, async () => {
      await expect(email.sendBookingStatusEmail(b, 'confirmed')).resolves.not.toThrow();
      expect(sendMailMock).toHaveBeenCalledTimes(1);
      expect(sentArg().html).toBeTruthy();
      expect(sentArg().text).toBeTruthy();
    });

    it(`sendBookingStatusEmail cancelled — ${label}`, async () => {
      await email.sendBookingStatusEmail(b, 'cancelled', { reason: 'Test' });
      expect(sendMailMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it(`sendNewBookingAdminNotification — ${label}`, async () => {
      await email.sendNewBookingAdminNotification(b);
      expect(sendMailMock).toHaveBeenCalledTimes(1);
    });

    it(`sendBookingReminderEmail — ${label}`, async () => {
      await email.sendBookingReminderEmail(b);
      // Customer mail + admin heads-up mail.
      expect(sendMailMock).toHaveBeenCalledTimes(2);
    });

    it(`sendPaymentRetryEmail — ${label}`, async () => {
      await email.sendPaymentRetryEmail(b, 'https://graveklar.no/betal/xyz', 30);
      expect(sendMailMock).toHaveBeenCalledTimes(1);
    });

    it(`sendBookingExpiredEmail — ${label}`, async () => {
      await email.sendBookingExpiredEmail(b);
      expect(sendMailMock).toHaveBeenCalledTimes(1);
    });

    it(`sendRepeatDiscountEmail — ${label}`, async () => {
      await email.sendRepeatDiscountEmail(b, 'RETUR-ABCDE', 10, new Date('2027-01-01'));
      expect(sendMailMock).toHaveBeenCalledTimes(1);
    });

    it(`sendReviewRequestEmail — ${label}`, async () => {
      await email.sendReviewRequestEmail(b, 'review-token-123');
      expect(sendMailMock).toHaveBeenCalledTimes(1);
    });
  }

  it('sendTestEmail', async () => {
    await email.sendTestEmail({}, 'someone@example.com');
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it('sendContactMessageEmail', async () => {
    const ok = await email.sendContactMessageEmail({ name: 'Kari', email: 'kari@example.com', phone: '99011223', message: 'Hei' });
    expect(ok).toBe(true);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it('sendContactMessageEmail without a phone', async () => {
    const ok = await email.sendContactMessageEmail({ name: 'Kari', email: 'kari@example.com', message: 'Hei' });
    expect(ok).toBe(true);
  });

  it('sendSurveyDiscountEmail', async () => {
    await email.sendSurveyDiscountEmail('svar@example.com', 'LANSERING10', 10);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  const quote = {
    id: 'q1', reference: 'TILBUD-001', company: 'Bygg AS', orgNumber: '999888777',
    contactName: 'Per Byggmester', email: 'per@bygg.no', phone: '90000000',
    machineId: null, machine: null, startDate: new Date('2026-10-01'), rentalType: 'week',
    customDays: null, projectDescription: 'Graving av grunnmur', trainingConfirmed: true,
    offerAmount: 15000, offerMessage: null, offerValidUntil: null, paymentMode: null,
    acceptToken: 'accept-token', status: 'pending', createdAt: new Date(), updatedAt: new Date(),
  } as unknown as Parameters<typeof email.sendNewQuoteRequestAdminNotification>[0];

  it('sendNewQuoteRequestAdminNotification', async () => {
    await email.sendNewQuoteRequestAdminNotification(quote);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it('sendQuoteRequestReceivedEmail', async () => {
    await email.sendQuoteRequestReceivedEmail(quote);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it('sendQuoteOfferEmail', async () => {
    await email.sendQuoteOfferEmail(quote);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it('sendQuoteOfferEmail with no acceptToken falls back to a reply-by-email CTA', async () => {
    await email.sendQuoteOfferEmail({ ...quote, acceptToken: null });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sentHtml()).toContain('Svar på denne e-posten');
  });
});

// ── HTML escaping of user-controlled fields ─────────────────────────────────

describe('user-controlled fields are HTML-escaped, never raw', () => {
  beforeEach(async () => {
    await seedConfigDefaults(CONFIGURED_SMTP);
  });

  it('booking.name in the confirmed status email', async () => {
    await email.sendBookingStatusEmail(sampleBooking({ name: XSS }), 'confirmed');
    expect(sentHtml()).not.toContain(XSS);
  });

  it('booking.name and the cancellation reason are escaped in the CUSTOMER copy', async () => {
    await email.sendBookingStatusEmail(sampleBooking({ name: XSS }), 'cancelled', { reason: XSS });
    // Call 0 is always the customer copy (admin copy, if any, follows).
    expect(sentHtml(0)).not.toContain(XSS);
  });

  // FIXED J-2: `layout()` now escapes its `preheader` argument once, for both
  // places it lands (the <title> and the hidden accessibility <span>). Several
  // senders build it from a user-controlled field — the admin copy of the
  // cancellation notice uses `${booking.name} har avbestilt …` — and a
  // "hidden" span is still parsed markup, where an <img onerror> fires
  // (display:none does not stop the browser requesting the image).
  it('booking.name is also escaped in the preheader of the ADMIN copy', async () => {
    await email.sendBookingStatusEmail(sampleBooking({ name: XSS }), 'cancelled', { reason: 'ok' });
    expect(sendMailMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(sentHtml(1)).not.toContain(XSS);
  });

  it('booking.deliveryAddress in the confirmed status email', async () => {
    await email.sendBookingStatusEmail(sampleBooking({ deliveryAddress: XSS, selfPickup: false }), 'confirmed');
    expect(sentHtml()).not.toContain(XSS);
  });

  it('booking.notes in the admin new-booking notification', async () => {
    await email.sendNewBookingAdminNotification(sampleBooking({ notes: XSS }));
    expect(sentHtml()).not.toContain(XSS);
  });

  // FIXED J-2 (see the cancelled-admin-copy case above): the admin
  // new-booking notification's preheader is `Ny booking fra ${booking.name}`.
  it('booking.name is escaped in the admin new-booking notification (preheader included)', async () => {
    await email.sendNewBookingAdminNotification(sampleBooking({ name: XSS }));
    expect(sentHtml()).not.toContain(XSS);
  });

  it('booking.name in the payment-retry email', async () => {
    await email.sendPaymentRetryEmail(sampleBooking({ name: XSS }), 'https://graveklar.no/x');
    expect(sentHtml()).not.toContain(XSS);
  });

  it('booking.name in the booking-expired email', async () => {
    await email.sendBookingExpiredEmail(sampleBooking({ name: XSS }));
    expect(sentHtml()).not.toContain(XSS);
  });

  it('booking.name in the reminder email (customer + admin copy)', async () => {
    await email.sendBookingReminderEmail(sampleBooking({ name: XSS }));
    for (let i = 0; i < sendMailMock.mock.calls.length; i++) {
      expect(sentHtml(i)).not.toContain(XSS);
    }
  });

  it('booking.name in the repeat-discount email', async () => {
    await email.sendRepeatDiscountEmail(sampleBooking({ name: XSS }), 'RETUR-X', 10, null);
    expect(sentHtml()).not.toContain(XSS);
  });

  it("booking.name's first token in the review-request email", async () => {
    await email.sendReviewRequestEmail(sampleBooking({ name: XSS }), 'tok');
    expect(sentHtml()).not.toContain(XSS);
  });

  it('the contact form email and message body are escaped', async () => {
    await email.sendContactMessageEmail({ name: 'Trygg Navn', email: `${XSS}@example.com`, message: XSS });
    expect(sentHtml()).not.toContain(XSS);
  });

  // FIXED J-2 (see above): sendContactMessageEmail's preheader is
  // `Henvendelse fra ${input.name}` — a submitter's own name used to inject
  // markup into the admin's inbox preview.
  it('the contact form name is escaped everywhere, including the preheader', async () => {
    await email.sendContactMessageEmail({ name: XSS, email: 'a@b.com', message: 'hi' });
    expect(sentHtml()).not.toContain(XSS);
  });

  it('discount code is escaped in the survey-discount email', async () => {
    await email.sendSurveyDiscountEmail('a@b.com', XSS, 10);
    expect(sentHtml()).not.toContain(XSS);
  });

  it('quote fields (contact name, project description, offer message) are escaped in the received + offer emails', async () => {
    const quote = {
      id: 'q1', reference: 'TILBUD-002', company: 'Trygg Firma AS', orgNumber: '1', contactName: XSS,
      email: 'a@b.com', phone: '90000000', machineId: null, machine: null, startDate: null,
      rentalType: null, customDays: null, projectDescription: XSS, trainingConfirmed: false,
      offerAmount: null, offerMessage: XSS, offerValidUntil: null, paymentMode: null,
      acceptToken: null, status: 'pending', createdAt: new Date(), updatedAt: new Date(),
    } as unknown as Parameters<typeof email.sendNewQuoteRequestAdminNotification>[0];

    await email.sendQuoteRequestReceivedEmail(quote);
    expect(sentHtml()).not.toContain(XSS);
    sendMailMock.mockClear();

    await email.sendQuoteOfferEmail(quote);
    expect(sentHtml()).not.toContain(XSS);
  });

  it('quote fields (company, contact name, project description) are escaped in the admin notification BODY', async () => {
    const quote = {
      id: 'q1', reference: 'TILBUD-002', company: 'Trygg Firma AS', orgNumber: '1', contactName: XSS,
      email: 'a@b.com', phone: '90000000', machineId: null, machine: null, startDate: null,
      rentalType: null, customDays: null, projectDescription: XSS, trainingConfirmed: false,
      offerAmount: null, offerMessage: null, offerValidUntil: null, paymentMode: null,
      acceptToken: null, status: 'pending', createdAt: new Date(), updatedAt: new Date(),
    } as unknown as Parameters<typeof email.sendNewQuoteRequestAdminNotification>[0];
    await email.sendNewQuoteRequestAdminNotification(quote);
    expect(sentHtml()).not.toContain(XSS);
  });

  // FIXED J-2 (see above): sendNewQuoteRequestAdminNotification's preheader is
  // `Ny bedriftsforespørsel fra ${quote.company}`.
  it('quote.company is escaped everywhere in the admin notification, including the preheader', async () => {
    const quote = {
      id: 'q1', reference: 'TILBUD-003', company: XSS, orgNumber: '1', contactName: 'Trygg Kontakt',
      email: 'a@b.com', phone: '90000000', machineId: null, machine: null, startDate: null,
      rentalType: null, customDays: null, projectDescription: null, trainingConfirmed: false,
      offerAmount: null, offerMessage: null, offerValidUntil: null, paymentMode: null,
      acceptToken: null, status: 'pending', createdAt: new Date(), updatedAt: new Date(),
    } as unknown as Parameters<typeof email.sendNewQuoteRequestAdminNotification>[0];
    await email.sendNewQuoteRequestAdminNotification(quote);
    expect(sentHtml()).not.toContain(XSS);
  });
});

// ── SMTP configuration behaviour ─────────────────────────────────────────────

describe('SMTP configuration', () => {
  it('an unconfigured (blank host) SMTP resolves without calling sendMail', async () => {
    await seedConfigDefaults(); // smtpHost defaults to ''
    // Rewritten for FIXED P-4: the senders now report whether anything was
    // actually sent, so an unconfigured SMTP resolves `false` rather than
    // `undefined` — that boolean is what the admin test-email button checks.
    await expect(email.sendTestEmail({}, 'a@b.com')).resolves.toBe(false);
    expect(sendMailMock).not.toHaveBeenCalled();
    expect(createTransportMock).not.toHaveBeenCalled();
  });

  it('blank smtpFrom derives the From address from the siteUrl host, not a placeholder domain', async () => {
    await seedConfigDefaults({
      ...CONFIGURED_SMTP,
      smtpFrom: '',
      siteUrl: 'https://www.eksempel-utleie.no',
      businessName: 'Eksempel Utleie',
    });
    await email.sendTestEmail({}, 'a@b.com');
    expect(sentArg().from).toBe('Eksempel Utleie <noreply@eksempel-utleie.no>');
  });

  it('blank smtpFrom AND blank siteUrl falls back to the graveklar.no domain', async () => {
    await seedConfigDefaults({ ...CONFIGURED_SMTP, smtpFrom: '', siteUrl: '' });
    await email.sendTestEmail({}, 'a@b.com');
    expect(sentArg().from).toContain('@graveklar.no');
  });

  it('adminEmail unset — the admin notification warns and never calls sendMail', async () => {
    await seedConfigDefaults({ ...CONFIGURED_SMTP, adminEmail: '' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await email.sendNewBookingAdminNotification(sampleBooking());
      expect(sendMailMock).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('sendContactMessageEmail returns false and never sends when there is no recipient at all', async () => {
    await seedConfigDefaults({ ...CONFIGURED_SMTP, adminEmail: '', contactEmail: '' });
    const ok = await email.sendContactMessageEmail({ name: 'A', email: 'a@b.com', message: 'hi' });
    expect(ok).toBe(false);
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});

// ── Retry policy ─────────────────────────────────────────────────────────────

describe('transient SMTP error retry', () => {
  beforeEach(async () => {
    await seedConfigDefaults(CONFIGURED_SMTP);
  });

  // The backoff (5s/10s/15s) is driven by the real global `setTimeout`. Fully
  // faking timers here fights the concurrent real Prisma I/O inside
  // getSmtpConfig(), so instead we replace `setTimeout` with a spy that
  // records the requested delay and fires immediately — proving the delay
  // schedule without a single real second of wall-clock wait.
  function instantTimeouts(): { delays: number[]; restore: () => void } {
    const delays: number[] = [];
    const real = global.setTimeout;
    const spy = vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      queueMicrotask(fn);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    return { delays, restore: () => { spy.mockRestore(); void real; } };
  }

  it('retries 421 up to 3 times with 5s/10s/15s backoff, then gives up', async () => {
    const { delays, restore } = instantTimeouts();
    try {
      const err = Object.assign(new Error('service unavailable'), { responseCode: 421 });
      sendMailMock.mockRejectedValue(err);

      await expect(email.sendTestEmail({}, 'a@b.com')).rejects.toThrow('service unavailable');

      expect(sendMailMock).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
      expect(delays).toEqual([5_000, 10_000, 15_000]);
    } finally {
      restore();
    }
  });

  it('retries 451 the same way and succeeds once the transient error clears', async () => {
    const { delays, restore } = instantTimeouts();
    try {
      const err = Object.assign(new Error('local error'), { responseCode: 451 });
      sendMailMock
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce({ messageId: 'ok' });

      await email.sendTestEmail({}, 'a@b.com');

      expect(sendMailMock).toHaveBeenCalledTimes(2);
      expect(delays).toEqual([5_000]);
    } finally {
      restore();
    }
  });

  it('does NOT retry a 550 (permanent rejection) — fails immediately', async () => {
    const err = Object.assign(new Error('mailbox unavailable'), { responseCode: 550 });
    sendMailMock.mockRejectedValueOnce(err);

    await expect(email.sendTestEmail({}, 'a@b.com')).rejects.toThrow('mailbox unavailable');
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry an error with no responseCode', async () => {
    sendMailMock.mockRejectedValueOnce(new Error('boom'));
    await expect(email.sendTestEmail({}, 'a@b.com')).rejects.toThrow('boom');
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });
});

// ── Admin MVA line uses the configured rate, not a hardcoded 25% ───────────

describe('admin new-booking notification MVA line', () => {
  beforeEach(async () => {
    await seedConfigDefaults(CONFIGURED_SMTP);
  });

  // FIXED J-1: sendNewBookingAdminNotification used to compute the MVA split
  // as `totalPrice - totalPrice / 1.25` and print a hardcoded "MVA (25 %)"
  // label. It now reads PricingConfig.mvaRate through readMvaSettings()/
  // splitMva(), like every other MVA figure in the app.
  it('reflects the configured mvaRate, not a hardcoded 25%', async () => {
    await setPricing({ mvaRate: 20 });
    const booking = sampleBooking({ totalPrice: 1250 });

    await email.sendNewBookingAdminNotification(booking);

    const html = sentHtml();
    // Correct at 20%: ex-mva = 1250 / 1.20 = 1041.67 → mva ≈ 208 kr.
    expect(html).toContain('MVA (20 %)');
    expect(html).toContain('208');
    expect(html).not.toContain('MVA (25 %)');
  });
});
