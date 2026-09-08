// Quick integration smoke test for checklist helpers against the real DB.
// Run: DATABASE_URL="file:$(pwd)/prisma/prisma/db/custom.db" npx tsx scripts/test-checklist-integration.ts
import { db } from '@/lib/db';
import {
  filterPhasesForBooking,
  countChecklistProgress,
  findCompletionTriggerPhase,
  isCompletionPhaseDone,
  parseChecklistData,
} from '@/lib/checklist';
import { maybeAutoCompleteOnReturDone } from '@/lib/booking-service';

async function main() {
  const phases = await db.checklistPhase.findMany({
    include: { items: true },
    orderBy: { sortOrder: 'asc' },
  });
  console.log('Phases:', phases.map((p) => p.name).join(', ') || '(none)');

  const booking = await db.booking.findFirst({ where: { status: 'confirmed' } });
  if (!booking) {
    console.log('No confirmed booking — integration smoke skipped.');
    return;
  }

  const filtered = filterPhasesForBooking(phases, booking);
  console.log(`Filtered for ${booking.reference} (selfPickup=${booking.selfPickup}):`, filtered.map((p) => p.name).join(', '));

  const trigger = findCompletionTriggerPhase(phases, booking);
  console.log('Completion trigger:', trigger?.name ?? 'none');

  const data = parseChecklistData(booking.checklistData);
  const progress = countChecklistProgress(phases, data, booking);
  console.log('Progress:', `${progress.done}/${progress.total}`);

  if (trigger) {
    console.log('Trigger phase done:', isCompletionPhaseDone(trigger, data));
  }

  const auto = await maybeAutoCompleteOnReturDone(booking.id);
  console.log('maybeAutoCompleteOnReturDone:', auto);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
