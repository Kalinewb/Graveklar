// One-off, idempotent content fixes for the live TermsSection rows. The TOC
// lives in the DB (admin-edited), so editing terms-defaults.ts only affects
// fresh installs — this script brings the existing rows in line.
//
//   1. Fix a single-brace {weekendIncludedHours} typo so the token resolves.
//   2. Replace the dead/incorrect "gravemeldingstjeneste.no" reference with
//      the real operator (Geomatikk / geomatikk.no) + a third-party-link
//      disclaimer so the utleier isn't on the hook for someone else's site.
//   3. Add clauses on sticky/hardening materials (asphalt, concrete, tar) and
//      what the included wash does / does not cover.
//
// Run:  DATABASE_URL="file:$(pwd)/prisma/prisma/db/custom.db" npx tsx scripts/update-terms-content.ts
import { db } from '@/lib/db';

const GEOMATIKK_SENTENCE =
  'Den nasjonale gravemeldingstjenesten driftes av Geomatikk (geomatikk.no). Utleier er ikke ansvarlig for innholdet på, eller tilgjengeligheten av, tredjeparts nettsteder det vises til i disse vilkårene.';

const STICKY_LINES = [
  'Vask av normal jord og skitt etter ordinært gravearbeid er inkludert i leien.',
  'Inkludert vask dekker ikke herdende eller klebrige materialer. Brukes utstyret i eller med asfalt, betong, tjære, maling, lim, fugemasse, kjemikalier eller liknende, er leietaker selv ansvarlig for å fjerne alle rester før retur.',
  'Slike rester regnes ikke som normal skitt. Betongsøl, asfalt, tjære, maling og kjemikalier som har herdet eller satt seg på utstyret faktureres med faktisk rengjørings- og utbedringskostnad i sin helhet, i tillegg til eventuell skade dette har påført utstyret.',
];

async function updateByTitle(title: string, transform: (content: string) => string) {
  const row = await db.termsSection.findFirst({ where: { title } });
  if (!row) {
    console.warn(`! Section not found: "${title}" — skipping`);
    return;
  }
  const next = transform(row.content);
  if (next === row.content) {
    console.log(`= "${title}" already up to date — no change`);
    return;
  }
  await db.termsSection.update({ where: { id: row.id }, data: { content: next } });
  console.log(`✓ Updated "${title}"`);
}

async function main() {
  // 1. Single-brace typo → double brace, but only the broken form. The
  //    lookarounds skip an already-correct {{weekendIncludedHours}} so the
  //    script is safe to re-run.
  await updateByTitle('Leieperiode og tider', (c) =>
    c.replace(/(?<!\{)\{weekendIncludedHours\}(?!\})/g, '{{weekendIncludedHours}}')
  );

  // 2. gravemeldingstjeneste.no → Geomatikk + disclaimer.
  await updateByTitle('Gravearbeid og infrastruktur', (c) => {
    if (c.includes('Geomatikk')) return c; // already migrated
    return c.replace(
      /Informasjon om gravemelding finnes på gravemeldingstjeneste\.no\.?/,
      GEOMATIKK_SENTENCE
    );
  });

  // 3. Sticky materials + wash scope. Appended as their own newline-separated
  //    sub-points (the renderer splits content on '\n').
  await updateByTitle('Retur og rengjøring', (c) => {
    if (c.includes('klebrige materialer')) return c; // already added
    return [c, ...STICKY_LINES].join('\n');
  });
}

main()
  .then(() => db.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await db.$disconnect();
    process.exit(1);
  });
