/**
 * L3 — src/lib/freeze-contract.ts (freezeContractForBooking) plus how
 * src/lib/booking-service.ts's updateBookingStatus wires it into the
 * confirmation path: idempotent by bookingId, audience picked from
 * booking.customerType, and a freeze failure never blocks the status
 * transition itself.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/email', async () => (await import('../helpers/mocks')).mockEmail());

import { freezeContractForBooking } from '@/lib/freeze-contract';
import { updateBookingStatus } from '@/lib/booking-service';
import { booking, db, ensureSchema, machine, resetDb, seedConfigDefaults } from '../helpers/db';
import { call, type RouteHandler } from '../helpers/route';
import { emailMock } from '../helpers/mocks';

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDb();
  await seedConfigDefaults();
  await machine({ quantity: 1 });
  emailMock.reset();
});

describe('freezeContractForBooking', () => {
  it('creates an AcceptedContract row with the frozen html, hash, context and acceptance metadata', async () => {
    const b = await booking('confirmed', { name: 'Kari Nordmann' });

    const result = await freezeContractForBooking({
      bookingId: b.id,
      acceptedFromIp: '203.0.113.9',
      acceptanceMethod: 'scroll-then-checkbox',
    });

    expect(result).toMatchObject({ created: true });
    expect(result!.termsVersionHash).toMatch(/^[0-9a-f]{64}$/);

    const row = await db.acceptedContract.findUniqueOrThrow({ where: { bookingId: b.id } });
    expect(row.renderedHtml).toContain('<!DOCTYPE html>');
    expect(row.renderedHtml).toContain('Leievilkår');
    expect(row.termsVersionHash).toBe(result!.termsVersionHash);
    expect(row.acceptedFromIp).toBe('203.0.113.9');
    expect(row.acceptanceMethod).toBe('scroll-then-checkbox');
    expect(row.acceptedAt).toBeInstanceOf(Date);

    const ctx = JSON.parse(row.renderContext) as Record<string, string>;
    expect(ctx['booking.name']).toBe('Kari Nordmann');
    expect(ctx['booking.reference']).toBe(b.reference);
    expect(ctx.businessName).toBeDefined();
  });

  it('falls back to now() for acceptedAt when the booking has no termsAcceptedAt', async () => {
    const b = await booking('confirmed', { termsAcceptedAt: null });
    const before = Date.now();
    await freezeContractForBooking({ bookingId: b.id });
    const row = await db.acceptedContract.findUniqueOrThrow({ where: { bookingId: b.id } });
    expect(row.acceptedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it('defaults acceptanceMethod to "checkbox" and acceptedFromIp to null when omitted', async () => {
    const b = await booking('confirmed');
    await freezeContractForBooking({ bookingId: b.id });
    const row = await db.acceptedContract.findUniqueOrThrow({ where: { bookingId: b.id } });
    expect(row.acceptanceMethod).toBe('checkbox');
    expect(row.acceptedFromIp).toBeNull();
  });

  it('is idempotent — a second call for the same booking reports created:false and does not touch the row', async () => {
    const b = await booking('confirmed');
    const first = await freezeContractForBooking({ bookingId: b.id, acceptedFromIp: '1.1.1.1' });
    expect(first!.created).toBe(true);

    const second = await freezeContractForBooking({ bookingId: b.id, acceptedFromIp: '2.2.2.2' });
    expect(second).toMatchObject({ created: false, termsVersionHash: first!.termsVersionHash, missingTokens: [] });

    expect(await db.acceptedContract.count({ where: { bookingId: b.id } })).toBe(1);
    // Original artifact is untouched — the second call's IP never landed.
    const row = await db.acceptedContract.findUniqueOrThrow({ where: { bookingId: b.id } });
    expect(row.acceptedFromIp).toBe('1.1.1.1');
  });

  it('returns null for a booking that does not exist', async () => {
    expect(await freezeContractForBooking({ bookingId: 'no-such-booking' })).toBeNull();
  });

  it('picks the business terms audience for customerType "business"', async () => {
    const b = await booking('confirmed', { customerType: 'business' });
    await freezeContractForBooking({ bookingId: b.id });
    const row = await db.acceptedContract.findUniqueOrThrow({ where: { bookingId: b.id } });
    // A section that exists only in the business default TOC, not consumer.
    expect(row.renderedHtml).toContain('bareboat');
    expect(row.renderedHtml).not.toContain('Angrerett');
  });

  it('picks the consumer terms audience for any non-business customerType', async () => {
    const b = await booking('confirmed', { customerType: 'consumer' });
    await freezeContractForBooking({ bookingId: b.id });
    const row = await db.acceptedContract.findUniqueOrThrow({ where: { bookingId: b.id } });
    expect(row.renderedHtml).toContain('Angrerett');
  });
});

describe('updateBookingStatus → confirmed drives exactly one freeze, failure does not block confirmation', () => {
  it('freezes the contract once when a pending booking is confirmed', async () => {
    const b = await booking('pending');
    const result = await updateBookingStatus(b.id, 'confirmed', { fullyPaid: true });
    expect(result.transitioned).toBe(true);
    expect(await db.acceptedContract.count({ where: { bookingId: b.id } })).toBe(1);
  });

  it('a repeated confirm (same status, different options) does not create a second AcceptedContract', async () => {
    const b = await booking('pending');
    await updateBookingStatus(b.id, 'confirmed', { fullyPaid: true });
    expect(await db.acceptedContract.count({ where: { bookingId: b.id } })).toBe(1);

    // Same booking, already confirmed — options differ (adminNote) so this
    // is not the plain idempotency short-circuit, but the confirmed→confirmed
    // guard (`previousStatus !== 'confirmed'`) still prevents a second freeze.
    const again = await updateBookingStatus(b.id, 'confirmed', { adminNote: 'admin touched it' });
    expect(again.previousStatus).toBe('confirmed');
    expect(await db.acceptedContract.count({ where: { bookingId: b.id } })).toBe(1);
  });

  it('confirming via the admin PATCH route produces exactly one AcceptedContract', async () => {
    const b = await booking('pending');
    const { PATCH } = await import('@/app/api/bookings/[id]/route');
    const patch = (body: Record<string, unknown>) =>
      call(PATCH as unknown as RouteHandler, {
        method: 'PATCH',
        path: `/api/bookings/${b.id}`,
        params: { id: b.id },
        body,
      });

    const res1 = await patch({ status: 'confirmed', fullyPaid: true });
    expect(res1.status).toBe(200);
    const res2 = await patch({ status: 'confirmed', fullyPaid: true });
    expect(res2.status).toBe(200);

    expect(await db.acceptedContract.count({ where: { bookingId: b.id } })).toBe(1);
  });

  it('does not block the confirmed transition when the contract freeze throws', async () => {
    const b = await booking('pending');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const createSpy = vi.spyOn(db.acceptedContract, 'create').mockRejectedValueOnce(new Error('disk full'));

    try {
      const result = await updateBookingStatus(b.id, 'confirmed', { fullyPaid: true });
      expect(result.transitioned).toBe(true);
      const stored = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
      expect(stored.status).toBe('confirmed');
      expect(await db.acceptedContract.count({ where: { bookingId: b.id } })).toBe(0);
      expect(errorSpy).toHaveBeenCalledWith('Contract freeze failed:', expect.any(Error));
    } finally {
      createSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
