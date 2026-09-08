/**
 * L1 — the TOTP second factor.
 *
 * Nothing here enrols 2FA through the product's enrollment flow. Codes are
 * derived with otplib in isolation against a fixed test secret, and the
 * "enrolled" state is an `AdminTotp` row written straight into the per-worker
 * scratch database (see tests/helpers/auth.ts).
 *
 * The properties that matter: a code is accepted at most once per 30-second
 * step (replay guard), the code format is enforced before any crypto runs, and
 * `requireTotp()` is fail-closed when 2FA has never been set up — the sensitive
 * saves rely on that to refuse rather than wave a change through.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  isTotpEnrolled,
  readTotpHeader,
  requireTotp,
  startTotpEnrollment,
  verifyTotpCode,
  verifyTotpCodeAgainst,
} from '@/lib/totp';

import { db, ensureSchema, resetDb } from '../helpers/db';
import { mockClock } from '../helpers/mocks';
import { TEST_TOTP_SECRET, seedTotpSecret, totpCodeFor, totpStep } from '../helpers/auth';

const STEP_MS = 30_000;
// A time whose epoch-seconds sit comfortably inside one 30 s step, so the
// "current step" a test computes cannot straddle a boundary.
const FROZEN = '2026-09-06T12:00:05.000Z';

beforeAll(() => ensureSchema());
beforeEach(() => resetDb());

describe('verifyTotpCodeAgainst', () => {
  it('accepts the code for the current time step', async () => {
    const clock = mockClock(FROZEN);
    try {
      const code = await totpCodeFor(TEST_TOTP_SECRET);
      expect(code).toMatch(/^\d{6}$/);
      expect(await verifyTotpCodeAgainst(TEST_TOTP_SECRET, code)).toBe(true);
    } finally {
      clock.restore();
    }
  });

  it('rejects a code from an adjacent time step — there is no tolerance window', async () => {
    // Documented behaviour: otplib's `epochTolerance` defaults to 0 and
    // src/lib/totp.ts does not raise it, so a code entered a second after its
    // step rolls over is refused. Strict (an authenticator ~20 s of clock skew
    // out will never work) but not a security defect; the alternative widens
    // the replay surface the lastUsedStep guard exists to close.
    const clock = mockClock(FROZEN);
    try {
      const previous = await totpCodeFor(TEST_TOTP_SECRET, Date.now() - STEP_MS);
      const next = await totpCodeFor(TEST_TOTP_SECRET, Date.now() + STEP_MS);
      expect(await verifyTotpCodeAgainst(TEST_TOTP_SECRET, previous)).toBe(false);
      expect(await verifyTotpCodeAgainst(TEST_TOTP_SECRET, next)).toBe(false);
    } finally {
      clock.restore();
    }
  });

  it('enforces the 6-digit format before touching the secret', async () => {
    const clock = mockClock(FROZEN);
    try {
      const good = await totpCodeFor(TEST_TOTP_SECRET);
      for (const bad of [
        '',
        '12345',
        '1234567',
        'abcdef',
        '12345a',
        ` ${good}`,
        `${good} `,
        good.slice(0, 3) + ' ' + good.slice(3),
        '+12345',
        '０００００１', // full-width digits
      ]) {
        expect(await verifyTotpCodeAgainst(TEST_TOTP_SECRET, bad)).toBe(false);
      }
      // …and the well-formed one still works, so the loop above proves format
      // rejection rather than a broken secret.
      expect(await verifyTotpCodeAgainst(TEST_TOTP_SECRET, good)).toBe(true);
    } finally {
      clock.restore();
    }
  });

  it('rejects a valid-looking code for a different secret', async () => {
    const clock = mockClock(FROZEN);
    try {
      const other = startTotpEnrollment().secret;
      const code = await totpCodeFor(other);
      expect(await verifyTotpCodeAgainst(TEST_TOTP_SECRET, code)).toBe(false);
    } finally {
      clock.restore();
    }
  });
});

describe('startTotpEnrollment', () => {
  it('produces a fresh Base32 secret and a scannable otpauth URI, and persists nothing', async () => {
    const a = startTotpEnrollment();
    const b = startTotpEnrollment();
    expect(a.secret).not.toBe(b.secret);
    expect(a.secret).toMatch(/^[A-Z2-7]+=*$/);
    expect(a.otpauthUri.startsWith('otpauth://totp/')).toBe(true);
    expect(a.otpauthUri).toContain('Graveklar');
    expect(a.otpauthUri).toContain(`secret=${a.secret}`);
    expect(a.accountLabel).toBe('admin');
    expect(await db.adminTotp.count()).toBe(0);
  });
});

describe('verifyTotpCode replay guard', () => {
  it('accepts a code once per 30-second step and refuses the replay', async () => {
    await seedTotpSecret();
    const clock = mockClock(FROZEN);
    try {
      const code = await totpCodeFor();
      expect(await verifyTotpCode(code)).toBe(true);

      const row = await db.adminTotp.findFirstOrThrow();
      expect(row.lastUsedStep).toBe(totpStep(Date.now()));
      expect(row.lastUsedAt).not.toBeNull();

      // Same step, same code: the guard is what stops a captured code being
      // replayed inside its own window.
      expect(await verifyTotpCode(code)).toBe(false);

      // Still the same step a few seconds later — still refused.
      clock.advance(5_000);
      expect(await verifyTotpCode(code)).toBe(false);
    } finally {
      clock.restore();
    }
  });

  it('accepts the next step\'s code once the window rolls over', async () => {
    await seedTotpSecret();
    const clock = mockClock(FROZEN);
    try {
      expect(await verifyTotpCode(await totpCodeFor())).toBe(true);
      const firstStep = totpStep(Date.now());

      clock.advance(STEP_MS);
      expect(totpStep(Date.now())).toBe(firstStep + 1);
      expect(await verifyTotpCode(await totpCodeFor())).toBe(true);
      expect((await db.adminTotp.findFirstOrThrow()).lastUsedStep).toBe(firstStep + 1);
    } finally {
      clock.restore();
    }
  });

  it('does not burn the step on a failed attempt', async () => {
    await seedTotpSecret();
    const clock = mockClock(FROZEN);
    try {
      expect(await verifyTotpCode('000000')).toBe(false);
      expect((await db.adminTotp.findFirstOrThrow()).lastUsedStep).toBeNull();
      expect(await verifyTotpCode(await totpCodeFor())).toBe(true);
    } finally {
      clock.restore();
    }
  });

  it('returns false when nothing is enrolled', async () => {
    const clock = mockClock(FROZEN);
    try {
      expect(await isTotpEnrolled()).toBe(false);
      expect(await verifyTotpCode(await totpCodeFor())).toBe(false);
    } finally {
      clock.restore();
    }
  });
});

describe('requireTotp', () => {
  const withCode = (code?: string) =>
    new Request('http://localhost/x', { headers: code ? { 'x-admin-totp': code } : {} });

  it('reads the code from x-admin-totp only', () => {
    expect(readTotpHeader(withCode('123456'))).toBe('123456');
    expect(readTotpHeader(withCode())).toBeNull();
    expect(
      readTotpHeader(new Request('http://localhost/x', { headers: { 'x-totp': '123456' } })),
    ).toBeNull();
  });

  it('is fail-closed when 2FA has never been enrolled', async () => {
    const result = await requireTotp(withCode('123456'));
    expect(result).toEqual({ ok: false, reason: 'not-enrolled' });
  });

  it('distinguishes missing, invalid and valid once enrolled', async () => {
    await seedTotpSecret();
    const clock = mockClock(FROZEN);
    try {
      expect(await requireTotp(withCode())).toEqual({ ok: false, reason: 'missing' });
      expect(await requireTotp(withCode('000000'))).toEqual({ ok: false, reason: 'invalid' });

      const code = await totpCodeFor();
      expect(await requireTotp(withCode(code))).toEqual({ ok: true });
      // Replay inside the same step degrades to `invalid`, not `ok`.
      expect(await requireTotp(withCode(code))).toEqual({ ok: false, reason: 'invalid' });
    } finally {
      clock.restore();
    }
  });
});
