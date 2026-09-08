// Add "Laste og sikring" operator checklist phase. Idempotent.
//
// Run: DATABASE_URL="file:$(pwd)/prisma/prisma/db/custom.db" npx tsx scripts/add-laste-phase.ts
import { db } from '@/lib/db';

const PHASE_NAME = 'Laste og sikring';

const ITEMS = [
  { label: 'Henger sjekket: lys, dekk, kobling, sikringskjetting', answerType: 'checkbox', sortOrder: 0 },
  { label: 'Maskin lastet på henger, bøtte senket', answerType: 'checkbox', sortOrder: 1 },
  { label: 'Last sikret med stropper', answerType: 'checkbox', sortOrder: 2 },
  { label: 'Foto av lastet maskin', answerType: 'photo', sortOrder: 3, minPhotos: 1 },
  { label: 'Kunde/vi informert om trygg losning og sikring før kjøring', answerType: 'checkbox', sortOrder: 4 },
] as const;

async function main() {
  const existing = await db.checklistPhase.findFirst({ where: { name: PHASE_NAME } });
  if (existing) {
    console.log(`Phase "${PHASE_NAME}" already exists (${existing.id}).`);
    return;
  }

  const retur = await db.checklistPhase.findFirst({
    where: { isCompletionTrigger: true },
    orderBy: { sortOrder: 'asc' },
  });
  const sortOrder = retur ? Math.max(0, retur.sortOrder) : 2;

  const created = await db.checklistPhase.create({
    data: {
      name: PHASE_NAME,
      sortOrder,
      appliesTo: 'all',
      audience: 'split',
      intervalMode: 'return',
      isCompletionTrigger: false,
      isActive: true,
      items: {
        create: ITEMS.map((item) => ({
          label: item.label,
          answerType: item.answerType,
          sortOrder: item.sortOrder,
          minPhotos: 'minPhotos' in item ? item.minPhotos : null,
          isActive: true,
        })),
      },
    },
    include: { items: true },
  });

  console.log(`Created "${created.name}" (sortOrder ${created.sortOrder}) with ${created.items.length} items.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
