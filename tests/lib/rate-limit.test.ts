/**
 * L1 — the two in-process rate limiters.
 *
 * `createRateLimiter` charges every call, so a caller is billed for rejected
 * attempts too (that is the point for login: failures are the thing being
 * budgeted). `createConsumableRateLimiter` splits reading from charging, so a
 * route can budget work that actually succeeded.
 *
 * Both hold a plain Map in the Node process. That has two consequences worth
 * pinning: state is per-process (a restart clears every budget, and two
 * processes never share one), and the key is whatever the caller passes —
 * which is where F-7 lives, see tests/api/admin-auth-routes.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { createConsumableRateLimiter, createRateLimiter } from '@/lib/rate-limit';

import { mockClock } from '../helpers/mocks';

describe('createRateLimiter', () => {
  it('allows exactly `max` calls, then blocks', () => {
    const limited = createRateLimiter(3, 60_000);
    expect(limited('a')).toBe(false); // 1
    expect(limited('a')).toBe(false); // 2
    expect(limited('a')).toBe(false); // 3
    expect(limited('a')).toBe(true);  // 4 — over budget
    expect(limited('a')).toBe(true);
  });

  it('charges rejected attempts too — a blocked caller cannot spin the counter down', () => {
    const limited = createRateLimiter(2, 60_000);
    limited('a');
    limited('a');
    expect(limited('a')).toBe(true);
    // Blocked calls do NOT increment (the counter is already at max), but they
    // also never decay: the key stays blocked for the rest of the window.
    for (let i = 0; i < 50; i++) expect(limited('a')).toBe(true);
  });

  it('keeps keys independent', () => {
    const limited = createRateLimiter(1, 60_000);
    expect(limited('a')).toBe(false);
    expect(limited('a')).toBe(true);
    expect(limited('b')).toBe(false);
    expect(limited('c')).toBe(false);
    expect(limited('a')).toBe(true);
  });

  it('rolls the window over strictly after resetAt, not at it', () => {
    const clock = mockClock('2026-09-06T12:00:00.000Z');
    try {
      const limited = createRateLimiter(2, 60_000);
      limited('a'); // resetAt = T + 60_000
      limited('a');
      expect(limited('a')).toBe(true);

      // At exactly resetAt the record is still live (`now > record.resetAt`).
      clock.advance(60_000);
      expect(limited('a')).toBe(true);

      // One millisecond past it, the budget is fresh.
      clock.advance(1);
      expect(limited('a')).toBe(false);
      expect(limited('a')).toBe(false);
      expect(limited('a')).toBe(true);
    } finally {
      clock.restore();
    }
  });

  it('anchors the window on the first call, not the last (no sliding extension)', () => {
    const clock = mockClock('2026-09-06T12:00:00.000Z');
    try {
      const limited = createRateLimiter(5, 60_000);
      limited('a');
      clock.advance(59_000);
      limited('a');
      limited('a');
      // The extra calls did not push resetAt out.
      clock.advance(1_001);
      expect(limited('a')).toBe(false);
    } finally {
      clock.restore();
    }
  });

  it('treats the empty string and `unknown` as ordinary keys', () => {
    const limited = createRateLimiter(1, 60_000);
    expect(limited('')).toBe(false);
    expect(limited('')).toBe(true);
    expect(limited('unknown')).toBe(false);
    expect(limited('unknown')).toBe(true);
  });
});

describe('createConsumableRateLimiter', () => {
  it('never trips on reads alone — only consume() charges', () => {
    const limiter = createConsumableRateLimiter(2, 60_000);
    for (let i = 0; i < 100; i++) expect(limiter.isLimited('a')).toBe(false);
    limiter.consume('a');
    limiter.consume('a');
    expect(limiter.isLimited('a')).toBe(true);
  });

  it('allows exactly `max` consumes per window', () => {
    const clock = mockClock('2026-09-06T12:00:00.000Z');
    try {
      const limiter = createConsumableRateLimiter(3, 60_000);
      for (let i = 0; i < 3; i++) {
        expect(limiter.isLimited('a')).toBe(false);
        limiter.consume('a');
      }
      expect(limiter.isLimited('a')).toBe(true);

      clock.advance(60_001);
      expect(limiter.isLimited('a')).toBe(false);
      limiter.consume('a');
      expect(limiter.isLimited('a')).toBe(false);
    } finally {
      clock.restore();
    }
  });

  it('keeps keys independent', () => {
    const limiter = createConsumableRateLimiter(1, 60_000);
    limiter.consume('a');
    expect(limiter.isLimited('a')).toBe(true);
    expect(limiter.isLimited('b')).toBe(false);
  });

  it('starts a fresh window when consume() lands after the previous one expired', () => {
    const clock = mockClock('2026-09-06T12:00:00.000Z');
    try {
      const limiter = createConsumableRateLimiter(1, 60_000);
      limiter.consume('a');
      expect(limiter.isLimited('a')).toBe(true);
      clock.advance(60_001);
      limiter.consume('a'); // resets to count 1 rather than incrementing to 2
      expect(limiter.isLimited('a')).toBe(true);
      clock.advance(60_001);
      expect(limiter.isLimited('a')).toBe(false);
    } finally {
      clock.restore();
    }
  });
});

describe('limiter state is per-instance and per-process', () => {
  it('two limiters built from the same arguments share nothing', () => {
    const a = createRateLimiter(1, 60_000);
    const b = createRateLimiter(1, 60_000);
    expect(a('ip')).toBe(false);
    expect(a('ip')).toBe(true);
    expect(b('ip')).toBe(false);
  });

  it('sweeps expired keys as the map is used, without changing decisions', () => {
    const clock = mockClock('2026-09-06T12:00:00.000Z');
    try {
      const limited = createRateLimiter(1, 1_000);
      // 150 distinct keys drives the every-100th-call sweep at least once.
      for (let i = 0; i < 150; i++) expect(limited(`ip-${i}`)).toBe(false);
      clock.advance(2_000);
      for (let i = 0; i < 150; i++) expect(limited(`ip-${i}`)).toBe(false);
    } finally {
      clock.restore();
    }
  });
});
