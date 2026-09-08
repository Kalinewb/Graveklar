import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

// Per-booking event timeline. Sources:
//   1. The booking row's own timestamps (createdAt, fullyPaidAt,
//      paymentDeadline, reminderSentAt, updatedAt).
//   2. The AcceptedContract row (contract freeze time + acceptance IP).
//   3. AdminAuditLog entries where the JSON `changes` payload references
//      this bookingId — covers admin transitions, refunds, manual
//      corrections.
//
// Returned events are not yet rendered as a UI; the BookingTimeline
// component reads from the booking row directly. This endpoint is the
// machine-readable feed for that component's future audit overlay and
// for any external operator tooling.

interface TimelineEvent {
  at: string;          // ISO timestamp
  kind: string;        // e.g. 'created', 'paid', 'contract_frozen', 'audit:booking.cancelled'
  source: 'booking' | 'contract' | 'audit';
  detail?: unknown;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const [booking, contract, auditRows] = await Promise.all([
    db.booking.findUnique({ where: { id } }),
    db.acceptedContract.findUnique({ where: { bookingId: id } }),
    // Cheap-ish scan filter — there's no FK index on AuditLog.changes JSON,
    // so we fetch a bounded window of recent rows and filter in JS. Fine for
    // current scale; if audit volume grows, add a dedicated bookingId
    // column on AdminAuditLog.
    db.adminAuditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 1000,
    }),
  ]);

  if (!booking) {
    return NextResponse.json({ error: 'Booking ikke funnet.' }, { status: 404 });
  }

  const events: TimelineEvent[] = [];

  const push = (at: Date | null | undefined, kind: string, source: TimelineEvent['source'], detail?: unknown) => {
    if (!at) return;
    events.push({ at: at.toISOString(), kind, source, detail });
  };

  push(booking.createdAt, 'created', 'booking');
  push(booking.termsAcceptedAt, 'terms_accepted', 'booking');
  push(booking.fullyPaidAt, 'paid', 'booking');
  push(booking.paymentDeadline, 'payment_deadline_set', 'booking');
  push(booking.reminderSentAt, 'reminder_sent', 'booking');
  if (contract) {
    push(contract.createdAt, 'contract_frozen', 'contract', {
      hash: contract.termsVersionHash,
      ip: contract.acceptedFromIp,
      method: contract.acceptanceMethod,
    });
  }

  // Filter audit entries whose JSON changes blob references this bookingId.
  for (const row of auditRows) {
    let changes: unknown;
    try { changes = JSON.parse(row.changes); } catch { continue; }
    const arr = Array.isArray(changes) ? changes : [];
    const refsBooking = arr.some(
      (c: { key?: string; from?: unknown; to?: unknown }) =>
        c?.key === 'bookingId' && (c.from === id || c.to === id),
    );
    if (refsBooking) {
      events.push({
        at: row.createdAt.toISOString(),
        kind: `audit:${row.action}`,
        source: 'audit',
        detail: { actor: row.actor, ip: row.ip, changes },
      });
    }
  }

  events.sort((a, b) => a.at.localeCompare(b.at));

  return NextResponse.json({
    booking: { id: booking.id, reference: booking.reference, status: booking.status },
    events,
  });
}
