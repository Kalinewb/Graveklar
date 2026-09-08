/**
 * L1 — the renter QR-kiosk session.
 *
 * This token is the only thing standing between a phone in a customer's hand
 * and the checklist/upload endpoints, so it has to bind BOTH the booking and
 * the phone number, expire quickly, and never be confusable with the admin
 * session token (whose secret it falls back to when RENTER_SESSION_SECRET is
 * unset).
 */
import { describe, expect, it } from 'vitest';

import { verifySessionToken } from '@/lib/admin-auth';
import {
  createRenterSessionToken,
  extractBearerToken,
  verifyRenterSessionToken,
} from '@/lib/renter-checklist-session';

import { mockClock } from '../helpers/mocks';
import {
  b64urlDecode,
  b64urlEncode,
  renterTokenExpiringAt,
  signAdminToken,
  signRenterToken,
} from '../helpers/auth';

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const BOOKING = 'ckqz0000abcdefghijklmno';
const PHONE = '+4740000000';

describe('renter session token', () => {
  it('round-trips the booking id and phone it was minted for', async () => {
    const token = await createRenterSessionToken(BOOKING, PHONE);
    const payload = await verifyRenterSessionToken(token);
    expect(payload).toMatchObject({ bookingId: BOOKING, phone: PHONE });
    expect(payload!.exp).toBeGreaterThan(Date.now());

    const decoded = b64urlDecode(token);
    expect(decoded.startsWith(`renter:${BOOKING}:${PHONE}:`)).toBe(true);
    expect(decoded.split(':').pop()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('expires four hours after issue, inclusive of the boundary instant', async () => {
    const clock = mockClock('2026-09-06T09:00:00.000Z');
    try {
      const issuedAt = Date.now();
      const token = await createRenterSessionToken(BOOKING, PHONE);
      const payload = await verifyRenterSessionToken(token);
      expect(payload!.exp).toBe(issuedAt + FOUR_HOURS_MS);

      clock.advance(FOUR_HOURS_MS);
      expect(await verifyRenterSessionToken(token)).not.toBeNull();

      clock.advance(1);
      expect(await verifyRenterSessionToken(token)).toBeNull();
    } finally {
      clock.restore();
    }
  });

  it('rejects an already-expired token', async () => {
    const stale = await renterTokenExpiringAt(BOOKING, PHONE, Date.now() - 1);
    expect(await verifyRenterSessionToken(stale)).toBeNull();
  });

  it('rejects a tampered signature and a re-pointed booking id', async () => {
    const token = await createRenterSessionToken(BOOKING, PHONE);
    const decoded = b64urlDecode(token);
    const cut = decoded.lastIndexOf(':');
    const payload = decoded.slice(0, cut);
    const sig = decoded.slice(cut + 1);

    const flipped = (sig[0] === '0' ? '1' : '0') + sig.slice(1);
    expect(await verifyRenterSessionToken(b64urlEncode(`${payload}:${flipped}`))).toBeNull();

    // Same signature, someone else's booking.
    const repointed = payload.replace(BOOKING, 'ckqz9999zzzzzzzzzzzzzzz');
    expect(await verifyRenterSessionToken(b64urlEncode(`${repointed}:${sig}`))).toBeNull();

    // Same signature, someone else's phone.
    const rephoned = payload.replace(PHONE, '+4790000000');
    expect(await verifyRenterSessionToken(b64urlEncode(`${rephoned}:${sig}`))).toBeNull();
  });

  it('requires exactly four colon-separated payload fields', async () => {
    const exp = Date.now() + 60_000;
    expect(await verifyRenterSessionToken(await signRenterToken(`renter:${BOOKING}:${exp}`))).toBeNull();
    expect(
      await verifyRenterSessionToken(await signRenterToken(`renter:${BOOKING}:${PHONE}:x:${exp}`)),
    ).toBeNull();
    expect(await verifyRenterSessionToken(await signRenterToken(`renter:::${exp}`))).toBeNull();
    expect(
      await verifyRenterSessionToken(await signRenterToken(`renter:${BOOKING}:${PHONE}:notanumber`)),
    ).toBeNull();
  });

  it('is not confusable with an admin session token, even on a shared secret', async () => {
    const original = process.env.RENTER_SESSION_SECRET;
    try {
      // With RENTER_SESSION_SECRET unset both modules derive their key from
      // ADMIN_SESSION_SECRET, so only the payload prefix separates them.
      delete process.env.RENTER_SESSION_SECRET;

      const adminToken = await signAdminToken(`admin:${Date.now() + 60_000}`);
      expect(await verifySessionToken(adminToken)).toBe(true);
      expect(await verifyRenterSessionToken(adminToken)).toBeNull();

      const renterToken = await createRenterSessionToken(BOOKING, PHONE);
      expect(await verifyRenterSessionToken(renterToken)).not.toBeNull();
      expect(await verifySessionToken(renterToken)).toBe(false);
    } finally {
      if (original === undefined) delete process.env.RENTER_SESSION_SECRET;
      else process.env.RENTER_SESSION_SECRET = original;
    }
  });

  it('is invalidated by a secret rotation', async () => {
    const original = process.env.RENTER_SESSION_SECRET;
    try {
      const token = await createRenterSessionToken(BOOKING, PHONE);
      process.env.RENTER_SESSION_SECRET = 'rotated-renter-secret';
      expect(await verifyRenterSessionToken(token)).toBeNull();
    } finally {
      if (original === undefined) delete process.env.RENTER_SESSION_SECRET;
      else process.env.RENTER_SESSION_SECRET = original;
    }
  });

  it('never throws on garbage', async () => {
    for (const token of [undefined, null, '', 'not base64 !!', '@@@@', b64urlEncode('nocolon'), 'A'.repeat(5000)]) {
      await expect(verifyRenterSessionToken(token)).resolves.toBeNull();
    }
  });
});

describe('extractBearerToken', () => {
  it('accepts only the `Bearer ` scheme, case-sensitively', () => {
    expect(extractBearerToken('Bearer abc')).toBe('abc');
    expect(extractBearerToken('Bearer   abc   ')).toBe('abc');
    expect(extractBearerToken('bearer abc')).toBeNull();
    expect(extractBearerToken('BEARER abc')).toBeNull();
    expect(extractBearerToken('Basic abc')).toBeNull();
    expect(extractBearerToken('abc')).toBeNull();
  });

  it('returns null for an empty or whitespace-only credential', () => {
    expect(extractBearerToken('Bearer ')).toBeNull();
    expect(extractBearerToken('Bearer    ')).toBeNull();
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken('')).toBeNull();
  });
});
