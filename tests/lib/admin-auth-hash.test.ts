import { describe, it, expect } from 'vitest';
import { hashPassword, verifyHashedPassword, needsRehash } from '@/lib/admin-auth';

describe('admin password hashing', () => {
  it('round-trips with PBKDF2 and rejects a wrong password', async () => {
    const stored = await hashPassword('Korrekt-passord-42');
    expect(stored.startsWith('pbkdf2$600000$')).toBe(true);
    expect(await verifyHashedPassword('Korrekt-passord-42', stored)).toBe(true);
    expect(await verifyHashedPassword('feil-passord', stored)).toBe(false);
    expect(needsRehash(stored)).toBe(false);
  }, 20_000);

  it('still verifies a legacy salted-HMAC hash and flags it for upgrade', async () => {
    // Legacy format: `<saltHex>:<hmacSha256Hex(password, key=saltHex)>`.
    const saltHex = '00112233445566778899aabbccddeeff';
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(saltHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode('gammelt-passord'));
    const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
    const legacy = `${saltHex}:${hex}`;
    expect(await verifyHashedPassword('gammelt-passord', legacy)).toBe(true);
    expect(await verifyHashedPassword('annet', legacy)).toBe(false);
    expect(needsRehash(legacy)).toBe(true);
  });

  it('rejects malformed stored values', async () => {
    expect(await verifyHashedPassword('x', 'pbkdf2$notanumber$abcd$ef')).toBe(false);
    expect(await verifyHashedPassword('x', 'garbage')).toBe(false);
  });
});
