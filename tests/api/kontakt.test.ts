import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Rather than mocking '@/lib/email' wholesale (which would mask the exact
// behaviour this file needs to check — the 503-when-unconfigured path and
// the Reply-To header), mock only the external dependency: nodemailer. All
// of src/lib/email.ts's real logic runs (SMTP-config gate, formatting,
// Reply-To), and `sendMail` never touches a socket.
const transport = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  reset(): void {
    transport.calls.length = 0;
  },
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async (opts: Record<string, unknown>) => {
        transport.calls.push(opts);
        return { messageId: 'test' };
      },
    }),
  },
}));

import { db, ensureSchema, invalidateCaches, resetDb, seedConfigDefaults } from '../helpers/db';
import { call } from '../helpers/route';

// L2 — POST /api/kontakt. The public contact form: gated by
// contactFormEnabled (default 'true'), honeypot, field validation, 503 when
// SMTP is unconfigured (the real, unmocked email module's own behaviour),
// Reply-To set to the sender, and a 5/15-min limiter.

let POST: typeof import('@/app/api/kontakt/route').POST;

let ipSeq = 0;
function ip(): Record<string, string> {
  return { 'x-forwarded-for': `10.5.0.${++ipSeq}` };
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Kari Nordmann',
    email: 'kari@example.com',
    phone: '+4740000001',
    message: 'Jeg lurer på om dere har ledig minigraver neste helg.',
    ...overrides,
  };
}

async function post(body: unknown, headers: Record<string, string> = ip()) {
  return call(POST, { method: 'POST', path: '/api/kontakt', body, headers });
}

/** Valid SMTP config so sendContactMessageEmail's real send() path runs
 *  against the mocked transporter instead of short-circuiting at "not
 *  configured". */
async function configureSmtp(): Promise<void> {
  for (const [key, value] of Object.entries({
    smtpHost: 'smtp.example.com',
    smtpUser: 'user@example.com',
    smtpPass: 'secret',
    adminEmail: 'admin@example.com',
  })) {
    await db.appConfig.update({ where: { key }, data: { value } });
  }
  invalidateCaches();
}

beforeAll(async () => {
  await ensureSchema();
  ({ POST } = await import('@/app/api/kontakt/route'));
});

beforeEach(async () => {
  await resetDb();
  await seedConfigDefaults();
  transport.reset();
});

describe('the contactFormEnabled gate', () => {
  it('APP_CONFIG_DEFAULTS ships contactFormEnabled = true', async () => {
    const row = await db.appConfig.findUniqueOrThrow({ where: { key: 'contactFormEnabled' } });
    expect(row.value).toBe('true');
  });

  it('404s once the admin turns it off', async () => {
    await db.appConfig.update({ where: { key: 'contactFormEnabled' }, data: { value: 'false' } });
    invalidateCaches();
    const res = await post(validBody());
    expect(res.status).toBe(404);
  });
});

describe('POST /api/kontakt — honeypot and validation', () => {
  it('400s on the honeypot field', async () => {
    const res = await post(validBody({ website: 'http://spam.example' }));
    expect(res.status).toBe(400);
  });

  it('400s on malformed JSON', async () => {
    const res = await call(POST, {
      method: 'POST', path: '/api/kontakt',
      headers: { ...ip(), 'content-type': 'application/json' },
      body: '{ not json',
    });
    expect(res.status).toBe(400);
  });

  it('requires a name of at least 2 characters', async () => {
    expect((await post(validBody({ name: 'A' }))).status).toBe(400);
    expect((await post(validBody({ name: '' }))).status).toBe(400);
  });

  it('requires a well-formed email', async () => {
    for (const bad of ['not-an-email', 'a@b', '@example.com']) {
      expect((await post(validBody({ email: bad }))).status).toBe(400);
    }
  });

  it('requires a message of at least 10 characters', async () => {
    expect((await post(validBody({ message: 'too short' }))).status).toBe(400);
  });

  it('rejects a message over 5000 characters', async () => {
    expect((await post(validBody({ message: 'x'.repeat(5001) }))).status).toBe(400);
    expect((await post(validBody({ message: 'x'.repeat(5000) }))).status).not.toBe(400);
  });
});

describe('POST /api/kontakt — SMTP unconfigured (real, unmocked email module)', () => {
  it('503s when no SMTP host/user/pass and no adminEmail/contactEmail are set', async () => {
    // seedConfigDefaults() ships every smtp* key and adminEmail/contactEmail
    // blank, so this is the out-of-the-box state.
    const res = await post(validBody());
    expect(res.status).toBe(503);
    expect(transport.calls).toHaveLength(0); // never even reached nodemailer
  });
});

describe('POST /api/kontakt — success (SMTP configured)', () => {
  beforeEach(configureSmtp);

  it('200s and actually calls the (mocked) transporter', async () => {
    const res = await post(validBody());
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ success: true });
    expect(transport.calls).toHaveLength(1);
  });

  it('Reply-To is the sender\'s own address, not the business admin address', async () => {
    const res = await post(validBody({ email: 'sender@example.com' }));
    expect(res.status).toBe(200);
    expect(transport.calls[0].replyTo).toBe('sender@example.com');
    expect(transport.calls[0].to).toBe('admin@example.com');
  });

  it('the recipient is adminEmail, falling back to contactEmail when adminEmail is blank', async () => {
    await db.appConfig.update({ where: { key: 'adminEmail' }, data: { value: '' } });
    await db.appConfig.update({ where: { key: 'contactEmail' }, data: { value: 'kontakt@example.com' } });
    invalidateCaches();
    const res = await post(validBody());
    expect(res.status).toBe(200);
    expect(transport.calls[0].to).toBe('kontakt@example.com');
  });
});

describe('POST /api/kontakt — rate limit', () => {
  it('allows 5 requests then 429s the 6th, from the same identity', async () => {
    const headers = ip();
    for (let i = 0; i < 5; i++) {
      const res = await post(validBody(), headers);
      expect(res.status, `request ${i + 1}`).not.toBe(429);
    }
    expect((await post(validBody(), headers)).status).toBe(429);
  });
});
