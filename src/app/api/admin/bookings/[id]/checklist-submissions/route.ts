import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { isAdminAuthenticated } from '@/lib/admin-auth';
import { loadRenterSubmissionsForBooking } from '@/lib/renter-checklist-db';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'Ikke autorisert.' }, { status: 401 });
  }

  const { id } = await params;

  const booking = await db.booking.findUnique({
    where: { id },
    select: { id: true, selfPickup: true },
  });
  if (!booking) {
    return NextResponse.json({ error: 'Booking ikke funnet.' }, { status: 404 });
  }

  const result = await loadRenterSubmissionsForBooking(id, booking);
  return NextResponse.json(result);
}
