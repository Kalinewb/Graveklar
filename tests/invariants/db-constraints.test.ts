/**
 * L3i — area U.1: what stops corruption when the application logic fails?
 *
 * Every unique constraint in `prisma/schema.prisma` is exercised **at the
 * database**: a raw `client.<model>.create()` with no service code in front of
 * it. The application already refuses most of these duplicates; the question
 * here is what happens when it does not — a second process, a retried webhook,
 * a hand-written script, a race the compare-and-set missed.
 *
 * Two assertions per constraint, always:
 *   1. the duplicate is rejected with Prisma's `P2002`, and
 *   2. the FIRST row is still there afterwards (a rejected write must not
 *      clobber or half-apply).
 *
 * `@unique` on a nullable column is a separate question, so the columns that
 * carry one (`Booking.cancelToken`, `checklistToken`, `vippsReference`,
 * `QuoteRequest.acceptToken`) also assert that SQLite's "NULLs are all
 * distinct" rule holds — several rows may sit at NULL at once, which is what
 * makes the cleanup sweep's `cancelToken: null` write legal.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  booking,
  campaignCode,
  checklistPhase,
  db,
  machine,
  repeatCode,
  resetDb,
  unavailableDate,
} from '../helpers/db';
import { conflictTarget, expectNoOrphanLocks, expectP2002 } from '../helpers/invariants';
import { dateToDbMidnight } from '@/lib/availability';

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
  await expectNoOrphanLocks();
});

describe('BookingDateLock (machineId, date, slot)', () => {
  it('refuses a second lock on the same machine, date and slot', async () => {
    const m = await machine();
    const b = await booking('pending', { machineId: m.id, skipLocks: true });
    const date = dateToDbMidnight('2026-06-15');

    await db.bookingDateLock.create({ data: { bookingId: b.id, machineId: m.id, date, slot: 0 } });

    const err = await expectP2002(() =>
      db.bookingDateLock.create({ data: { bookingId: b.id, machineId: m.id, date, slot: 0 } }),
    );
    expect(conflictTarget(err).join(',')).toMatch(/machineId|slot|date/);
    expect(await db.bookingDateLock.count()).toBe(1);
  });

  it('is the ONLY thing standing between two bookings and a double-booked day', async () => {
    // Two independent bookings, same machine, same day, same slot. Nothing in
    // the schema links a lock to its booking, so the unique index is the
    // whole defence.
    const m = await machine();
    const a = await booking('pending', { machineId: m.id, skipLocks: true });
    const b = await booking('pending', { machineId: m.id, skipLocks: true });
    const date = dateToDbMidnight('2026-06-15');

    await db.bookingDateLock.create({ data: { bookingId: a.id, machineId: m.id, date, slot: 0 } });
    await expectP2002(() =>
      db.bookingDateLock.create({ data: { bookingId: b.id, machineId: m.id, date, slot: 0 } }),
    );

    const rows = await db.bookingDateLock.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].bookingId).toBe(a.id);
  });

  it('lets a second machine, a second day and a second slot through', async () => {
    const m1 = await machine();
    const m2 = await machine({ name: 'Andre maskin' });
    const b = await booking('pending', { machineId: m1.id, skipLocks: true });
    const date = dateToDbMidnight('2026-06-15');

    await db.bookingDateLock.create({ data: { bookingId: b.id, machineId: m1.id, date, slot: 0 } });
    await db.bookingDateLock.create({ data: { bookingId: b.id, machineId: m2.id, date, slot: 0 } });
    await db.bookingDateLock.create({ data: { bookingId: b.id, machineId: m1.id, date, slot: 1 } });
    await db.bookingDateLock.create({
      data: { bookingId: b.id, machineId: m1.id, date: dateToDbMidnight('2026-06-16'), slot: 0 },
    });

    expect(await db.bookingDateLock.count()).toBe(4);
  });
});

describe('Booking single-column unique columns', () => {
  it('Booking.reference refuses a duplicate', async () => {
    const first = await booking('pending', { reference: 'GK-2606-001-ABCDE' });
    await expectP2002(() => booking('pending', { reference: 'GK-2606-001-ABCDE', skipLocks: true }));
    const rows = await db.booking.findMany({ where: { reference: 'GK-2606-001-ABCDE' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.id);
  });

  it('Booking.cancelToken refuses a duplicate but allows many NULLs', async () => {
    const first = await booking('confirmed', { cancelToken: 'tok-cancel-1' });
    await expectP2002(() =>
      booking('confirmed', { cancelToken: 'tok-cancel-1', skipLocks: true }),
    );
    expect(await db.booking.count({ where: { cancelToken: 'tok-cancel-1' } })).toBe(1);
    expect((await db.booking.findUniqueOrThrow({ where: { id: first.id } })).cancelToken).toBe(
      'tok-cancel-1',
    );

    // NULL is not a value: the cleanup sweep nulls every lapsed token at once.
    await booking('confirmed', { skipLocks: true });
    await booking('confirmed', { skipLocks: true });
    expect(await db.booking.count({ where: { cancelToken: null } })).toBe(2);
  });

  it('Booking.checklistToken refuses a duplicate but allows many NULLs', async () => {
    await booking('confirmed', { checklistToken: 'tok-checklist-1' });
    await expectP2002(() =>
      booking('confirmed', { checklistToken: 'tok-checklist-1', skipLocks: true }),
    );
    expect(await db.booking.count({ where: { checklistToken: 'tok-checklist-1' } })).toBe(1);
    await booking('confirmed', { skipLocks: true });
    await booking('confirmed', { skipLocks: true });
    expect(await db.booking.count({ where: { checklistToken: null } })).toBe(2);
  });

  it('Booking.vippsReference refuses a duplicate — the retry must mint a new one', async () => {
    // Vipps requires a payment reference to be unique per sales unit forever,
    // which is why the retry path derives `…-r2` rather than reusing.
    await booking('pending', { vippsReference: 'GK-2606-001-ABCDE' });
    await expectP2002(() =>
      booking('pending', { vippsReference: 'GK-2606-001-ABCDE', skipLocks: true }),
    );
    expect(await db.booking.count({ where: { vippsReference: 'GK-2606-001-ABCDE' } })).toBe(1);

    // …and the -r2 retry reference is accepted.
    await booking('pending', { vippsReference: 'GK-2606-001-ABCDE-r2', skipLocks: true });
    expect(await db.booking.count({ where: { vippsReference: { not: null } } })).toBe(2);
  });
});

describe('discount and referral code uniqueness', () => {
  it('CampaignDiscountCode.code refuses a duplicate', async () => {
    const first = await campaignCode({ code: 'SOMMER2026' });
    await expectP2002(() => campaignCode({ code: 'SOMMER2026' }));
    const rows = await db.campaignDiscountCode.findMany({ where: { code: 'SOMMER2026' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.id);
    expect(rows[0].usedCount).toBe(0);
  });

  it('RepeatDiscountCode.code refuses a duplicate', async () => {
    const first = await repeatCode({ code: 'RETUR-ABCD1234' });
    await expectP2002(() => repeatCode({ code: 'RETUR-ABCD1234', email: 'other@example.com' }));
    const rows = await db.repeatDiscountCode.findMany({ where: { code: 'RETUR-ABCD1234' } });
    expect(rows).toHaveLength(1);
    // The loser's e-mail did not overwrite the winner's binding.
    expect(rows[0].email).toBe(first.email);
  });

  it('ReferralCode.code refuses a duplicate', async () => {
    await db.referralCode.create({ data: { code: 'GRAV-1234', ownerEmail: 'a@example.com' } });
    await expectP2002(() =>
      db.referralCode.create({ data: { code: 'GRAV-1234', ownerEmail: 'b@example.com' } }),
    );
    const rows = await db.referralCode.findMany({ where: { code: 'GRAV-1234' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].ownerEmail).toBe('a@example.com');
  });
});

describe('WebhookEvent (provider, eventId) — the replay guard', () => {
  it('refuses the same event id from the same provider twice', async () => {
    await db.webhookEvent.create({ data: { provider: 'stripe', eventId: 'evt_1' } });
    await expectP2002(() =>
      db.webhookEvent.create({ data: { provider: 'stripe', eventId: 'evt_1' } }),
    );
    expect(await db.webhookEvent.count()).toBe(1);
  });

  it('scopes the guard per provider — Stripe and Vipps may share an id', async () => {
    await db.webhookEvent.create({ data: { provider: 'stripe', eventId: 'shared-id' } });
    await db.webhookEvent.create({ data: { provider: 'vipps', eventId: 'shared-id' } });
    expect(await db.webhookEvent.count()).toBe(2);
  });
});

describe('one-per-booking children', () => {
  it('AcceptedContract.bookingId refuses a second frozen contract', async () => {
    const b = await booking('confirmed');
    const data = {
      bookingId: b.id,
      renderedHtml: '<p>vilkår</p>',
      termsVersionHash: 'hash-1',
      renderContext: '{}',
      acceptedAt: new Date('2026-06-15T10:00:00+02:00'),
      acceptanceMethod: 'checkbox',
    };
    await db.acceptedContract.create({ data });

    await expectP2002(() =>
      db.acceptedContract.create({ ...{ data: { ...data, termsVersionHash: 'hash-2' } } }),
    );

    const rows = await db.acceptedContract.findMany();
    expect(rows).toHaveLength(1);
    // The immutable artifact was not rewritten by the refused second freeze.
    expect(rows[0].termsVersionHash).toBe('hash-1');
  });

  it('Review.bookingId refuses a second review, and Review.token refuses a duplicate token', async () => {
    const b1 = await booking('completed');
    const b2 = await booking('completed', { skipLocks: true });

    await db.review.create({ data: { bookingId: b1.id, token: 'rev-token-1' } });

    await expectP2002(() => db.review.create({ data: { bookingId: b1.id, token: 'rev-token-2' } }));
    await expectP2002(() => db.review.create({ data: { bookingId: b2.id, token: 'rev-token-1' } }));

    const rows = await db.review.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].bookingId).toBe(b1.id);
    expect(rows[0].status).toBe('pending');
  });
});

describe('ChecklistSubmission (bookingId, phaseId, intervalKey)', () => {
  it('refuses a second submission for the same interval', async () => {
    const b = await booking('confirmed');
    const phase = await checklistPhase({ audience: 'renter', intervalMode: 'daily' });
    const row = {
      bookingId: b.id,
      phaseId: phase.id,
      intervalKey: 'day-2026-06-15',
      phone: '+4740000000',
      data: '{"a":1}',
    };
    await db.checklistSubmission.create({ data: row });

    await expectP2002(() => db.checklistSubmission.create({ data: { ...row, data: '{"a":2}' } }));

    const rows = await db.checklistSubmission.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toBe('{"a":1}');
  });

  it('lets the next day, the next phase and the next booking through', async () => {
    const b1 = await booking('confirmed');
    const b2 = await booking('confirmed', { skipLocks: true });
    const p1 = await checklistPhase({ audience: 'renter', intervalMode: 'daily' });
    const p2 = await checklistPhase({ name: 'Daglig 2', audience: 'renter', intervalMode: 'daily' });
    const base = { phone: '+4740000000', data: '{}' };

    await db.checklistSubmission.createMany({
      data: [
        { ...base, bookingId: b1.id, phaseId: p1.id, intervalKey: 'day-2026-06-15' },
        { ...base, bookingId: b1.id, phaseId: p1.id, intervalKey: 'day-2026-06-16' },
        { ...base, bookingId: b1.id, phaseId: p2.id, intervalKey: 'day-2026-06-15' },
        { ...base, bookingId: b2.id, phaseId: p1.id, intervalKey: 'day-2026-06-15' },
      ],
    });
    expect(await db.checklistSubmission.count()).toBe(4);
  });
});

describe('calendar and configuration keys', () => {
  it('UnavailableDate.date refuses the same blocked day twice', async () => {
    await unavailableDate('2026-06-15', 'Service');
    await expectP2002(() => unavailableDate('2026-06-15', 'Ferie'));
    const rows = await db.unavailableDate.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('Service');
  });

  it('UnavailableDate treats local midnight as the key — a different time of day is a different row', async () => {
    // Every writer goes through `dateToDbMidnight`; this pins that the column
    // is an instant, not a calendar day, so a row written at any other time
    // would silently duplicate the day.
    await unavailableDate('2026-06-15');
    await db.unavailableDate.create({ data: { date: new Date('2026-06-15T12:00:00+02:00') } });
    expect(await db.unavailableDate.count()).toBe(2);
  });

  it('AppConfig.key is the primary key and refuses a duplicate', async () => {
    await db.appConfig.create({ data: { key: 'siteUrl', value: 'https://a', label: 'A', group: 'g' } });
    await expectP2002(() =>
      db.appConfig.create({ data: { key: 'siteUrl', value: 'https://b', label: 'B', group: 'g' } }),
    );
    const rows = await db.appConfig.findMany({ where: { key: 'siteUrl' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe('https://a');
  });

  it('PricingConfig.key refuses a duplicate', async () => {
    await db.pricingConfig.create({ data: { key: 'dayPrice', value: 2490, label: 'Dag', group: 'p' } });
    await expectP2002(() =>
      db.pricingConfig.create({ data: { key: 'dayPrice', value: 1, label: 'Dag', group: 'p' } }),
    );
    const rows = await db.pricingConfig.findMany({ where: { key: 'dayPrice' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(2490);
  });

  it('SurveyQuestion.key refuses a duplicate', async () => {
    const row = { key: 'planlagt', type: 'radio', section: 'Om deg', label: 'Planlagt?' };
    await db.surveyQuestion.create({ data: row });
    await expectP2002(() => db.surveyQuestion.create({ data: { ...row, label: 'Annet' } }));
    const rows = await db.surveyQuestion.findMany({ where: { key: 'planlagt' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('Planlagt?');
  });
});

describe('QuoteRequest uniqueness', () => {
  const quote = (overrides: Record<string, unknown> = {}) => ({
    reference: 'FT-2606-001',
    company: 'Test AS',
    orgNumber: '999999999',
    contactName: 'Test Testesen',
    email: 'firma@example.com',
    phone: '+4740000000',
    ...overrides,
  });

  it('QuoteRequest.reference refuses a duplicate', async () => {
    await db.quoteRequest.create({ data: quote() });
    await expectP2002(() => db.quoteRequest.create({ data: quote({ company: 'Annet AS' }) }));
    const rows = await db.quoteRequest.findMany({ where: { reference: 'FT-2606-001' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].company).toBe('Test AS');
    expect(rows[0].status).toBe('ny');
  });

  it('QuoteRequest.acceptToken refuses a duplicate but allows many NULLs', async () => {
    await db.quoteRequest.create({ data: quote({ acceptToken: 'accept-1' }) });
    await expectP2002(() =>
      db.quoteRequest.create({ data: quote({ reference: 'FT-2606-002', acceptToken: 'accept-1' }) }),
    );
    expect(await db.quoteRequest.count({ where: { acceptToken: 'accept-1' } })).toBe(1);

    await db.quoteRequest.create({ data: quote({ reference: 'FT-2606-003' }) });
    await db.quoteRequest.create({ data: quote({ reference: 'FT-2606-004' }) });
    expect(await db.quoteRequest.count({ where: { acceptToken: null } })).toBe(2);
  });
});

describe('U.4 — NOT NULL columns and column defaults', () => {
  it('refuses NULL in five representative required columns', async () => {
    const m = await machine();
    // Prisma rejects a null on a non-nullable column before it reaches SQLite,
    // which is the guarantee that matters to a caller: the write never lands.
    const nulls: Array<[string, () => Promise<unknown>]> = [
      [
        'Booking.email',
        () => booking('pending', { email: null as unknown as string, skipLocks: true }),
      ],
      [
        'Booking.startDate',
        () => db.booking.create({ data: { ...minimalBooking(m.id), startDate: null as unknown as Date } }),
      ],
      [
        'Machine.model',
        () => db.machine.create({ data: { name: 'X', model: null as unknown as string } }),
      ],
      [
        'AppConfig.label',
        () => db.appConfig.create({ data: { key: 'k', value: 'v', label: null as unknown as string, group: 'g' } }),
      ],
      [
        'ChecklistItem.label',
        () => db.checklistItem.create({ data: { phaseId: 'nope', label: null as unknown as string } }),
      ],
    ];

    for (const [label, write] of nulls) {
      await expect(write(), `${label} must refuse NULL`).rejects.toThrow();
    }

    expect(await db.booking.count()).toBe(0);
    expect(await db.appConfig.count()).toBe(0);
    expect(await db.checklistItem.count()).toBe(0);
    expect(await db.machine.count()).toBe(1);
  });

  it('applies the documented defaults when a column is omitted', async () => {
    const m = await machine();
    const before = Date.now();
    const b = await db.booking.create({ data: minimalBooking(m.id) });
    const after = Date.now();

    expect(b.status).toBe('pending');
    expect(b.customerType).toBe('consumer');
    expect(b.selfPickup).toBe(false);
    expect(b.includedHours).toBe(0);
    expect(b.paymentRetries).toBe(0);
    expect(b.checklistData).toBe('{}');
    expect(b.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(b.createdAt.getTime()).toBeLessThanOrEqual(after);
    expect(b.updatedAt.getTime()).toBeGreaterThanOrEqual(before);

    const code = await db.campaignDiscountCode.create({ data: { code: 'X1', percent: 10 } });
    expect(code.usedCount).toBe(0);
    expect(code.isActive).toBe(true);
    expect(code.maxUses).toBeNull();

    const phase = await db.checklistPhase.create({ data: { name: 'Levering' } });
    expect(phase.isActive).toBe(true);
    expect(phase.appliesTo).toBe('all');
    expect(phase.audience).toBe('operator');
    expect(phase.intervalMode).toBe('once');
    expect(phase.isCompletionTrigger).toBe(false);

    const item = await db.checklistItem.create({ data: { phaseId: phase.id, label: 'Rengjort' } });
    expect(item.answerType).toBe('checkbox');
    expect(item.isActive).toBe(true);

    const terms = await db.termsSection.create({ data: { title: 'T', content: 'C' } });
    expect(terms.audience).toBe('consumer');
    expect(terms.isActive).toBe(true);

    const lock = await db.bookingDateLock.create({
      data: { bookingId: b.id, machineId: m.id, date: dateToDbMidnight('2026-06-15') },
    });
    expect(lock.slot).toBe(0);

    const cfg = await db.appConfig.create({ data: { key: 'k', label: 'L', group: 'g' } });
    expect(cfg.value).toBe('');
    expect(cfg.type).toBe('text');
    expect(cfg.isPublic).toBe(false);
    expect(cfg.sortOrder).toBe(0);
  });
});

/** The smallest row `Booking` will accept — every other column has a default. */
function minimalBooking(machineId: string) {
  return {
    reference: `GK-2606-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    name: 'Test Testesen',
    phone: '+4740000000',
    email: 'test@example.com',
    deliveryAddress: 'Testveien 1',
    rentalType: 'day',
    startDate: dateToDbMidnight('2026-06-15'),
    deliveryDistance: 0,
    deliveryFee: 0,
    basePrice: 2490,
    totalPrice: 2490,
    machineId,
  };
}
