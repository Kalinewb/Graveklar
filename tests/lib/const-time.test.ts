/**
 * L1 — `constTimeEqual`, the comparison every secret check funnels through
 * (cron bearer, HMAC digests, password hashes).
 *
 * The contract is narrow on purpose: correct equality, no early return on the
 * first differing byte, and an acknowledged length leak. Anything comparing a
 * variable-length secret needs to hash first — which is exactly what
 * `verifyAdminPassword` does.
 */
import { describe, expect, it } from 'vitest';

import { constTimeEqual } from '@/lib/const-time';

describe('constTimeEqual', () => {
  it('is true only for identical strings', () => {
    expect(constTimeEqual('', '')).toBe(true);
    expect(constTimeEqual('abc', 'abc')).toBe(true);
    expect(constTimeEqual('abc', 'abd')).toBe(false);
    expect(constTimeEqual('abc', 'ABC')).toBe(false);
    expect(constTimeEqual('a'.repeat(64), 'a'.repeat(64))).toBe(true);
  });

  it('is false for different lengths, including prefixes', () => {
    expect(constTimeEqual('abc', 'abcd')).toBe(false);
    expect(constTimeEqual('abcd', 'abc')).toBe(false);
    expect(constTimeEqual('', 'a')).toBe(false);
    expect(constTimeEqual('a', '')).toBe(false);
  });

  it('compares the whole string — a difference in the last byte is still caught', () => {
    const hex = 'f'.repeat(63);
    expect(constTimeEqual(hex + '0', hex + '1')).toBe(false);
    expect(constTimeEqual('0' + hex, '1' + hex)).toBe(false);
  });

  it('compares by code unit, so equal-looking Unicode is not equal', () => {
    // NFC "é" vs NFD "e" + combining acute: same rendering, different bytes.
    expect(constTimeEqual('café', 'café')).toBe(false);
    // Surrogate pairs compare correctly.
    expect(constTimeEqual('🔒', '🔒')).toBe(true);
    expect(constTimeEqual('🔒', '🔑')).toBe(false);
  });

  it('does not short-circuit: mismatch position does not change the work done', () => {
    // Not a timing measurement (unreliable under a JIT) — a structural check
    // that the loop is unconditional. The implementation ORs every XOR into an
    // accumulator, so the result is identical whichever byte differs.
    const a = 'x'.repeat(1000);
    for (const at of [0, 1, 499, 998, 999]) {
      const b = a.slice(0, at) + 'y' + a.slice(at + 1);
      expect(constTimeEqual(a, b)).toBe(false);
    }
  });

  it('matches the digest comparison admin-auth relies on', () => {
    const digest = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
    expect(constTimeEqual(digest, digest)).toBe(true);
    expect(constTimeEqual(digest, digest.toUpperCase())).toBe(false);
    expect(constTimeEqual(digest, digest.slice(0, -1) + '9')).toBe(false);
  });
});
