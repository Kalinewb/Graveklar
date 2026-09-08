/**
 * L3i — area U.6: how a DateTime is actually stored, and why the repo rule
 * "never insert a DateTime via the sqlite3 CLI" exists.
 *
 * Prisma's SQLite connector stores every `DateTime` as an **INTEGER** holding
 * epoch milliseconds. A value written by hand as `'2026-06-15'` lands in the
 * same column as TEXT, and SQLite — being dynamically typed — accepts it
 * without a murmur. Every date comparison in this codebase (`gte`, `lte`,
 * `lt` on `startDate`, `paymentDeadline`, `cancelTokenExpiry`, …) then compares
 * a number against a string, which in SQLite's type ordering means the string
 * sorts *after* every integer: an availability query silently stops matching.
 *
 * So: every DateTime column of every populated table is asserted to be an
 * integer, every write is asserted to round-trip to the millisecond, and the
 * counter-example is pinned so the rule is not folklore.
 *
 * `AdminTotp` is deliberately left out of the fixture — the suite never enrols
 * 2FA (`docs/testing.md`, isolation rules).
 */
import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../setup';
import { db, resetDb } from '../helpers/db';
import { expectNoOrphanLocks, sqliteRawInt, sqliteTypeOf } from '../helpers/invariants';
import { dateToDbMidnight, dbDateToStr } from '@/lib/availability';
import {
  AT_LEAP_DAY,
  AT_MIDNIGHT,
  AT_MONTH_END,
  AT_YEAR_END,
  DST_BACK_MIDNIGHT,
  DST_FORWARD_MIDNIGHT,
  MIDNIGHT_DATE,
} from './time-clock';

const SCHEMA = fs.readFileSync(path.join(REPO_ROOT, 'prisma', 'schema.prisma'), 'utf8');

/** Tables the fixture below does not populate, and why. */
const NOT_POPULATED = new Set(['AdminTotp']);

/** model → its DateTime columns, read straight out of schema.prisma. */
function dateTimeColumns(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const modelRe = /^model (\w+) \{$([\s\S]*?)^\}$/gm;
  let m: RegExpExecArray | null;
  while ((m = modelRe.exec(SCHEMA))) {
    const cols = m[2]
      .split('\n')
      .map((line) => /^\s*(\w+)\s+DateTime\b/.exec(line))
      .filter((x): x is RegExpExecArray => x !== null)
      .map((x) => x[1]);
    if (cols.length > 0) out.set(m[1], cols);
  }
  return out;
}

/** Distinct, deliberately awkward instants — DST edges, month/year ends, a leap day. */
const INSTANTS = {
  startDate: dateToDbMidnight(MIDNIGHT_DATE),
  terms: new Date(AT_MIDNIGHT),
  paid: new Date(AT_MONTH_END),
  deadline: new Date(AT_YEAR_END),
  reminder: new Date(AT_LEAP_DAY),
  captured: new Date(DST_FORWARD_MIDNIGHT),
  contractSent: new Date(DST_BACK_MIDNIGHT),
  contractSigned: new Date('2026-10-25T02:59:59.999+02:00'),
  tokenExpiry: new Date('2026-12-31T23:59:59.999+01:00'),
};

/**
 * One row in every table that has a DateTime column, with every *settable*
 * DateTime explicitly filled. `@default(now())` / `@updatedAt` columns are left
 * to Prisma on purpose — they are part of what is being checked.
 */
async function seedEveryDateTime() {
  const machine = await db.machine.create({ data: { name: 'M', model: 'TB216' } });
  const booking = await db.booking.create({
    data: {
      reference: 'GK-2606-DT001',
      name: 'Test Testesen',
      phone: '+4740000000',
      email: 'test@example.com',
      deliveryAddress: 'Testveien 1',
      rentalType: 'day',
      startDate: INSTANTS.startDate,
      deliveryDistance: 0,
      deliveryFee: 0,
      basePrice: 1,
      totalPrice: 1,
      machineId: machine.id,
      termsAcceptedAt: INSTANTS.terms,
      fullyPaidAt: INSTANTS.paid,
      paymentDeadline: INSTANTS.deadline,
      reminderSentAt: INSTANTS.reminder,
      vippsCapturedAt: INSTANTS.captured,
      contractSentAt: INSTANTS.contractSent,
      contractSignedAt: INSTANTS.contractSigned,
      cancelToken: 'cancel-dt',
      cancelTokenExpiry: INSTANTS.tokenExpiry,
    },
  });

  const phase = await db.checklistPhase.create({ data: { name: 'Levering' } });
  await db.checklistItem.create({ data: { phaseId: phase.id, label: 'Rengjort' } });
  await db.checklistSubmission.create({
    data: {
      bookingId: booking.id,
      phaseId: phase.id,
      intervalKey: 'once',
      phone: '+4740000000',
      submittedAt: INSTANTS.terms,
    },
  });
  await db.bookingDateLock.create({
    data: { bookingId: booking.id, machineId: machine.id, date: INSTANTS.startDate },
  });
  await db.unavailableDate.create({ data: { date: dateToDbMidnight('2026-03-29') } });
  await db.machineDocument.create({
    data: { machineId: machine.id, title: 'Manual', fileUrl: '/api/uploads/m.pdf' },
  });
  await db.acceptedContract.create({
    data: {
      bookingId: booking.id,
      renderedHtml: '<p>x</p>',
      termsVersionHash: 'h',
      renderContext: '{}',
      acceptedAt: INSTANTS.terms,
      acceptanceMethod: 'checkbox',
    },
  });
  await db.review.create({
    data: { bookingId: booking.id, token: 'rev-dt', submittedAt: INSTANTS.paid },
  });
  const campaign = await db.campaignDiscountCode.create({
    data: { code: 'DT-CAMP', percent: 10, expiresAt: INSTANTS.deadline },
  });
  await db.campaignRedemption.create({
    data: {
      codeId: campaign.id,
      bookingId: booking.id,
      email: 'test@example.com',
      redeemedAt: INSTANTS.paid,
    },
  });
  const referral = await db.referralCode.create({
    data: { code: 'GRAV-DT01', ownerEmail: 'owner@example.com' },
  });
  await db.referralRedemption.create({
    data: {
      referralCodeId: referral.id,
      referredBookingId: booking.id,
      referredEmail: 'test@example.com',
      redeemedAt: INSTANTS.paid,
    },
  });
  await db.repeatDiscountCode.create({
    data: {
      code: 'RETUR-DT01',
      email: 'test@example.com',
      expiresAt: INSTANTS.deadline,
      redeemedAt: INSTANTS.paid,
    },
  });
  await db.quoteRequest.create({
    data: {
      reference: 'FT-2606-DT1',
      company: 'Test AS',
      orgNumber: '999999999',
      contactName: 'Test',
      email: 'firma@example.com',
      phone: '+4740000000',
      startDate: INSTANTS.startDate,
      offerValidUntil: INSTANTS.deadline,
      acceptTokenExpiry: INSTANTS.tokenExpiry,
      acceptToken: 'accept-dt',
    },
  });
  await db.termsSection.create({ data: { title: 'T', content: 'C' } });
  await db.faqItem.create({ data: { question: 'Q', answer: 'A' } });
  await db.insuranceCard.create({ data: { label: 'L', value: 'V', detail: 'D' } });
  await db.webhookEvent.create({
    data: { provider: 'stripe', eventId: 'evt_dt', processedAt: INSTANTS.paid },
  });
  await db.adminAuditLog.create({ data: { actor: 'admin', action: 'test', changes: '[]' } });
  await db.systemState.create({ data: { key: 'k', value: '{}' } });
  await db.surveyResponse.create({ data: { data: '{}' } });
  await db.surveyQuestion.create({
    data: { key: 'k', type: 'radio', section: 'S', label: 'L' },
  });

  return { booking, machine };
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
  await expectNoOrphanLocks();
});

describe('U.6 — every DateTime is stored as an INTEGER', () => {
  it('holds no DateTime column in any populated table as TEXT or REAL', async () => {
    await seedEveryDateTime();

    const offenders: string[] = [];
    for (const [model, columns] of dateTimeColumns()) {
      if (NOT_POPULATED.has(model)) continue;
      for (const column of columns) {
        const types = await sqliteTypeOf(model, column);
        expect(types.length, `${model} has no rows — the fixture must cover it`).toBeGreaterThan(0);
        for (const t of types) {
          if (t !== 'integer' && t !== 'null') offenders.push(`${model}.${column}=${t}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('covers every model that has a DateTime column', () => {
    // Guard against the fixture silently going stale when a model is added.
    const models = [...dateTimeColumns().keys()].filter((m) => !NOT_POPULATED.has(m));
    expect(models.length).toBeGreaterThanOrEqual(24);
    expect(models).toContain('Booking');
    expect(models).toContain('BookingDateLock');
    expect(models).toContain('ChecklistSubmission');
  });

  it('round-trips every explicitly written instant to the millisecond', async () => {
    const { booking } = await seedEveryDateTime();
    const row = await db.booking.findUniqueOrThrow({ where: { id: booking.id } });

    const pairs: Array<[string, Date | null, Date]> = [
      ['startDate', row.startDate, INSTANTS.startDate],
      ['termsAcceptedAt', row.termsAcceptedAt, INSTANTS.terms],
      ['fullyPaidAt', row.fullyPaidAt, INSTANTS.paid],
      ['paymentDeadline', row.paymentDeadline, INSTANTS.deadline],
      ['reminderSentAt', row.reminderSentAt, INSTANTS.reminder],
      ['vippsCapturedAt', row.vippsCapturedAt, INSTANTS.captured],
      ['contractSentAt', row.contractSentAt, INSTANTS.contractSent],
      ['contractSignedAt', row.contractSignedAt, INSTANTS.contractSigned],
      ['cancelTokenExpiry', row.cancelTokenExpiry, INSTANTS.tokenExpiry],
    ];
    for (const [label, actual, expected] of pairs) {
      expect(actual, label).toBeInstanceOf(Date);
      expect(actual!.getTime(), label).toBe(expected.getTime());
    }

    // The raw integer is epoch milliseconds — not seconds, not a Julian day.
    const raw = await sqliteRawInt('Booking', 'startDate', `id = '${booking.id}'`);
    expect(raw).toBe(INSTANTS.startDate.getTime());
    // …and the millisecond component survives (a `.999` deadline is the whole
    // point of every boundary test in area V).
    const rawDeadline = await sqliteRawInt('Booking', 'paymentDeadline', `id = '${booking.id}'`);
    expect(rawDeadline! % 1000).toBe(999);
  });

  it('keeps a booking date at Oslo local midnight, not UTC midnight', async () => {
    const { booking } = await seedEveryDateTime();
    const row = await db.booking.findUniqueOrThrow({ where: { id: booking.id } });

    expect(dbDateToStr(row.startDate)).toBe(MIDNIGHT_DATE);
    expect(row.startDate.getHours()).toBe(0);
    expect(row.startDate.getMinutes()).toBe(0);
    // Oslo midnight in June is 22:00 UTC the previous day — the exact reason
    // `toISOString().split('T')[0]` is banned (see no-iso-split.test.ts).
    expect(row.startDate.toISOString()).toBe('2026-06-14T22:00:00.000Z');
  });

  it('stores local midnight on both DST-transition days as a real instant', async () => {
    // 2026-03-29 is 23 h long and 2026-10-25 is 25 h long, but midnight exists
    // on both (Oslo shifts at 02:00/03:00), so the storage rule is unaffected.
    for (const day of ['2026-03-29', '2026-10-25']) {
      await db.unavailableDate.create({ data: { date: dateToDbMidnight(day) } });
    }
    const rows = await db.unavailableDate.findMany({ orderBy: { date: 'asc' } });
    expect(rows.map((r) => dbDateToStr(r.date))).toEqual(['2026-03-29', '2026-10-25']);
    expect(await sqliteTypeOf('UnavailableDate', 'date')).toEqual(['integer', 'integer']);
    expect(rows[0].date.toISOString()).toBe('2026-03-28T23:00:00.000Z'); // still CET
    expect(rows[1].date.toISOString()).toBe('2026-10-24T22:00:00.000Z'); // still CEST
  });
});

describe('U.6 — the counter-example the repo rule exists for', () => {
  it('a DateTime written as raw SQL text is accepted by SQLite and is not the date it looks like', async () => {
    await db.unavailableDate.create({ data: { date: dateToDbMidnight('2026-06-15') } });
    // Exactly what a `sqlite3 custom.db "INSERT …"` would produce.
    await db.$executeRawUnsafe(
      `INSERT INTO "UnavailableDate" ("id","date","reason","createdAt") VALUES ('raw-text','2026-06-15','CLI',0)`,
    );

    const types = await sqliteTypeOf('UnavailableDate', 'date');
    expect(types.sort()).toEqual(['integer', 'text']);

    // The date range query every calendar read uses no longer sees it: in
    // SQLite's type ordering every TEXT value sorts after every INTEGER, so a
    // `lte` bound built from a real Date can never match it.
    const june = await db.unavailableDate.findMany({
      where: {
        date: {
          gte: dateToDbMidnight('2026-06-01'),
          lte: new Date('2026-06-30T23:59:59.999+02:00'),
        },
      },
    });
    expect(june).toHaveLength(1);
    expect(june[0].id).not.toBe('raw-text');

    // …while the row is still very much there.
    const all = await db.$queryRawUnsafe<{ n: number | bigint }[]>(
      'SELECT COUNT(*) AS n FROM "UnavailableDate"',
    );
    expect(Number(all[0].n)).toBe(2);
  });
});
