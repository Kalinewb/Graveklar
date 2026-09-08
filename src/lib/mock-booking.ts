import { db, withSqliteRetry } from '@/lib/db';
import { loadConfigValues } from '@/lib/config-server';
import { buildQuote } from '@/lib/domain/quote';
import {
  computeBookingPrices,
  generateBookingReference,
  updateBookingStatus,
  BookingValidationError,
  type EquipmentPricing,
} from '@/lib/booking-service';
import {
  dateToDbMidnight,
  dbDateToStr,
  getRentalDateRange,
  rentalDayCount,
} from '@/lib/availability';
import type { RentalType } from '@/lib/pricing';
import { writeAuditLog } from '@/lib/audit-log';
import type { Prisma } from '@prisma/client';

export interface CreateMockBookingInput {
  startDate: string;
  rentalType?: RentalType;
  customDays?: number;
  name?: string;
  phone?: string;
  email?: string;
  machineId?: string;
  selfPickup?: boolean;
  status?: 'pending' | 'confirmed';
  sendEmails?: boolean;
  /** Clear test-booking locks + manual blocks on rental dates before placing. */
  force?: boolean;
}

export interface MockBookingResult {
  bookingId: string;
  reference: string;
  name: string;
  phone: string;
  startDate: string;
  status: string;
  totalPrice: number;
}

const MOCK_NOTE = '[TESTBOOKING] Opprettet fra admin — kan slettes.';

function mockIdentity(input: CreateMockBookingInput, seq: number) {
  const phone = input.phone?.trim() || `990${String(10000 + (seq % 90000)).slice(-5)}`;
  const email = input.email?.trim().toLowerCase() || `test+mock${seq}@example.com`;
  const name = input.name?.trim() || `Test Leietaker ${seq}`;
  return { phone, email, name };
}

async function clearMockConflicts(
  tx: Prisma.TransactionClient,
  machineId: string,
  range: string[],
) {
  const dateObjs = range.map(dateToDbMidnight);
  const testBookings = await tx.booking.findMany({
    where: {
      machineId,
      OR: [
        { notes: { contains: '[TESTBOOKING]' } },
        { adminNote: { contains: '[TESTBOOKING]' } },
      ],
    },
    select: { id: true },
  });
  if (testBookings.length > 0) {
    await tx.bookingDateLock.deleteMany({
      where: {
        bookingId: { in: testBookings.map((b) => b.id) },
        date: { in: dateObjs },
      },
    });
  }
  await tx.unavailableDate.deleteMany({
    where: { date: { in: dateObjs } },
  });
}

export async function createMockBooking(
  input: CreateMockBookingInput,
): Promise<MockBookingResult> {
  if (!input.startDate || !/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)) {
    throw new BookingValidationError('Ugyldig startdato.');
  }

  const rentalType = input.rentalType ?? 'day';
  const customDays = input.customDays ?? (rentalType === 'week' ? 7 : rentalType === 'custom' ? 2 : 1);
  const selfPickup = input.selfPickup ?? false;
  const status = input.status ?? 'confirmed';
  const force = input.force !== false;

  const seq = await db.booking.count();
  const { phone, email, name } = mockIdentity(input, seq);

  const machine = input.machineId
    ? await db.machine.findFirst({ where: { id: input.machineId, isActive: true } })
    : await db.machine.findFirst({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });

  if (!machine) {
    throw new BookingValidationError('Ingen aktiv maskin — legg til utstyr først.');
  }

  const deliveryAddress = selfPickup ? '' : 'Testveien 1, 8000 Bodø';

  const quote = await buildQuote({
    rentalType,
    startDate: input.startDate,
    customDays: rentalType === 'custom' || rentalType === 'week' ? customDays : null,
    machineId: machine.id,
    selfPickup,
    deliveryDistance: selfPickup ? 0 : 5,
    deliveryFee: 0,
    extraHours: 0,
    email,
    phone,
  });

  const config = await loadConfigValues();
  const equipmentPricing: EquipmentPricing = {
    dayPrice: machine.dayPrice,
    weekendPrice: machine.weekendPrice,
    weekPrice: machine.weekPrice,
    dayIncludedHours: machine.dayIncludedHours,
    weekendIncludedHours: machine.weekendIncludedHours,
    weekIncludedHours: machine.weekIncludedHours,
    overtimeRate: machine.overtimeRate,
    preOrderHourRate: machine.preOrderHourRate,
  };

  const computed = computeBookingPrices(
    {
      rentalType,
      startDate: input.startDate,
      customDays,
      deliveryFee: 0,
      extraHours: 0,
    },
    config,
    equipmentPricing,
  );

  const range = getRentalDateRange(
    input.startDate,
    rentalType,
    rentalType === 'week' ? customDays : customDays,
  );
  const reference = await generateBookingReference();

  const booking = await withSqliteRetry(
    () => db.$transaction(async (tx) => {
      if (force) {
        await clearMockConflicts(tx, machine.id, range);
      }

      const created = await tx.booking.create({
        data: {
          reference,
          name,
          phone,
          email,
          deliveryAddress,
          rentalType,
          startDate: dateToDbMidnight(input.startDate),
          customDays:
            rentalType === 'custom'
              ? rentalDayCount('custom', customDays)
              : rentalType === 'week' && customDays > 7
                ? customDays
                : null,
          preferredTime: '08:00',
          deliveryDistance: selfPickup ? 0 : 5,
          deliveryFee: computed.deliveryFee,
          basePrice: computed.basePrice,
          totalPrice: quote.totalPrice,
          // The quote's total is already net of any discount it applied, so
          // the discount has to be stored alongside it — same convention as
          // `createPendingBooking`. Without these two the admin drawer's
          // "Prisbrudd" showed a subtotal and a smaller total with no line
          // explaining the gap (P-3).
          discountKr: quote.discountKr > 0 ? quote.discountKr : null,
          discountLabel: quote.discountLabel,
          extraHours: computed.extraHours,
          extraHoursCost: computed.extraHoursCost,
          includedHours: computed.includedHours,
          totalHours: computed.totalHours,
          notes: MOCK_NOTE,
          selfPickup,
          status: 'pending',
          termsAcceptedAt: new Date(),
          machineId: machine.id,
          adminNote: MOCK_NOTE,
          paymentDeadline: status === 'pending'
            ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
            : null,
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
        const taken = slotsTaken.get(dateStr) ?? new Set();
        let slot = -1;
        for (let i = 0; i < machine.quantity; i++) {
          if (!taken.has(i)) { slot = i; break; }
        }
        if (slot === -1) {
          throw new BookingValidationError(
            force
              ? `Ingen ledig kapasitet ${dateStr} — en ekte booking blokkerer datoen. Slett eller flytt den først.`
              : `Ingen ledig kapasitet ${dateStr}.`,
          );
        }
        lockData.push({
          bookingId: created.id,
          machineId: machine.id,
          date: dateToDbMidnight(dateStr),
          slot,
        });
      }

      await tx.bookingDateLock.createMany({ data: lockData });
      return created;
    }, { maxWait: 8000, timeout: 15000 }),
    { label: 'createMockBooking transaction' },
  );

  let final = booking;
  if (status === 'confirmed') {
    final = await updateBookingStatus(booking.id, 'confirmed', {
      fullyPaid: true,
      paymentMethod: 'mock',
      skipEmails: !input.sendEmails,
    });
  }

  writeAuditLog({
    action: 'booking.mock_created',
    changes: [
      { key: 'bookingId', from: booking.id, to: booking.id },
      { key: 'reference', from: reference, to: reference },
      { key: 'startDate', from: input.startDate, to: input.startDate },
    ],
  }).catch((err) => console.error('mock booking audit failed:', err));

  return {
    bookingId: final.id,
    reference: final.reference,
    name: final.name,
    phone: final.phone,
    startDate: dbDateToStr(final.startDate),
    status: final.status,
    totalPrice: final.totalPrice,
  };
}
