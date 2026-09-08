/**
 * L4 — the two whole-site take-overs.
 *
 * `maintenanceMode` replaces the home page with the maintenance notice and
 * `surveyMode` replaces it with the needs survey. Both are global switches on a
 * shared instance, so this file is opt-in: it only runs with
 * AUDIT_ALLOW_CONFIG_FLIP=1 set, and it restores whatever it found — including
 * on failure — before releasing the instance lock.
 *
 *   AUDIT_BASE_URL=… AUDIT_DB_FILE=… AUDIT_ALLOW_CONFIG_FLIP=1 \
 *     npx vitest run tests/e2e/maintenance.e2e.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONFIG_CACHE_MS, E2E_READY, acquireInstanceLock, appConfig, goto, openBrowser, pageText, releaseInstanceLock,
  setAppConfig, sleep,
} from './helpers';

const ENABLED = E2E_READY && process.env.AUDIT_ALLOW_CONFIG_FLIP === '1';

let previousMaintenance = 'false';
let previousSurvey = 'false';

async function restore(): Promise<void> {
  setAppConfig('maintenanceMode', previousMaintenance);
  setAppConfig('surveyMode', previousSurvey);
  await sleep(CONFIG_CACHE_MS);
}

describe.skipIf(!ENABLED)('L4 maintenance and survey take-over', () => {
  beforeAll(async () => {
    await acquireInstanceLock('maintenance');
    previousMaintenance = appConfig('maintenanceMode') ?? 'false';
    previousSurvey = appConfig('surveyMode') ?? 'false';
  }, 900_000);

  afterAll(async () => {
    await restore();
    releaseInstanceLock();
  }, 60_000);

  it('replaces the home page with the maintenance notice, and puts it back', async () => {
    const message = appConfig('maintenanceMessage') ?? '';
    setAppConfig('maintenanceMode', 'true');
    setAppConfig('surveyMode', 'false');
    await sleep(CONFIG_CACHE_MS);

    const session = await openBrowser();
    try {
      const { page } = session;
      await goto(page, '/');
      await sleep(1500);
      const text = await pageText(page);
      if (message.trim()) expect(text).toContain(message.trim().slice(0, 40));
      // The booking funnel is gone, not merely hidden behind an overlay.
      expect(await page.evaluate(() => !!document.querySelector('#booking'))).toBe(false);
      expect(text).not.toContain('Sjekk tilgjengelighet og book');

      setAppConfig('maintenanceMode', 'false');
      await sleep(CONFIG_CACHE_MS);
      await goto(page, '/');
      await sleep(2000);
      expect(await page.evaluate(() => !!document.querySelector('#booking'))).toBe(true);
    } finally {
      await restore();
      await session.close();
    }
  }, 240_000);

  it('replaces the home page with the survey while surveyMode is on', async () => {
    setAppConfig('maintenanceMode', 'false');
    setAppConfig('surveyMode', 'true');
    await sleep(CONFIG_CACHE_MS);

    const session = await openBrowser();
    try {
      const { page } = session;
      await goto(page, '/');
      await sleep(2000);
      const text = await pageText(page);
      expect(text).toMatch(/BEHOVSUNDERSØKELSE|Hjelp oss å forme/);
      expect(await page.evaluate(() => !!document.querySelector('#booking'))).toBe(false);
    } finally {
      await restore();
      await session.close();
    }

    // And the switch is genuinely back off for whoever uses the instance next.
    const session2 = await openBrowser();
    try {
      await goto(session2.page, '/');
      await sleep(2000);
      expect(await session2.page.evaluate(() => !!document.querySelector('#booking'))).toBe(true);
    } finally {
      await session2.close();
    }
  }, 240_000);
});
