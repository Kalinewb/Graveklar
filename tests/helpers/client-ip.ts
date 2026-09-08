/**
 * Rate-limit identities for synthetic requests.
 *
 * Since finding H-5 was fixed, every limited route derives its budget key
 * through `clientIdentity()` (src/lib/client-ip.ts): `CF-Connecting-IP`, else
 * the LAST `X-Forwarded-For` hop, else `'unknown'`. `x-real-ip` is ignored, so
 * a test that wants its own bucket must send a forwarded hop — a header map
 * built here rather than a hand-written `{ 'x-real-ip': … }`.
 *
 * Route rate limiters are module singletons that live for a whole test file,
 * so any test that must not inherit another test's budget asks for a fresh
 * address.
 */

let seq = 0;

/** A fresh forwarded-for value, unique within the process. */
export function freshForwardedIp(): string {
  seq += 1;
  return `198.18.${Math.floor(seq / 250) % 250}.${seq % 250}`;
}

/** Header map giving `call()` its own rate-limit bucket. */
export function ipHeaders(ip = freshForwardedIp()): Record<string, string> {
  return { 'x-forwarded-for': ip };
}

/** The header map for an identity the caller already holds. */
export function forwardedFor(ip: string): Record<string, string> {
  return { 'x-forwarded-for': ip };
}
