/**
 * /api/unavailable — the admin's manual calendar blocks.
 *
 * Every method sits behind src/proxy.ts (`/api/unavailable` and
 * `/api/unavailable/:path*` are both in the matcher), so the handlers are
 * called directly and the gate is asserted separately.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { booking, db, ensureSchema, machine, resetDb, seedConfigDefaults, unavailableDate } from '../helpers/db';
import { adminCookieJar, call, proxyCall } from '../helpers/route';
import { mockClock } from '../helpers/mocks';
import { dateToDbMidnight } from '@/lib/availability';
import { toDateStr } from '@/lib/dates';

const NOW = '2026-09-07T09:00:00+02:00';

let clock: ReturnType<typeof mockClock>;

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDb();
  clock = mockClock(NOW);
  await seedConfigDefaults();
});

afterEach(() => {
  clock.restore();
});

async function get(searchParams: Record<string, string> = {}) {
  const { GET } = await import('@/app/api/unavailable/route');
  return call(GET, { path: '/api/unavailable', searchParams });
}

async function post(body: unknown) {
  const { POST } = await import('@/app/api/unavailable/route');
  return call(POST, { method: 'POST', path: '/api/unavailable', body });
}

async function del(body: unknown) {
  const { DELETE } = await import('@/app/api/unavailable/route');
  return call(DELETE, { method: 'DELETE', path: '/api/unavailable', body });
}

describe('GET /api/unavailable', () => {
  it('rejects anything that is not YYYY-MM', async () => {
    for (const month of [undefined, '', '2026-6', 'oktober', '2026-10-01']) {
      const res = await get(month === undefined ? {} : { month });
      expect(res.status, `month=${month}`).toBe(400);
      expect(res.json.error).toBe('Ugyldig måned. Bruk format YYYY-MM.');
    }
  });

  it('returns the month’s blocks in date order, and nothing from other months', async () => {
    await unavailableDate('2026-10-20', 'Service');
    await unavailableDate('2026-10-02', 'Ferie');
    await unavailableDate('2026-11-01', 'Neste måned');

    const res = await get({ month: '2026-10' });

    expect(res.status).toBe(200);
    expect(res.json.unavailableDates.map((u: { date: string }) => u.date)).toEqual([
      '2026-10-02',
      '2026-10-20',
    ]);
    expect(res.json.unavailableDates[0]).toMatchObject({ date: '2026-10-02', reason: 'Ferie' });
    expect(res.json.unavailableDates[0].id).toEqual(expect.any(String));
  });
});

describe('POST /api/unavailable', () => {
  it('requires a non-empty dates array', async () => {
    for (const body of [{}, { dates: [] }, { dates: '2026-10-02' }, { dates: null }]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json.error).toBe('Angi minst én dato.');
    }
    expect(await db.unavailableDate.count()).toBe(0);
  });

  it('blocks the well-formed dates and silently drops the rest', async () => {
    const res = await post({
      dates: ['2026-10-02', '2026-10-3', 'i morgen', '', 20261002, null, '2026-10-04'],
      reason: 'Service',
    });

    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(res.json.created.map((c: { date: string }) => c.date)).toEqual(['2026-10-02', '2026-10-04']);
    expect(res.json.skipped).toEqual([]);

    const rows = await db.unavailableDate.findMany({ orderBy: { date: 'asc' } });
    expect(rows.map((r) => toDateStr(r.date))).toEqual(['2026-10-02', '2026-10-04']);
    // Stored as Oslo local midnight, matching dateToDbMidnight everywhere else.
    expect(rows[0].date.getHours()).toBe(0);
    expect(rows.every((r) => r.reason === 'Service')).toBe(true);
  });

  it('refuses to shadow a date a booking already holds, and says which', async () => {
    const m = await machine({ quantity: 1 });
    await booking('confirmed', { machineId: m.id, startDateStr: '2026-10-06', rentalType: 'weekend' });

    const res = await post({ dates: ['2026-10-06', '2026-10-07', '2026-10-09'], reason: 'Service' });

    expect(res.json.skipped).toEqual(['2026-10-06', '2026-10-07']);
    expect(res.json.created.map((c: { date: string }) => c.date)).toEqual(['2026-10-09']);
    expect(await db.unavailableDate.count()).toBe(1);
  });

  it('upserts — re-posting a blocked date replaces its reason', async () => {
    await post({ dates: ['2026-10-02'], reason: 'Service' });
    const res = await post({ dates: ['2026-10-02'], reason: 'Ferie' });

    expect(res.json.created).toHaveLength(1);
    expect(await db.unavailableDate.count()).toBe(1);
    const row = await db.unavailableDate.findFirstOrThrow();
    expect(row.reason).toBe('Ferie');
  });
});

describe('DELETE /api/unavailable', () => {
  it('requires either ids or dates', async () => {
    const res = await del({});
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('Angi ids eller dates for sletting.');
  });

  it('deletes by id', async () => {
    const a = await unavailableDate('2026-10-02');
    const b = await unavailableDate('2026-10-03');

    const res = await del({ ids: [a.id] });

    expect(res.status).toBe(200);
    expect(res.json.deleted).toBe(1);
    expect((await db.unavailableDate.findMany()).map((r) => r.id)).toEqual([b.id]);
  });

  // FIXED C-4: the delete-by-date branch now matches the Oslo local midnight
  // the rows are written at (`dateToDbMidnight`) instead of UTC midnight.
  it('deletes by date string', async () => {
    await unavailableDate('2026-10-02', 'Service');
    expect(
      await db.unavailableDate.count({ where: { date: dateToDbMidnight('2026-10-02') } }),
    ).toBe(1);

    const res = await del({ dates: ['2026-10-02'] });

    expect(res.status).toBe(200);
    expect(await db.unavailableDate.count()).toBe(0);
  });

  // FIXED C-5: `deleted` is now deleteMany's own count, so the admin UI can
  // tell a successful delete from a no-op.
  it('reports how many rows were actually removed', async () => {
    await unavailableDate('2026-10-02');

    const res = await del({ ids: ['nope-1', 'nope-2', 'nope-3'] });

    expect(res.json.deleted).toBe(0);
    expect(await db.unavailableDate.count()).toBe(1);
  });
});

describe('proxy gate for /api/unavailable', () => {
  it('401s every method without an admin session and passes through with one', async () => {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const anonymous = await proxyCall('/api/unavailable', { method });
      expect(anonymous.status, method).toBe(401);
      await expect(anonymous.clone().json()).resolves.toEqual({ error: 'Unauthorized' });

      const authed = await proxyCall('/api/unavailable', { method, cookies: await adminCookieJar() });
      expect(authed.headers.get('x-middleware-next'), method).toBe('1');
    }
  });
});
