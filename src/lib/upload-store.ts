import { randomBytes } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';

/**
 * Where uploaded files live, and how they are named.
 *
 * Two writers share this: `/api/admin/upload` (machine photos, manuals, the
 * logo — public content by design) and `/api/checklist/upload` (renter damage
 * photos — private, readable only by that renter or an admin). One reader
 * serves them back: `/api/uploads/[filename]`.
 *
 * Names used to be `<prefix>-<Date.now()>.<ext>`, which was two defects at
 * once: a millisecond timestamp is a 40-bit guess over a known day (H-7), and
 * two uploads inside the same millisecond produced the same name, the second
 * silently overwriting the first (H-8). Now every name carries 64 bits of
 * randomness and is created with the `wx` flag, so a collision fails loudly
 * instead of destroying bytes.
 *
 * A renter file also carries its booking id: `renter-<bookingId>-<random>.<ext>`.
 * That is what lets the read route check a renter's bearer token against the
 * file it is being asked for without a database round-trip.
 */

/** Resolve the on-disk uploads directory (next to the SQLite file). */
export function getUploadDir(): string {
  const dbUrl = process.env.DATABASE_URL || '';
  const match = dbUrl.match(/file:(.+)/);
  if (match) {
    // turbopackIgnore: the directory is only known at runtime (see cleanup.ts).
    const dbDir = path.dirname(path.resolve(/*turbopackIgnore: true*/ match[1]));
    return path.join(dbDir, 'uploads');
  }
  return path.join(/*turbopackIgnore: true*/ process.cwd(), 'uploads');
}

/** 16 hex characters — 64 bits, from the CSPRNG. */
function randomSuffix(): string {
  return randomBytes(8).toString('hex');
}

/**
 * Write `bytes` under an unguessable name built from `prefix` and `ext`, and
 * return the filename. Never overwrites: the file is created exclusively, and
 * a name collision is retried with fresh randomness.
 */
export async function storeUpload(prefix: string, ext: string, bytes: Uint8Array): Promise<string> {
  const uploadDir = getUploadDir();
  await mkdir(uploadDir, { recursive: true });
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const filename = `${prefix}-${randomSuffix()}.${ext}`;
    try {
      await writeFile(path.join(uploadDir, filename), bytes, { flag: 'wx' });
      return filename;
    } catch (err) {
      lastErr = err;
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('could not allocate an upload filename');
}

/** Name of a renter checklist photo for `bookingId`. */
export const renterUploadPrefix = (bookingId: string): string => `renter-${bookingId}`;

/** True for anything written by the renter checklist route, legacy names included. */
export function isRenterUpload(filename: string): boolean {
  return filename.startsWith('renter-');
}

/**
 * The booking id embedded in a renter filename, or null when there is none —
 * legacy `renter-<timestamp>.<ext>` files pre-date the booking-scoped naming
 * and can only be read with an admin session.
 */
export function renterUploadBookingId(filename: string): string | null {
  const match = filename.match(/^renter-([A-Za-z0-9_]+)-[0-9a-f]{16}\.[A-Za-z0-9]+$/);
  return match ? match[1] : null;
}
