// Short-lived HMAC session for the renter QR kiosk. Binds a normalized
// phone number to a specific booking so subsequent checklist API calls
// don't need to re-verify ownership on every keystroke.

const MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours

function getSecret(): string {
  return (
    process.env.RENTER_SESSION_SECRET
    || process.env.ADMIN_SESSION_SECRET
    || process.env.ADMIN_PASSWORD
    || 'dev-only-insecure-secret'
  );
}

function b64urlEncode(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64urlDecode(str: string): string {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=');
  return atob(padded);
}

function constTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(payload: string, secret: string): Promise<string> {
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

export interface RenterSessionPayload {
  bookingId: string;
  phone: string;
  exp: number;
}

export async function createRenterSessionToken(
  bookingId: string,
  phone: string,
): Promise<string> {
  const exp = Date.now() + MAX_AGE_MS;
  const payload = `renter:${bookingId}:${phone}:${exp}`;
  const signature = await hmacHex(payload, getSecret());
  return b64urlEncode(`${payload}:${signature}`);
}

export async function verifyRenterSessionToken(
  token: string | undefined | null,
): Promise<RenterSessionPayload | null> {
  if (!token) return null;
  try {
    const decoded = b64urlDecode(token);
    const lastColon = decoded.lastIndexOf(':');
    if (lastColon === -1) return null;
    const payload = decoded.slice(0, lastColon);
    const signature = decoded.slice(lastColon + 1);
    const expected = await hmacHex(payload, getSecret());
    if (!constTimeEqual(signature, expected)) return null;
    if (!payload.startsWith('renter:')) return null;
    const parts = payload.split(':');
    if (parts.length !== 4) return null;
    const [, bookingId, phone, expStr] = parts;
    const exp = Number(expStr);
    if (!bookingId || !phone || !exp || Date.now() > exp) return null;
    return { bookingId, phone, exp };
  } catch {
    return null;
  }
}

export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  return authHeader.slice(7).trim() || null;
}
