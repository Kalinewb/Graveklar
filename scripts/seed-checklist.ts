// Seed default checklist phases + items for new installs. Idempotent:
// skips if any ChecklistPhase already exists.
//
// Run:  DATABASE_URL="file:$(pwd)/prisma/prisma/db/custom.db" npx tsx scripts/seed-checklist.ts
import { db } from '@/lib/db';

const DEFAULT_PHASES = [
  {
    name: 'Forberedelse',
    sortOrder: 0,
    appliesTo: 'all',
    isCompletionTrigger: false,
    items: [
      { label: 'Utstyr inspisert og rengjort', answerType: 'checkbox', sortOrder: 0 },
      { label: 'Drivstoff og olje kontrollert', answerType: 'checkbox', sortOrder: 1 },
      { label: 'Tilbehør og verktøy pakket', answerType: 'checkbox', sortOrder: 2 },
    ],
  },
  {
    name: 'Levering',
    sortOrder: 1,
    appliesTo: 'delivery',
    isCompletionTrigger: false,
    items: [
      { label: 'Kunde mottatt utstyr', answerType: 'checkbox', sortOrder: 0 },
      { label: 'Gjennomgang av betjening utført', answerType: 'checkbox', sortOrder: 1 },
      { label: 'Foto av utstyr ved levering', answerType: 'photo', sortOrder: 2 },
      { label: 'Drivstoffnivå ved levering', answerType: 'measurement', unit: 'L', sortOrder: 3 },
    ],
  },
  {
    name: 'Selvhenting',
    sortOrder: 1,
    appliesTo: 'selfPickup',
    isCompletionTrigger: false,
    items: [
      { label: 'Kunde har hentet utstyr', answerType: 'checkbox', sortOrder: 0 },
      { label: 'Gjennomgang av betjening utført', answerType: 'checkbox', sortOrder: 1 },
      { label: 'Foto av utstyr ved utlevering', answerType: 'photo', sortOrder: 2 },
    ],
  },
  {
    name: 'Retur',
    sortOrder: 2,
    appliesTo: 'all',
    isCompletionTrigger: true,
    audience: 'operator',
    intervalMode: 'once',
    items: [
      { label: 'Utstyr returnert og inspisert', answerType: 'checkbox', sortOrder: 0 },
      { label: 'Skader eller avvik notert', answerType: 'text', sortOrder: 1 },
      { label: 'Foto av utstyr ved retur', answerType: 'photo', sortOrder: 2 },
      { label: 'Drivstoffnivå ved retur', answerType: 'measurement', unit: 'L', sortOrder: 3 },
    ],
  },
  {
    name: 'Laste og sikring',
    sortOrder: 3,
    appliesTo: 'all',
    isCompletionTrigger: false,
    audience: 'split',
    intervalMode: 'return',
    items: [
      { label: 'Henger sjekket: lys, dekk, kobling, sikringskjetting', answerType: 'checkbox', sortOrder: 0 },
      { label: 'Maskin lastet på henger, bøtte senket', answerType: 'checkbox', sortOrder: 1 },
      { label: 'Last sikret med stropper', answerType: 'checkbox', sortOrder: 2 },
      { label: 'Foto av lastet maskin', answerType: 'photo', sortOrder: 3 },
      { label: 'Kunde/vi informert om trygg losning og sikring før kjøring', answerType: 'checkbox', sortOrder: 4 },
    ],
  },
  {
    name: 'Daglig kontroll',
    sortOrder: 4,
    appliesTo: 'all',
    isCompletionTrigger: false,
    audience: 'renter',
    intervalMode: 'daily',
    items: [
      { label: 'Utstyr fungerer som det skal', answerType: 'checkbox', sortOrder: 0 },
      { label: 'Ingen synlige skader', answerType: 'checkbox', sortOrder: 1 },
      { label: 'Kommentar (valgfritt)', answerType: 'text', sortOrder: 2 },
    ],
  },
] as const;

async function main() {
  const existing = await db.checklistPhase.count();
  if (existing > 0) {
    console.log(`Skipping — ${existing} checklist phase(s) already exist.`);
    return;
  }

  for (const phase of DEFAULT_PHASES) {
    const created = await db.checklistPhase.create({
      data: {
        name: phase.name,
        sortOrder: phase.sortOrder,
        appliesTo: phase.appliesTo,
        isCompletionTrigger: phase.isCompletionTrigger,
        audience: 'audience' in phase ? phase.audience : 'operator',
        intervalMode: 'intervalMode' in phase ? phase.intervalMode : 'once',
        intervalHours: 'intervalHours' in phase ? (phase as { intervalHours?: number }).intervalHours ?? null : null,
        isActive: true,
        items: {
          create: phase.items.map((item) => ({
            label: item.label,
            answerType: item.answerType,
            unit: 'unit' in item ? item.unit : null,
            sortOrder: item.sortOrder,
            isActive: true,
          })),
        },
      },
      include: { items: true },
    });
    console.log(`Created phase "${created.name}" with ${created.items.length} items`);
  }

  console.log('Checklist seed complete.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('seed-checklist failed:', err);
    process.exit(1);
  });
