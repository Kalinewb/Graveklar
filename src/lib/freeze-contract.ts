import { db } from '@/lib/db';
import { renderAcceptedTerms } from '@/lib/terms-template';
import { dbDateToStr } from '@/lib/availability';

/**
 * Freeze the rental contract for a booking at the moment payment is
 * confirmed. Idempotent — if an AcceptedContract row already exists for
 * the bookingId we leave it alone (the original artifact is the legal
 * record; we never silently overwrite it).
 *
 * Called from the Stripe webhook on `checkout.session.completed`.
 */
export async function freezeContractForBooking(opts: {
  bookingId: string;
  acceptedFromIp?: string | null;
  acceptanceMethod?: 'checkbox' | 'scroll-then-checkbox';
}): Promise<{ created: boolean; termsVersionHash: string; missingTokens: string[] } | null> {
  const existing = await db.acceptedContract.findUnique({
    where: { bookingId: opts.bookingId },
  });
  if (existing) {
    return {
      created: false,
      termsVersionHash: existing.termsVersionHash,
      missingTokens: [],
    };
  }

  const booking = await db.booking.findUnique({
    where: { id: opts.bookingId },
    include: { machine: true },
  });
  if (!booking) return null;

  const rendered = await renderAcceptedTerms(
    booking.customerType === 'business' ? 'business' : 'consumer'
  );

  // Snapshot the booking facts into the renderContext so the frozen
  // contract is self-contained — if the admin later edits the booking
  // (correcting an address, etc.), the legal artifact still shows what the
  // customer actually agreed to. The terms HTML uses the live AppConfig
  // values; this block stores the booking-specific values alongside.
  const bookingSnapshot: Record<string, string> = {
    'booking.reference':       booking.reference,
    'booking.name':            booking.name,
    'booking.email':           booking.email,
    'booking.phone':           booking.phone,
    'booking.rentalType':      booking.rentalType,
    'booking.startDate':       dbDateToStr(booking.startDate),
    'booking.customDays':      booking.customDays != null ? String(booking.customDays) : '',
    'booking.selfPickup':      booking.selfPickup ? 'true' : 'false',
    'booking.deliveryAddress': booking.deliveryAddress,
    'booking.deliveryDistance':String(booking.deliveryDistance),
    'booking.deliveryFee':     String(booking.deliveryFee),
    'booking.basePrice':       String(booking.basePrice),
    'booking.extraHours':      String(booking.extraHours),
    'booking.extraHoursCost':  String(booking.extraHoursCost),
    'booking.includedHours':   String(booking.includedHours),
    'booking.totalHours':      String(booking.totalHours),
    'booking.totalPrice':      String(booking.totalPrice),
    'booking.discountKr':      booking.discountKr != null ? String(booking.discountKr) : '',
    'booking.discountLabel':   booking.discountLabel ?? '',
    'booking.machine.id':      booking.machine?.id ?? '',
    'booking.machine.name':    booking.machine?.name ?? '',
    'booking.machine.model':   booking.machine?.model ?? '',
  };

  await db.acceptedContract.create({
    data: {
      bookingId: opts.bookingId,
      renderedHtml: rendered.html,
      termsVersionHash: rendered.termsVersionHash,
      renderContext: JSON.stringify({ ...rendered.ctx, ...bookingSnapshot }),
      acceptedAt: booking.termsAcceptedAt ?? new Date(),
      acceptedFromIp: opts.acceptedFromIp ?? null,
      acceptanceMethod: opts.acceptanceMethod ?? 'checkbox',
    },
  });

  return {
    created: true,
    termsVersionHash: rendered.termsVersionHash,
    missingTokens: rendered.missingTokens,
  };
}
