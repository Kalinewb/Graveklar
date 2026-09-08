import { NextRequest, NextResponse } from 'next/server';
import { createMockBooking } from '@/lib/mock-booking';
import { BookingValidationError } from '@/lib/booking-service';
import { loadAppConfig } from '@/lib/app-config';
import type { RentalType } from '@/lib/pricing';

const RENTAL_TYPES: RentalType[] = ['day', 'weekend', 'week', 'custom'];

export async function POST(request: NextRequest) {
  try {
    const cfg = await loadAppConfig();
    if (cfg['showMockBookingPanel'] === 'false') {
      return NextResponse.json({ error: 'Testbooking er deaktivert i innstillinger.' }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const startDate = typeof body.startDate === 'string' ? body.startDate : '';
    const rentalType = RENTAL_TYPES.includes(body.rentalType) ? body.rentalType as RentalType : 'day';

    const result = await createMockBooking({
      startDate,
      rentalType,
      customDays: body.customDays != null ? Number(body.customDays) : undefined,
      name: typeof body.name === 'string' ? body.name : undefined,
      phone: typeof body.phone === 'string' ? body.phone : undefined,
      email: typeof body.email === 'string' ? body.email : undefined,
      machineId: typeof body.machineId === 'string' ? body.machineId : undefined,
      selfPickup: typeof body.selfPickup === 'boolean' ? body.selfPickup : undefined,
      status: body.status === 'pending' ? 'pending' : 'confirmed',
      sendEmails: body.sendEmails === true,
      force: body.force !== false,
    });

    return NextResponse.json({ success: true, booking: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Kunne ikke opprette testbooking';
    const status = err instanceof BookingValidationError ? 400 : 500;
    console.error('admin/mock-booking error:', err);
    return NextResponse.json({ error: message }, { status });
  }
}
