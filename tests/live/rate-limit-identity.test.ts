/**
 * L5 — flag F-7 / finding H-5: who gets to say who you are?
 *
 * Every rate-limited route in the app used to derive its budget key the same
 * way:
 *
 *   x-real-ip  ||  x-forwarded-for[0]  ||  'unknown'
 *
 * Both of those are values the client sends. This origin has no reverse proxy
 * in front of Next today (`next start` on :3000 is exposed directly), and the
 * live probes in this file proved empirically that nothing overwrote them: a
 * client varying one header per request never met a single budget in the app,
 * the admin login budget included.
 *
 * The fix (src/lib/client-ip.ts) keys on `CF-Connecting-IP` — set by the edge
 * in the production shape, `server: cloudflare` — and otherwise on the LAST
 * `X-Forwarded-For` hop, which is the element a proxy appends or the socket
 * peer Next fills in when the client sent none. `x-real-ip` is never read.
 *
 * These probes therefore assert two different things:
 *   - a rotating X-Real-IP no longer buys anything, and CF-Connecting-IP is
 *     honoured above everything else, and
 *   - a client rotating its own X-Forwarded-For still gets a fresh bucket,
 *     which is the residual risk by design: on a directly exposed origin no
 *     header a handler can read distinguishes a forged hop from a real one.
 *     The control for that is operational — the origin must accept only
 *     Cloudflare traffic (R-7 in docs/audit/phase1d-auth-config-uploads.md).
 *
 * `/api/quote` is the probe surface: public, cheap, read-only, and limited to
 * 60 requests per minute per key.
 *
 * Skipped unless AUDIT_BASE_URL points at a running instance:
 *   AUDIT_BASE_URL=http://localhost:3001 npx vitest run tests/live
 */
import { describe, expect, it } from 'vitest';

const BASE = process.env.AUDIT_BASE_URL;

const QUOTE_LIMIT = 60;          // createRateLimiter(60, 60_000) in the route
const BURST = QUOTE_LIMIT + 1;

/** Distinct per run, so a re-run inside the same 60 s window starts clean. */
const RUN = Math.floor(Math.random() * 200) + 20;

const QUOTE_BODY = JSON.stringify({
  rentalType: 'day',
  startDate: '2026-12-15',
  selfPickup: true,
});

async function quote(headers: Record<string, string> = {}): Promise<number> {
  const res = await fetch(`${BASE}/api/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: QUOTE_BODY,
  });
  await res.arrayBuffer();
  return res.status;
}

/** Fire `n` requests, returning the status counts. */
async function burst(n: number, headersFor: (i: number) => Record<string, string>) {
  const counts = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const status = await quote(headersFor(i));
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return counts;
}

describe.skipIf(!BASE)('live: rate-limit identity', () => {
  it('enforces the budget when the identity stays put', async () => {
    // Baseline: one fixed forwarded hop, and the limiter behaves exactly as
    // designed — 60 through, the 61st refused.
    const counts = await burst(BURST, () => ({ 'x-forwarded-for': `198.51.100.${RUN}` }));
    expect(counts.get(200)).toBe(QUOTE_LIMIT);
    expect(counts.get(429)).toBe(1);
  }, 180_000);

  // FIXED H-5 (F-7), confirmed over HTTP. Before the fix these 61 requests all
  // returned 200: the client simply varied the header it was never entitled to
  // set. Now `x-real-ip` is not read at all, so every one of them keys on the
  // socket peer Next fills into X-Forwarded-For, and the budget engages.
  it('FIXED H-5: a rotating X-Real-IP does not defeat the quote budget', async () => {
    const counts = await burst(BURST, (i) => ({ 'x-real-ip': `192.0.2.${(RUN + i) % 250}` }));
    expect(counts.get(429) ?? 0).toBeGreaterThan(0);
    // The peer bucket is shared with any other header-less caller, so at most
    // the budget can have got through — often fewer.
    expect(counts.get(200) ?? 0).toBeLessThanOrEqual(QUOTE_LIMIT);
  }, 180_000);

  it('honours CF-Connecting-IP above a rotating X-Forwarded-For', async () => {
    // The production shape: the edge stamps CF-Connecting-IP, and whatever the
    // client writes into the forwarded chain underneath is ignored.
    const cf = `198.51.100.${(RUN + 3) % 250}`;
    const counts = await burst(BURST, (i) => ({
      'cf-connecting-ip': cf,
      'x-forwarded-for': `203.0.113.${(RUN + i) % 250}`,
    }));
    expect(counts.get(200)).toBe(QUOTE_LIMIT);
    expect(counts.get(429)).toBe(1);
  }, 180_000);

  it('records that a rotating X-Forwarded-For still bypasses a directly exposed origin', async () => {
    // By design, and the reason R-7 is an ops requirement rather than a code
    // change: Next passes a client-supplied X-Forwarded-For through untouched,
    // so its last hop is whatever the client chose. Behind Cloudflare the same
    // requests would carry a CF-Connecting-IP the client cannot write, and the
    // probe above shows that identity holding.
    const counts = await burst(BURST, (i) => ({ 'x-forwarded-for': `203.0.113.${(RUN + i) % 250}` }));
    expect([...counts.keys()]).toEqual([200]);
  }, 180_000);

  it('shows Next supplying the peer address when the client sends nothing', async () => {
    // A header-less client gets a stable identity — Next fills x-forwarded-for
    // with the socket peer — so the budget engages…
    const counts = await burst(BURST, () => ({}));
    expect(counts.get(429) ?? 0).toBeGreaterThan(0);

    // …and that identity is `127.0.0.1` for a loopback client. A claimed
    // x-forwarded-for of the same value lands in the same exhausted bucket,
    // and so does a claimed x-real-ip — because x-real-ip is not read, leaving
    // the request header-less and back on the peer address.
    expect(await quote({ 'x-forwarded-for': '127.0.0.1' })).toBe(429);
    expect(await quote({ 'x-real-ip': '127.0.0.1' })).toBe(429);

    // Any other claimed forwarded value is still a fresh bucket (see above).
    expect(await quote({ 'x-forwarded-for': `::ffff:127.0.0.${RUN % 250}` })).toBe(200);
  }, 180_000);

  it('keys on the LAST X-Forwarded-For hop, so rewriting the head changes nothing', async () => {
    const appended = `10.0.${(RUN + 5) % 250}.9`;
    await burst(BURST, (i) => ({ 'x-forwarded-for': `198.51.100.${(RUN + i) % 250}, ${appended}` }));
    // Same last hop, a different claimed head → the same exhausted bucket.
    expect(await quote({ 'x-forwarded-for': `172.16.0.9, 10.1.1.1, ${appended}` })).toBe(429);
    // A different last hop is a different client.
    expect(await quote({ 'x-forwarded-for': `${appended}, 10.0.${(RUN + 6) % 250}.9` })).toBe(200);
  }, 180_000);
});
