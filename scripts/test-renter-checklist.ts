// Smoke test renter checklist phone lookup against real DB.
// Run: DATABASE_URL="file:$(pwd)/prisma/prisma/db/custom.db" npx tsx scripts/test-renter-checklist.ts
import { db } from '@/lib/db';
import { isBookingActiveForRenterChecklist } from '@/lib/renter-checklist';
import { findActiveBookingsByPhone } from '@/lib/renter-checklist-db';
import { normalizePhone } from '@/lib/phone-normalize';

async function main() {
  const confirmed = await db.booking.findMany({
    where: { status: 'confirmed' },
    take: 5,
    orderBy: { createdAt: 'desc' },
  });

  console.log(`Confirmed bookings sample: ${confirmed.length}`);
  for (const b of confirmed) {
    const active = isBookingActiveForRenterChecklist(b);
    console.log(`  ${b.reference} phone=${b.phone} active=${active} paid=${!!b.fullyPaidAt}`);
    if (active) {
      const found = await findActiveBookingsByPhone(b.phone);
      console.log(`    lookup → ${found.length} match(es): ${found.map((x) => x.reference).join(', ')}`);
      console.log(`    normalized phone: ${normalizePhone(b.phone)}`);
    }
  }

  const renterPhases = await db.checklistPhase.count({ where: { audience: 'renter', isActive: true } });
  console.log(`Active renter phases: ${renterPhases}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
