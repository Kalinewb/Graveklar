/**
 * PATCH / DELETE /api/bookings/[id] — the admin lifecycle endpoint.
 *
 * Everything here is behind src/proxy.ts, so the handler tests call the
 * handler directly and the proxy gate is asserted on its own at the bottom.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/email', async () => (await import('../helpers/mocks')).mockEmail());

import { booking, db, ensureSchema, machine, resetDb, seedConfigDefaults } from '../helpers/db';
import { adminCookieJar, call, proxyCall, type RouteHandler } from '../helpers/route';
import { emailMock, mockClock } from '../helpers/mocks';

const NOW = '2026-09-07T09:00:00+02:00';
const MONDAY = '2026-09-14';

let clock: ReturnType<typeof mockClock>;

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDb();
  clock = mockClock(NOW);
  emailMock.reset();
  await seedConfigDefaults({ stripeEnabled: 'false', vippsEnabled: 'false' });
  await machine({ quantity: 1 });
});

afterEach(() => {
  clock.restore();
});

// The handlers declare `params: Promise<{ id: string }>`; the harness types it
// as the wider `Promise<RouteParams>`, so the cast is the assignment Next makes
// itself at runtime.
async function patch(id: string, body: Record<string, unknown>) {
  const { PATCH } = await import('@/app/api/bookings/[id]/route');
  return call(PATCH as unknown as RouteHandler, {
    method: 'PATCH',
    path: `/api/bookings/${id}`,
    params: { id },
    body,
  });
}

async function del(id: string) {
  const { DELETE } = await import('@/app/api/bookings/[id]/route');
  return call(DELETE as unknown as RouteHandler, {
    method: 'DELETE',
    path: `/api/bookings/${id}`,
    params: { id },
  });
}

describe('PATCH — status transitions', () => {
  it('refuses a status outside the valid set', async () => {
    const b = await booking('pending', { startDateStr: MONDAY });

    for (const status of ['paid', 'PENDING', '', null, 42]) {
      const res = await patch(b.id, { status });
      expect(res.status, `status=${JSON.stringify(status)}`).toBe(400);
      expect(res.json.error).toBe('Ugyldig status');
    }
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('pending');
  });

  it('refuses a cancellation with no reason', async () => {
    const b = await booking('pending', { startDateStr: MONDAY });

    for (const reason of [undefined, '', '   ', 7]) {
      const res = await patch(b.id, { status: 'cancelled', reason });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe('Årsak må angis for kansellering.');
    }
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('pending');
    expect(emailMock.sent).toHaveLength(0);
  });

  it('cancels with a reason, records it and releases the date locks', async () => {
    const b = await booking('pending', { startDateStr: MONDAY, rentalType: 'weekend' });
    expect(await db.bookingDateLock.count({ where: { bookingId: b.id } })).toBe(3);

    const res = await patch(b.id, { status: 'cancelled', reason: 'Maskinen er på verksted' });

    expect(res.status).toBe(200);
    expect(res.json.booking.status).toBe('cancelled');
    expect(res.json.booking.transitioned).toBe(true);
    const stored = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(stored.status).toBe('cancelled');
    expect(stored.adminNote).toBe('Maskinen er på verksted');
    expect(await db.bookingDateLock.count({ where: { bookingId: b.id } })).toBe(0);
    expect(emailMock.by('sendBookingStatusEmail')).toHaveLength(1);
    expect(emailMock.by('sendBookingStatusEmail')[0].args[2]).toMatchObject({
      reason: 'Maskinen er på verksted',
    });
  });

  it('confirms a pending booking and clears its payment deadline', async () => {
    const b = await booking('pending', {
      startDateStr: MONDAY,
      paymentDeadline: new Date(Date.now() + 60 * 60 * 1000),
    });

    const res = await patch(b.id, { status: 'confirmed', fullyPaid: true });

    expect(res.status).toBe(200);
    const stored = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(stored.status).toBe('confirmed');
    expect(stored.paymentDeadline).toBeNull();
    expect(stored.fullyPaidAt).toBeInstanceOf(Date);
    // Locks survive confirmation — the dates stay reserved.
    expect(await db.bookingDateLock.count({ where: { bookingId: b.id } })).toBe(1);
  });

  // FIXED B-7: updateBookingStatus fires sendBookingExpiredEmail for every
  // pending→cancelled transition. The admin route never passed `skipEmails`,
  // so an admin cancelling an unpaid booking sent the customer BOTH the
  // cancellation mail and a "your booking expired" mail. The route now sets
  // `skipEmails` on the cancel path, exactly as /api/booking/cancel does,
  // and sends its own mail with the reason.
  it('sends exactly one customer mail when an admin cancels a pending booking', async () => {
    const b = await booking('pending', { startDateStr: MONDAY });

    await patch(b.id, { status: 'cancelled', reason: 'Kunden ringte og avbestilte' });

    expect(emailMock.by('sendBookingExpiredEmail')).toHaveLength(0);
    expect(emailMock.sent.filter((s) => s.fn !== 'sendNewBookingAdminNotification')).toHaveLength(1);
  });

  // FIXED B-8: the one-shot guard covered the goodwill code but not the
  // email — a re-submitted cancel fell into the `else if (EMAIL_STATUSES…)`
  // branch and mailed the customer a second time, with no reason and no
  // goodwill code. That branch is gone: `cancelled` was the only status that
  // ever reached it.
  it('does not re-mail the customer when a cancel is submitted twice', async () => {
    const b = await booking('pending', { startDateStr: MONDAY });

    const first = await patch(b.id, { status: 'cancelled', reason: 'Kunden avbestilte' });
    const second = await patch(b.id, { status: 'cancelled', reason: 'Kunden avbestilte' });

    expect(first.json.booking.transitioned).toBe(true);
    expect(second.json.booking.transitioned).toBe(false);
    expect(emailMock.by('sendBookingStatusEmail')).toHaveLength(1);
  });
});

describe('PATCH — checklist saves', () => {
  it('stores the checklist payload the admin submitted', async () => {
    const b = await booking('confirmed', { startDateStr: MONDAY });
    const payload = JSON.stringify({ 'item-1': true, 'item-2': '12,5 t' });

    const res = await patch(b.id, { action: 'checklist', checklistData: payload });

    expect(res.status).toBe(200);
    expect(res.json.autoCompleted).toBe(false);
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).checklistData).toBe(payload);
  });

  it('falls back to an empty object when no payload is given', async () => {
    const b = await booking('confirmed', { startDateStr: MONDAY });
    const res = await patch(b.id, { action: 'checklist' });

    expect(res.status).toBe(200);
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).checklistData).toBe('{}');
  });

  // FIXED F-11: `checklistData: body.checklistData ?? '{}'` was written
  // verbatim — no size limit, no type check, no JSON validation. A single
  // request could park megabytes of arbitrary text on a Booking row, and a
  // non-string value reached Prisma as a type error (a 500).
  it('caps the size and type of a checklist payload', async () => {
    const b = await booking('confirmed', { startDateStr: MONDAY });

    const huge = await patch(b.id, { action: 'checklist', checklistData: 'x'.repeat(2_000_000) });
    expect(huge.status).toBe(400);
    expect(
      (await db.booking.findUniqueOrThrow({ where: { id: b.id } })).checklistData?.length ?? 0,
    ).toBeLessThan(1000);

    const wrongType = await patch(b.id, { action: 'checklist', checklistData: { a: 1 } });
    expect(wrongType.status).toBe(400);
  });
});

describe('PATCH / DELETE — unknown id', () => {
  // FIXED F-9: a status PATCH for a missing booking answered 400, and the
  // checklist branch answered 500 carrying Prisma's own error text — the
  // absolute path of the route file and an excerpt of its source. Both are a
  // plain 404 now: PATCH resolves the booking before either branch runs.
  it('answers 404 for a status change on a booking that does not exist', async () => {
    const res = await patch('no-such-booking', { status: 'confirmed' });
    expect(res.status).toBe(404);
  });

  it('answers 404 without leaking Prisma internals on a checklist save', async () => {
    const res = await patch('no-such-booking', { action: 'checklist', checklistData: '{}' });

    // This used to be a 500 whose body carried Prisma's message verbatim: the
    // absolute path of the route file and a four-line excerpt of its source.
    const message = String(res.json.error ?? '');
    expect(message).not.toMatch(/invocation|db\.booking\.update|depends on one or more/i);
    expect(message).not.toMatch(/\/src\/app\/api\//);
    expect(res.status).toBe(404);
  });

  it('answers 404 on DELETE', async () => {
    const res = await del('no-such-booking');
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('Booking ikke funnet.');
  });
});

describe('PATCH — a completed rental releases its dates (FIXED Q-4)', () => {
  // FIXED Q-4: `updateBookingStatus` deleted the BookingDateLock rows only for
  // `cancelled`. The calendar and `checkBookable` count only confirmed and
  // pending bookings, so a completed rental's days read as free and
  // /api/quote answered `bookable: true` — while `createPendingBooking`, which
  // allocates its slots from that very table, refused the same dates with
  // "En eller flere dager i perioden er opptatt." It bit whenever a rental was
  // marked done before its last day, killing the remaining days for good.
  it('deletes the locks and frees the day for the next customer', async () => {
    const b = await booking('confirmed', { startDateStr: MONDAY, rentalType: 'day' });
    expect(await db.bookingDateLock.count({ where: { bookingId: b.id } })).toBe(1);

    const res = await patch(b.id, { status: 'completed' });

    expect(res.status).toBe(200);
    expect(await db.bookingDateLock.count({ where: { bookingId: b.id } })).toBe(0);
    const { getUnavailableDateStringsForRange } = await import('@/lib/booking-service');
    expect(await getUnavailableDateStringsForRange([MONDAY], undefined, b.machineId!)).toEqual([]);
  });

  it('releases stale locks on a replayed completion too — the release is idempotent', async () => {
    const b = await booking('completed', { startDateStr: MONDAY, rentalType: 'day' });
    // A row that reached `completed` before this rule existed still holds its
    // slot; asking for the state it is already in has to clear it.
    expect(await db.bookingDateLock.count({ where: { bookingId: b.id } })).toBe(1);

    const res = await patch(b.id, { status: 'completed' });

    expect(res.status).toBe(200);
    expect(res.json.booking.transitioned).toBe(false);
    expect(await db.bookingDateLock.count({ where: { bookingId: b.id } })).toBe(0);
  });
});

describe('PATCH — a paid B2B booking converts its quote request (FIXED M-1)', () => {
  // FIXED M-1: `convertQuoteToBooking` stamps `convertedBookingId` and leaves
  // the quote at `akseptert`; nothing in the card path ever moved it on. The
  // admin UI keys "Send tilbud" / "Trekk tilbake" off `status !== 'konvertert'`,
  // so both stayed available on a quote that was fully paid and already had a
  // real, locked Booking behind it. `updateBookingStatus` now makes the move
  // where the money lands.
  async function quoteFor(bookingId: string, status = 'akseptert') {
    return db.quoteRequest.create({
      data: {
        reference: `BQ-TEST-${Math.random().toString(36).slice(2, 8)}`,
        company: 'Testfirma AS',
        orgNumber: '999888777',
        contactName: 'Kari Nordmann',
        email: 'kari@testfirma.no',
        phone: '+4740000001',
        status,
        paymentMode: 'card',
        offerAmount: 5000,
        convertedBookingId: bookingId,
      },
    });
  }

  it('moves an accepted quote to konvertert when its booking is paid', async () => {
    const b = await booking('pending', { startDateStr: MONDAY, customerType: 'business' });
    const q = await quoteFor(b.id);

    const res = await patch(b.id, { status: 'confirmed', fullyPaid: true });

    expect(res.status).toBe(200);
    expect((await db.quoteRequest.findUniqueOrThrow({ where: { id: q.id } })).status).toBe('konvertert');
  });

  it('leaves a quote the admin has withdrawn alone, and touches no other quote', async () => {
    const b = await booking('pending', { startDateStr: MONDAY, customerType: 'business' });
    const withdrawn = await quoteFor(b.id, 'trukket');
    const other = await quoteFor('some-other-booking');

    await patch(b.id, { status: 'confirmed', fullyPaid: true });

    expect((await db.quoteRequest.findUniqueOrThrow({ where: { id: withdrawn.id } })).status).toBe('trukket');
    expect((await db.quoteRequest.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('akseptert');
  });
});

describe('DELETE — allowed only from a settled state', () => {
  it('refuses to delete a pending or confirmed booking', async () => {
    const pending = await booking('pending', { startDateStr: MONDAY });
    const confirmed = await booking('confirmed', { startDateStr: '2026-09-20' });

    for (const b of [pending, confirmed]) {
      const res = await del(b.id);
      expect(res.status).toBe(400);
      expect(res.json.error).toBe('Kun avbestilte eller fullførte bookinger kan slettes.');
    }
    expect(await db.booking.count()).toBe(2);
  });

  it('deletes a cancelled or completed booking together with its locks', async () => {
    const cancelled = await booking('cancelled', { startDateStr: MONDAY });
    const completed = await booking('completed', { startDateStr: '2026-09-20' });

    expect((await del(cancelled.id)).status).toBe(200);
    expect((await del(completed.id)).status).toBe(200);
    expect(await db.booking.count()).toBe(0);
    expect(await db.bookingDateLock.count()).toBe(0);
  });
});

describe('proxy gate for /api/bookings/[id]', () => {
  it('401s every method without an admin session and passes through with one', async () => {
    for (const method of ['GET', 'PATCH', 'DELETE']) {
      const anonymous = await proxyCall('/api/bookings/abc123', { method });
      expect(anonymous.status, method).toBe(401);
      await expect(anonymous.clone().json()).resolves.toEqual({ error: 'Unauthorized' });

      const authed = await proxyCall('/api/bookings/abc123', {
        method,
        cookies: await adminCookieJar(),
      });
      expect(authed.headers.get('x-middleware-next'), method).toBe('1');
    }
  });
});
