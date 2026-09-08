import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';

export type ContractSigningAction = 'mark_sent' | 'mark_signed' | 'mark_paper' | 'reset_pending';

export const CONTRACT_SIGNING_ACTIONS = new Set<ContractSigningAction>([
  'mark_sent',
  'mark_signed',
  'mark_paper',
  'reset_pending',
]);

export function serializeContractSigningBooking(booking: {
  id: string;
  status: string;
  email: string;
  contractSigningMethod: string | null;
  contractSigningStatus: string | null;
  contractSentAt: Date | null;
  contractSignedAt: Date | null;
  digipostReference: string | null;
  contractSigningNote: string | null;
  termsAcceptedAt: Date | null;
  fullyPaidAt: Date | null;
}) {
  return {
    id: booking.id,
    status: booking.status,
    email: booking.email,
    contractSigningMethod: booking.contractSigningMethod,
    contractSigningStatus: booking.contractSigningStatus,
    contractSentAt: booking.contractSentAt?.toISOString() ?? null,
    contractSignedAt: booking.contractSignedAt?.toISOString() ?? null,
    digipostReference: booking.digipostReference,
    contractSigningNote: booking.contractSigningNote,
    termsAcceptedAt: booking.termsAcceptedAt?.toISOString() ?? null,
    fullyPaidAt: booking.fullyPaidAt?.toISOString() ?? null,
  };
}

export function buildContractSigningUpdate(
  action: ContractSigningAction,
  input: { note?: string | null; digipostReference?: string | null; method?: string | null },
): Prisma.BookingUpdateInput {
  const now = new Date();
  const note = input.note?.trim() || null;
  const digipostReference = input.digipostReference?.trim() || null;

  switch (action) {
    case 'mark_sent':
      return {
        contractSigningMethod: 'digipost',
        contractSigningStatus: 'sent',
        contractSentAt: now,
        contractSignedAt: null,
        digipostReference,
        contractSigningNote: note,
      };
    case 'mark_signed':
      return {
        contractSigningMethod: 'digipost',
        contractSigningStatus: 'signed',
        contractSignedAt: now,
        digipostReference,
        contractSigningNote: note,
      };
    case 'mark_paper':
      return {
        contractSigningMethod: 'paper',
        contractSigningStatus: 'paper',
        contractSignedAt: now,
        contractSigningNote: note,
      };
    case 'reset_pending':
      return {
        contractSigningMethod: null,
        contractSigningStatus: 'pending',
        contractSentAt: null,
        contractSignedAt: null,
        digipostReference: null,
        contractSigningNote: null,
      };
  }
}

export async function applyContractSigningUpdate(
  bookingId: string,
  action: ContractSigningAction,
  input: { note?: string | null; digipostReference?: string | null; method?: string | null },
) {
  const booking = await db.booking.findUnique({ where: { id: bookingId } });
  if (!booking) {
    return { ok: false as const, status: 404, error: 'Booking ikke funnet.' };
  }
  if (booking.status !== 'confirmed') {
    return { ok: false as const, status: 400, error: 'Kun bekreftede bookinger kan oppdateres.' };
  }

  const data = buildContractSigningUpdate(action, input);
  const updated = await db.booking.update({ where: { id: bookingId }, data });
  return { ok: true as const, booking: serializeContractSigningBooking(updated) };
}
