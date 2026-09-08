/**
 * L2 — the renter QR kiosk endpoints: POST /api/checklist/lookup,
 * GET /api/checklist/session, POST /api/checklist/submit.
 *
 * All three are public (no admin/proxy gate) and rely on the short-lived
 * renter session bearer token instead. Session-token forgery/expiry itself is
 * exhaustively covered at the unit level in tests/lib/renter-session.test.ts —
 * here we only need one 401 to prove the route actually calls it.
 *
 * Every booking + token is created INSIDE the `mockClock` window under test:
 * `createRenterSessionToken` stamps its 4h expiry off the real clock, so
 * minting a token before freezing time (to some other date) can make it
 * look expired (or not-yet-valid) the moment the frozen clock takes over.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  booking,
  checklistPhase,
  db,
  ensureSchema,
  invalidateCaches,
  resetDb,
  seedConfigDefaults,
} from '../helpers/db';
import { call, renterBearer } from '../helpers/route';
import { mockClock } from '../helpers/mocks';

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDb();
  await seedConfigDefaults();
});

async function lookup(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/checklist/lookup/route');
  return call(POST, { method: 'POST', path: '/api/checklist/lookup', body });
}

async function session(bearer?: string) {
  const { GET } = await import('@/app/api/checklist/session/route');
  return call(GET, {
    path: '/api/checklist/session',
    headers: bearer ? { authorization: bearer } : {},
  });
}

async function submit(bearer: string, body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/checklist/submit/route');
  return call(POST, {
    method: 'POST',
    path: '/api/checklist/submit',
    headers: { authorization: bearer },
    body,
  });
}

// ── POST /api/checklist/lookup ──────────────────────────────────────────────

describe('POST /api/checklist/lookup', () => {
  it('403s when renterChecklistEnabled is off', async () => {
    await db.appConfig.update({ where: { key: 'renterChecklistEnabled' }, data: { value: 'false' } });
    invalidateCaches();
    const res = await lookup({ phone: '99011223' });
    expect(res.status).toBe(403);
  });

  it('400s on a phone that normalises to fewer than 8 digits', async () => {
    for (const phone of ['', '123', '47', '1234567']) {
      const res = await lookup({ phone });
      expect(res.status, phone).toBe(400);
    }
  });

  it('404s when no active booking matches the phone', async () => {
    const res = await lookup({ phone: '99011223' });
    expect(res.status).toBe(404);
  });

  it('normalises phone formatting before matching (spaces, +47 prefix)', async () => {
    const clock = mockClock('2026-09-07T09:00:00+02:00');
    try {
      await booking('confirmed', {
        phone: '+47 990 11 223',
        fullyPaidAt: new Date(),
        startDateStr: '2026-09-07',
        skipLocks: true,
      });
      const res = await lookup({ phone: '990 11 223' });
      expect(res.status).toBe(200);
      expect(res.json.sessionToken).toBeTruthy();
    } finally {
      clock.restore();
    }
  });

  it('returns needsSelection with the booking list when the phone has more than one active booking', async () => {
    const clock = mockClock('2026-09-07T09:00:00+02:00');
    try {
      const b1 = await booking('confirmed', { phone: '99011223', fullyPaidAt: new Date(), startDateStr: '2026-09-07', skipLocks: true });
      const b2 = await booking('confirmed', { phone: '99011223', fullyPaidAt: new Date(), startDateStr: '2026-09-07', skipLocks: true });

      const res = await lookup({ phone: '99011223' });
      expect(res.status).toBe(200);
      expect(res.json.needsSelection).toBe(true);
      expect(res.json.bookings.map((b: { id: string }) => b.id).sort()).toEqual([b1.id, b2.id].sort());
    } finally {
      clock.restore();
    }
  });

  it('picks the chosen booking by id and issues a session when bookingId disambiguates', async () => {
    const clock = mockClock('2026-09-07T09:00:00+02:00');
    try {
      await booking('confirmed', { phone: '99011223', fullyPaidAt: new Date(), startDateStr: '2026-09-07', skipLocks: true });
      const b2 = await booking('confirmed', { phone: '99011223', fullyPaidAt: new Date(), startDateStr: '2026-09-07', skipLocks: true });

      const res = await lookup({ phone: '99011223', bookingId: b2.id });
      expect(res.status).toBe(200);
      expect(res.json.needsSelection).toBe(false);
      expect(res.json.booking.id).toBe(b2.id);
    } finally {
      clock.restore();
    }
  });

  it('400s when the given bookingId does not belong to this phone', async () => {
    const clock = mockClock('2026-09-07T09:00:00+02:00');
    try {
      await booking('confirmed', { phone: '99011223', fullyPaidAt: new Date(), startDateStr: '2026-09-07', skipLocks: true });
      const res = await lookup({ phone: '99011223', bookingId: 'not-a-real-booking-id' });
      expect(res.status).toBe(400);
    } finally {
      clock.restore();
    }
  });

  it('a paid but not-yet-started booking does not count as active', async () => {
    const clock = mockClock('2026-09-07T09:00:00+02:00');
    try {
      await booking('confirmed', { phone: '99011223', fullyPaidAt: new Date(), startDateStr: '2026-09-20', skipLocks: true });
      const res = await lookup({ phone: '99011223' });
      expect(res.status).toBe(404);
    } finally {
      clock.restore();
    }
  });
});

// ── GET /api/checklist/session ──────────────────────────────────────────────

describe('GET /api/checklist/session', () => {
  it('401s on a missing or tampered bearer', async () => {
    expect((await session()).status).toBe(401);
    expect((await session('Bearer not-a-real-token')).status).toBe(401);
  });

  it('403s when the rental is not currently active (booking ended)', async () => {
    const clock = mockClock('2026-09-07T09:00:00+02:00'); // well after the 1-day rental ended
    try {
      const b = await booking('confirmed', {
        phone: '99011223', fullyPaidAt: new Date(), startDateStr: '2026-09-01', rentalType: 'day', skipLocks: true,
      });
      const bearer = await renterBearer(b.id, '99011223');
      const res = await session(bearer);
      expect(res.status).toBe(403);
    } finally {
      clock.restore();
    }
  });

  it('404s when no renter checklist phase is configured', async () => {
    const clock = mockClock('2026-09-07T09:00:00+02:00');
    try {
      const b = await booking('confirmed', { phone: '99011223', fullyPaidAt: new Date(), startDateStr: '2026-09-07', skipLocks: true });
      const bearer = await renterBearer(b.id, '99011223');
      const res = await session(bearer);
      expect(res.status).toBe(404);
    } finally {
      clock.restore();
    }
  });

  it('a renter phase is locked until the operator handover phase is marked __phase_locked_<id>', async () => {
    const clock = mockClock('2026-09-07T09:00:00+02:00');
    try {
      const handover = await checklistPhase({ name: 'Levering', audience: 'operator', appliesTo: 'delivery' });
      await checklistPhase({ name: 'Daglig kontroll', audience: 'renter', intervalMode: 'daily', appliesTo: 'all' });

      const b = await booking('confirmed', {
        phone: '99011223', fullyPaidAt: new Date(), startDateStr: '2026-09-07', selfPickup: false, skipLocks: true,
      });
      const bearer = await renterBearer(b.id, '99011223');

      const locked = await session(bearer);
      expect(locked.status).toBe(200);
      const dailyPhase = locked.json.phases.find((p: { name: string }) => p.name === 'Daglig kontroll');
      expect(dailyPhase.available).toBe(false);
      expect(dailyPhase.lockedReason).toContain('levering');

      await db.booking.update({
        where: { id: b.id },
        data: { checklistData: JSON.stringify({ [`__phase_locked_${handover.id}`]: true }) },
      });

      const unlocked = await session(bearer);
      const dailyAfter = unlocked.json.phases.find((p: { name: string }) => p.name === 'Daglig kontroll');
      expect(dailyAfter.available).toBe(true);
    } finally {
      clock.restore();
    }
  });

  it('a return-mode phase stays locked until the booking\'s end date, even with handover complete', async () => {
    let bookingId = '';
    const midWeek = mockClock('2026-09-10T09:00:00+02:00'); // day 4 of 7
    try {
      const handover = await checklistPhase({ name: 'Selvhenting', audience: 'operator', appliesTo: 'selfPickup' });
      await checklistPhase({ name: 'Laste og sikring', audience: 'split', intervalMode: 'return', appliesTo: 'all' });

      const b = await booking('confirmed', {
        phone: '99011223', fullyPaidAt: new Date(), startDateStr: '2026-09-07', rentalType: 'week',
        selfPickup: true, skipLocks: true,
        checklistData: JSON.stringify({ [`__phase_locked_${handover.id}`]: true }),
      });
      bookingId = b.id;
      const bearer = await renterBearer(b.id, '99011223');

      const res = await session(bearer);
      const laste = res.json.phases.find((p: { name: string }) => p.name === 'Laste og sikring');
      expect(laste.available).toBe(false);
      expect(laste.lockedReason).toContain('retur');
    } finally {
      midWeek.restore();
    }

    // A fresh token, minted under the LATER frozen clock — the session
    // token created above already expired 3h into that same day.
    const endDate = mockClock('2026-09-13T09:00:00+02:00'); // last of the 7 days
    try {
      const bearer = await renterBearer(bookingId, '99011223');
      const res = await session(bearer);
      const laste = res.json.phases.find((p: { name: string }) => p.name === 'Laste og sikring');
      expect(laste.available).toBe(true);
    } finally {
      endDate.restore();
    }
  });
});

// ── POST /api/checklist/submit ───────────────────────────────────────────────

describe('POST /api/checklist/submit', () => {
  async function setupUnlockedRenterPhase(overrides: Record<string, unknown> = {}) {
    const handover = await checklistPhase({ name: 'Levering', audience: 'operator', appliesTo: 'delivery' });
    const renterPhase = await checklistPhase({
      name: 'Daglig kontroll',
      audience: 'renter',
      intervalMode: 'daily',
      appliesTo: 'all',
      items: [
        { label: 'Drivstoffnivå OK', answerType: 'checkbox' },
        { label: 'Skader?', answerType: 'yesno' },
      ],
    });
    const b = await booking('confirmed', {
      phone: '99011223',
      fullyPaidAt: new Date(),
      startDateStr: '2026-09-07',
      selfPickup: false,
      skipLocks: true,
      checklistData: JSON.stringify({ [`__phase_locked_${handover.id}`]: true }),
      ...overrides,
    });
    const bearer = await renterBearer(b.id, '99011223');
    return { handover, renterPhase, booking: b, bearer };
  }

  it('keys are filtered to the submitted phase\'s active item ids — foreign keys are dropped', async () => {
    const clock = mockClock('2026-09-07T09:00:00+02:00');
    try {
      const { renterPhase, bearer } = await setupUnlockedRenterPhase();
      const [item1, item2] = renterPhase.items;
      const res = await submit(bearer, {
        phaseId: renterPhase.id,
        data: { [item1.id]: true, [item2.id]: false, 'not-a-real-item-id': 'sneaky', __locked: true },
      });
      expect(res.status).toBe(200);
      const stored = await db.checklistSubmission.findUniqueOrThrow({ where: { id: res.json.submission.id } });
      const data = JSON.parse(stored.data);
      expect(Object.keys(data).sort()).toEqual([item1.id, item2.id].sort());
      expect(data['not-a-real-item-id']).toBeUndefined();
      expect(data.__locked).toBeUndefined();
    } finally {
      clock.restore();
    }
  });

  it('400s when the submission is not complete (a required active item is missing)', async () => {
    const clock = mockClock('2026-09-07T09:00:00+02:00');
    try {
      const { renterPhase, bearer } = await setupUnlockedRenterPhase();
      const [item1] = renterPhase.items;
      const res = await submit(bearer, { phaseId: renterPhase.id, data: { [item1.id]: true } });
      expect(res.status).toBe(400);
      expect(await db.checklistSubmission.count()).toBe(0);
    } finally {
      clock.restore();
    }
  });

  it('409s on a duplicate submission for the same interval', async () => {
    const clock = mockClock('2026-09-07T09:00:00+02:00');
    try {
      const { renterPhase, bearer } = await setupUnlockedRenterPhase();
      const [item1, item2] = renterPhase.items;
      const data = { [item1.id]: true, [item2.id]: true };
      const first = await submit(bearer, { phaseId: renterPhase.id, data });
      expect(first.status).toBe(200);
      const second = await submit(bearer, { phaseId: renterPhase.id, data });
      expect(second.status).toBe(409);
      expect(await db.checklistSubmission.count()).toBe(1);
    } finally {
      clock.restore();
    }
  });

  it('recomputes the intervalKey server-side as day-YYYY-MM-DD for a daily phase', async () => {
    const clock = mockClock('2026-09-08T15:00:00+02:00'); // day 2 of the rental
    try {
      const { renterPhase, bearer } = await setupUnlockedRenterPhase({ rentalType: 'weekend' });
      const [item1, item2] = renterPhase.items;
      const res = await submit(bearer, { phaseId: renterPhase.id, data: { [item1.id]: true, [item2.id]: false } });
      expect(res.status).toBe(200);
      expect(res.json.submission.intervalKey).toBe('day-2026-09-08');
    } finally {
      clock.restore();
    }
  });

  it('recomputes intervalKey as "once" for a once-mode phase', async () => {
    const clock = mockClock('2026-09-07T09:00:00+02:00');
    try {
      const handover = await checklistPhase({ name: 'Levering', audience: 'operator', appliesTo: 'delivery' });
      const renterPhase = await checklistPhase({
        name: 'Engangskontroll', audience: 'renter', intervalMode: 'once', appliesTo: 'all',
        items: [{ label: 'OK', answerType: 'checkbox' }],
      });
      const b = await booking('confirmed', {
        phone: '99011223', fullyPaidAt: new Date(), startDateStr: '2026-09-07', selfPickup: false, skipLocks: true,
        checklistData: JSON.stringify({ [`__phase_locked_${handover.id}`]: true }),
      });
      const bearer = await renterBearer(b.id, '99011223');
      const res = await submit(bearer, { phaseId: renterPhase.id, data: { [renterPhase.items[0]!.id]: true } });
      expect(res.json.submission.intervalKey).toBe('once');
    } finally {
      clock.restore();
    }
  });

  it('recomputes intervalKey as "return" for a return-mode phase, only once the end date is reached', async () => {
    const clock = mockClock('2026-09-07T09:00:00+02:00'); // day rental → same day is the end date
    try {
      const handover = await checklistPhase({ name: 'Selvhenting', audience: 'operator', appliesTo: 'selfPickup' });
      const renterPhase = await checklistPhase({
        name: 'Laste og sikring', audience: 'split', intervalMode: 'return', appliesTo: 'all',
        items: [{ label: 'Sikret', answerType: 'checkbox' }],
      });
      const b = await booking('confirmed', {
        phone: '99011223', fullyPaidAt: new Date(), startDateStr: '2026-09-07', rentalType: 'day', selfPickup: true,
        skipLocks: true,
        checklistData: JSON.stringify({ [`__phase_locked_${handover.id}`]: true }),
      });
      const bearer = await renterBearer(b.id, '99011223');
      const res = await submit(bearer, { phaseId: renterPhase.id, data: { [renterPhase.items[0]!.id]: true } });
      expect(res.status).toBe(200);
      expect(res.json.submission.intervalKey).toBe('return');
    } finally {
      clock.restore();
    }
  });

  it('recomputes intervalKey as h<n> for an hours-mode phase, anchored at 07:00 on the start date', async () => {
    // 07:00 (start) + 17h = 2026-09-08T00:00 → slot floor(17/8) = 2.
    const clock = mockClock('2026-09-08T00:00:00+02:00');
    try {
      const handover = await checklistPhase({ name: 'Levering', audience: 'operator', appliesTo: 'delivery' });
      const renterPhase = await checklistPhase({
        name: 'Timekontroll', audience: 'renter', intervalMode: 'hours', intervalHours: 8, appliesTo: 'all',
        items: [{ label: 'OK', answerType: 'checkbox' }],
      });
      const b = await booking('confirmed', {
        phone: '99011223', fullyPaidAt: new Date(), startDateStr: '2026-09-07', rentalType: 'weekend', selfPickup: false,
        skipLocks: true,
        checklistData: JSON.stringify({ [`__phase_locked_${handover.id}`]: true }),
      });
      const bearer = await renterBearer(b.id, '99011223');
      const res = await submit(bearer, { phaseId: renterPhase.id, data: { [renterPhase.items[0]!.id]: true } });
      expect(res.json.submission.intervalKey).toBe('h2');
    } finally {
      clock.restore();
    }
  });

  it('403s a submission for a phase still locked behind the operator handover', async () => {
    const clock = mockClock('2026-09-07T09:00:00+02:00');
    try {
      const { renterPhase, bearer } = await setupUnlockedRenterPhase({ checklistData: '{}' });
      const res = await submit(bearer, { phaseId: renterPhase.id, data: { [renterPhase.items[0]!.id]: true } });
      expect(res.status).toBe(403);
    } finally {
      clock.restore();
    }
  });

  it('rejects a phaseId that does not belong to the renter audience', async () => {
    const clock = mockClock('2026-09-07T09:00:00+02:00');
    try {
      const operatorOnly = await checklistPhase({ name: 'Klargjøring', audience: 'operator' });
      const b = await booking('confirmed', { phone: '99011223', fullyPaidAt: new Date(), startDateStr: '2026-09-07', skipLocks: true });
      const bearer = await renterBearer(b.id, '99011223');
      const res = await submit(bearer, { phaseId: operatorOnly.id, data: { x: true } });
      expect(res.status).toBe(400);
    } finally {
      clock.restore();
    }
  });
});
