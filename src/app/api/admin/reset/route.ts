import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireTotp } from '@/lib/totp';
import { writeAuditLog } from '@/lib/audit-log';
import { createRateLimiter } from '@/lib/rate-limit';
import { clientIdentity } from '@/lib/client-ip';

export const dynamic = 'force-dynamic';

// Destructive: wipes every booking, lock, and accepted contract. To prevent
// accidental nukes the request must carry:
//
//   1. A valid admin session (enforced by src/proxy.ts).
//   2. A valid TOTP code. 2FA must be enrolled — no "not-enrolled" bypass.
//      A data-wiping endpoint should never be reachable without a second
//      factor.
//   3. The literal confirmation string `SLETT ALT` in the body so a stray
//      POST never wipes the database.
//
// Every call lands in the audit log with the actor IP.

const RESET_CONFIRMATION = 'SLETT ALT';
const checkLimit = createRateLimiter(3, 60 * 60 * 1000); // 3 per hour per IP

export async function POST(request: NextRequest) {
  try {
    const ip = clientIdentity(request);
    if (checkLimit(ip)) {
      return NextResponse.json({ error: 'For mange forsøk. Prøv igjen om en time.' }, { status: 429 });
    }

    const body = await request.json().catch(() => ({}));
    const confirm: string = typeof body.confirm === 'string' ? body.confirm : '';
    if (confirm !== RESET_CONFIRMATION) {
      return NextResponse.json(
        { error: `Skriv "${RESET_CONFIRMATION}" i confirm-feltet for å bekrefte.` },
        { status: 400 }
      );
    }

    const totpGuard = await requireTotp(request);
    if (!totpGuard.ok) {
      const errorMsg = totpGuard.reason === 'not-enrolled'
        ? 'Aktivér 2FA før du kan slette data.'
        : totpGuard.reason === 'missing'
          ? '2FA-kode mangler.'
          : 'Ugyldig 2FA-kode.';
      return NextResponse.json(
        {
          error: errorMsg,
          requiresTotp: true,
          requiresTotpEnrollment: totpGuard.reason === 'not-enrolled',
        },
        { status: 401 }
      );
    }
    const totpEnforced = true;

    // Snapshot counts so the audit row records what was wiped.
    const [bookingCount, lockCount, contractCount, unavailableCount] = await Promise.all([
      db.booking.count(),
      db.bookingDateLock.count(),
      db.acceptedContract.count(),
      db.unavailableDate.count(),
    ]);

    // Order matters — child rows first to avoid orphans. BookingDateLock
    // and AcceptedContract were leaking before this fix, causing "can't
    // block date after deleted booking" since the locks survived.
    await db.bookingDateLock.deleteMany({});
    await db.acceptedContract.deleteMany({}).catch(() => {});
    const deleted = await db.booking.deleteMany({});
    await db.unavailableDate.deleteMany({});

    await writeAuditLog({
      action: 'data.reset',
      changes: [
        { key: 'bookings', from: bookingCount, to: 0 },
        { key: 'bookingDateLocks', from: lockCount, to: 0 },
        { key: 'acceptedContracts', from: contractCount, to: 0 },
        { key: 'unavailableDates', from: unavailableCount, to: 0 },
      ],
      request,
    });

    return NextResponse.json({ success: true, deletedBookings: deleted.count, totpEnforced });
  } catch (err) {
    console.error('admin/reset error:', err);
    return NextResponse.json({ error: 'Kunne ikke slette data.' }, { status: 500 });
  }
}
