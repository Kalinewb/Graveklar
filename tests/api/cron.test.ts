/**
 * L2 — GET /api/cron/cleanup and GET /api/cron/reminders: the two external
 * cron entry points. Both share the same CRON_SECRET bearer gate; reminders
 * additionally has to get "tomorrow" right across a DST transition.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/email', async () => (await import('../helpers/mocks')).mockEmail());

import * as email from '@/lib/email';
import { booking, db, ensureSchema, machine, resetDb, seedConfigDefaults } from '../helpers/db';
import { call, cronBearer } from '../helpers/route';
import { emailMock, mockClock } from '../helpers/mocks';

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDb();
  await seedConfigDefaults();
  await machine({ quantity: 1 });
  emailMock.reset();
});

async function callCleanup(headers: Record<string, string> = {}) {
  const { GET } = await import('@/app/api/cron/cleanup/route');
  return call(GET, { path: '/api/cron/cleanup', headers });
}

async function callReminders(headers: Record<string, string> = {}) {
  const { GET } = await import('@/app/api/cron/reminders/route');
  return call(GET, { path: '/api/cron/reminders', headers });
}

function withoutCronSecret<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  return fn().finally(() => {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  });
}

describe('GET /api/cron/cleanup', () => {
  it('503s when CRON_SECRET is not configured', async () => {
    const res = await withoutCronSecret(() => callCleanup({ authorization: 'Bearer anything' }));
    expect(res.status).toBe(503);
  });

  it('401s on a missing or wrong bearer', async () => {
    expect((await callCleanup()).status).toBe(401);
    expect((await callCleanup({ authorization: 'Bearer wrong-secret' })).status).toBe(401);
  });

  it('200s and actually runs the cleanup sweep with the correct bearer', async () => {
    const clock = mockClock('2026-09-07T09:00:00+02:00');
    try {
      const stale = await booking('pending', { paymentDeadline: new Date(Date.now() - 1), skipLocks: true });
      const res = await callCleanup({ authorization: cronBearer() });
      expect(res.status).toBe(200);
      expect(res.json.cancelled).toBe(1);
      expect((await db.booking.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe('cancelled');
    } finally {
      clock.restore();
    }
  });
});

describe('GET /api/cron/reminders', () => {
  it('503s when CRON_SECRET is not configured', async () => {
    const res = await withoutCronSecret(() => callReminders({ authorization: 'Bearer anything' }));
    expect(res.status).toBe(503);
  });

  it('401s on a missing or wrong bearer', async () => {
    expect((await callReminders()).status).toBe(401);
    expect((await callReminders({ authorization: 'Bearer wrong-secret' })).status).toBe(401);
  });

  it('selects only confirmed bookings starting tomorrow (Oslo local) with reminderSentAt null', async () => {
    const clock = mockClock('2026-09-07T09:00:00+02:00'); // "today" = 2026-09-07 Oslo
    try {
      const dueTomorrow = await booking('confirmed', { startDateStr: '2026-09-08', skipLocks: true });
      await booking('confirmed', { startDateStr: '2026-09-09', skipLocks: true }); // day after tomorrow
      await booking('confirmed', { startDateStr: '2026-09-07', skipLocks: true }); // today, not tomorrow
      await booking('pending', { startDateStr: '2026-09-08', skipLocks: true }); // not confirmed
      const alreadyReminded = await booking('confirmed', {
        startDateStr: '2026-09-08', skipLocks: true, reminderSentAt: new Date(),
      });

      const res = await callReminders({ authorization: cronBearer() });
      expect(res.status).toBe(200);
      expect(res.json.total).toBe(1);
      expect(res.json.sent).toBe(1);

      const sentIds = emailMock.by('sendBookingReminderEmail').map((s) => (s.args[0] as { id: string }).id);
      expect(sentIds).toEqual([dueTomorrow.id]);

      const stamped = await db.booking.findUniqueOrThrow({ where: { id: dueTomorrow.id } });
      expect(stamped.reminderSentAt).toBeInstanceOf(Date);
      void alreadyReminded;
    } finally {
      clock.restore();
    }
  });

  it('gets "tomorrow" right across the spring DST transition (2026-03-29)', async () => {
    const clock = mockClock('2026-03-28T09:00:00+01:00'); // day before the clocks spring forward
    try {
      const b = await booking('confirmed', { startDateStr: '2026-03-29', skipLocks: true });
      const res = await callReminders({ authorization: cronBearer() });
      expect(res.json.total).toBe(1);
      expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).reminderSentAt).toBeInstanceOf(Date);
    } finally {
      clock.restore();
    }
  });

  it('gets "tomorrow" right across the autumn DST transition (2026-10-25)', async () => {
    const clock = mockClock('2026-10-24T09:00:00+02:00'); // day before the clocks fall back
    try {
      const b = await booking('confirmed', { startDateStr: '2026-10-25', skipLocks: true });
      const res = await callReminders({ authorization: cronBearer() });
      expect(res.json.total).toBe(1);
      expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).reminderSentAt).toBeInstanceOf(Date);
    } finally {
      clock.restore();
    }
  });

  it('a send failure does not stamp reminderSentAt, and does not stop the rest of the batch', async () => {
    const clock = mockClock('2026-09-07T09:00:00+02:00');
    try {
      // Created first, so it is queried first (no explicit orderBy in the
      // route — sqlite returns insertion/rowid order) and gets the one-time
      // rejection queued below.
      const doomed = await booking('confirmed', { startDateStr: '2026-09-08', skipLocks: true, phone: '90000001' });
      const ok = await booking('confirmed', { startDateStr: '2026-09-08', skipLocks: true, phone: '90000002' });

      vi.mocked(email.sendBookingReminderEmail).mockRejectedValueOnce(new Error('smtp down'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await callReminders({ authorization: cronBearer() });
      errorSpy.mockRestore();

      expect(res.status).toBe(200);
      expect(res.json.total).toBe(2);
      expect(res.json.sent).toBe(1);

      const doomedRow = await db.booking.findUniqueOrThrow({ where: { id: doomed.id } });
      expect(doomedRow.reminderSentAt).toBeNull();
      const okRow = await db.booking.findUniqueOrThrow({ where: { id: ok.id } });
      expect(okRow.reminderSentAt).toBeInstanceOf(Date);
    } finally {
      clock.restore();
    }
  });
});
