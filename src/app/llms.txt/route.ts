import { NextResponse } from 'next/server';
import { loadAppConfig } from '@/lib/app-config';
import { loadConfigValues } from '@/lib/config-server';
import { buildPricingFromConfig } from '@/lib/pricing';
import { resolveSeoKeywords, siteBaseUrl } from '@/lib/seo';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

// /llms.txt — emerging convention (llmstxt.org) that tells AI tools what
// the site is and how to summarise it without having to parse the full
// HTML. Served as text/plain.

export async function GET() {
  const [appCfg, pricingValues, machines] = await Promise.all([
    loadAppConfig(),
    loadConfigValues(),
    db.machine.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }] }),
  ]);
  const PRICES = buildPricingFromConfig(pricingValues);

  const name = appCfg['businessName'] || 'Graveklar';
  const area = appCfg['serviceArea'] || 'Bodø og Salten';
  const url = siteBaseUrl(appCfg);
  const phone = appCfg['contactPhone'] || '';
  const email = appCfg['contactEmail'] || '';
  const keywords = resolveSeoKeywords(
    appCfg,
    machines.map((m) => ({ name: m.name, model: m.model, category: m.category }))
  );

  const machineLines = machines
    .map((m) => `- **${m.name} ${m.model}**${m.year ? ` (${m.year})` : ''}${m.description ? ` — ${m.description.replace(/\s+/g, ' ').slice(0, 140)}` : ''}`)
    .join('\n');

  const body = `# ${name} — Utstyrsutleie i ${area}

> ${name} leier ut minigraver og annet anleggsutstyr til privatkunder i ${area}. Alt inkludert i prisen: drivstoff for hele leieperioden, levering og henting, forsikring, vask. Bookes online; ingen kontanter, ingen depositum.

## Hva som leies ut
${machineLines || '- (Maskiner lastes dynamisk fra databasen — sjekk /utstyr på nettsiden.)'}

## Priser
- **1 dag**: fra ${PRICES.day.basePrice.toLocaleString('nb-NO')} kr (${PRICES.day.includedHours} timer inkludert)
- **Helg**: fra ${PRICES.weekend.basePrice.toLocaleString('nb-NO')} kr (${PRICES.weekend.includedHours} timer inkludert)
- **1 uke**: fra ${PRICES.week.basePrice.toLocaleString('nb-NO')} kr (${PRICES.week.includedHours} timer inkludert)
- **Tilpasset**: dag-for-dag, prises etter hverdag/helg

Alle priser inkluderer MVA. Levering inkludert inntil ${pricingValues.deliveryIncludedKm} km hver vei.

## Inkludert i alle priser
- Drivstoff for hele leieperioden
- Levering og henting innenfor ${pricingValues.deliveryIncludedKm} km
- Full kasko- og maskinskadeforsikring
- Vask etter retur
- Personlig opplæring ved utlevering

## Slik booker man
1. Velg utstyr på forsiden ([${url}](${url}))
2. Velg dato og leietype
3. Fyll inn kontaktinfo og leveringsadresse
4. Godta vilkår og betal med kort

Booking bekreftes umiddelbart etter betaling. SMS + e-post sendes med all informasjon.

## Hvem kan leie
Leie er forbeholdt privatpersoner. Minimumsalder 21 år. Bedrifter må ta kontakt direkte.

## Kontakt
${phone ? `- Telefon: ${phone}` : ''}
${email ? `- E-post: ${email}` : ''}
- Nettside: ${url}

## Søkeord / emner
${keywords.slice(0, 16).map((k) => `- ${k}`).join('\n')}

## Tekniske noter for AI-verktøy
- Sidene er server-rendret (Next.js SSR) — innholdet er tilgjengelig uten JS-eksekvering.
- Sitemap: ${url}/sitemap.xml
- robots.txt tillater GPTBot, ChatGPT-User, OAI-SearchBot, ClaudeBot, PerplexityBot.
- Vilkår: vises under "Vilkår" på forsiden.
- Personvern: kontaktdata behandles i samsvar med personopplysningsloven.
`;

  return new NextResponse(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
