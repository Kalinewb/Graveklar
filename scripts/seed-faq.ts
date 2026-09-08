// Seed the FaqItem table from the shared FAQ defaults so the questions shown
// on the website also exist in the admin panel — editable, reorderable and
// individually togglable (isActive). Idempotent: clears existing rows and
// re-inserts the canonical set in order.
//
// Run:  DATABASE_URL="file:$(pwd)/prisma/prisma/db/custom.db" npx tsx scripts/seed-faq.ts
import { db } from '@/lib/db';
import { FAQ_DEFAULTS } from '@/lib/faq-defaults';

async function main() {
  const existing = await db.faqItem.count();
  console.log(`Existing FAQ rows: ${existing}`);

  // Replace the whole set so re-running yields the canonical defaults rather
  // than duplicates. Admin edits are intentionally overwritten by a re-seed.
  await db.faqItem.deleteMany();

  for (let i = 0; i < FAQ_DEFAULTS.length; i++) {
    const f = FAQ_DEFAULTS[i];
    await db.faqItem.create({
      data: {
        question: f.question,
        answer: f.answer,
        sortOrder: i,
        isActive: true,
      },
    });
  }

  const total = await db.faqItem.count();
  console.log(`Seeded ${total} FAQ rows.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('seed-faq failed:', err);
    process.exit(1);
  });
