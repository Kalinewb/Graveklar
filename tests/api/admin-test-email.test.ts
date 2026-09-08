/**
 * L2 — POST /api/admin/app-config/test-email, against the REAL email module.
 *
 * tests/api/app-config.test.ts covers this route with `mockEmail()`, which
 * replaces every sender with a stub that always reports success — exactly the
 * thing finding P-4 is about, so it cannot see the bug. Here the transport is
 * stubbed one level down instead (`vi.mock('nodemailer')`), so the real
 * senders run and the route sees what they really report. Nothing leaves the
 * process either way.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface SendMailArgs {
  from: string; to: string; subject: string; html: string; text: string;
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

import { ensureSchema, resetDb, seedConfigDefaults } from '../helpers/db';
import { call } from '../helpers/route';

const WORKING_SMTP = {
  adminEmail: 'drift@example.com',
  smtpHost: 'smtp.example.no',
  smtpPort: '587',
  smtpSecure: 'false',
  smtpUser: 'sender@example.no',
  smtpPass: 'secret',
  smtpFrom: 'Graveklar <post@graveklar.no>',
  siteUrl: 'https://graveklar.no',
};

async function testEmail(template = 'test') {
  const { POST } = await import('@/app/api/admin/app-config/test-email/route');
  return call(POST, {
    method: 'POST',
    path: '/api/admin/app-config/test-email',
    searchParams: { template },
  });
}

beforeAll(() => ensureSchema());

beforeEach(async () => {
  await resetDb();
  sendMailMock.mockReset();
  sendMailMock.mockResolvedValue({ messageId: 'test' });
  createTransportMock.mockClear();
});

// FIXED P-4: the route returned `{success:true}` unconditionally while
// `send()` in src/lib/email.ts returned `undefined` after
// `console.warn('SMTP not configured — skipping email to', …)`. The owner's
// only way to check the SMTP setup therefore always said yes — the toast read
// "✓ Sendt" with no mail server configured at all. Every sender the route uses
// now reports whether the message actually left the process.
describe('POST /api/admin/app-config/test-email — reporting what really happened', () => {
  it('reports a failure when SMTP is not configured, instead of a green success', async () => {
    await seedConfigDefaults({ adminEmail: 'drift@example.com' }); // smtpHost defaults to ''
    const res = await testEmail('test');

    expect(res.status).toBe(400);
    expect(res.json.success).toBeUndefined();
    expect(res.json.error).toContain('SMTP');
    // Nothing was even attempted: no transport was constructed.
    expect(createTransportMock).not.toHaveBeenCalled();
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('reports a failure when the host is set but the credentials are not', async () => {
    await seedConfigDefaults({ ...WORKING_SMTP, smtpPass: '' });
    const res = await testEmail('test');
    expect(res.status).toBe(400);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('answers 200 only when the message was actually accepted by the transport', async () => {
    await seedConfigDefaults(WORKING_SMTP);
    const res = await testEmail('test');

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ success: true, template: 'test', to: 'drift@example.com' });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock.mock.calls[0][0].to).toBe('drift@example.com');
  });

  it('surfaces a rejected send as a 500 carrying the reason', async () => {
    await seedConfigDefaults(WORKING_SMTP);
    sendMailMock.mockRejectedValueOnce(new Error('SMTP-tilkobling nektet'));

    const res = await testEmail('test');
    expect(res.status).toBe(500);
    expect(res.json.error).toContain('SMTP-tilkobling nektet');
  });

  it('the payment-retry template reports the same way (every template goes through send())', async () => {
    await seedConfigDefaults({ ...WORKING_SMTP, smtpHost: '' });
    const res = await testEmail('payment-retry');
    expect(res.status).toBe(400);
    expect(res.json.template).toBe('payment-retry');
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('still refuses before sending when no admin address is configured', async () => {
    const originalEnv = process.env.ADMIN_EMAIL;
    try {
      delete process.env.ADMIN_EMAIL;
      await seedConfigDefaults({ ...WORKING_SMTP, adminEmail: '' });
      const res = await testEmail('test');
      expect(res.status).toBe(400);
      expect(res.json.error).toContain('Admin-e-post');
      expect(sendMailMock).not.toHaveBeenCalled();
    } finally {
      if (originalEnv === undefined) delete process.env.ADMIN_EMAIL;
      else process.env.ADMIN_EMAIL = originalEnv;
    }
  });
});
