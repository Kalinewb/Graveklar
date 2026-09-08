/**
 * L4 — what the booking form and the payment-return dialog actually SAY.
 *
 * The sibling file (`booking-checkout.e2e.test.ts`) proves the money path
 * works. This one proves the page tells the truth about it: the calendar's
 * reasons, the picker's headline price, the extra-hours cap, the period the
 * summary prints, the terms dialog's read-through hint, and the three
 * post-payment states where the query string and the booking row disagree.
 *
 * Findings covered: Q-1, Q-2, Q-3, Q-7, Q-8, Q-10, Q-11, Q-13.
 *
 * Only one booking is created (for Q-1), and it is deleted in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'puppeteer-core';
import {
  BASE_URL, E2E_READY, acquireInstanceLock, appConfig, auditEmail, clickText, deleteBookingCascade,
  firstFreeStartDate, goto, installWebhookSecret, norwegianDayLabel, openBrowser, pageText, payAndConfirm,
  pickMachineId, queryAll, releaseInstanceLock, setInput, sleep, textOf, createSelfPickupBooking,
} from './helpers';

const EMAIL = auditEmail('checkout-ui');
const created: string[] = [];
let restoreSecret: (() => Promise<void>) | null = null;

const MONTHS = [
  'januar', 'februar', 'mars', 'april', 'mai', 'juni',
  'juli', 'august', 'september', 'oktober', 'november', 'desember',
];

const iso = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** Every date the instance would call unavailable, as YYYY-MM-DD. */
function blockedDates(machineId: string): Set<string> {
  const toIso = (ms: number) => iso(new Date(Number(ms)));
  const locks = queryAll<{ date: number }>('SELECT date FROM BookingDateLock WHERE machineId = ?', machineId);
  const closed = queryAll<{ date: number }>('SELECT date FROM UnavailableDate');
  return new Set([...locks, ...closed].map((r) => toIso(r.date)));
}

/**
 * A Friday that is free for a whole weekend but still inside the
 * `minBookingDaysAhead` window — the case Q-7 mislabels: nothing is booked,
 * the weekend is simply too soon.
 */
function tooSoonFreeWeekend(machineId: string, minAhead: number): { fri: string; sat: string; sun: string } | null {
  const blocked = blockedDates(machineId);
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  for (let i = 1; i < minAhead; i++) {
    const fri = new Date(today);
    fri.setDate(fri.getDate() + i);
    if (fri.getDay() !== 5) continue;
    const span = [0, 1, 2].map((n) => {
      const d = new Date(fri);
      d.setDate(d.getDate() + n);
      return iso(d);
    });
    if (span.some((d) => blocked.has(d))) continue;
    return { fri: span[0], sat: span[1], sun: span[2] };
  }
  return null;
}

/** Page the booking calendar to a given year/month. */
async function showMonth(page: Page, target: string): Promise<void> {
  const [wantYear, wantMonth] = target.split('-').map(Number);
  for (let i = 0; i < 26; i++) {
    const header = await page.evaluate(() => {
      const prev = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Forrige måned');
      return (prev?.parentElement?.innerText || '').replace(/\s+/g, ' ').trim();
    });
    const match = header.match(/([a-zæøå]+)\s+(\d{4})/i);
    if (!match) throw new Error(`no month header in the calendar (got ${JSON.stringify(header)})`);
    const current = MONTHS.indexOf(match[1].toLowerCase()) + 1;
    const currentYear = Number(match[2]);
    if (currentYear === wantYear && current === wantMonth) return;
    const forward = currentYear < wantYear || (currentYear === wantYear && current < wantMonth);
    await page.evaluate((label) => {
      ([...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label) as HTMLElement).click();
    }, forward ? 'Neste måned' : 'Forrige måned');
    await sleep(250);
  }
  throw new Error(`could not page the calendar to ${target}`);
}

/** The calendar day button's accessible name, which carries the reason. */
function dayAria(page: Page, isoDate: string): Promise<string | null> {
  return page.evaluate((prefix) => {
    const b = [...document.querySelectorAll('#booking button')].find((x) =>
      (x.getAttribute('aria-label') || '').startsWith(prefix),
    );
    return b ? b.getAttribute('aria-label') : null;
  }, norwegianDayLabel(isoDate));
}

/** The whole home page with a stripe/vipps return in the query string. */
async function openReturn(query: string): Promise<{ text: string; title: string | null; buttons: string[] }> {
  const session = await openBrowser();
  try {
    const { page } = session;
    await goto(page, `/?${query}`);
    await sleep(2000);
    return await page.evaluate(() => {
      const dialog = document.querySelector('[role=dialog]') as HTMLElement | null;
      return {
        text: (dialog?.innerText || '').replace(/\s+/g, ' ').trim(),
        title: (dialog?.querySelector('h2') as HTMLElement | null)?.innerText.trim() ?? null,
        buttons: dialog ? [...dialog.querySelectorAll('button, a')].map((b) => (b as HTMLElement).innerText.trim()) : [],
      };
    });
  } finally {
    await session.close();
  }
}

describe.skipIf(!E2E_READY)('L4 booking form + payment-return copy', () => {
  beforeAll(async () => {
    await acquireInstanceLock('booking-checkout-ui');
    restoreSecret = await installWebhookSecret();
  }, 900_000);

  afterAll(async () => {
    for (const id of created) deleteBookingCascade(id);
    if (restoreSecret) await restoreSecret();
    releaseInstanceLock();
  }, 60_000);

  it('labels the calendar, the picker, the hours cap and the period honestly', async () => {
    const machineId = pickMachineId();
    const minAhead = Number(appConfig('minBookingDaysAhead') ?? '0');
    const enabled = (appConfig('enabledRentalTypes') || 'day,weekend,week').split(',').map((s) => s.trim());
    const soon = tooSoonFreeWeekend(machineId, minAhead);
    const startDate = firstFreeStartDate(machineId, 'friday', minAhead + 3, 3);
    const session = await openBrowser();

    try {
      const { page } = session;
      await goto(page, '/');
      await sleep(1500);
      await clickText(page, '#booking button', 'Helg');
      await sleep(500);

      // ── FIXED Q-7 ───────────────────────────────────────────────────────
      // A Sat/Sun snaps to its Friday, so a weekend inside the lead-time
      // window is not selectable — but nothing is booked on it. The reason
      // ladder used to collapse that (and the past) into "Opptatt – utstyret
      // er allerede booket", telling the customer the machine was taken when
      // it was free.
      if (soon) {
        await showMonth(page, soon.fri.slice(0, 7));
        const leadTime = `Booking må gjøres minst ${minAhead} dager i forveien`;
        for (const [name, date] of [['fredag', soon.fri], ['lørdag', soon.sat], ['søndag', soon.sun]] as const) {
          const aria = await dayAria(page, date);
          expect(aria, `${name} ${date} is in the calendar`).toBeTruthy();
          expect(aria, `${name} ${date} is free — it must not say "Opptatt"`).not.toContain('Opptatt');
          expect(aria).toContain(leadTime);
        }
      }

      // ── FIXED Q-8 ───────────────────────────────────────────────────────
      // The picker used to headline "… kr fra/dag" for every machine while the
      // døgn rental was switched off and every calendar day answered "Ikke
      // tilgjengelig for denne leietypen".
      await clickText(page, '#booking button', 'Bytt utstyr');
      await sleep(700);
      const picker = await page.evaluate(() =>
        [...document.querySelectorAll('#booking [role=button]')].map((r) => (r as HTMLElement).innerText.replace(/\s+/g, ' ').trim()),
      );
      expect(picker.length, 'the equipment picker is open').toBeGreaterThan(0);
      for (const row of picker) {
        if (!enabled.includes('day')) expect(row, 'no per-day price for a disabled rental type').not.toContain('fra/dag');
        expect(row).toMatch(/fra\/(dag|helg|uke)/);
      }

      // Back into the form on the machine the rest of this test uses.
      await page.evaluate((id) => {
        const rows = [...document.querySelectorAll('#booking [role=button]')] as HTMLElement[];
        (rows[0] as HTMLElement).click();
        return id;
      }, machineId);
      await sleep(800);
      await clickText(page, '#booking button', 'Helg');
      await sleep(400);
      await showMonth(page, startDate.slice(0, 7));
      await page.evaluate((prefix) => {
        const b = [...document.querySelectorAll('#booking button')].find((x) =>
          (x.getAttribute('aria-label') || '').startsWith(prefix),
        ) as HTMLElement;
        b.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
        b.click();
      }, norwegianDayLabel(startDate));
      await sleep(900);

      // ── FIXED Q-11 ──────────────────────────────────────────────────────
      // The cap was rentalDays × 24 = 72 hours for a weekend that the same
      // page describes as "Fre 15:00 – Man 07:00" — 64 elapsed hours. At
      // 300 kr/h that was up to 15 600 kr of hours the rental has no room for.
      await page.evaluate(() => {
        const plus = [...document.querySelectorAll('#booking button')].find(
          (b) => b.getAttribute('aria-label') === 'Flere ekstra timer',
        ) as HTMLButtonElement;
        for (let i = 0; i < 300 && !plus.disabled; i++) plus.click();
      });
      await sleep(1200);

      const schedule = appConfig('weekendSchedule') || 'Fre 15:00 – Man 07:00';
      const clocks = schedule.match(/\d{1,2}[:.]\d{2}/g)!;
      const hhmm = (t: string) => { const [h, m] = t.split(/[:.]/).map(Number); return h + m / 60; };
      const periodHours = Math.floor(3 * 24 + (hhmm(clocks[1]) - hhmm(clocks[0])));

      const form = await textOf(page, '#booking');
      expect(form).toContain(`leieperioden er ${periodHours} timer`);
      expect(form).toContain(schedule);
      const total = form.match(/Totalt antall timer (\d+) timer/);
      expect(total, 'the hours breakdown is on screen').toBeTruthy();
      expect(Number(total![1]), 'included + pre-ordered never exceeds the period').toBe(periodHours);

      // ── FIXED Q-13 ──────────────────────────────────────────────────────
      // The summary said "fredag – søndag" next to a card that said
      // "Fre 15:00 – Man 07:00". The period now ends on the return morning.
      const back = new Date(startDate + 'T00:00:00');
      back.setDate(back.getDate() + 3);
      expect(form, 'the period ends on the return day').toContain(norwegianDayLabel(iso(back)).split(' ').slice(1).join(' '));
      expect(form).toContain(schedule);
    } finally {
      await session.close();
    }
  }, 300_000);

  it('drops the terms dialog scroll hint once the terms have been read', async () => {
    const machineId = pickMachineId();
    const minAhead = Number(appConfig('minBookingDaysAhead') ?? '0');
    const startDate = firstFreeStartDate(machineId, 'friday', minAhead + 3, 3);
    const session = await openBrowser();

    try {
      const { page } = session;
      await goto(page, '/');
      await sleep(1500);
      await clickText(page, '#booking button', 'Helg');
      await sleep(400);
      await showMonth(page, startDate.slice(0, 7));
      await page.evaluate((prefix) => {
        const b = [...document.querySelectorAll('#booking button')].find((x) =>
          (x.getAttribute('aria-label') || '').startsWith(prefix),
        ) as HTMLElement;
        b.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
        b.click();
      }, norwegianDayLabel(startDate));
      await sleep(700);
      await clickText(page, '#booking button', 'Hent selv');
      await sleep(300);
      await setInput(page, '#name', 'Audit 2A Vilkår');
      await setInput(page, '#phone', '41200109');
      await setInput(page, '#email', auditEmail('terms-hint'));
      await sleep(2500);
      await page.evaluate(() => (document.querySelector('#booking button[type=submit]') as HTMLElement).click());
      await sleep(1200);
      await page.evaluate(() => {
        ([...document.querySelectorAll('[role=dialog] [role=checkbox]')][0] as HTMLElement).click();
      });
      await sleep(1000);

      // FIXED Q-10 — the effect that watches the scroll position captured a
      // ref that was still null on the render where `open` flipped to true and
      // never re-ran, so neither the listener nor the ResizeObserver was ever
      // attached and the hint stayed up forever.
      const before = await pageText(page);
      expect(before, 'the hint is shown before the terms are read').toContain('Bla ned for å se godta-knappen');

      const scrolled = await page.evaluate(async () => {
        const root = document.querySelector('[data-testid=terms-scroll]') as HTMLElement | null;
        if (!root) return null;
        root.scrollTop = root.scrollHeight;
        root.dispatchEvent(new Event('scroll'));
        await new Promise((r) => setTimeout(r, 200));
        return { top: root.scrollTop, height: root.scrollHeight, client: root.clientHeight };
      });
      expect(scrolled, 'the terms body is scrollable').toBeTruthy();
      expect(scrolled!.top + scrolled!.client).toBeGreaterThanOrEqual(scrolled!.height - 24);
      await sleep(600);
      expect(await pageText(page)).not.toContain('Bla ned for å se godta-knappen');
    } finally {
      await session.close();
    }
  }, 300_000);

  it('never tells a paid customer the payment was cancelled or the booking expired', async () => {
    const machineId = pickMachineId();
    const minAhead = Number(appConfig('minBookingDaysAhead') ?? '0');
    const startDate = firstFreeStartDate(machineId, 'friday', minAhead + 21, 3);
    const fixture = await createSelfPickupBooking({
      name: 'Audit 2A Paid Return',
      phone: '41200108',
      email: EMAIL,
      rentalType: 'weekend',
      startDate,
      machineId,
    });
    created.push(fixture.id);
    await payAndConfirm(fixture.id);
    await sleep(1200);

    // FIXED Q-1 — pressing Back out of Checkout after paying (or any
    // prefetcher following cancel_url) returns ?stripe=cancelled for a booking
    // that is already confirmed and fully paid. The dialog used to say
    // "Betaling avbrutt … bookingen er ikke bekreftet", and its "Prøv igjen"
    // button then turned the create endpoint's 410 into "Bookingen utløp".
    // The booking row now outranks the query string.
    const cancelled = await openReturn(`stripe=cancelled&ref=${encodeURIComponent(fixture.reference)}`);
    expect(cancelled.title).toBe('Booking bekreftet og betalt!');
    expect(cancelled.text).toContain(fixture.reference);
    expect(cancelled.text).not.toContain('Betaling avbrutt');
    expect(cancelled.text).not.toContain('bookingen er ikke bekreftet');
    expect(cancelled.buttons.join(' ')).not.toContain('Prøv igjen');

    // The same holds for the error branch.
    const errored = await openReturn(`stripe=error&ref=${encodeURIComponent(fixture.reference)}`);
    expect(errored.title).toBe('Booking bekreftet og betalt!');
    expect(errored.text).not.toContain('utløp');
  }, 300_000);

  it('says something useful when the return carries no resolvable booking', async () => {
    // FIXED Q-3 — a success URL whose reference resolves to nothing used to
    // render the full success dialog: "Booking bekreftet og betalt!" and
    // "Betaling og booking () er registrert", an unverified claim with an
    // empty parenthesis where the reference should have been.
    const ghost = await openReturn('stripe=success&ref=GK-0000-000-XXXXX');
    expect(ghost.title).toBe('Vi fant ikke bookingen');
    expect(ghost.text).not.toContain('bekreftet og betalt');
    expect(ghost.text).not.toContain('()');
    expect(ghost.buttons.join(' ')).toContain('Velg datoer på nytt');

    // FIXED Q-2 — five branches of the Stripe callback redirect without a ref.
    // The mount effect only opened the dialog for 'success', so a failed
    // payment landed on the ordinary home page: no dialog, no message, and the
    // query string stripped.
    for (const status of ['cancelled', 'error'] as const) {
      const silent = await openReturn(`stripe=${status}`);
      expect(silent.title, `?stripe=${status} must not be silent`).toBe('Betalingen ble ikke fullført');
      expect(silent.text).toContain('ingen booking er bekreftet');
      expect(silent.buttons.join(' ')).toContain('Velg datoer på nytt');
    }
  }, 300_000);

  it('carries the booking reference out of the Stripe callback failure branches', async () => {
    const id = created[0];
    expect(id, 'the paid-return test must have created a booking').toBeTruthy();
    const reference = created.length
      ? queryAll<{ reference: string }>('SELECT reference FROM Booking WHERE id = ?', id)[0].reference
      : '';

    // FIXED Q-2 (server half) — the outer catch used to redirect to a bare
    // `/?stripe=error`. Every branch below `bid` knows the booking, so every
    // one of them can hand the home page a reference to talk about.
    const res = await fetch(
      `${BASE_URL}/api/payment/stripe/callback?session_id=cs_test_audit2a_bogus&bid=${encodeURIComponent(id)}`,
      { redirect: 'manual' },
    );
    await res.text();
    expect(res.status).toBe(307);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('stripe=error');
    expect(location).toContain(`ref=${encodeURIComponent(reference)}`);

    // No booking id at all is the one case with nothing to carry.
    const bare = await fetch(`${BASE_URL}/api/payment/stripe/callback`, { redirect: 'manual' });
    await bare.text();
    expect(bare.headers.get('location') ?? '').not.toContain('ref=');
  }, 120_000);
});
