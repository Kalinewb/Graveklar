// Signed proof that /api/delivery measured a given (address, distance, fee).
//
// The booking endpoint requires this proof so a client can't submit a
// fabricated distance — either to get cheaper/free delivery or to book an
// address outside the insured service radius. Same HMAC shape as the renter
// checklist session; the 6-hour validity comfortably covers a slow checkout.
// Node-only (uses Buffer) — consumed by route handlers, not the proxy.

const MAX_AGE_MS = 6 * 60 * 60 * 1000;

function getSecret(): string {
  return (
    process.env.ADMIN_SESSION_SECRET
    || process.env.ADMIN_PASSWORD
    || 'dev-only-insecure-secret'
  );
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
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Whitespace/case-insensitive so a retyped trailing space doesn't invalidate the quote. */
export function normalizeDeliveryAddress(address: string): string {
  return address.trim().replace(/\s+/g, ' ').toLowerCase();
}

export interface DeliveryQuote {
  address: string;
  distance: number;
  fee: number;
}

export async function signDeliveryQuoteToken(q: DeliveryQuote): Promise<string> {
  const exp = Date.now() + MAX_AGE_MS;
  const addr = Buffer.from(normalizeDeliveryAddress(q.address), 'utf8').toString('base64url');
  const payload = `dq:${addr}:${q.distance}:${q.fee}:${exp}`;
  const sig = await hmacHex(payload, getSecret());
  return Buffer.from(`${payload}:${sig}`, 'utf8').toString('base64url');
}

export async function verifyDeliveryQuoteToken(
  token: string | null | undefined,
  q: DeliveryQuote,
): Promise<boolean> {
  if (!token) return false;
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const parts = decoded.split(':');
    if (parts.length !== 6 || parts[0] !== 'dq') return false;
    const [, addr, distance, fee, expStr, sig] = parts;
    const payload = `dq:${addr}:${distance}:${fee}:${expStr}`;
    const expected = await hmacHex(payload, getSecret());
    if (!constTimeEqual(sig, expected)) return false;
    const exp = Number(expStr);
    if (!exp || Date.now() > exp) return false;
    const address = Buffer.from(addr, 'base64url').toString('utf8');
    if (address !== normalizeDeliveryAddress(q.address)) return false;
    return Number(distance) === q.distance && Number(fee) === q.fee;
  } catch {
    return false;
  }
}
