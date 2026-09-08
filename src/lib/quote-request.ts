import { db, withSqliteRetry } from '@/lib/db';
import {
  dateToDbMidnight,
  dbDateToStr,
  getRentalDateRange,
  rentalDayCount,
} from '@/lib/availability';
import { generateBookingReference, BookingValidationError } from '@/lib/booking-service';
import type { RentalType } from '@/lib/pricing';
import type { QuoteRequest, Machine } from '@prisma/client';

// Lifecycle states for a B2B quote request. The "counteroffer" is not a
// separate state — the admin revises offerAmount/offerMessage in place and
// re-sends, which moves (or keeps) the row at `tilbud_sendt`.
export const QUOTE_STATUSES = [
  'ny', // new lead, awaiting admin review
  'tilbud_sendt', // offer sent (or revised); awaiting customer
  'akseptert', // customer accepted the offer
  'konvertert', // turned into a real Booking
  'avslatt', // declined by customer
  'utlopt', // offer validity lapsed
  'trukket', // withdrawn by admin
] as const;

export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const QUOTE_STATUS_LABELS: Record<QuoteStatus, string> = {
  ny: 'Ny',
  tilbud_sendt: 'Tilbud sendt',
  akseptert: 'Akseptert',
  konvertert: 'Konvertert',
  avslatt: 'Avslått',
  utlopt: 'Utløpt',
  trukket: 'Trukket',
};

const VALID_RENTAL_TYPES = new Set(['day', 'weekend', 'week', 'custom']);

// Same alphabet as booking references — ambiguous glyphs removed so the
// reference is safe to read aloud over the phone.
const REF_SUFFIX_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomRefSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  let out = '';
  for (const b of bytes) out += REF_SUFFIX_ALPHABET[b % REF_SUFFIX_ALPHABET.length];
  return out;
}

// BQ-YYMM-NNN-XXXX. BQ = "business quote", parallel to GK booking refs.
export async function generateQuoteReference(): Promise<string> {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `BQ-${yy}${mm}-`;

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

  const count = await db.quoteRequest.count({
    where: { createdAt: { gte: monthStart, lte: monthEnd } },
  });

  for (let offset = 0; offset < 20; offset++) {
    const candidate = `${prefix}${String(count + 1 + offset).padStart(3, '0')}-${randomRefSuffix()}`;
    const exists = await db.quoteRequest.findUnique({ where: { reference: candidate } });
    if (!exists) return candidate;
  }
  return `${prefix}${Date.now().toString(36).toUpperCase().slice(-4)}-${randomRefSuffix()}`;
}

export class QuoteValidationError extends Error {}

export interface CreateQuoteRequestInput {
  company: string;
  orgNumber: string;
  contactName: string;
  email: string;
  phone: string;
  machineId?: string | null;
  startDate?: string | null;
  rentalType?: string | null;
  customDays?: number | null;
  projectDescription?: string | null;
  trainingConfirmed: boolean;
}

const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Norwegian org numbers are 9 digits. We tolerate spaces ("123 456 789").
const ORG_RE = /^\d{9}$/;

export async function createQuoteRequest(input: CreateQuoteRequestInput) {
  const company = clean(input.company);
  const orgNumber = clean(input.orgNumber).replace(/\s+/g, '');
  const contactName = clean(input.contactName);
  const email = clean(input.email).toLowerCase();
  const phone = clean(input.phone);
  const projectDescription = clean(input.projectDescription) || null;

  if (!company) throw new QuoteValidationError('Firmanavn er påkrevd');
  if (!ORG_RE.test(orgNumber)) throw new QuoteValidationError('Organisasjonsnummer må være 9 siffer');
  if (!contactName) throw new QuoteValidationError('Kontaktperson er påkrevd');
  if (!EMAIL_RE.test(email)) throw new QuoteValidationError('Ugyldig e-postadresse');
  if (!phone) throw new QuoteValidationError('Telefon er påkrevd');
  if (!input.trainingConfirmed) {
    throw new QuoteValidationError('Du må bekrefte at fører har dokumentert opplæring (M2)');
  }

  // Machine is optional, but if supplied it must exist and be active.
  let machineId: string | null = null;
  if (input.machineId) {
    const m = await db.machine.findUnique({ where: { id: input.machineId } });
    if (!m || !m.isActive) throw new QuoteValidationError('Ugyldig maskinvalg');
    machineId = m.id;
  }

  const rentalType =
    input.rentalType && VALID_RENTAL_TYPES.has(input.rentalType) ? input.rentalType : null;

  let startDate: Date | null = null;
  if (input.startDate) {
    const d = new Date(input.startDate);
    if (!Number.isNaN(d.getTime())) startDate = d;
  }

  const customDays =
    rentalType === 'custom' && input.customDays && input.customDays > 0
      ? Math.min(Math.floor(input.customDays), 365)
      : null;

  const reference = await generateQuoteReference();

  const quote = await db.quoteRequest.create({
    data: {
      reference,
      company,
      orgNumber,
      contactName,
      email,
      phone,
      machineId,
      startDate,
      rentalType,
      customDays,
      projectDescription,
      trainingConfirmed: true,
      status: 'ny',
    },
    include: { machine: true },
  });

  return quote;
}

type QuoteWithMachine = QuoteRequest & { machine?: Machine | null };

/**
 * Turn an accepted offer into a real (pending) Booking, locking the calendar
 * for the rental dates. This is the FIRST moment a B2B request touches
 * availability — until acceptance an unvetted business never blocks dates.
 *
 * Creates the booking + locks atomically; the caller decides how to settle
 * payment (Stripe for `card`, mark confirmed/invoice for `invoice`).
 * Idempotent at the call site via QuoteRequest.convertedBookingId.
 */
export async function convertQuoteToBooking(quote: QuoteWithMachine) {
  if (!quote.offerAmount || quote.offerAmount <= 0) {
    throw new BookingValidationError('Tilbudet mangler pris.');
  }
  if (!quote.startDate) {
    throw new BookingValidationError('Tilbudet mangler startdato. Ta kontakt med utleier.');
  }
  const machine = quote.machine ?? (quote.machineId ? await db.machine.findUnique({ where: { id: quote.machineId } }) : null);
  if (!machine || !machine.isActive) {
    throw new BookingValidationError('Maskinen er ikke tilgjengelig. Ta kontakt med utleier.');
  }

  const rentalType = (quote.rentalType ?? 'day') as RentalType;
  const customDays = quote.customDays ?? (rentalType === 'week' ? 7 : rentalType === 'custom' ? 2 : 1);
  const startStr = dbDateToStr(quote.startDate);
  const range = getRentalDateRange(startStr, rentalType, customDays);
  const reference = await generateBookingReference();

  const notesParts = [`Bedrift: ${quote.company} (org.nr ${quote.orgNumber})`, `Forespørsel ${quote.reference}`];
  if (quote.projectDescription) notesParts.push(quote.projectDescription);
  const notes = notesParts.join('\n');

  const booking = await withSqliteRetry(
    () => db.$transaction(async (tx) => {
      const created = await tx.booking.create({
        data: {
          reference,
          name: quote.contactName,
          phone: quote.phone,
          email: quote.email,
          deliveryAddress: 'Avtales (bedrift)',
          rentalType,
          startDate: dateToDbMidnight(startStr),
          customDays:
            rentalType === 'custom'
              ? rentalDayCount('custom', customDays)
              : rentalType === 'week' && customDays > 7
                ? customDays
                : null,
          preferredTime: null,
          deliveryDistance: 0,
          deliveryFee: 0,
          basePrice: quote.offerAmount!,
          totalPrice: quote.offerAmount!,
          extraHours: 0,
          extraHoursCost: 0,
          includedHours: 0,
          totalHours: 0,
          notes,
          selfPickup: false,
          status: 'pending',
          customerType: 'business',
          termsAcceptedAt: new Date(),
          machineId: machine.id,
          paymentDeadline: new Date(Date.now() + 60 * 60 * 1000),
        },
      });

      const existingLocks = await tx.bookingDateLock.findMany({
        where: { machineId: machine.id, date: { in: range.map(dateToDbMidnight) } },
        select: { date: true, slot: true },
      });
      const slotsTaken = new Map<string, Set<number>>();
      for (const lock of existingLocks) {
        const key = dbDateToStr(lock.date);
        if (!slotsTaken.has(key)) slotsTaken.set(key, new Set());
        slotsTaken.get(key)!.add(lock.slot);
      }

      const lockData: { bookingId: string; machineId: string; date: Date; slot: number }[] = [];
      for (const dateStr of range) {
        const taken = slotsTaken.get(dateStr) ?? new Set<number>();
        let slot = -1;
        for (let i = 0; i < machine.quantity; i++) {
          if (!taken.has(i)) { slot = i; break; }
        }
        if (slot === -1) {
          throw new BookingValidationError(`Ingen ledig kapasitet ${dateStr}. Ta kontakt med utleier.`);
        }
        lockData.push({ bookingId: created.id, machineId: machine.id, date: dateToDbMidnight(dateStr), slot });
      }
      await tx.bookingDateLock.createMany({ data: lockData });
      return created;
    }, { maxWait: 8000, timeout: 15000 }),
    { label: 'convertQuoteToBooking transaction' },
  );

  await db.quoteRequest.update({
    where: { id: quote.id },
    data: { convertedBookingId: booking.id, status: 'akseptert' },
  });

  return booking;
}
