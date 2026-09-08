import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  booking,
  db,
  ensureSchema,
  machine,
  resetDb,
  seedConfigDefaults,
} from '../helpers/db';

// L3 — src/lib/quote-request.ts. The B2B lead → offer → accept lifecycle,
// below HTTP. Routes (POST /api/bedrift, POST /api/tilbud/[token],
// /api/admin/quote-requests*) are covered in tests/api/*.

let QUOTE_STATUSES: typeof import('@/lib/quote-request').QUOTE_STATUSES;
let generateQuoteReference: typeof import('@/lib/quote-request').generateQuoteReference;
let createQuoteRequest: typeof import('@/lib/quote-request').createQuoteRequest;
let convertQuoteToBooking: typeof import('@/lib/quote-request').convertQuoteToBooking;
let QuoteValidationError: typeof import('@/lib/quote-request').QuoteValidationError;

beforeAll(async () => {
  await ensureSchema();
  const mod = await import('@/lib/quote-request');
  ({ QUOTE_STATUSES, generateQuoteReference, createQuoteRequest, convertQuoteToBooking, QuoteValidationError } = mod);
});

beforeEach(async () => {
  await resetDb();
  await seedConfigDefaults();
});

function validInput(overrides: Partial<Parameters<typeof createQuoteRequest>[0]> = {}) {
  return {
    company: 'Testfirma AS',
    orgNumber: '999888777',
    contactName: 'Kari Nordmann',
    email: 'kari@testfirma.no',
    phone: '+4740000001',
    trainingConfirmed: true,
    ...overrides,
  };
}

describe('QUOTE_STATUSES', () => {
  it('is the seven-state lifecycle, in lifecycle order', () => {
    expect(QUOTE_STATUSES).toEqual([
      'ny', 'tilbud_sendt', 'akseptert', 'konvertert', 'avslatt', 'utlopt', 'trukket',
    ]);
  });
});

describe('generateQuoteReference', () => {
  it('is shaped BQ-YYMM-NNN-XXXX', async () => {
    const ref = await generateQuoteReference();
    expect(ref).toMatch(/^BQ-\d{4}-\d{3}-[A-Z0-9]{5}$/);
  });

  it('never uses an ambiguous glyph (0/O/1/I/L) in the random suffix', async () => {
    for (let i = 0; i < 20; i++) {
      const ref = await generateQuoteReference();
      const suffix = ref.split('-')[3];
      expect(suffix).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/);
    }
  });

  it('the sequence number reflects how many quotes exist this month', async () => {
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    for (let i = 0; i < 3; i++) {
      await createQuoteRequest(validInput({ email: `k${i}@testfirma.no` }));
    }
    const ref = await generateQuoteReference();
    expect(ref.startsWith(`BQ-${yy}${mm}-004-`)).toBe(true);
  });
});

describe('createQuoteRequest — validation', () => {
  it('creates a quote with a fresh reference and status ny', async () => {
    const q = await createQuoteRequest(validInput());
    expect(q.status).toBe('ny');
    expect(q.reference).toMatch(/^BQ-/);
    expect(q.trainingConfirmed).toBe(true);
    expect(q.email).toBe('kari@testfirma.no');
  });

  it('trims and lowercases the email, trims the rest', async () => {
    const q = await createQuoteRequest(validInput({
      company: '  Testfirma AS  ',
      contactName: '  Kari Nordmann  ',
      email: '  KARI@TESTFIRMA.NO  ',
      phone: '  40000001  ',
    }));
    expect(q.company).toBe('Testfirma AS');
    expect(q.contactName).toBe('Kari Nordmann');
    expect(q.email).toBe('kari@testfirma.no');
    expect(q.phone).toBe('40000001');
  });

  it('tolerates spaces in the org number ("123 456 789")', async () => {
    const q = await createQuoteRequest(validInput({ orgNumber: '999 888 777' }));
    expect(q.orgNumber).toBe('999888777');
  });

  it('rejects a missing company', async () => {
    await expect(createQuoteRequest(validInput({ company: '' }))).rejects.toThrow(QuoteValidationError);
  });

  it('rejects an org number that is not 9 digits', async () => {
    for (const bad of ['12345678', '1234567890', 'ABCDEFGHI', '']) {
      await expect(createQuoteRequest(validInput({ orgNumber: bad }))).rejects.toThrow(QuoteValidationError);
    }
  });

  it('rejects a missing contact name', async () => {
    await expect(createQuoteRequest(validInput({ contactName: '' }))).rejects.toThrow(QuoteValidationError);
  });

  it('rejects an invalid email', async () => {
    for (const bad of ['not-an-email', 'a@b', '@testfirma.no', 'kari@']) {
      await expect(createQuoteRequest(validInput({ email: bad }))).rejects.toThrow(QuoteValidationError);
    }
  });

  it('rejects a missing phone', async () => {
    await expect(createQuoteRequest(validInput({ phone: '' }))).rejects.toThrow(QuoteValidationError);
  });

  it('rejects when the M2 training box is not confirmed', async () => {
    await expect(createQuoteRequest(validInput({ trainingConfirmed: false }))).rejects.toThrow(
      /M2/,
    );
  });

  it('nothing is written to the database when validation fails', async () => {
    await expect(createQuoteRequest(validInput({ company: '' }))).rejects.toThrow();
    expect(await db.quoteRequest.count()).toBe(0);
  });
});

describe('createQuoteRequest — machine, rental shape', () => {
  it('accepts no machine (undecided equipment)', async () => {
    const q = await createQuoteRequest(validInput());
    expect(q.machineId).toBeNull();
  });

  it('accepts an active machine', async () => {
    const m = await machine();
    const q = await createQuoteRequest(validInput({ machineId: m.id }));
    expect(q.machineId).toBe(m.id);
    expect(q.machine?.id).toBe(m.id);
  });

  it('rejects an unknown machine id', async () => {
    await expect(createQuoteRequest(validInput({ machineId: 'does-not-exist' }))).rejects.toThrow(
      QuoteValidationError,
    );
  });

  it('rejects an inactive machine', async () => {
    const m = await machine({ isActive: false });
    await expect(createQuoteRequest(validInput({ machineId: m.id }))).rejects.toThrow(
      QuoteValidationError,
    );
  });

  it('drops an unrecognised rentalType to null rather than storing garbage', async () => {
    const q = await createQuoteRequest(validInput({ rentalType: 'fortnight' }));
    expect(q.rentalType).toBeNull();
  });

  it('accepts every whitelisted rentalType', async () => {
    for (const t of ['day', 'weekend', 'week', 'custom']) {
      const q = await createQuoteRequest(validInput({ rentalType: t, email: `${t}@testfirma.no` }));
      expect(q.rentalType).toBe(t);
    }
  });

  it('parses a valid startDate and drops an invalid one to null', async () => {
    const q1 = await createQuoteRequest(validInput({ startDate: '2027-05-03' }));
    expect(q1.startDate?.toISOString().slice(0, 10)).toBe('2027-05-03');
    const q2 = await createQuoteRequest(validInput({ startDate: 'not-a-date', email: 'x@testfirma.no' }));
    expect(q2.startDate).toBeNull();
  });

  it('customDays only applies to rentalType "custom", clamped 1…365 and floored', async () => {
    const notCustom = await createQuoteRequest(
      validInput({ rentalType: 'week', customDays: 40, email: 'a@testfirma.no' }),
    );
    expect(notCustom.customDays).toBeNull();

    const zeroOrNeg = await createQuoteRequest(
      validInput({ rentalType: 'custom', customDays: 0, email: 'b@testfirma.no' }),
    );
    expect(zeroOrNeg.customDays).toBeNull();

    const tooMany = await createQuoteRequest(
      validInput({ rentalType: 'custom', customDays: 900, email: 'c@testfirma.no' }),
    );
    expect(tooMany.customDays).toBe(365);

    const fractional = await createQuoteRequest(
      validInput({ rentalType: 'custom', customDays: 4.9, email: 'd@testfirma.no' }),
    );
    expect(fractional.customDays).toBe(4);
  });

  it('projectDescription is trimmed, blank becomes null', async () => {
    const q1 = await createQuoteRequest(validInput({ projectDescription: '  Grave grunnmur  ' }));
    expect(q1.projectDescription).toBe('Grave grunnmur');
    const q2 = await createQuoteRequest(validInput({ projectDescription: '   ', email: 'x2@testfirma.no' }));
    expect(q2.projectDescription).toBeNull();
  });
});

describe('convertQuoteToBooking', () => {
  async function acceptedQuote(overrides: Record<string, unknown> = {}) {
    const m = await machine();
    return db.quoteRequest.create({
      data: {
        reference: `BQ-TEST-${Math.random().toString(36).slice(2, 8)}`,
        company: 'Testfirma AS',
        orgNumber: '999888777',
        contactName: 'Kari Nordmann',
        email: 'kari@testfirma.no',
        phone: '+4740000001',
        machineId: m.id,
        startDate: new Date('2027-06-07T00:00:00+02:00'),
        rentalType: 'day',
        trainingConfirmed: true,
        status: 'tilbud_sendt',
        offerAmount: 5000,
        paymentMode: 'invoice',
        ...overrides,
      },
      include: { machine: true },
    });
  }

  it('throws when the offer has no price', async () => {
    const q = await acceptedQuote({ offerAmount: null });
    await expect(convertQuoteToBooking(q)).rejects.toThrow(/pris/i);
  });

  it('throws when the offer has no start date', async () => {
    const q = await acceptedQuote({ startDate: null });
    await expect(convertQuoteToBooking(q)).rejects.toThrow(/startdato/i);
  });

  it('throws when the machine no longer exists', async () => {
    const q = await acceptedQuote();
    await db.machine.delete({ where: { id: q.machineId! } });
    const reloaded = await db.quoteRequest.findUniqueOrThrow({ where: { id: q.id } });
    await expect(convertQuoteToBooking(reloaded)).rejects.toThrow(/ikke tilgjengelig/i);
  });

  it('throws when the machine has since been deactivated', async () => {
    const q = await acceptedQuote();
    await db.machine.update({ where: { id: q.machineId! }, data: { isActive: false } });
    const reloaded = await db.quoteRequest.findUniqueOrThrow({ where: { id: q.id }, include: { machine: true } });
    await expect(convertQuoteToBooking(reloaded)).rejects.toThrow(/ikke tilgjengelig/i);
  });

  it('creates a pending Booking priced at the offer amount, with a lock per rental day', async () => {
    const q = await acceptedQuote({ rentalType: 'week', offerAmount: 12000 });
    const b = await convertQuoteToBooking(q);
    expect(b.status).toBe('pending');
    expect(b.customerType).toBe('business');
    expect(b.basePrice).toBe(12000);
    expect(b.totalPrice).toBe(12000);
    expect(b.machineId).toBe(q.machineId);

    const locks = await db.bookingDateLock.findMany({ where: { bookingId: b.id } });
    expect(locks).toHaveLength(7); // one week
  });

  it('notes name the company, org number and the original reference', async () => {
    const q = await acceptedQuote({ projectDescription: 'Grave grunnmur til garasje' });
    const b = await convertQuoteToBooking(q);
    expect(b.notes).toContain(q.company);
    expect(b.notes).toContain(q.orgNumber);
    expect(b.notes).toContain(q.reference);
    expect(b.notes).toContain('Grave grunnmur til garasje');
  });

  it('refuses when every slot for a rental day is already locked', async () => {
    const q = await acceptedQuote();
    // Fill the only slot (quantity: 1) on the quote's start date.
    await booking('pending', { machineId: q.machineId!, startDateStr: '2027-06-07', rentalType: 'day' });
    await expect(convertQuoteToBooking(q)).rejects.toThrow(/kapasitet/i);
    // Nothing was left behind by the failed transaction.
    expect(await db.booking.count({ where: { customerType: 'business' } })).toBe(0);
  });

  it('stamps convertedBookingId on the quote', async () => {
    const q = await acceptedQuote();
    const b = await convertQuoteToBooking(q);
    const reloaded = await db.quoteRequest.findUniqueOrThrow({ where: { id: q.id } });
    expect(reloaded.convertedBookingId).toBe(b.id);
  });

  // FIXED M-1. `konvertert` means "a real, paid Booking exists": the invoice
  // path sets it in the tilbud accept route (the invoice IS the commitment),
  // and the card path sets it in updateBookingStatus the moment the booking is
  // confirmed by a payment (tests/api/bookings-id.test.ts, "a paid B2B booking
  // converts its quote request"). Conversion itself therefore leaves a
  // card-mode quote at `akseptert`: the pending booking it created can still
  // expire unpaid, and a quote that reads `konvertert` with a cancelled
  // booking behind it would hide the "Send tilbud"/"Trekk tilbake"
  // affordances the admin needs to recover it.
  it('card-mode conversion leaves the quote at akseptert until the booking is paid', async () => {
    const q = await acceptedQuote({ paymentMode: 'card' });
    const booking = await convertQuoteToBooking(q);
    const reloaded = await db.quoteRequest.findUniqueOrThrow({ where: { id: q.id } });
    expect(reloaded.status).toBe('akseptert');
    expect(reloaded.convertedBookingId).toBe(booking.id);
  });

  it('defaults customDays by rentalType when the offer never pinned one (week → 7, custom → 2, day → 1)', async () => {
    const week = await acceptedQuote({ rentalType: 'week', customDays: null, email: 'w@testfirma.no' });
    const wb = await convertQuoteToBooking(week);
    expect(await db.bookingDateLock.count({ where: { bookingId: wb.id } })).toBe(7);

    const custom = await acceptedQuote({
      rentalType: 'custom', customDays: null, email: 'c@testfirma.no', startDate: new Date('2027-07-05T00:00:00+02:00'),
    });
    const cb = await convertQuoteToBooking(custom);
    expect(await db.bookingDateLock.count({ where: { bookingId: cb.id } })).toBe(2);
  });
});
