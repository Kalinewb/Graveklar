/**
 * Length-checked constant-time string comparison.
 *
 * The length check can leak the comparand's length but never its contents, so
 * this is appropriate for comparing fixed secrets (cron bearer tokens, HMAC
 * digests) where the concern is a per-byte early-return revealing how many
 * leading characters matched. Matches the comparison used in admin-auth.
 */
export function constTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
