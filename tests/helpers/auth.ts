/**
 * Auth-audit helpers (phase 1d).
 *
 * Everything here is a *forger's* toolkit: it reproduces the token formats
 * `src/lib/admin-auth.ts` and `src/lib/renter-checklist-session.ts` produce so
 * a test can hand-craft payloads the product's own factories cannot make —
 * an expired token, a payload with extra colons, a token signed with a rotated
 * secret, a tampered signature.
 *
 * The TOTP side never *enrols* anything through the product's enrollment
 * endpoints. `seedTotpSecret()` writes an `AdminTotp` row straight into the
 * per-worker scratch database (tests/setup.ts guarantees the connection can
 * only point there) and `totpCodeFor()` derives codes with otplib in
 * isolation, so no test ever depends on a real authenticator.
 */
import { generate } from 'otplib';

import { db } from '@/lib/db';

// ── Primitives (mirrors of the product's private helpers) ────────────────────

export async function hmacHex(payload: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function b64urlEncode(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function b64urlDecode(str: string): string {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  return atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '='));
}

// ── Admin session tokens ─────────────────────────────────────────────────────

/** The key `admin-auth.getSecret()` resolves to under tests/setup.ts. */
export function adminSecret(): string {
  return process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || 'dev-only-insecure-secret';
}

/** Sign an arbitrary session payload — the shape verifySessionToken parses. */
export async function signAdminToken(payload: string, secret = adminSecret()): Promise<string> {
  return b64urlEncode(`${payload}:${await hmacHex(payload, secret)}`);
}

/** An admin token that expires at exactly `expMs` (epoch milliseconds). */
export async function adminTokenExpiringAt(expMs: number, secret = adminSecret()): Promise<string> {
  return signAdminToken(`admin:${expMs}`, secret);
}

/** Flip one character of a token's signature without changing its length. */
export async function tamperAdminSignature(token: string): Promise<string> {
  const decoded = b64urlDecode(token);
  const cut = decoded.lastIndexOf(':');
  const payload = decoded.slice(0, cut);
  const sig = decoded.slice(cut + 1);
  const flipped = (sig[0] === '0' ? '1' : '0') + sig.slice(1);
  return b64urlEncode(`${payload}:${flipped}`);
}

// ── Renter kiosk session tokens ──────────────────────────────────────────────

export function renterSecret(): string {
  return (
    process.env.RENTER_SESSION_SECRET
    || process.env.ADMIN_SESSION_SECRET
    || process.env.ADMIN_PASSWORD
    || 'dev-only-insecure-secret'
  );
}

export async function signRenterToken(payload: string, secret = renterSecret()): Promise<string> {
  return b64urlEncode(`${payload}:${await hmacHex(payload, secret)}`);
}

export async function renterTokenExpiringAt(
  bookingId: string,
  phone: string,
  expMs: number,
  secret = renterSecret(),
): Promise<string> {
  return signRenterToken(`renter:${bookingId}:${phone}:${expMs}`, secret);
}

// ── TOTP ─────────────────────────────────────────────────────────────────────

/** A fixed Base32 secret — deterministic, never a real enrollment. */
export const TEST_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

/**
 * Put an `AdminTotp` row into the scratch database so `isTotpEnrolled()` and
 * `requireTotp()` take their enrolled branch. NOT enrollment: no product
 * enrollment endpoint is called and nothing outside the scratch file is
 * touched. Refuses to run outside the test harness.
 */
export async function seedTotpSecret(secret = TEST_TOTP_SECRET): Promise<void> {
  if (process.env.GRAVEKLAR_TEST_DB !== '1') {
    throw new Error('[auth-helper] seedTotpSecret is only valid against the scratch database');
  }
  await db.adminTotp.deleteMany();
  await db.adminTotp.create({ data: { secret } });
}

/** Remove any seeded enrollment. */
export async function clearTotpSecret(): Promise<void> {
  await db.adminTotp.deleteMany();
}

/** The 6-digit code for `secret` at `epochMs` (defaults to the current clock). */
export async function totpCodeFor(
  secret = TEST_TOTP_SECRET,
  epochMs: number = Date.now(),
): Promise<string> {
  return generate({ secret, epoch: Math.floor(epochMs / 1000) });
}

/** The 30-second time step `src/lib/totp.ts` records as `lastUsedStep`. */
export function totpStep(epochMs: number = Date.now()): number {
  return Math.floor(epochMs / 1000 / 30);
}
