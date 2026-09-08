import { generateSecret, generateURI, verify } from 'otplib';
import { db } from '@/lib/db';

// Minimal TOTP setup: single shared admin secret. Bitwarden / Aegis /
// Google Authenticator all read the standard otpauth URI.

const ISSUER = 'Graveklar';

export interface TotpEnrollment {
  secret: string;
  otpauthUri: string;
  accountLabel: string;
}

/** Generate a new secret + URI for enrollment. Does NOT persist yet. */
export function startTotpEnrollment(accountLabel = 'admin'): TotpEnrollment {
  const secret = generateSecret();
  const otpauthUri = generateURI({ secret, issuer: ISSUER, label: accountLabel });
  return { secret, otpauthUri, accountLabel };
}

/** Persist the secret after the admin successfully verifies it. */
export async function persistTotpSecret(secret: string): Promise<void> {
  // Single-row table: clear any previous enrollment first.
  await db.adminTotp.deleteMany();
  await db.adminTotp.create({ data: { secret } });
}

/** True if a TOTP secret has been enrolled. */
export async function isTotpEnrolled(): Promise<boolean> {
  const count = await db.adminTotp.count();
  return count > 0;
}

/** Verify a 6-digit TOTP code against a given secret (used at enrollment). */
export async function verifyTotpCodeAgainst(secret: string, code: string): Promise<boolean> {
  if (!code || !/^\d{6}$/.test(code)) return false;
  const result = await verify({ secret, token: code });
  return result.valid === true;
}

// TOTP time-step length in seconds (otplib default).
const STEP_SECONDS = 30;
function currentStep(): number {
  return Math.floor(Date.now() / 1000 / STEP_SECONDS);
}

/** Verify a 6-digit TOTP code against the stored secret. Single-use per
 *  time-step: once a code is accepted, its step is recorded and the same
 *  code can't be replayed within its ~30 s window. */
export async function verifyTotpCode(code: string): Promise<boolean> {
  const row = await db.adminTotp.findFirst();
  if (!row) return false;
  const ok = await verifyTotpCodeAgainst(row.secret, code);
  if (!ok) return false;

  const step = currentStep();
  // Replay guard: reject a code whose step has already been consumed.
  if (row.lastUsedStep != null && row.lastUsedStep === step) {
    return false;
  }
  await db.adminTotp.update({
    where: { id: row.id },
    data: { lastUsedAt: new Date(), lastUsedStep: step },
  });
  return true;
}

/** Pull the TOTP code out of the request headers. */
export function readTotpHeader(request: Request): string | null {
  return request.headers.get('x-admin-totp');
}

/** Convenience: throw-style guard used by sensitive endpoints. */
export async function requireTotp(
  request: Request
): Promise<{ ok: true } | { ok: false; reason: 'not-enrolled' | 'missing' | 'invalid' }> {
  const enrolled = await isTotpEnrolled();
  if (!enrolled) return { ok: false, reason: 'not-enrolled' };
  const code = readTotpHeader(request);
  if (!code) return { ok: false, reason: 'missing' };
  const ok = await verifyTotpCode(code);
  return ok ? { ok: true } : { ok: false, reason: 'invalid' };
}
