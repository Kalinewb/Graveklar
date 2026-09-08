// Normalize a Norwegian phone number for identity matching.
//
//   "+47 990 11 223" → "99011223"
//   "(0047) 99011223" → "99011223"
//   "47 99011223"     → "99011223"
//   "99011223"        → "99011223"
//   "001-555-1212"    → "0015551212"   // non-NO numbers kept as digits
//
// Used to detect repeat customers so cosmetic differences (spaces, prefixes)
// don't bypass the first-time-discount check.

export function normalizePhone(input: string | null | undefined): string {
  if (!input) return '';
  let digits = input.replace(/\D+/g, '');
  // Strip a leading 47 country code if the remaining number then looks like
  // a Norwegian mobile/landline (8 digits, the canonical NO format).
  if (digits.startsWith('47') && digits.length === 10) {
    digits = digits.slice(2);
  }
  // Strip a leading 00 international prefix if a 47 follows.
  if (digits.startsWith('0047') && digits.length === 12) {
    digits = digits.slice(4);
  }
  return digits;
}

/** Normalised lowercase email — case-insensitive identity matching. */
export function normalizeEmail(input: string | null | undefined): string {
  if (!input) return '';
  return input.trim().toLowerCase();
}
