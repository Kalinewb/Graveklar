/**
 * L2 — GET /api/admin/audit-log, the `action` filter specifically.
 *
 * The rest of the route (auth, limits, date window, the distinct action list)
 * is covered in tests/api/admin-auth-routes.test.ts; this file exists for
 * finding P-5, which is about what the filter MEANS.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ jar: {} as Record<string, string> }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name in store.jar ? { name, value: store.jar[name] } : undefined),
    getAll: () => Object.entries(store.jar).map(([name, value]) => ({ name, value })),
    has: (name: string) => name in store.jar,
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers(),
}));

import { db, ensureSchema, resetDb } from '../helpers/db';
import { COOKIE_NAME, adminSessionToken, call } from '../helpers/route';

async function auditLog(searchParams: Record<string, string> = {}) {
  const { GET } = await import('@/app/api/admin/audit-log/route');
  return call(GET, { path: '/api/admin/audit-log', searchParams });
}

async function seed(action: string, n: number, actor = 'admin') {
  for (let i = 0; i < n; i++) {
    await db.adminAuditLog.create({
      data: { actor, action, changes: '[]', ip: '203.0.113.1' },
    });
  }
}

beforeAll(() => ensureSchema());

beforeEach(async () => {
  await resetDb();
  store.jar = { [COOKIE_NAME]: await adminSessionToken() };
});

// FIXED P-5: `where.action = { contains: action }` matched by substring, so
// selecting `auth.login` in the dropdown returned `auth.login_failed` rows too
// — 49 rows where 33 were meant, and `total` agreed with the wrong number.
// Every action name that prefixes another was similarly wrong. The dropdown is
// populated from the distinct action list the same route returns, so the value
// is always a whole action name: exact match.
describe('GET /api/admin/audit-log — the action filter', () => {
  it('matches the action exactly, not as a substring', async () => {
    await seed('auth.login', 3);
    await seed('auth.login_failed', 2);

    const res = await auditLog({ action: 'auth.login' });
    expect(res.status).toBe(200);
    expect(res.json.total).toBe(3);
    expect(res.json.rows.map((r: { action: string }) => r.action)).toEqual(['auth.login', 'auth.login', 'auth.login']);
  });

  it('a partial action name matches nothing at all', async () => {
    await seed('auth.login', 3);
    await seed('config.update', 1);

    const res = await auditLog({ action: 'auth' });
    expect(res.json.total).toBe(0);
    expect(res.json.rows).toEqual([]);
  });

  it('every name the dropdown can offer round-trips to its own rows only', async () => {
    await seed('auth.login', 3);
    await seed('auth.login_failed', 2);
    await seed('config.update', 4);

    const all = await auditLog();
    expect(all.json.actions).toEqual(['auth.login', 'auth.login_failed', 'config.update']);

    for (const [action, expected] of [
      ['auth.login', 3],
      ['auth.login_failed', 2],
      ['config.update', 4],
    ] as const) {
      const res = await auditLog({ action });
      expect({ action, total: res.json.total }).toEqual({ action, total: expected });
      expect(res.json.rows.every((r: { action: string }) => r.action === action)).toBe(true);
    }
  });

  it('the actor filter is still a substring search — it is a free-text box, not a dropdown', async () => {
    await seed('config.update', 2, 'admin@example.com');
    await seed('config.update', 1, 'cron');

    const res = await auditLog({ actor: 'admin' });
    expect(res.json.total).toBe(2);
  });
});
