// scripts/seed-test-bookings.ts
// Simulates 5 customers booking machines end-to-end. Each booking:
//   1. Goes through createPendingBooking (real discount engine + pricing)
//   2. Is marked confirmed + paid (via updateBookingStatus, fullyPaid=true)
//   3. Triggers sendBookingStatusEmail('confirmed')  → SMTP to customer
//
// Customer emails all land at one inbox via plus/sub-addressing,
// so you receive 5 distinct confirmations and can verify formatting.
//
// Run with:  npx tsx scripts/seed-test-bookings.ts
//
// Safe to re-run — each invocation creates fresh bookings with fresh refs.

import { createPendingBooking, updateBookingStatus } from '@/lib/booking-service';
import { buildQuote } from '@/lib/domain/quote';
import { sendBookingStatusEmail, sendNewBookingAdminNotification } from '@/lib/email';
import { db } from '@/lib/db';

interface Customer {
  name: string;
  emailLocal: string;
  phone: string;
  rentalType: 'day' | 'weekend' | 'week' | 'custom';
  startDate: string; // YYYY-MM-DD
  customDays?: number;
  machineKey: 'rippa' | 'kovaco';
  deliveryAddress: string;
  deliveryDistance: number;
  deliveryFee: number;
  selfPickup: boolean;
  notes?: string;
}

// Set SEED_EMAIL to route generated bookings to a real inbox (plus-addressing
// keeps them in one mailbox); defaults to a placeholder.
const CUSTOMER_INBOX = process.env.SEED_EMAIL || 'test@example.com';
const emailFor = (local: string) =>
  CUSTOMER_INBOX.replace('@', `+${local}@`);

const CUSTOMERS: Customer[] = [
  {
    name: 'Lars Hansen',
    emailLocal: 'lars',
    phone: '90123456',
    rentalType: 'day',
    startDate: '2026-06-09', // Tuesday
    machineKey: 'rippa',
    deliveryAddress: 'Storgata 12, 8006 Bodø',
    deliveryDistance: 4.2,
    deliveryFee: 0,
    selfPickup: false,
    notes: 'Skal grave for terrasse-fundament. Levering om morgenen takk.',
  },
  {
    name: 'Marit Olsen',
    emailLocal: 'marit',
    phone: '93211887',
    rentalType: 'weekend',
    startDate: '2026-06-19', // Friday
    machineKey: 'rippa',
    deliveryAddress: 'Bjørkåsen 4, 8011 Bodø',
    deliveryDistance: 6.8,
    deliveryFee: 0,
    selfPickup: false,
  },
  {
    name: 'Erik Vatn',
    emailLocal: 'erik',
    phone: '47834901',
    rentalType: 'day',
    startDate: '2026-06-17', // Wednesday
    machineKey: 'kovaco',
    deliveryAddress: 'Skogveien 18, 8020 Bodø',
    deliveryDistance: 12.4,
    deliveryFee: 0,
    selfPickup: false,
    notes: 'Trenger maskinen i smal port – derfor Kovaco.',
  },
  {
    name: 'Anna Berg',
    emailLocal: 'anna',
    phone: '99887766',
    rentalType: 'week',
    startDate: '2026-07-13', // Monday
    machineKey: 'rippa',
    deliveryAddress: 'Vågåvegen 11, 8009 Bodø',
    deliveryDistance: 2.1,
    deliveryFee: 0,
    selfPickup: false,
    notes: 'Stort drenerings-prosjekt rundt hytta.',
  },
  {
    name: 'Ola Nordmann',
    emailLocal: 'ola',
    phone: '48122334',
    rentalType: 'custom',
    startDate: '2026-07-21', // Tuesday
    customDays: 3,
    machineKey: 'kovaco',
    deliveryAddress: 'Fjordgata 88, 8200 Fauske',
    deliveryDistance: 64.0,
    deliveryFee: 1700, // 64 - 30 = 34 km × ~50 kr/km estimate
    selfPickup: false,
  },
];

async function main() {
  console.log('→ Seeding 5 test bookings\n');

  const machines = await db.machine.findMany();
  const machineByKey: Record<string, string> = {};
  for (const m of machines) {
    const key = m.name.toLowerCase().includes('rippa') ? 'rippa' : 'kovaco';
    machineByKey[key] = m.id;
  }
  if (!machineByKey.rippa || !machineByKey.kovaco) {
    console.error('✗ Need both Rippa and Kovaco machines in DB.');
    process.exit(1);
  }

  const created: { ref: string; id: string; name: string; email: string }[] = [];

  for (const c of CUSTOMERS) {
    const email = emailFor(c.emailLocal);
    try {
      const quote = await buildQuote({
        rentalType: c.rentalType,
        startDate: c.startDate,
        customDays: c.customDays ?? null,
        machineId: machineByKey[c.machineKey],
        selfPickup: c.selfPickup,
        deliveryDistance: c.deliveryDistance,
        deliveryFee: c.deliveryFee,
        extraHours: 0,
        email,
        phone: c.phone,
        code: null,
      });
      const { booking } = await createPendingBooking({
        name: c.name,
        phone: c.phone,
        email,
        deliveryAddress: c.deliveryAddress,
        rentalType: c.rentalType,
        startDate: c.startDate,
        customDays: c.customDays,
        deliveryDistance: c.deliveryDistance,
        deliveryFee: c.deliveryFee,
        extraHours: 0,
        notes: c.notes,
        termsAccepted: true,
        machineId: machineByKey[c.machineKey],
        selfPickup: c.selfPickup,
        expectedTotalKr: quote.totalPrice,
      });
      console.log(`✓ ${booking.reference}  ${c.name.padEnd(15)} ${c.rentalType.padEnd(8)} ${c.startDate}  ${booking.totalPrice.toLocaleString('nb-NO')} kr  (${email})`);
      created.push({ ref: booking.reference, id: booking.id, name: c.name, email });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`✗ ${c.name}: ${msg}`);
    }
  }

  if (created.length === 0) {
    console.error('\n✗ No bookings created.');
    process.exit(1);
  }

  console.log(`\n→ Confirming + sending emails for ${created.length} booking(s)\n`);

  for (const b of created) {
    try {
      // Mark confirmed + paid — same state Stripe webhook would set.
      const updated = await updateBookingStatus(b.id, 'confirmed', { fullyPaid: true });

      // Customer confirmation email.
      await sendBookingStatusEmail(updated, 'confirmed');
      console.log(`✓ ${b.ref}  customer email → ${b.email}`);

      // Admin "new booking" notification (matches the Stripe webhook flow).
      await sendNewBookingAdminNotification(updated).catch((err) => {
        console.log(`  ⚠ admin notification failed: ${(err as Error).message}`);
      });
    } catch (err) {
      console.log(`✗ ${b.ref}: ${(err as Error).message}`);
    }
  }

  // Summary
  const total = await db.booking.count();
  const confirmed = await db.booking.count({ where: { status: 'confirmed' } });
  console.log(`\n--- Summary ---`);
  console.log(`Total bookings:     ${total}`);
  console.log(`Confirmed bookings: ${confirmed}`);
  console.log(`\nAll customer emails land at ${CUSTOMER_INBOX}`);
  console.log(`Admin emails land at the configured adminEmail (see Innstillinger → SMTP).`);
  console.log(`\nOpen /admin → Kalender for the calendar + usage %.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
