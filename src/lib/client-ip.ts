/**
 * The one place that answers "who is this request, for rate-limiting purposes?"
 *
 * Every limited route used to copy the same six lines:
 *
 *     x-real-ip || x-forwarded-for[0] || 'unknown'
 *
 * Both halves of that are wrong. `x-real-ip` is never set by Next and never
 * corrected by anything in front of it, so a client that sends one simply
 * picks its own bucket. The *first* `x-forwarded-for` hop is the same story:
 * a forwarding chain grows left-to-right, so hop 0 is whatever the original
 * client claimed. Rotating either header defeated every per-IP budget in the
 * app — including the 10-attempts-per-15-minutes admin login budget.
 *
 * What is trustworthy depends on what sits in front of the origin:
 *
 *   - Behind Cloudflare (the production shape: `server: cloudflare`),
 *     `CF-Connecting-IP` is set by the edge and replaces anything the client
 *     sent. It is the identity. `X-Real-IP` is passed through from the client
 *     untouched, which is exactly why it is never consulted here.
 *   - Behind any ordinary reverse proxy, the proxy *appends* the peer it saw
 *     to `X-Forwarded-For`, so the LAST hop is the one written by
 *     infrastructure rather than claimed by the client.
 *   - With nothing in front, Next fills `X-Forwarded-For` with the socket peer
 *     — but only when the client sent no such header. That fill is also the
 *     last (and only) hop, so the same rule covers it.
 *
 * Residual risk, by design: on a DIRECTLY exposed origin a client can still
 * send its own `X-Forwarded-For` (or `CF-Connecting-IP`) and rotate it, because
 * Next passes a client-supplied value through untouched. Nothing readable from
 * inside a handler can tell that apart from a real proxy hop. The deployment
 * requirement that closes it is an ops one, not a code one: **the origin must
 * accept traffic only from Cloudflare** (see R-7 in
 * docs/audit/phase1d-auth-config-uploads.md) — firewall the origin to
 * Cloudflare's IP ranges, or front it with `cloudflared`. Once that holds, the
 * only way to reach this code is through the edge, and `CF-Connecting-IP` is
 * authoritative.
 */

/** Anything with request headers — NextRequest, Request, or a test double. */
export interface HeaderSource {
  headers: { get(name: string): string | null };
}

/** Last comma-separated element of a header value, trimmed. */
function lastHop(value: string | null): string | null {
  if (!value) return null;
  const hops = value.split(',');
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i].trim();
    if (hop) return hop;
  }
  return null;
}

/**
 * The rate-limit identity for a request: `CF-Connecting-IP` when the edge set
 * one, else the last `X-Forwarded-For` hop (the one a proxy appended, or the
 * socket peer Next filled in), else `'unknown'`.
 *
 * Never `x-real-ip`, never the first forwarded hop — both are values the
 * client chooses.
 */
export function clientIdentity(request: HeaderSource): string {
  return (
    lastHop(request.headers.get('cf-connecting-ip'))
    ?? lastHop(request.headers.get('x-forwarded-for'))
    ?? 'unknown'
  );
}

/**
 * Same derivation for records that store the address (a frozen contract's
 * acceptedFromIp): null rather than 'unknown' when nothing trustworthy was
 * presented, so the column keeps its existing meaning.
 */
export function nullableClientIdentity(request: HeaderSource): string | null {
  const id = clientIdentity(request);
  return id === 'unknown' ? null : id;
}
