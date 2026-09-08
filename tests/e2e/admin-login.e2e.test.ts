/**
 * L4 — the admin authentication perimeter, driven through the real form.
 *
 * Covers the four things `tests/api/admin-auth-routes.test.ts` cannot prove
 * in-process: that the proxy redirect actually fires for a browser navigation
 * and carries `?from=`, that the login form surfaces the 401 message, that a
 * correct password lands on the page named by `from`, and that logging out
 * really invalidates the cookie for the next navigation.
 *
 *   AUDIT_BASE_URL=http://localhost:3001 \
 *   AUDIT_DB_FILE=…/audit.db npx vitest run tests/e2e/admin
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'puppeteer-core';

import {
  ADMIN_PASSWORD, BASE, LIVE, SESSION_COOKIE,
  launchBrowser, loginWithPassword, newPage, seenMark, setInput, sqlValue, waitForApi,
  waitForPath,
} from './admin-helpers';

describe.skipIf(!LIVE)('admin login / logout / proxy redirect (L4)', { timeout: 90_000 }, () => {
  let browser: Browser;

  beforeAll(async () => { browser = await launchBrowser(); }, 60_000);
  afterAll(async () => { await browser?.close(); }, 30_000);

  /**
   * A page with its own cookie jar. Pages opened straight from the browser
   * share one, and a session left behind by a neighbouring test would make the
   * "no session" cases pass for the wrong reason.
   */
  async function isolatedPage() {
    const context = await browser.createBrowserContext();
    const page = await newPage(context);
    return { page, context };
  }

  it('redirects an anonymous /admin navigation to the login form with ?from=', async () => {
    const { page, context } = await isolatedPage();
    try {
      await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
      const url = new URL(page.url());
      expect(url.pathname).toBe('/admin/login');
      expect(url.searchParams.get('from')).toBe('/admin');
      await page.waitForSelector('input[type="password"]');
    } finally {
      await context.close();
    }
  });

  it('carries the originally requested admin path in ?from=', async () => {
    const { page, context } = await isolatedPage();
    try {
      await page.goto(`${BASE}/admin/audit-log`, { waitUntil: 'domcontentloaded' });
      const url = new URL(page.url());
      expect(url.pathname).toBe('/admin/login');
      expect(url.searchParams.get('from')).toBe('/admin/audit-log');
    } finally {
      await context.close();
    }
  });

  it('refuses a wrong password with 401 and shows "Feil passord"', async () => {
    const { page, context } = await isolatedPage();
    try {
      const before = Number(sqlValue("SELECT count(*) FROM AdminAuditLog WHERE action='auth.login_failed'"));
      const res = await loginWithPassword(page, 'definitely-not-the-password');
      expect(res.status).toBe(401);
      await page.waitForFunction(() => document.body.innerText.includes('Feil passord'));
      expect(new URL(page.url()).pathname).toBe('/admin/login');

      const cookies = await page.cookies(BASE);
      expect(cookies.some((c) => c.name === SESSION_COOKIE)).toBe(false);

      const after = Number(sqlValue("SELECT count(*) FROM AdminAuditLog WHERE action='auth.login_failed'"));
      expect(after).toBe(before + 1);
    } finally {
      await context.close();
    }
  });

  it('accepts the right password, honours ?from=, then logout kills the session', async () => {
    const { page, context } = await isolatedPage();
    try {
      // Land on /admin/audit-log via the redirect so ?from= is exercised end to end.
      // Land on /admin/audit-log via the redirect so ?from= is exercised end
      // to end: the form posts, then the page it lands on is the one asked for.
      await page.goto(`${BASE}/admin/audit-log`, { waitUntil: 'domcontentloaded' });
      const mark = seenMark(page);
      let posted: Awaited<ReturnType<typeof waitForApi>> | null = null;
      for (let attempt = 0; attempt < 5 && !posted; attempt++) {
        await setInput(page, 'input[type="password"]', ADMIN_PASSWORD);
        await page.click('button[type="submit"]');
        posted = await waitForApi(page, '/api/admin/login', 'POST', { since: mark, timeoutMs: 5_000 })
          .catch(() => null);
      }
      expect(posted?.status).toBe(200);
      await waitForPath(page, '/admin/audit-log');
      const cookies = await page.cookies(BASE);
      const session = cookies.find((c) => c.name === SESSION_COOKIE);
      expect(session?.httpOnly).toBe(true);

      // The audit trail records the successful login.
      expect(Number(sqlValue("SELECT count(*) FROM AdminAuditLog WHERE action='auth.login'"))).toBeGreaterThan(0);

      // …and an authenticated navigation to /admin no longer bounces.
      await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
      expect(new URL(page.url()).pathname).toBe('/admin');

      // Logout: the header button posts to /api/admin/logout and redirects.
      await page.waitForSelector('[aria-label="Logg ut"], [title="Logg ut"]');
      await page.click('[aria-label="Logg ut"], [title="Logg ut"]');
      // handleLogout awaits POST /api/admin/logout before assigning
      // location.href, so wait for the address the button promises rather than
      // for whichever navigation fires first.
      await waitForPath(page, '/admin/login');

      const after = await page.cookies(BASE);
      const stale = after.find((c) => c.name === SESSION_COOKIE);
      expect(stale?.value ?? '').toBe('');

      // The gate is real, not just a redirect: /admin bounces again.
      await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
      expect(new URL(page.url()).pathname).toBe('/admin/login');
    } finally {
      await context.close();
    }
  });

  it('refuses the admin API with 401 for a browser that has no session', async () => {
    const { page, context } = await isolatedPage();
    try {
      await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
      const status = await page.evaluate(async () => {
        const res = await fetch('/api/admin/app-config', { credentials: 'include' });
        return res.status;
      });
      expect(status).toBe(401);
    } finally {
      await context.close();
    }
  });
});
