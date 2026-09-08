/**
 * L1 — `clientIdentity()`, the single derivation of a rate-limit bucket key.
 *
 * The rule under test (finding H-5 / flag F-7): the identity is
 * `CF-Connecting-IP` when the edge set one, else the LAST `X-Forwarded-For`
 * hop — the element a proxy appended, or the socket peer Next filled in when
 * the client sent no header at all — else `'unknown'`.
 *
 * `x-real-ip` is never consulted: Next never sets it, nothing in front of the
 * origin overwrites it, so it is a value the caller picks for itself.
 *
 * Requests are built through `Headers` rather than a hand-rolled map so the
 * repeated-header case goes through the same joining the runtime does.
 */
import { describe, expect, it } from 'vitest';

import { clientIdentity } from '@/lib/client-ip';

/** A request-shaped object with exactly the header access the helper uses. */
function req(headers: Record<string, string | string[]> = {}) {
  const h = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    for (const v of Array.isArray(value) ? value : [value]) h.append(name, v);
  }
  return { headers: h };
}

describe('clientIdentity — CF-Connecting-IP', () => {
  it('wins outright when the edge set it', () => {
    expect(clientIdentity(req({ 'cf-connecting-ip': '198.51.100.7' }))).toBe('198.51.100.7');
  });

  it('wins over both forwarding headers, whatever they claim', () => {
    const identity = clientIdentity(req({
      'cf-connecting-ip': '198.51.100.7',
      'x-forwarded-for': '203.0.113.9, 10.0.0.1',
      'x-real-ip': '192.0.2.55',
    }));
    expect(identity).toBe('198.51.100.7');
  });

  it('is matched case-insensitively, as HTTP header names are', () => {
    expect(clientIdentity(req({ 'CF-Connecting-IP': '198.51.100.8' }))).toBe('198.51.100.8');
  });

  it('is ignored when blank, falling through to the forwarded chain', () => {
    expect(clientIdentity(req({ 'cf-connecting-ip': '   ', 'x-forwarded-for': '203.0.113.9' })))
      .toBe('203.0.113.9');
    expect(clientIdentity(req({ 'cf-connecting-ip': '' }))).toBe('unknown');
  });
});

describe('clientIdentity — X-Forwarded-For', () => {
  it('uses the only hop when there is one', () => {
    expect(clientIdentity(req({ 'x-forwarded-for': '203.0.113.9' }))).toBe('203.0.113.9');
  });

  it('uses the LAST hop, not the first — the first is client-supplied', () => {
    expect(clientIdentity(req({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }))).toBe('10.0.0.1');
    expect(clientIdentity(req({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' }))).toBe('3.3.3.3');
  });

  it('a client cannot pin the identity by appending hops of its own choosing', () => {
    // It CAN (see the module comment: that is the residual risk on a directly
    // exposed origin) — what it cannot do is keep the same bucket while
    // varying the head of the list, which is what the old first-hop rule let
    // an attacker exploit in reverse.
    const a = clientIdentity(req({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }));
    const b = clientIdentity(req({ 'x-forwarded-for': '198.51.100.1, 10.0.0.1' }));
    expect(a).toBe(b);
  });

  it('trims surrounding whitespace and tabs around the hop', () => {
    expect(clientIdentity(req({ 'x-forwarded-for': '  203.0.113.9  ' }))).toBe('203.0.113.9');
    expect(clientIdentity(req({ 'x-forwarded-for': '203.0.113.9 ,\t 10.0.0.1 ' }))).toBe('10.0.0.1');
  });

  it('skips empty trailing elements rather than keying on an empty string', () => {
    expect(clientIdentity(req({ 'x-forwarded-for': '203.0.113.9,' }))).toBe('203.0.113.9');
    expect(clientIdentity(req({ 'x-forwarded-for': '203.0.113.9, ,  ' }))).toBe('203.0.113.9');
    expect(clientIdentity(req({ 'x-forwarded-for': ',' }))).toBe('unknown');
    expect(clientIdentity(req({ 'x-forwarded-for': '   ' }))).toBe('unknown');
  });

  it('keeps a malformed hop verbatim — a bucket key, not an address', () => {
    // The value is only ever a map key. Refusing to parse it means a garbage
    // value gets its own bucket instead of sharing `unknown` with everyone.
    expect(clientIdentity(req({ 'x-forwarded-for': 'not-an-ip' }))).toBe('not-an-ip');
    expect(clientIdentity(req({ 'x-forwarded-for': '999.999.999.999' }))).toBe('999.999.999.999');
    expect(clientIdentity(req({ 'x-forwarded-for': '<script>' }))).toBe('<script>');
  });

  it('handles repeated headers, which the runtime joins with a comma', () => {
    const identity = clientIdentity(req({ 'x-forwarded-for': ['203.0.113.9', '10.0.0.1'] }));
    expect(identity).toBe('10.0.0.1');
  });

  it('handles IPv6, plain and IPv4-mapped', () => {
    expect(clientIdentity(req({ 'x-forwarded-for': '2001:db8::1' }))).toBe('2001:db8::1');
    expect(clientIdentity(req({ 'x-forwarded-for': '203.0.113.9, 2001:db8::1' }))).toBe('2001:db8::1');
    expect(clientIdentity(req({ 'x-forwarded-for': '::ffff:127.0.0.1' }))).toBe('::ffff:127.0.0.1');
    // A bracketed, ported form is kept whole — splitting on ':' would key on
    // the port, merging every client behind the same proxy into one bucket.
    expect(clientIdentity(req({ 'x-forwarded-for': '[2001:db8::1]:41234' }))).toBe('[2001:db8::1]:41234');
  });
});

describe('clientIdentity — what it refuses to trust', () => {
  it('ignores x-real-ip entirely', () => {
    expect(clientIdentity(req({ 'x-real-ip': '192.0.2.55' }))).toBe('unknown');
  });

  it('ignores x-real-ip even when it is the only plausible-looking value', () => {
    expect(clientIdentity(req({ 'x-real-ip': '192.0.2.55', 'x-forwarded-for': '   ' }))).toBe('unknown');
  });

  it('does not let a rotating x-real-ip produce a rotating identity', () => {
    const identities = new Set(
      Array.from({ length: 20 }, (_, i) => clientIdentity(req({ 'x-real-ip': `192.0.2.${i}` }))),
    );
    expect([...identities]).toEqual(['unknown']);
  });

  it('ignores forwarded, x-client-ip and true-client-ip too', () => {
    // Only the two headers the deployment can actually vouch for are read.
    const identity = clientIdentity(req({
      forwarded: 'for=192.0.2.60',
      'x-client-ip': '192.0.2.61',
      'true-client-ip': '192.0.2.62',
    }));
    expect(identity).toBe('unknown');
  });

  it('falls back to `unknown` when the request carries no headers at all', () => {
    expect(clientIdentity(req())).toBe('unknown');
  });
});
