import { NextRequest, NextResponse } from 'next/server';
import { createRateLimiter } from '@/lib/rate-limit';
import { extractBearerToken, verifyRenterSessionToken } from '@/lib/renter-checklist-session';
import { isBookingActiveForRenterChecklist, assertPhoneMatchesBooking } from '@/lib/renter-checklist';
import { db } from '@/lib/db';
import { sniffFileType } from '@/lib/upload-sniff';
import { clientIdentity } from '@/lib/client-ip';
import { renterUploadPrefix, storeUpload } from '@/lib/upload-store';

const checkLimit = createRateLimiter(10, 5 * 60 * 1000);

// Images only. The stored extension comes from the file's magic bytes, not
// from the client's MIME type or filename (see lib/upload-sniff.ts).
const MAX_SIZE = 10 * 1024 * 1024;

export async function POST(request: NextRequest) {
  try {
    const token = extractBearerToken(request.headers.get('authorization'));
    const session = await verifyRenterSessionToken(token);
    if (!session) {
      return NextResponse.json({ error: 'Ugyldig økt.' }, { status: 401 });
    }

    const booking = await db.booking.findUnique({ where: { id: session.bookingId } });
    if (!booking || !assertPhoneMatchesBooking(booking, session.phone)) {
      return NextResponse.json({ error: 'Booking ikke funnet.' }, { status: 404 });
    }
    if (!isBookingActiveForRenterChecklist(booking)) {
      return NextResponse.json({ error: 'Leien er ikke aktiv.' }, { status: 403 });
    }

    const ip = clientIdentity(request);
    if (checkLimit(ip)) {
      return NextResponse.json({ error: 'For mange opplastinger.' }, { status: 429 });
    }

    const form = await request.formData();
    const file = form.get('file') as File | null;
    if (!file) return NextResponse.json({ error: 'Ingen fil.' }, { status: 400 });
    if (file.size > MAX_SIZE) return NextResponse.json({ error: 'Filen er for stor (maks 10 MB).' }, { status: 400 });

    const bytes = new Uint8Array(await file.arrayBuffer());
    const ext = sniffFileType(bytes);
    if (!ext || ext === 'pdf') return NextResponse.json({ error: 'Kun bilder er tillatt (JPG, PNG, WebP, GIF, HEIC).' }, { status: 400 });

    // `renter-<bookingId>-<random>.<ext>`. The booking id is what
    // /api/uploads/[filename] checks a renter's bearer token against; the
    // random half makes the name unguessable (H-7) and the exclusive create
    // makes an overwrite impossible (H-8).
    const filename = await storeUpload(renterUploadPrefix(booking.id), ext, bytes);

    return NextResponse.json({ url: `/api/uploads/${filename}` });
  } catch (err) {
    console.error('checklist/upload error:', err);
    return NextResponse.json({ error: 'Opplasting feilet.' }, { status: 500 });
  }
}
