import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import path from 'path';
import { COOKIE_NAME, verifySessionToken } from '@/lib/admin-auth';
import { extractBearerToken, verifyRenterSessionToken } from '@/lib/renter-checklist-session';
import { getUploadDir, isRenterUpload, renterUploadBookingId } from '@/lib/upload-store';

// SVG intentionally excluded — see /api/admin/upload/route.ts for rationale.
// If a legacy SVG is still on disk, it falls through to application/octet-
// stream which the browser downloads rather than executes.
const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif',
  pdf: 'application/pdf',
};

/**
 * Who may read a stored file (finding H-6).
 *
 * `upload-*` files are public content by design: machine photos, equipment
 * manuals, the logo and the hero image are all rendered on the public site,
 * and several of them are hot-linked from e-mails and PDFs. They stay open.
 *
 * `renter-*` files are damage and condition photos tied to a named, addressed
 * customer. They need either an admin session or the renter session for the
 * booking the file belongs to. This path is OUTSIDE the proxy matcher (it is
 * not under /api/admin), so the check has to happen here in the handler.
 *
 * Legacy `renter-<timestamp>.<ext>` names carry no booking id — nothing can
 * tie them to a renter, so they are admin-only.
 */
async function readVerdict(
  request: NextRequest,
  filename: string,
): Promise<'allow' | 'unauthenticated' | 'forbidden'> {
  if (!isRenterUpload(filename)) return 'allow';

  // Same-origin <img> requests from the admin UI carry the session cookie, so
  // the admin gallery and the printable checklist keep working untouched.
  if (await verifySessionToken(request.cookies.get(COOKIE_NAME)?.value)) return 'allow';

  const session = await verifyRenterSessionToken(
    extractBearerToken(request.headers.get('authorization')),
  );
  if (!session) return 'unauthenticated';

  // A renter session is real but belongs to someone else's rental (or the
  // file is a legacy name that names no booking): identified, not entitled.
  const bookingId = renterUploadBookingId(filename);
  return bookingId !== null && bookingId === session.bookingId ? 'allow' : 'forbidden';
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) {
  const { filename } = await params;

  if (!filename || filename.includes('..') || filename.includes('/')) {
    return NextResponse.json({ error: 'Invalid filename' }, { status: 400 });
  }

  const verdict = await readVerdict(request, filename);
  if (verdict === 'unauthenticated') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (verdict === 'forbidden') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const contentType = MIME[ext] || 'application/octet-stream';
  const filePath = path.join(getUploadDir(), filename);

  try {
    const data = await readFile(filePath);
    return new NextResponse(data, {
      headers: {
        'Content-Type': contentType,
        // Renter photos are per-session content: cache them in the browser
        // that fetched them, never in a shared cache.
        'Cache-Control': isRenterUpload(filename)
          ? 'private, max-age=31536000, immutable'
          : 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }
}
