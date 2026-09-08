import { cookies } from 'next/headers';

const COOKIE_NAME = 'graveklar_admin_session';
const MAX_AGE_SEC = 60 * 60 * 24 * 7;

// The request proxy (src/proxy.ts) imports this file; that constrains us to env-only
// secrets (no DB reads). The strict-production behaviour is therefore:
//   - ADMIN_SESSION_SECRET set:                 use it (recommended).
//   - ADMIN_SESSION_SECRET unset, ADMIN_PASSWORD set:
//       use ADMIN_PASSWORD as a fallback BUT warn at startup. The HMAC key
//       then never rotates even if the admin changes the password via the
//       UI — that's an accepted limitation, mitigated by SameSite=lax and
//       the 7-day cookie TTL.
//   - Both unset in production:                 throw (refuse to issue or
//                                               verify sessions).
//   - Dev fallback:                             a fixed insecure string so
//                                               `next dev` works without
//                                               configuration.
let warnedAboutFallback = false;
function getSecret(): string {
  const explicit = process.env.ADMIN_SESSION_SECRET;
  if (explicit) return explicit;
  const password = process.env.ADMIN_PASSWORD;
  if (password) {
    if (!warnedAboutFallback && process.env.NODE_ENV === 'production') {
      console.warn(
        '[admin-auth] ADMIN_SESSION_SECRET is not set; falling back to ' +
        'ADMIN_PASSWORD as the HMAC key. Set ADMIN_SESSION_SECRET to a ' +
        'strong random value (`openssl rand -hex 32`) so the session key ' +
        'is independent of the password.'
      );
      warnedAboutFallback = true;
    }
    return password;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ADMIN_SESSION_SECRET must be set in production');
  }
  return 'dev-only-insecure-secret';
}

function constTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Stored format: `pbkdf2$<iterations>$<saltHex>$<hashHex>` — PBKDF2-SHA-256
// via WebCrypto (no native dependency; works wherever admin-auth is imported).
// 600k iterations is the OWASP floor for SHA-256: a few hundred ms per
// verify, nothing for a single rate-limited admin login, but it turns an
// exfiltrated SQLite file into an expensive offline target. Legacy
// `<saltHex>:<hmacHex>` hashes (salted HMAC-SHA-256 — fast to brute-force)
// still verify, and the login route upgrades them on the next successful
// login via needsRehash().
const PBKDF2_ITERATIONS = 600_000;

async function pbkdf2Hex(password: string, saltHex: string, iterations: number): Promise<string> {
  const enc = new TextEncoder();
  const salt = new Uint8Array((saltHex.match(/.{2}/g) ?? []).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
  const hash = await pbkdf2Hex(password, saltHex, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${saltHex}$${hash}`;
}

/** True when `stored` is a legacy fast hash (or a PBKDF2 hash with fewer
 *  iterations than we now use) and should be re-hashed after a successful verify. */
export function needsRehash(stored: string): boolean {
  if (!stored.startsWith('pbkdf2$')) return true;
  const iterations = Number(stored.split('$')[1]);
  return !Number.isFinite(iterations) || iterations < PBKDF2_ITERATIONS;
}

export async function verifyHashedPassword(password: string, stored: string): Promise<boolean> {
  if (stored.startsWith('pbkdf2$')) {
    const [, iterStr, salt, hash] = stored.split('$');
    const iterations = Number(iterStr);
    if (!salt || !hash || !Number.isInteger(iterations) || iterations < 1) return false;
    const computed = await pbkdf2Hex(password, salt, iterations);
    return constTimeEqual(computed, hash);
  }
  // Legacy salted-HMAC format.
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const computed = await hmacHex(password, salt);
  return constTimeEqual(computed, hash);
}

export async function verifyAdminPassword(password: string): Promise<boolean> {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    return process.env.NODE_ENV !== 'production' && password === 'admin';
  }
  // Compare HMAC digests rather than the raw strings. Hashing both sides to a
  // fixed-length hex digest means neither the comparison length nor the loop
  // timing reveals the configured password's length to an attacker who can
  // vary their own input length and measure response time.
  const [got, want] = await Promise.all([
    hmacHex(password, 'admin-password-compare'),
    hmacHex(expected, 'admin-password-compare'),
  ]);
  return constTimeEqual(got, want);
}

export function isDefaultPassword(): boolean {
  return (process.env.ADMIN_PASSWORD || 'admin') === 'admin';
}

async function hmacHex(payload: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function b64urlEncode(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64urlDecode(str: string): string {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=');
  return atob(padded);
}

export async function createSessionToken(): Promise<string> {
  const exp = Date.now() + MAX_AGE_SEC * 1000;
  const payload = `admin:${exp}`;
  const signature = await hmacHex(payload, getSecret());
  return b64urlEncode(`${payload}:${signature}`);
}

export async function verifySessionToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  try {
    const decoded = b64urlDecode(token);
    const lastColon = decoded.lastIndexOf(':');
    if (lastColon === -1) return false;
    const payload = decoded.slice(0, lastColon);
    const signature = decoded.slice(lastColon + 1);
    const expected = await hmacHex(payload, getSecret());
    if (!constTimeEqual(signature, expected)) return false;
    const [, expStr] = payload.split(':');
    const exp = Number(expStr);
    if (!exp || Date.now() > exp) return false;
    return payload.startsWith('admin:');
  } catch {
    return false;
  }
}

export async function isAdminAuthenticated(): Promise<boolean> {
  const jar = await cookies();
  return verifySessionToken(jar.get(COOKIE_NAME)?.value);
}

/**
 * Is this request effectively HTTPS?
 *
 * `x-forwarded-proto` is the reliable signal — but only when the terminating
 * proxy actually sets it. A tunnel or load balancer that terminates TLS and
 * forwards plain HTTP without the header would have the admin session cookie
 * issued without `Secure` on a real HTTPS site, which is exactly the class of
 * "the domain is set up wrong" mistake that is invisible until it isn't.
 *
 * So: trust the header when it's there, and otherwise infer from the Host.
 * A registrable public domain (graveklar.no) is HTTPS in practice; bare IPs,
 * `localhost` and `.local` names are the LAN/dev cases where forcing `Secure`
 * makes the browser drop the cookie and login silently fails to stick.
 */
export function isSecureRequest(req: {
  headers: { get(name: string): string | null };
  nextUrl?: { protocol: string };
}): boolean {
  // Compared case-insensitively: the value is an opaque token and appliances
  // do emit `HTTPS`. A case-sensitive match returned false there, and the
  // session cookie was issued without `Secure` on a genuinely HTTPS-terminated
  // site — the exact failure this function exists to prevent (H-1).
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0].trim().toLowerCase();
  if (proto) return proto === 'https';
  if (req.nextUrl?.protocol === 'https:') return true;

  const host = (req.headers.get('x-forwarded-host') || req.headers.get('host') || '')
    .split(',')[0].trim().split(':')[0].toLowerCase();
  if (!host || !host.includes('.')) return false;            // localhost, bare hostnames
  if (host.endsWith('.local') || host.endsWith('.localhost')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;     // raw IPv4
  return true;
}

// Cookie security: only set `secure: true` when the request is actually
// HTTPS-terminated (see isSecureRequest). Setting secure based on
// NODE_ENV alone breaks LAN/HTTP access — the browser drops the cookie
// silently and login appears to succeed but the session never sticks.
export function sessionCookieOptions(token: string, isSecure?: boolean) {
  return {
    name: COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure: isSecure ?? false,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: MAX_AGE_SEC,
  };
}

export function clearSessionCookieOptions(isSecure?: boolean) {
  return {
    name: COOKIE_NAME,
    value: '',
    httpOnly: true,
    secure: isSecure ?? false,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 0,
  };
}

export { COOKIE_NAME };
