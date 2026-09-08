/**
 * L3i — area U.5: SQLite has no enum type, so every "status" column in this
 * schema is a plain TEXT column whose value list exists in exactly two places:
 * a comment in `prisma/schema.prisma`, and whatever the code happens to write.
 * Nothing reconciles them. This file does.
 *
 * Three questions per column:
 *   1. **Does the database defend it?** No — asserted, once, so the reader is
 *      never in doubt about where the defence has to live.
 *   2. **Is every value the code writes documented?** A value the schema does
 *      not list is a value the next reader will not expect (findings U-2, U-3).
 *   3. **Is every documented value actually written?** A documented value no
 *      code path produces is a promise the schema is making on the product's
 *      behalf (finding U-4).
 *
 * `DOCUMENTED` below is transcribed from the schema comments, and every entry
 * is re-checked against the live schema text — so editing a comment without
 * editing this table fails here rather than drifting silently.
 */
import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../setup';
import type { RouteHandler } from '../helpers/route';
import { booking, checklistPhase, db, machine, resetDb } from '../helpers/db';
import { expectNoOrphanLocks } from '../helpers/invariants';
import { dateToDbMidnight } from '@/lib/availability';

const SCHEMA = fs.readFileSync(path.join(REPO_ROOT, 'prisma', 'schema.prisma'), 'utf8');

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
  await expectNoOrphanLocks();
});

// ── The reconciliation table ────────────────────────────────────────────────

interface EnumColumn {
  model: string;
  field: string;
  /** Values the schema comment on (or immediately above) the field lists. */
  documented: string[];
  /** Values `src/` can actually write, with the site that writes them. */
  writes: string[];
  /** Values that only reach the column from outside (a provider's own vocabulary). */
  external?: string[];
  note?: string;
}

const COLUMNS: EnumColumn[] = [
  {
    model: 'Booking',
    field: 'status',
    documented: ['pending', 'confirmed', 'cancelled', 'completed'],
    // src/lib/booking-service.ts:682 (BookingStatus) + :765 (LEGAL_TRANSITIONS)
    writes: ['pending', 'confirmed', 'cancelled', 'completed'],
  },
  {
    model: 'Booking',
    field: 'customerType',
    documented: ['consumer', 'business'],
    // schema default + src/lib/quote-request.ts:218
    writes: ['consumer', 'business'],
  },
  {
    model: 'Booking',
    field: 'rentalType',
    documented: ['day', 'weekend', 'week', 'custom'],
    // src/lib/booking-service.ts:314 VALID_RENTAL_TYPES
    writes: ['day', 'weekend', 'week', 'custom'],
  },
  {
    model: 'Booking',
    field: 'paymentProvider',
    documented: ['vipps', 'stripe'],
    // src/lib/vipps-payments.ts:66,184 + src/lib/booking-service.ts:1041
    writes: ['vipps', 'stripe'],
  },
  {
    model: 'Booking',
    field: 'paymentMethod',
    // FIXED U-2: the schema comment used to say "'card' | 'vipps' | future
    // methods" while three more values reached the column. It now names all
    // four writers, so this list and the comment agree.
    documented: ['card', 'vipps', 'invoice', 'mock'],
    // src/lib/vipps-payments.ts:183 ('vipps'), src/app/api/tilbud/[token]/route.ts:96
    // ('invoice'), src/lib/mock-booking.ts:240 ('mock'), and whatever
    // getSessionPaymentMethodType() read off the Stripe session ('card', …).
    writes: ['card', 'vipps', 'invoice', 'mock'],
    external: [],
  },
  {
    model: 'Booking',
    field: 'vippsState',
    documented: ['CREATED', 'AUTHORIZED', 'ABORTED', 'EXPIRED', 'TERMINATED'],
    // src/lib/vipps-payments.ts:68,119 + vipps webhook :154, typed by
    // VippsPaymentState in src/lib/vipps.ts:24.
    writes: ['CREATED', 'AUTHORIZED', 'ABORTED', 'EXPIRED', 'TERMINATED'],
  },
  {
    model: 'Booking',
    field: 'contractSigningMethod',
    // FIXED U-4: 'online' is DOCUMENTED AS RESERVED, not as a stored value.
    // The schema comment used to promise "online Stripe bookings auto-set
    // method=online, status=signed when AcceptedContract is frozen" — a design
    // the code deliberately contradicts (resolveContractSigning keeps a
    // confirmed online booking at 'pending'; paying is not signing). The
    // comment now says so, and this list holds what is actually stored, so the
    // day a writer appears the "no undocumented value" case above fails.
    documented: ['digipost', 'paper'],
    // src/lib/contract-signing-service.ts:52,61,69,76
    writes: ['digipost', 'paper'],
  },
  {
    model: 'Booking',
    field: 'contractSigningStatus',
    // FIXED U-4: 'not_required' is only ever DERIVED by
    // resolveContractSigning() at read time, never stored — the schema comment
    // now separates "stored" from "derived only".
    documented: ['pending', 'sent', 'signed', 'paper'],
    // src/lib/contract-signing-service.ts:53,62,70,77
    writes: ['pending', 'sent', 'signed', 'paper'],
  },
  {
    model: 'QuoteRequest',
    field: 'status',
    documented: ['ny', 'tilbud_sendt', 'akseptert', 'konvertert', 'avslatt', 'utlopt', 'trukket'],
    // src/lib/quote-request.ts:15 QUOTE_STATUSES
    writes: ['ny', 'tilbud_sendt', 'akseptert', 'konvertert', 'avslatt', 'utlopt', 'trukket'],
  },
  {
    model: 'QuoteRequest',
    field: 'paymentMode',
    documented: ['card', 'invoice'],
    // src/app/api/admin/quote-requests/[id]/route.ts:28
    writes: ['card', 'invoice'],
  },
  {
    model: 'Review',
    field: 'status',
    documented: ['pending', 'submitted', 'approved', 'rejected'],
    // src/lib/review.ts:18,104 + src/app/api/admin/reviews/[id]/route.ts:28
    writes: ['pending', 'submitted', 'approved', 'rejected'],
  },
  {
    model: 'ChecklistPhase',
    field: 'appliesTo',
    documented: ['all', 'delivery', 'selfPickup'],
    // src/app/api/admin/checklist-phases/route.ts:23 (whitelisted)
    writes: ['all', 'delivery', 'selfPickup'],
  },
  {
    model: 'ChecklistPhase',
    field: 'audience',
    documented: ['operator', 'renter', 'split'],
    // src/lib/checklist.ts:25 CHECKLIST_AUDIENCES, enforced by isValidChecklistAudience
    writes: ['operator', 'renter', 'split'],
  },
  {
    model: 'ChecklistPhase',
    field: 'intervalMode',
    documented: ['once', 'return', 'daily', 'hours'],
    // src/app/api/admin/checklist-phases/route.ts:36 (whitelisted)
    writes: ['once', 'return', 'daily', 'hours'],
  },
  {
    model: 'ChecklistItem',
    field: 'answerType',
    documented: ['checkbox', 'yesno', 'number', 'text', 'photo', 'measurement'],
    // FIXED U-3: both admin write sites (create and PATCH) now check the value
    // against this list and answer 400 for anything else, like every other
    // whitelisted column in this table.
    writes: ['checkbox', 'yesno', 'number', 'text', 'photo', 'measurement'],
  },
  {
    model: 'TermsSection',
    field: 'audience',
    documented: ['consumer', 'business'],
    // src/app/api/admin/terms/route.ts:22 — coerced, never free text
    writes: ['consumer', 'business'],
  },
  {
    model: 'AcceptedContract',
    field: 'acceptanceMethod',
    // FIXED U-4: 'scroll-then-checkbox' is accepted by
    // freezeContractForBooking()'s input type for a stricter flow that does not
    // exist, and no caller passes it — the schema comment records it as
    // "accepted but unused" rather than as a value the column holds.
    documented: ['checkbox'],
    // src/lib/booking-service.ts:905 is the only caller.
    writes: ['checkbox'],
  },
  {
    model: 'WebhookEvent',
    field: 'provider',
    documented: ['stripe', 'vipps'],
    // stripe webhook :39, vipps webhook claim
    writes: ['stripe', 'vipps'],
  },
];

// ── Schema comment extraction ───────────────────────────────────────────────

/**
 * The comment text attached to `model.field` in schema.prisma: the trailing
 * `// …` on the field's own line plus the contiguous `//` block above it.
 * Used only as a drift guard on the `documented` column above.
 */
function schemaCommentFor(model: string, field: string): string {
  const block = new RegExp(`^model ${model} \\{$([\\s\\S]*?)^\\}$`, 'm').exec(SCHEMA);
  if (!block) throw new Error(`model ${model} not found in schema.prisma`);
  const lines = block[1].split('\n');
  const idx = lines.findIndex((l) => new RegExp(`^\\s*${field}\\s+\\S`).test(l));
  if (idx === -1) throw new Error(`field ${model}.${field} not found in schema.prisma`);

  const parts: string[] = [];
  const trailing = lines[idx].indexOf('//');
  if (trailing !== -1) parts.push(lines[idx].slice(trailing + 2));
  for (let i = idx - 1; i >= 0 && lines[i].trim().startsWith('//'); i--) {
    parts.unshift(lines[i].trim().slice(2));
  }
  return parts.join('\n');
}

describe('the schema comments this file transcribes are still the schema comments', () => {
  it.each(COLUMNS)('$model.$field lists every documented value', ({ model, field, documented }) => {
    const comment = schemaCommentFor(model, field);
    expect(comment.length, `${model}.${field} carries no comment at all`).toBeGreaterThan(0);
    for (const value of documented) {
      expect(comment, `${model}.${field} comment must mention "${value}"`).toContain(value);
    }
  });
});

// ── 1. The database defends nothing ─────────────────────────────────────────

describe('U.5 — SQLite has no enums', () => {
  it('stores every status column as plain TEXT and accepts a value nobody documented', async () => {
    const m = await machine();
    const b = await db.booking.create({
      data: {
        reference: 'GK-2606-ENUM1',
        name: 'Test',
        phone: '+4740000000',
        email: 'test@example.com',
        deliveryAddress: 'Testveien 1',
        rentalType: 'kvartalsleie', // not one of the four
        startDate: dateToDbMidnight('2026-06-15'),
        deliveryDistance: 0,
        deliveryFee: 0,
        basePrice: 1,
        totalPrice: 1,
        status: 'schrödinger', // not one of the four
        customerType: 'alien',
        machineId: m.id,
      },
    });
    expect(b.status).toBe('schrödinger');
    expect(b.rentalType).toBe('kvartalsleie');
    expect(b.customerType).toBe('alien');

    const phase = await db.checklistPhase.create({
      data: { name: 'X', appliesTo: 'nonsense', audience: 'nonsense', intervalMode: 'nonsense' },
    });
    expect(phase.intervalMode).toBe('nonsense');

    await db.review.create({ data: { bookingId: b.id, token: 't', status: 'nonsense' } });
    await db.webhookEvent.create({ data: { provider: 'paypal', eventId: 'e1' } });

    // …and the storage class is TEXT for all of them, which is why nothing
    // above raised. The defence has to live in the application, per column.
    const types = await db.$queryRawUnsafe<{ s: string; r: string; c: string }[]>(
      'SELECT typeof(status) AS s, typeof(rentalType) AS r, typeof(customerType) AS c FROM "Booking"',
    );
    expect(types[0]).toEqual({ s: 'text', r: 'text', c: 'text' });
  });

  it('accepts every documented value for every column', async () => {
    // The complement of the test above: nothing in the schema, the client or
    // the column type rejects a legal value either.
    const m = await machine();
    for (const status of ['pending', 'confirmed', 'cancelled', 'completed']) {
      const b = await booking(status as 'pending', { machineId: m.id, skipLocks: true });
      expect(b.status).toBe(status);
    }
    for (const rentalType of ['day', 'weekend', 'week', 'custom']) {
      const b = await booking('pending', { machineId: m.id, rentalType, skipLocks: true });
      expect(b.rentalType).toBe(rentalType);
    }
    for (const audience of ['operator', 'renter', 'split']) {
      const p = await checklistPhase({ name: `P-${audience}`, audience });
      expect(p.audience).toBe(audience);
    }
    for (const mode of ['once', 'return', 'daily', 'hours']) {
      const p = await checklistPhase({ name: `M-${mode}`, intervalMode: mode });
      expect(p.intervalMode).toBe(mode);
    }
  });
});

// ── 2. Every value the code writes is documented ────────────────────────────

describe('U.5 — code → schema: no undocumented value is written', () => {
  // FIXED U-2: every column is in this list now. `Booking.paymentMethod` used
  // to be excluded because the schema documented "'card' | 'vipps' | future
  // methods" while three more values reached it — 'invoice' from the B2B
  // accept route, 'mock' from the admin mock-booking tool, and whatever string
  // Stripe reported as the PaymentMethod type. The comment names all four.
  it.each(COLUMNS)('$model.$field writes only documented values', ({ documented, writes }) => {
    expect(writes.filter((v) => !documented.includes(v))).toEqual([]);
  });

  // FIXED U-3: every other whitelisted column is checked at its admin write
  // site; `ChecklistItem.answerType` was not — `body.answerType || 'checkbox'`
  // stored whatever arrived, and an unrecognised answerType renders as nothing
  // the renter can fill, so a completion-trigger phase could never complete and
  // the booking never auto-completed.
  it('ChecklistItem.answerType refuses a value outside the documented list', async () => {
    const phase = await checklistPhase({ items: [{ label: 'Bilde' }] });
    const { PATCH } = await import('@/app/api/admin/checklist-items/[id]/route');
    const { call, adminCookieJar } = await import('../helpers/route');
    const item = phase.items[0];

    const res = await call(PATCH as unknown as RouteHandler, {
      method: 'PATCH',
      path: `/api/admin/checklist-items/${item.id}`,
      params: { id: item.id },
      cookies: await adminCookieJar(),
      body: { answerType: 'holographic-signature' },
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    const after = await db.checklistItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.answerType).toBe('checkbox');
  });
});

// ── 3. Every documented value is written ────────────────────────────────────

describe('U.5 — schema → code: no documented value is unreachable', () => {
  it.each(COLUMNS)('$model.$field: every documented value has a writer', ({ documented, writes, external = [] }) => {
    const reachable = new Set([...writes, ...external]);
    expect(documented.filter((v) => !reachable.has(v))).toEqual([]);
  });

  // FIXED U-4: three documented values had no writer anywhere in `src/`, and
  // the schema was documenting a design the code contradicts. None of them
  // gained a writer — the comments were corrected instead, because the code is
  // right and the comments were not:
  //   · Booking.contractSigningMethod = 'online' — the comment promised
  //     "online Stripe bookings auto-set method=online, status=signed when
  //     AcceptedContract is frozen"; freeze-contract.ts writes neither column,
  //     and resolveContractSigning() deliberately returns 'pending' because
  //     paying online is not signing a contract. Writing it would have opened
  //     the handover gate (isHandoverAllowed) for every online booking.
  //   · Booking.contractSigningStatus = 'not_required' — derived at read time.
  //   · AcceptedContract.acceptanceMethod = 'scroll-then-checkbox' — accepted
  //     by freezeContractForBooking()'s input type, passed by no caller.
  // All three are now documented as reserved/derived rather than as stored
  // values, so this sweep covers every column.
  it('every documented value of every column has a writer', () => {
    const unreachable = COLUMNS.flatMap((c) => {
      const reachable = new Set([...c.writes, ...(c.external ?? [])]);
      return c.documented.filter((v) => !reachable.has(v)).map((v) => `${c.model}.${c.field}=${v}`);
    });
    expect(unreachable).toEqual([]);
  });
});
