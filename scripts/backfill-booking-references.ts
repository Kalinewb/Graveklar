/**
 * Run after schema migration if existing Booking rows lack reference:
 * npx tsx scripts/backfill-booking-references.ts
 */
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

async function main() {
  const rows = await db.booking.findMany({ where: { reference: '' } }).catch(() =>
    db.booking.findMany()
  );

  const all = await db.booking.findMany({ orderBy: { createdAt: 'asc' } });
  let n = 0;
  for (const b of all) {
    if ((b as { reference?: string }).reference) continue;
    const d = b.createdAt;
    const yy = String(d.getFullYear()).slice(-2);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    n += 1;
    const reference = `GK-${yy}${mm}-${String(n).padStart(3, '0')}`;
    await db.booking.update({
      where: { id: b.id },
      data: { reference, status: b.status === 'confirmed' ? b.status : 'pending' },
    });
    console.log(`Updated ${b.id} -> ${reference}`);
  }
}

main()
  .catch(console.error)
  .finally(() => db.$disconnect());
