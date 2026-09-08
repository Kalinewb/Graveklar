import { toDateStr } from '@/lib/dates';
import { db } from '@/lib/db';
import { loadAppConfig } from '@/lib/app-config';
import { filterPhasesForBooking, parseChecklistData } from '@/lib/checklist';
import { isHandoverAllowed } from '@/lib/contract-signing';
import { loadRenterSubmissionsForBooking } from '@/lib/renter-checklist-db';
import { notFound } from 'next/navigation';
import ChecklistClient from './ChecklistClient';

export const dynamic = 'force-dynamic';

export default async function ChecklistPage({ params }: { params: Promise<{ bookingId: string }> }) {
  const { bookingId } = await params;

  const [booking, phases, appConfig] = await Promise.all([
    db.booking.findUnique({
      where: { id: bookingId },
      include: {
        machine: {
          include: { documents: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
        },
      },
    }),
    db.checklistPhase.findMany({
      where: { isActive: true },
      include: { items: { where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
      orderBy: { sortOrder: 'asc' },
    }),
    loadAppConfig(),
  ]);

  if (!booking) notFound();

  const checklistData = parseChecklistData(booking.checklistData) as Record<string, string | boolean | string[]>;
  const filteredPhases = filterPhasesForBooking(phases, booking);
  const { submissions: renterSubmissions } = await loadRenterSubmissionsForBooking(
    bookingId,
    booking,
  );
  const handoverAllowed = isHandoverAllowed(booking);

  return (
    <ChecklistClient
      bookingId={booking.id}
      reference={booking.reference}
      customerName={booking.name}
      customerPhone={booking.phone}
      customerEmail={booking.email}
      equipmentName={booking.machine?.name || 'Ukjent utstyr'}
      startDate={toDateStr(booking.startDate)}
      rentalType={booking.rentalType}
      totalHours={booking.totalHours}
      totalPrice={booking.totalPrice}
      basePrice={booking.basePrice}
      deliveryFee={booking.deliveryFee}
      deliveryAddress={booking.deliveryAddress}
      selfPickup={booking.selfPickup}
      status={booking.status}
      handoverAllowed={handoverAllowed}
      machineDocuments={(booking.machine?.documents ?? []).map((d) => ({
        title: d.title,
        fileUrl: d.fileUrl,
      }))}
      businessName={appConfig['businessName'] || 'Graveklar'}
      orgNumber={appConfig['orgNumber'] || ''}
      logoUrl={appConfig['logoOnContract'] === 'false' ? '' : (appConfig['logoUrl'] || '')}
      fuelTankLiters={booking.machine?.fuelTankLiters ?? null}
      fuelConsumptionPerHour={booking.machine?.fuelConsumptionPerHour ?? null}
      phases={filteredPhases.map(p => ({
        id: p.id,
        name: p.name,
        items: p.items.map(i => ({
          id: i.id,
          label: i.label,
          answerType: i.answerType,
          unit: i.unit,
          conditionItemId: i.conditionItemId,
          conditionValue: i.conditionValue,
          statKey: i.statKey,
          minPhotos: i.minPhotos,
        })),
      }))}
      initialData={checklistData}
      renterSubmissions={renterSubmissions}
    />
  );
}
