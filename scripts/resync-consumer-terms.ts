// One-off: the live consumer TermsSection rows predate the {{token}} system
// and drifted from AppConfig (e.g. "1 uke" cancellation window while
// cancelFreeDays=5, hardcoded 12 000 kr egenandel while config says 5000).
// Deletes the stale rows and re-seeds from the current terms-defaults.ts
// DEFAULTS, which now carries forward every clause from the stale set.
// Run: DATABASE_URL="file:$(pwd)/prisma/prisma/db/custom.db" npx tsx scripts/resync-consumer-terms.ts
import { db } from '@/lib/db';
import { ensureDefaultTermsSeeded } from '@/lib/terms-defaults';

async function main() {
  const before = await db.termsSection.findMany({ where: { audience: 'consumer' } });
  console.log(`Deleting ${before.length} stale consumer TermsSection rows...`);
  await db.termsSection.deleteMany({ where: { audience: 'consumer' } });
  const result = await ensureDefaultTermsSeeded();
  console.log('Reseeded:', result);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
