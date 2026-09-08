/**
 * L4 — the renter's QR checklist at /sjekkliste.
 *
 * Phone lookup → (booking pick) → phase → photo upload → submit. The fixture is
 * a confirmed, paid rental that is active TODAY: `minBookingDaysAhead` and
 * `weekStartDay` are moved for the length of the create call and put back, so
 * the booking is made through the product's own endpoint on any weekday.
 *
 * The renter phases are gated on the operator having locked the handover phase,
 * which is a flag inside `Booking.checklistData` (a JSON text column) — the test
 * sets it directly rather than driving the admin UI, which is another agent's
 * surface.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  E2E_READY, acquireInstanceLock, appConfig, auditEmail, clickText, createSelfPickupBooking, deleteBookingCascade,
  exec, goto, installWebhookSecret, openBrowser, pageText, payAndConfirm, pickMachineId, queryAll, queryOne,
  releaseInstanceLock, setAppConfig, sleep, CONFIG_CACHE_MS,
} from './helpers';

const EMAIL = auditEmail('checklist');
const PHONE = '41200301';
const created: string[] = [];
const uploadedFiles: string[] = [];
let restoreSecret: (() => Promise<void>) | null = null;
let bookingId = '';
let reference = '';
let photoPath = '';

/** A tiny, valid 8×8 PNG — the upload route sniffs magic bytes, not the name. */
function writeTestPng(): string {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=',
    'base64',
  );
  const file = path.join(os.tmpdir(), `audit2a-checklist-${Date.now()}.png`);
  fs.writeFileSync(file, png);
  return file;
}

/** Today as YYYY-MM-DD in the process timezone (the app pins Europe/Oslo). */
function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** ISO weekday the way the booking rules count it (Mon=1 … Sun=7). */
function isoDow(): number {
  const d = new Date().getDay();
  return d === 0 ? 7 : d;
}

describe.skipIf(!E2E_READY)('L4 renter QR checklist', () => {
  beforeAll(async () => {
    await acquireInstanceLock('checklist');
    restoreSecret = await installWebhookSecret();
    photoPath = writeTestPng();

    const prevMinAhead = appConfig('minBookingDaysAhead') ?? '0';
    const prevWeekStart = appConfig('weekStartDay') ?? '1';
    setAppConfig('minBookingDaysAhead', '0');
    setAppConfig('weekStartDay', String(isoDow()));
    await sleep(CONFIG_CACHE_MS);
    try {
      const booking = await createSelfPickupBooking({
        name: 'Audit 2A Sjekkliste',
        phone: PHONE,
        email: EMAIL,
        rentalType: 'week',
        startDate: todayStr(),
        machineId: pickMachineId(),
      });
      bookingId = booking.id;
      reference = booking.reference;
      created.push(booking.id);
    } finally {
      setAppConfig('minBookingDaysAhead', prevMinAhead);
      setAppConfig('weekStartDay', prevWeekStart);
      await sleep(CONFIG_CACHE_MS);
    }

    await payAndConfirm(bookingId);
    await sleep(1200);

    // Unlock the renter phases: mark the operator handover phase as locked.
    const handover = queryAll<{ id: string; name: string }>(
      "SELECT id, name FROM ChecklistPhase WHERE isActive = 1 AND audience = 'operator' ORDER BY sortOrder",
    ).find((p) => /lever|utlever|delivery|selvhent|hent/i.test(p.name));
    expect(handover, 'the instance needs an operator handover phase').toBeTruthy();
    exec('UPDATE Booking SET checklistData = ? WHERE id = ?',
      JSON.stringify({ [`__phase_locked_${handover!.id}`]: true }), bookingId);
  }, 900_000);

  afterAll(async () => {
    for (const f of uploadedFiles) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* already gone */
      }
    }
    try {
      if (photoPath) fs.unlinkSync(photoPath);
    } catch {
      /* already gone */
    }
    for (const id of created) deleteBookingCascade(id);
    if (restoreSecret) await restoreSecret();
    releaseInstanceLock();
  }, 60_000);

  it('refuses a phone number with no active rental', async () => {
    const session = await openBrowser();
    try {
      const { page } = session;
      await goto(page, '/sjekkliste');
      await sleep(1500);
      await page.type('input[type=tel]', '99900011', { delay: 15 });
      await clickText(page, 'button', 'Finn min booking');
      await sleep(2500);
      const text = await pageText(page);
      expect(text).toContain('Ingen aktiv booking funnet for dette telefonnummeret');
      expect(text).not.toContain(reference);
    } finally {
      await session.close();
    }
  }, 180_000);

  it('finds the active rental, uploads a photo and submits the phase', async () => {
    const before = queryOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM ChecklistSubmission WHERE bookingId = ?', bookingId,
    )!.n;

    const session = await openBrowser();
    try {
      const { page } = session;
      await goto(page, '/sjekkliste');
      await sleep(1500);
      await page.type('input[type=tel]', PHONE, { delay: 15 });
      await clickText(page, 'button', 'Finn min booking');
      await page.waitForFunction((ref) => document.body.innerText.includes(ref), { timeout: 30_000 }, reference);

      const found = await pageText(page);
      expect(found).toContain(reference);
      expect(found).toContain('Audit 2A Sjekkliste');

      // The phase tabs are the only buttons that navigate; everything else in
      // the panel is a checklist item. Name them so the "tick the items" step
      // below cannot click a tab and lose the phase.
      const phaseNames = queryAll<{ name: string }>('SELECT name FROM ChecklistPhase WHERE isActive = 1')
        .map((p) => p.name);
      const phase = await page.evaluate((names: string[]) => {
        const btn = [...document.querySelectorAll('button')].find((b) => names.includes(b.innerText.trim()));
        if (btn) btn.click();
        return btn ? btn.innerText.trim() : null;
      }, phaseNames);
      expect(phase, 'a renter phase tab should be offered').toBeTruthy();
      await sleep(1200);

      // Submit is locked until every required item is answered.
      const locked = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => /Send inn sjekkliste/.test(x.innerText));
        return b ? (b as HTMLButtonElement).disabled : null;
      });
      expect(locked, 'submit starts disabled').toBe(true);

      const fileInput = await page.$('input[type=file]');
      expect(fileInput, 'the phase should ask for at least one photo').toBeTruthy();
      await fileInput!.uploadFile(photoPath);
      await page.waitForFunction(() => /1\/1 bilde|✓/.test(document.body.innerText), { timeout: 40_000 });

      // Tick whatever checkbox items are left — never a phase tab.
      await page.evaluate((names: string[]) => {
        const nav = /Send inn sjekkliste|Finn min booking|Legg til|Ta bilde|Logg ut|Avbryt/;
        [...document.querySelectorAll('button')]
          .filter((b) => {
            const t = b.innerText.trim();
            return t.length > 3 && !nav.test(t) && !names.includes(t);
          })
          .forEach((b) => (b as HTMLElement).click());
      }, phaseNames);
      await page.waitForFunction(
        () => {
          const b = [...document.querySelectorAll('button')].find((x) => /Send inn sjekkliste/.test(x.innerText));
          return !!b && !(b as HTMLButtonElement).disabled;
        },
        { timeout: 30_000 },
      );

      await clickText(page, 'button', 'Send inn sjekkliste');
      await sleep(3500);
    } finally {
      await session.close();
    }

    const rows = queryAll<{ id: string; phaseId: string; intervalKey: string; phone: string; data: string }>(
      'SELECT id, phaseId, intervalKey, phone, data FROM ChecklistSubmission WHERE bookingId = ?', bookingId,
    );
    expect(rows.length).toBe(before + 1);
    const row = rows[rows.length - 1];
    expect(row.phone).toBe(PHONE);
    expect(row.intervalKey).toContain(todayStr());

    const answers = JSON.parse(row.data) as Record<string, unknown>;
    const photos = Object.values(answers).flatMap((v) => (Array.isArray(v) ? v : [v])).filter(
      (v): v is string => typeof v === 'string' && v.startsWith('/api/uploads/'),
    );
    expect(photos.length, 'the photo item stores an upload URL').toBeGreaterThan(0);
    for (const url of photos) {
      expect(url).toMatch(new RegExp(`^/api/uploads/renter-${bookingId}-[0-9a-f]+\\.png$`));
      uploadedFiles.push(path.join(path.dirname(process.env.AUDIT_DB_FILE!), 'uploads', path.basename(url)));
    }
  }, 300_000);
});
