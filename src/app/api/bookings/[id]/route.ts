import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  updateBookingStatus,
  BookingClientError,
  type BookingStatus,
} from '@/lib/booking-service';
import { sendBookingStatusEmail } from '@/lib/email';

const VALID: BookingStatus[] = ['pending', 'confirmed', 'cancelled', 'completed'];

/** Upper bound on a stored checklist payload. Generous next to a real
 *  checklist (a few kB of answers plus upload URLs) and far below what a
 *  single request could otherwise park on a Booking row — the column was
 *  written verbatim, so one call could store megabytes of arbitrary text that
 *  every later read (admin list, PDF, checklist parse) then carried. */
const MAX_CHECKLIST_BYTES = 64 * 1024;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    // Both branches below need the booking to exist. Without this the status
    // branch answered 400 "Booking ikke funnet." while the checklist branch
    // let Prisma throw, and the 500 carried Prisma's message verbatim — the
    // absolute path of this file and a four-line excerpt of its source.
    const existing = await db.booking.findUnique({ where: { id }, select: { id: true } });
    if (!existing) {
      return NextResponse.json({ error: 'Booking ikke funnet.' }, { status: 404 });
    }

    if (body.action === 'checklist') {
      const checklistData = body.checklistData ?? '{}';
      if (typeof checklistData !== 'string') {
        return NextResponse.json({ error: 'Ugyldig sjekklistedata.' }, { status: 400 });
      }
      if (Buffer.byteLength(checklistData, 'utf8') > MAX_CHECKLIST_BYTES) {
        return NextResponse.json({ error: 'Sjekklistedata er for stor.' }, { status: 400 });
      }
      try {
        JSON.parse(checklistData);
      } catch {
        return NextResponse.json({ error: 'Ugyldig sjekklistedata.' }, { status: 400 });
      }
      const booking = await db.booking.update({
        where: { id },
        data: { checklistData },
      });
      // After every checklist save, check if the retur phase is now
      // complete. If yes, transition booking → 'completed'.
      const { maybeAutoCompleteOnReturDone } = await import('@/lib/booking-service');
      const autoCompleted = await maybeAutoCompleteOnReturDone(id).catch((err) => {
        console.error('auto-complete-on-retur error:', err);
        return false;
      });
      return NextResponse.json({ success: true, booking, autoCompleted });
    }

    const status = body.status as BookingStatus;
    if (!VALID.includes(status)) {
      return NextResponse.json({ error: 'Ugyldig status' }, { status: 400 });
    }

    // Cancel-with-reason flow: admin marks a paid booking as cancelled,
    // provides a reason (recorded as adminNote), and the customer gets a
    // goodwill discount code in the cancellation email.
    const reason: string | undefined = typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim()
      : undefined;
    if (status === 'cancelled' && !reason) {
      return NextResponse.json({ error: 'Årsak må angis for kansellering.' }, { status: 400 });
    }

    const booking = await updateBookingStatus(id, status, {
      fullyPaid: Boolean(body.fullyPaid),
      adminNote: reason ?? body.adminNote,
      // Behind the admin session — this one really is an operator action.
      actor: 'admin',
      // This handler sends its own cancellation mail below, with the admin's
      // reason and any goodwill code. Without `skipEmails` the service ALSO
      // fired the silent-expiry "bookingen din er utløpt" mail on a pending →
      // cancelled transition, so an admin cancelling an unpaid booking sent
      // the customer two contradictory notices. Only for `cancelled`: the
      // `confirmed` path relies on the service's confirmation mails.
      ...(status === 'cancelled' ? { skipEmails: true } : {}),
    });

    // One-shot side effects are gated on `transitioned`: a retried or
    // double-clicked cancel on an already-cancelled booking must not mint
    // a second goodwill code or re-send the cancellation email.
    if (status === 'cancelled' && booking.transitioned) {
      // Goodwill code only if customer actually paid (otherwise there's
      // nothing to compensate for). Issued via the standard discount
      // engine so it's a real, single-use, email-bound RETUR-XXXX code.
      let codeExtras: { repeatCode?: string; repeatPercent?: number; repeatExpiresAt?: Date } = {};
      if (booking.fullyPaidAt) {
        try {
          const { issueRepeatCode } = await import('@/lib/discount-engine');
          const issued = await issueRepeatCode({
            email: booking.email,
            bookingId: booking.id,
            expiresInDays: 365,
          });
          if (issued) {
            const { loadAppConfig } = await import('@/lib/app-config');
            const appCfg = await loadAppConfig();
            codeExtras = {
              repeatCode: issued.code,
              repeatPercent: Number(appCfg['repeatDiscountPercent'] || '10') || 10,
              repeatExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
            };
          }
        } catch (err) {
          console.error('Goodwill code issue failed:', err);
        }
      }
      sendBookingStatusEmail(booking, 'cancelled', { reason, ...codeExtras }).catch((err) =>
        console.error('Cancel email error:', err)
      );
    }
    // There is deliberately no `else` arm. A cancel that did NOT transition is
    // a re-submit or a double-click on an already-cancelled booking: it used
    // to fall through to a second cancellation mail, this time with no reason
    // and no goodwill code. `cancelled` was the only status that ever reached
    // that arm, so the whole branch is the bug.

    return NextResponse.json({ success: true, booking });
  } catch (error) {
    // Only our own client errors carry a message that is safe (and useful) to
    // show. Anything else — a Prisma failure above all — is logged and
    // answered generically: its `message` names this file's absolute path and
    // quotes the failing statement.
    if (error instanceof BookingClientError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Booking update error:', error);
    return NextResponse.json({ error: 'Oppdatering feilet' }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const booking = await db.booking.findUnique({ where: { id } });
    if (!booking) return NextResponse.json({ error: 'Booking ikke funnet.' }, { status: 404 });
    if (!['cancelled', 'completed'].includes(booking.status)) {
      return NextResponse.json({ error: 'Kun avbestilte eller fullførte bookinger kan slettes.' }, { status: 400 });
    }
    await db.bookingDateLock.deleteMany({ where: { bookingId: id } });
    await db.booking.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Kunne ikke slette booking.' }, { status: 500 });
  }
}
