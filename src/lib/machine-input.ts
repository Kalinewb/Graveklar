/**
 * Shape checks for the machine create/update payloads (finding I-4).
 *
 * The create path called `body.name?.trim()` (and the same for
 * category/model/year/description/imageUrl) with no type check, so a JSON
 * number where the admin UI sends a string threw a `TypeError` into the
 * catch-all and the client saw a 500. `PATCH` had the same gap one layer down,
 * where Prisma rejected the value instead. A wrong-typed field is a client
 * mistake: it deserves a 400 that names the field.
 */

/** Machine columns the routes treat as free text. */
export const MACHINE_STRING_FIELDS = [
  'name',
  'category',
  'model',
  'year',
  'description',
  'imageUrl',
] as const;

/**
 * The first string-typed field that arrived as something other than a string,
 * or null when the payload is fine. `null`/`undefined` are allowed — the
 * routes already treat them as "not provided" / "clear it".
 */
export function firstNonStringField(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  for (const field of MACHINE_STRING_FIELDS) {
    const value = record[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') return field;
  }
  return null;
}

/** True when the parsed body is not an object we can read fields off. */
export function isUnusableBody(body: unknown): boolean {
  return !body || typeof body !== 'object' || Array.isArray(body);
}
