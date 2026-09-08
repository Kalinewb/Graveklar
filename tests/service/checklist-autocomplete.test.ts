/**
 * L3 — src/lib/booking-service.ts maybeAutoCompleteOnReturDone, driven the way
 * production actually reaches it: PATCH /api/bookings/[id] { action:
 * 'checklist' }. Fires exactly once when every active item of the
 * completion-trigger phase is filled, never on a cancelled booking, never
 * twice, and the resulting completed-transition issues the repeat-discount
 * code + review request the same way any other completion does.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/email', async () => (await import('../helpers/mocks')).mockEmail());

import { booking, checklistPhase, db, ensureSchema, resetDb, seedConfigDefaults } from '../helpers/db';
import { call, type RouteHandler } from '../helpers/route';
import { emailMock } from '../helpers/mocks';

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDb();
  await seedConfigDefaults();
  emailMock.reset();
});

async function patchChecklist(id: string, checklistData: Record<string, unknown>) {
  const { PATCH } = await import('@/app/api/bookings/[id]/route');
  return call(PATCH as unknown as RouteHandler, {
    method: 'PATCH',
    path: `/api/bookings/${id}`,
    params: { id },
    body: { action: 'checklist', checklistData: JSON.stringify(checklistData) },
  });
}

/** Let the fire-and-forget review-request microtask chain settle. */
async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
}

async function setupReturPhase() {
  const retur = await checklistPhase({
    name: 'Retur',
    audience: 'operator',
    isCompletionTrigger: true,
    items: [
      { label: 'Maskin rengjort', answerType: 'checkbox' },
      { label: 'Skader ved retur?', answerType: 'yesno' },
    ],
  });
  const b = await booking('confirmed', { skipLocks: true, fullyPaidAt: new Date() });
  return { retur, booking: b };
}

describe('maybeAutoCompleteOnReturDone via PATCH /api/bookings/[id] {action: checklist}', () => {
  it('does NOT auto-complete while an active retur item is still unfilled', async () => {
    const { retur, booking: b } = await setupReturPhase();
    const [item1] = retur.items;

    const res = await patchChecklist(b.id, { [item1.id]: true }); // second item missing
    expect(res.status).toBe(200);
    expect(res.json.autoCompleted).toBe(false);
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('confirmed');
  });

  it('auto-completes once every active retur item is filled — yesno false counts as answered', async () => {
    const { retur, booking: b } = await setupReturPhase();
    const [item1, item2] = retur.items;

    const res = await patchChecklist(b.id, { [item1.id]: true, [item2.id]: false });
    expect(res.status).toBe(200);
    expect(res.json.autoCompleted).toBe(true);
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('completed');
  });

  it('never fires on a cancelled booking, even with every retur item filled', async () => {
    const retur = await checklistPhase({
      name: 'Retur', audience: 'operator', isCompletionTrigger: true,
      items: [{ label: 'OK', answerType: 'checkbox' }],
    });
    const b = await booking('cancelled', { skipLocks: true });

    const res = await patchChecklist(b.id, { [retur.items[0].id]: true });
    expect(res.status).toBe(200);
    expect(res.json.autoCompleted).toBe(false);
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('cancelled');
  });

  it('does not fire a second time once already completed (idempotent)', async () => {
    const { retur, booking: b } = await setupReturPhase();
    const [item1, item2] = retur.items;

    const first = await patchChecklist(b.id, { [item1.id]: true, [item2.id]: false });
    expect(first.json.autoCompleted).toBe(true);

    // Re-saving the (already complete) checklist must not re-trigger.
    const second = await patchChecklist(b.id, { [item1.id]: true, [item2.id]: true });
    expect(second.json.autoCompleted).toBe(false);
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('completed');
  });

  it('a completion-trigger phase with no items never auto-completes', async () => {
    const retur = await checklistPhase({ name: 'Retur', audience: 'operator', isCompletionTrigger: true, items: [] });
    const b = await booking('confirmed', { skipLocks: true });
    const res = await patchChecklist(b.id, {});
    expect(res.json.autoCompleted).toBe(false);
    void retur;
  });

  it('inactive retur items are ignored — completion only requires the active ones', async () => {
    const retur = await checklistPhase({
      name: 'Retur', audience: 'operator', isCompletionTrigger: true,
      items: [
        { label: 'Aktiv', answerType: 'checkbox' },
        { label: 'Avviklet punkt', answerType: 'checkbox', isActive: false },
      ],
    });
    const b = await booking('confirmed', { skipLocks: true, fullyPaidAt: new Date() });
    const [active] = retur.items;

    const res = await patchChecklist(b.id, { [active.id]: true });
    expect(res.json.autoCompleted).toBe(true);
  });

  it('the completion transition issues the repeat-discount code and a review request', async () => {
    const { retur, booking: b } = await setupReturPhase();
    const [item1, item2] = retur.items;

    const res = await patchChecklist(b.id, { [item1.id]: true, [item2.id]: true });
    expect(res.json.autoCompleted).toBe(true);
    await flush();

    expect(await db.repeatDiscountCode.count({ where: { issuedForBookingId: b.id } })).toBe(1);
    expect(emailMock.by('sendRepeatDiscountEmail')).toHaveLength(1);

    expect(await db.review.count({ where: { bookingId: b.id } })).toBe(1);
    expect(emailMock.by('sendReviewRequestEmail')).toHaveLength(1);
  });
});
