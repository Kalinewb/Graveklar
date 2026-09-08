// Mixed test bookings: paid + unpaid, with + without discounts, with + without
// self-pickup, with + without preferred-time. Plus 2 campaign codes so the
// discount-codes admin page has data to show.
//
//   npx tsx scripts/seed-mixed-bookings.ts

import { createPendingBooking, updateBookingStatus } from '@/lib/booking-service';
import { buildQuote } from '@/lib/domain/quote';
import { sendBookingStatusEmail, sendNewBookingAdminNotification } from '@/lib/email';
import { issueRepeatCode } from '@/lib/discount-engine';
import { db } from '@/lib/db';

// Set SEED_EMAIL to route generated bookings to a real inbox (plus-addressing
// keeps them in one mailbox); defaults to a placeholder.
const INBOX = process.env.SEED_EMAIL || 'test@example.com';
const emailFor = (sub: string) => INBOX.replace('@', `+${sub}@`);

interface Scenario {
  name: string;
  emailSub: string;
  phone: string;
  rentalType: 'day' | 'weekend' | 'week' | 'custom';
  startDate: string;
  customDays?: number;
  machineKey: 'rippa' | 'kovaco';
  selfPickup: boolean;
  preferredTime?: string;
  notes?: string;
  // post-create disposition
  pay: boolean;        // mark confirmed + paid (triggers customer + admin email)
  cancel?: { reason: string }; // cancel after creation (triggers cancel email)
  complete?: boolean;  // mark completed (triggers issueRepeatCode + email)
  discountCode?: string;
}

const SCENARIOS: Scenario[] = [
  // 1. Paid confirmed day rental, self-pickup
  {
    name: 'Hans Olsen', emailSub: 'hans', phone: '90112233',
    rentalType: 'day', startDate: '2026-06-09', machineKey: 'rippa',
    selfPickup: true, preferredTime: '08:00',
    notes: 'Henter tilhenger fra avtalt sted.',
    pay: true,
  },
  // 2. Paid weekend with delivery + preferred time, with discount code SOMMER (10%)
  {
    name: 'Lise Hagen', emailSub: 'lise', phone: '92334455',
    rentalType: 'weekend', startDate: '2026-06-12', machineKey: 'rippa',
    selfPickup: false, preferredTime: 'Fredag 16:00',
    pay: true, discountCode: 'SOMMER',
  },
  // 3. Paid week rental, no discount, delivery
  {
    name: 'Truls Eide', emailSub: 'truls', phone: '93445566',
    rentalType: 'week', startDate: '2026-06-22', machineKey: 'rippa',
    selfPickup: false, preferredTime: 'Mandag morgen',
    notes: 'Lengre prosjekt – kjeller-graving.',
    pay: true,
  },
  // 4. Unpaid (pending) day rental, no discount
  {
    name: 'Eirik Berg', emailSub: 'eirik', phone: '94556677',
    rentalType: 'day', startDate: '2026-07-07', machineKey: 'kovaco',
    selfPickup: false,
    pay: false,
  },
  // 5. Unpaid weekend, with valid campaign discount applied
  {
    name: 'Tone Ask', emailSub: 'tone', phone: '95667788',
    rentalType: 'weekend', startDate: '2026-07-10', machineKey: 'rippa',
    selfPickup: false, preferredTime: 'Fredag ettermiddag',
    pay: false, discountCode: 'NYHET15',
  },
  // 6. Paid custom 4-day rental, self-pickup, no discount
  {
    name: 'Sigrid Vik', emailSub: 'sigrid', phone: '96778899',
    rentalType: 'custom', startDate: '2026-07-13', customDays: 4,
    machineKey: 'kovaco', selfPickup: true, preferredTime: 'Mandag 09:00',
    notes: 'Henter med egen tilhenger.',
    pay: true,
  },
  // 7. Paid day rental that we then cancel (goodwill code issued)
  {
    name: 'Petter Bjerke', emailSub: 'petter', phone: '97889900',
    rentalType: 'day', startDate: '2026-07-20', machineKey: 'kovaco',
    selfPickup: false,
    pay: true, cancel: { reason: 'Maskin ikke tilgjengelig denne dagen – goodwill-kode utstedt.' },
  },
  // 8. Paid day rental, completed (triggers automatic repeat code)
  {
    name: 'Marit Lund', emailSub: 'marit', phone: '98990011',
    rentalType: 'day', startDate: '2026-07-22', machineKey: 'rippa',
    selfPickup: false,
    pay: true, complete: true,
  },
];

async function ensureCampaignCodes() {
  // Two reusable codes for the admin to see.
  const codes = [
    { code: 'SOMMER', percent: 10, maxUses: 100, notes: 'Sommer-kampanje 2026 – generisk' },
    { code: 'NYHET15', percent: 15, maxUses: 50, notes: 'Lansering av ny maskin – begrenset' },
  ];
  for (const c of codes) {
    await db.campaignDiscountCode.upsert({
      where: { code: c.code },
      update: { isActive: true, percent: c.percent, maxUses: c.maxUses, notes: c.notes },
      create: { ...c, isActive: true },
    });
  }
  console.log(`✓ ensured 2 campaign codes (SOMMER, NYHET15)`);
}

async function main() {
  console.log('→ Seeding mixed test bookings\n');

  await ensureCampaignCodes();

  const machines = await db.machine.findMany();
  const rippa = machines.find((m) => m.name.toLowerCase().includes('rippa'));
  const kovaco = machines.find((m) => m.name.toLowerCase().includes('kovaco'));
  if (!rippa || !kovaco) {
    console.error('Need both Rippa and Kovaco machines in DB.');
    process.exit(1);
  }
  const byKey = { rippa: rippa.id, kovaco: kovaco.id };

  for (const s of SCENARIOS) {
    const email = emailFor(s.emailSub);
    try {
      const quote = await buildQuote({
        rentalType: s.rentalType,
        startDate: s.startDate,
        customDays: s.customDays ?? null,
        machineId: byKey[s.machineKey],
        selfPickup: s.selfPickup,
        deliveryDistance: s.selfPickup ? 0 : 5,
        deliveryFee: 0,
        extraHours: 0,
        email,
        phone: s.phone,
        code: s.discountCode ?? null,
      });
      const { booking } = await createPendingBooking({
        name: s.name,
        phone: s.phone,
        email,
        deliveryAddress: s.selfPickup ? '' : 'Bjørkåsen 4, 8011 Bodø',
        rentalType: s.rentalType,
        startDate: s.startDate,
        customDays: s.customDays,
        preferredTime: s.preferredTime,
        deliveryDistance: s.selfPickup ? 0 : 5,
        deliveryFee: 0,
        extraHours: 0,
        notes: s.notes,
        termsAccepted: true,
        machineId: byKey[s.machineKey],
        selfPickup: s.selfPickup,
        discountCode: s.discountCode,
        expectedTotalKr: quote.totalPrice,
      });
      const tag = s.pay ? (s.cancel ? 'CANCEL' : s.complete ? 'COMPLETE' : 'PAID') : 'UNPAID';
      const disc = s.discountCode ? ` [${s.discountCode}]` : '';
      console.log(`✓ ${booking.reference}  ${s.name.padEnd(15)} ${s.rentalType.padEnd(8)} ${s.startDate}  ${booking.totalPrice.toLocaleString('nb-NO')} kr  ${tag}${disc}`);

      if (s.pay) {
        const updated = await updateBookingStatus(booking.id, 'confirmed', { fullyPaid: true });
        await sendBookingStatusEmail(updated, 'confirmed').catch(() => {});
        await sendNewBookingAdminNotification(updated).catch(() => {});

        if (s.complete) {
          await updateBookingStatus(booking.id, 'completed');
          // updateBookingStatus already calls issueRepeatCode internally
        } else if (s.cancel) {
          await updateBookingStatus(booking.id, 'cancelled', { adminNote: s.cancel.reason });
          // Goodwill code for cancelled paid bookings
          const issued = await issueRepeatCode({
            email: updated.email,
            bookingId: updated.id,
            expiresInDays: 365,
          });
          const reCustomer = await db.booking.findUnique({ where: { id: booking.id } });
          if (reCustomer && issued) {
            await sendBookingStatusEmail(reCustomer, 'cancelled', {
              reason: s.cancel.reason,
              repeatCode: issued.code,
              repeatPercent: 10,
              repeatExpiresAt: new Date(Date.now() + 365 * 86_400_000),
            }).catch(() => {});
          }
        }
      }
    } catch (err) {
      console.error(`✗ ${s.name}: ${(err as Error).message}`);
    }
  }

  console.log('\n--- Summary ---');
  console.log('Bookings:    ', await db.booking.count());
  console.log('  pending:   ', await db.booking.count({ where: { status: 'pending' } }));
  console.log('  confirmed: ', await db.booking.count({ where: { status: 'confirmed' } }));
  console.log('  completed: ', await db.booking.count({ where: { status: 'completed' } }));
  console.log('  cancelled: ', await db.booking.count({ where: { status: 'cancelled' } }));
  console.log('Repeat codes:', await db.repeatDiscountCode.count());
  console.log('Campaign codes:', await db.campaignDiscountCode.count());
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
