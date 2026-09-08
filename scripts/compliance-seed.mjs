import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

// §22(m) framing: date-specific rental is exempt from the right of withdrawal.
// Replaces the prior §22(a) "consent / lapse" wording. User-confirmed switch.
const ANGRERETT = [
  'Leie av maskin gjelder for en bestemt dato eller leieperiode. Slik tidsbestemt utleie er unntatt fra den lovbestemte angreretten etter angrerettloven § 22 bokstav m. Leietaker har derfor ikke 14 dagers angrerett på bestillingen.',
  'Leietaker kan likevel avbestille etter avbestillingsvilkårene (se punktet om avbestilling og refusjon).',
].join('\n');

async function main() {
  const ang = await db.termsSection.updateMany({
    where: { title: 'Angrerett' },
    data: { content: ANGRERETT },
  });
  console.log('Angrerett rows updated:', ang.count);
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => { console.error(e); await db.$disconnect(); process.exit(1); });
