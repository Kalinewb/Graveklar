import { describe, it, expect } from 'vitest';
import { createHash, createHmac } from 'crypto';
import {
  buildPaymentReference,
  fromMinorUnits,
  isValidVippsReference,
  toMinorUnits,
  verifyWebhookSignature,
} from '@/lib/vipps';

describe('amount conversion', () => {
  it('converts kroner to øre', () => {
    expect(toMinorUnits(2695)).toBe(269500);
    expect(toMinorUnits(0)).toBe(0);
  });

  it('rounds away float dust instead of truncating', () => {
    // 299.5 * 100 === 29949.999999999996 in IEEE 754; a truncating
    // conversion would undercharge by one øre.
    expect(toMinorUnits(299.5)).toBe(29950);
  });

  it('matches the Stripe conversion exactly', () => {
    // lib/stripe.ts charges Math.round(amountNOK * 100). The two providers
    // must never disagree on what the same booking costs.
    for (const kr of [0, 1, 999, 2695, 12500, 299.5, 1234.56]) {
      expect(toMinorUnits(kr)).toBe(Math.round(kr * 100));
    }
  });

  it('round-trips', () => {
    expect(fromMinorUnits(toMinorUnits(2695))).toBe(2695);
  });
});

describe('payment references', () => {
  it('accepts a booking reference as-is on the first attempt', () => {
    expect(buildPaymentReference('GK-2609-001-P6V32', 1)).toBe('GK-2609-001-P6V32');
  });

  it('never reuses a reference across attempts', () => {
    const first = buildPaymentReference('GK-2609-001-P6V32', 1);
    const second = buildPaymentReference('GK-2609-001-P6V32', 2);
    const third = buildPaymentReference('GK-2609-001-P6V32', 3);
    expect(new Set([first, second, third]).size).toBe(3);
  });

  it('strips characters Vipps rejects', () => {
    expect(buildPaymentReference('GK/2609 001', 1)).toBe('GK2609001');
  });

  it('throws rather than sending an invalid reference', () => {
    expect(() => buildPaymentReference('GK-1', 1)).toThrow();
  });

  it('validates the documented format (a-zA-Z0-9-, 8–64 chars)', () => {
    expect(isValidVippsReference('GK-2609-001')).toBe(true);
    expect(isValidVippsReference('short')).toBe(false);
    expect(isValidVippsReference('has_underscore_x')).toBe(false);
    expect(isValidVippsReference('a'.repeat(65))).toBe(false);
    expect(isValidVippsReference('a'.repeat(64))).toBe(true);
  });
});

describe('webhook signature verification', () => {
  const secret = 'test-webhook-secret';
  const body = JSON.stringify({ reference: 'GK-2609-001', name: 'AUTHORIZED' });
  const date = 'Thu, 30 Mar 2023 08:38:32 GMT';
  const host = 'graveklar.no';
  const path = '/api/payment/vipps/webhook';

  function sign(opts: {
    body?: string;
    path?: string;
    method?: string;
    date?: string;
    host?: string;
    secret?: string;
  } = {}) {
    const useBody = opts.body ?? body;
    const contentHash = createHash('sha256').update(useBody, 'utf8').digest('base64');
    const signedString = `${opts.method ?? 'POST'}\n${opts.path ?? path}\n${opts.date ?? date};${opts.host ?? host};${contentHash}`;
    const signature = createHmac('sha256', Buffer.from(opts.secret ?? secret, 'utf8'))
      .update(signedString, 'utf8')
      .digest('base64');
    return {
      method: opts.method ?? 'POST',
      pathWithQuery: opts.path ?? path,
      rawBody: useBody,
      headers: {
        authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`,
        xMsDate: opts.date ?? date,
        xMsContentSha256: contentHash,
        host: opts.host ?? host,
      },
      secret,
    };
  }

  it('accepts a correctly signed request', () => {
    expect(verifyWebhookSignature(sign())).toBe(true);
  });

  it('rejects a tampered body', () => {
    const input = sign();
    input.rawBody = JSON.stringify({ reference: 'GK-OTHER', name: 'AUTHORIZED' });
    expect(verifyWebhookSignature(input)).toBe(false);
  });

  it('rejects a body swapped together with its content hash', () => {
    // Attacker recomputes the hash but cannot recompute the HMAC.
    const evil = JSON.stringify({ reference: 'GK-EVIL', name: 'AUTHORIZED' });
    const input = sign();
    input.rawBody = evil;
    input.headers.xMsContentSha256 = createHash('sha256').update(evil, 'utf8').digest('base64');
    expect(verifyWebhookSignature(input)).toBe(false);
  });

  it('rejects a signature made with the wrong secret', () => {
    const input = sign({ secret: 'attacker-secret' });
    expect(verifyWebhookSignature(input)).toBe(false);
  });

  it('rejects when the signed path differs from the called path', () => {
    const input = sign();
    input.pathWithQuery = '/api/payment/vipps/webhook?injected=1';
    expect(verifyWebhookSignature(input)).toBe(false);
  });

  it('rejects when the host differs', () => {
    const input = sign();
    input.headers.host = 'evil.example.com';
    expect(verifyWebhookSignature(input)).toBe(false);
  });

  it('rejects when required headers are missing', () => {
    for (const key of ['authorization', 'xMsDate', 'xMsContentSha256', 'host'] as const) {
      const input = sign();
      const headers: Record<string, string | null> = { ...input.headers };
      headers[key] = null;
      expect(verifyWebhookSignature({ ...input, headers })).toBe(false);
    }
  });

  it('rejects when no secret is configured', () => {
    const input = sign();
    input.secret = '';
    expect(verifyWebhookSignature(input)).toBe(false);
  });

  it('rejects an Authorization header with no Signature part', () => {
    const input = sign();
    input.headers.authorization = 'HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256';
    expect(verifyWebhookSignature(input)).toBe(false);
  });
});
