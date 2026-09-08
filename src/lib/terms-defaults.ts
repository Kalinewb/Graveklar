import { db } from '@/lib/db';

// Default forbruker (consumer) TOC, drafted around the If insurance
// quote's hard constraints + Norwegian consumer-rental practice.
// Variables use {{token}} format — see terms-template.ts for the whitelist.
//
// Seeded only when the TermsSection table is empty so existing customised
// terms are left alone.

interface DefaultSection {
  title: string;
  content: string;
}

const DEFAULTS: DefaultSection[] = [
  {
    title: 'Partene',
    content:
      'Disse leievilkårene gjelder mellom {{businessName}} (utleier) og deg som leietaker (privatperson, ikke bedrift). Vilkårene gjelder all bruk av utstyr leid hos utleier og er bindende fra det tidspunktet du bekrefter bookingen.',
  },
  {
    title: 'Hvem kan leie',
    content:
      'Leie er kun tilgjengelig for privatpersoner som er fylt {{minAge}} år. Gyldig legitimasjon fremvises ved utlevering. Utstyret skal kun benyttes av leietaker selv – overlevering til tredjepart er ikke tillatt uten skriftlig samtykke.',
  },
  {
    title: 'Leieperiode og tider',
    content:
      'Leieperioden starter ved utlevering av utstyret og slutter ved tilbakelevering og kontroll. Inkluderte driftstimer: døgn – {{dayIncludedHours}} timer; helg (fre–man) – {{weekendIncludedHours}} timer; uke – {{weekIncludedHours}} timer. Overskridelse av inkluderte timer faktureres med {{overtimeRate}} kr per påbegynt time. Forhåndsbestilte tilleggstimer koster {{preOrderHourRate}} kr/time. Ved forsinket retur uten forhåndsvarsel faktureres {{overtimeRate}} kr per påbegynt time. Utleier er ikke ansvarlig for forsinkelser ved levering som skyldes trafikk, vær eller andre forhold utenfor utleiers kontroll.',
  },
  {
    title: 'Bruksrestriksjoner',
    content:
      'Følgende bruk er ikke tillatt og dekkes ikke av forsikring: riving uten skriftlig forhåndsgodkjenning, bruk i vann dypere enn 30 cm, kjøring på offentlig vei, bruk under påvirkning av alkohol/narkotika/legemidler som påvirker kjøreevne, bruk som overskrider maskinens kapasitet, og videreutleie til tredjepart. Brudd gir utleier rett til full erstatning utover forsikringens dekning.',
  },
  {
    title: 'Leietakers plikter',
    content:
      'Leietaker plikter å bruke utstyret aktsomt og i samsvar med bruksanvisning, sikkerhetsinstrukser og disse vilkårene, å kontrollere utstyret ved mottak og umiddelbart varsle utleier om synlige skader eller mangler, og å delta på sikkerhetsorienteringen ved utlevering. Utstyret skal kun opereres av leietaker personlig, med mindre annet er skriftlig avtalt. Leietaker plikter å varsle utleier umiddelbart ved skade, havari, tyveri eller ulykke.',
  },
  {
    title: 'Gravemelding og infrastruktur',
    content:
      'Leietaker er ansvarlig for å sende gravemelding til relevante netteiere før gravearbeid, samt for å undersøke om det finnes kabler, rør eller annen underjordisk infrastruktur. Utleier er ikke ansvarlig for skader på underjordisk infrastruktur som oppstår under leietakers bruk. Den nasjonale gravemeldingstjenesten driftes av Geomatikk (geomatikk.no). Utleier er ikke ansvarlig for innholdet på, eller tilgjengeligheten av, tredjeparts nettsteder det vises til i disse vilkårene.',
  },
  {
    title: 'Geografisk område',
    content:
      'Levering og henting skjer innenfor {{maxDeliveryRadius}} km fra utgangspunktet til utleier. Utstyret skal ikke transporteres ut av dette området uten skriftlig samtykke.',
  },
  {
    title: 'Levering og henting',
    content:
      'Levering og henting er inkludert i prisen inntil {{deliveryIncludedKm}} km hver vei. For lengre distanser beregnes tillegg på {{deliveryPerKm}} kr per km. Minimumsgebyr: {{minDeliveryFee}} kr. Leveringsområde: {{serviceArea}}.',
  },
  {
    title: 'Selvhenting',
    content:
      'Ved selvhenting stiller utleier tilhenger til disposisjon. Leietaker er ansvarlig for å ha et kjøretøy godkjent for å trekke tilhenger med totalvekt på minst 3 500 kg, samt gyldig kompetansebevis for tilhenger (BE-førerkort). Utleier har rett til å nekte utlevering dersom kjøretøy eller kompetanse ikke oppfyller kravene; leietaker har i så fall krav på full refusjon. Leietaker er ansvarlig for sikker lasting, transport og lossing. Utleier er ikke ansvarlig for skader under transport i leietakers varetekt.',
  },
  {
    title: 'Drivstoff og forbruksmateriell',
    content:
      'Drivstoff er inkludert i leieprisen. Tilstrekkelig drivstoff for hele leieperioden leveres med utstyret. Eventuelle smøremidler og andre forbruksmaterialer som påkreves under bruk dekkes av utleier.',
  },
  {
    title: 'Forsikring og egenandel',
    content:
      'Maskinen er forsikret med kasko- og maskinskadedekning. Ansvarsforsikring dekker tredjepart. Forsikringen dekker ikke skader som oppstår ved brudd på bruksvilkårene over. Leietaker er ansvarlig for forsikringens egenandel ved skader vedkommende forårsaker, inntil {{egenandel}} kr per skadetilfelle.',
  },
  {
    title: 'Sikkerhet og utlevering',
    content:
      'Ved utlevering gjennomføres en sikkerhetsorientering med gjennomgang av bruksanvisning, maskinens grenser og bruksrestriksjoner. Utstyret inspiseres sammen med leietaker, og eksisterende skader dokumenteres med foto. Leietaker bekrefter mottak ved signatur på utleveringsprotokollen.',
  },
  {
    title: 'Betaling',
    content:
      'Alle priser er oppgitt i norske kroner (NOK) inklusiv merverdiavgift. Full betaling skjer ved booking via kortbetaling (Stripe), og bookingen er ikke gyldig før betaling er gjennomført. Utleier lagrer ikke kortinformasjon – dette håndteres av Stripe i henhold til PCI DSS. Ved forsinket betaling av tilleggskostnader (overtid, skader) løper forsinkelsesrente etter forsinkelsesrenteloven, og ubetalte krav kan oversendes inkasso.',
  },
  {
    title: 'Avbestilling',
    content:
      'Gratis avbestilling inntil {{cancelFreeLabel}} før avtalt leiestart. Avbestilling senere enn dette: {{cancelLatePercent}} % av leieprisen. Samme dag eller no-show: {{cancelSameDayPercent}} % av leieprisen. Refusjon for gyldige avbestillinger sendes til den betalingsmetoden som ble brukt ved booking.',
  },
  {
    title: 'Skader og ansvar',
    content:
      'Leietaker er ansvarlig for skader forårsaket av uforsvarlig bruk, brudd på disse vilkårene eller manglende vedlikehold under leieperioden. Normal slitasje er utleiers ansvar. Ved skade som leietaker er ansvarlig for, og som forsikringen dekker, kan leietaker belastes forsikringens egenandel på inntil {{egenandel}} kr per skadetilfelle. Fører leietakers brudd på disse vilkårene til at forsikringen avkortes eller faller bort, er leietaker fullt ut ansvarlig for hele det udekkede tapet, ikke begrenset til egenandelen. Leietaker plikter å sikre utstyret mot tyveri når det ikke er i bruk. Skader og tyveri skal rapporteres til utleier umiddelbart, og senest ved retur.',
  },
  {
    title: 'Feil og reklamasjon',
    content:
      'Dersom utstyret har feil eller mangler som ikke skyldes leietakers bruk, har leietaker rett til utbedring, erstatningsmaskin, prisreduksjon eller heving av leieavtalen. Reklamasjon fremsettes til utleier på {{contactEmail}} eller {{contactPhone}} så snart som mulig, og senest innen 2 måneder etter at feilen ble oppdaget. Utleier plikter å utbedre reklamerte mangler uten ugrunnet opphold. Dersom utstyret er ubrukbart og utleier ikke kan stille erstatning, har leietaker rett til forholdsmessig prisreduksjon for perioden utstyret var ubrukbart.',
  },
  {
    title: 'Retur og rengjøring',
    content:
      'Utstyret skal returneres i rimelig ren stand på avtalt tidspunkt. Vask av normal jord og skitt etter ordinært gravearbeid er inkludert i leien. Unødig skitten retur ut over dette medfører et rengjøringsgebyr på 500 kr. Inkludert vask dekker ikke herdende eller klebrige materialer. Brukes utstyret i eller med asfalt, betong, tjære, maling, lim, fugemasse, kjemikalier eller liknende, er leietaker selv ansvarlig for å fjerne alle rester før retur. Slike rester regnes ikke som normal skitt, og faktisk rengjørings- og utbedringskostnad faktureres i sin helhet, i tillegg til eventuell skade dette har påført utstyret. Forsinket retur kan medføre tilleggsgebyr tilsvarende overtidspris frem til faktisk retur.',
  },
  {
    title: 'Ansvarsbegrensning',
    content:
      'Utleier er ikke ansvarlig for indirekte tap eller følgeskader, herunder tapt arbeidsinntekt eller forsinkelser i leietakers prosjekt. Utleiers ansvar er, så langt loven tillater, begrenset til direkte tap knyttet til leieforholdet. Denne begrensningen gjelder ikke ved grov uaktsomhet eller forsett fra utleiers side. Utleier er ikke ansvarlig for personskader eller skade på tredjeparts eiendom som skyldes leietakers bruk av utstyret, med mindre skaden skyldes feil eller mangler som utleier kjente eller burde kjent til.',
  },
  {
    title: 'Force majeure',
    content:
      'Ingen av partene er ansvarlige for manglende oppfyllelse som skyldes forhold utenfor partens kontroll, herunder ekstremt vær, naturkatastrofer, streik, transportforstyrrelser, offentlige pålegg, pandemi eller andre ekstraordinære omstendigheter. Den berørte parten skal varsle den andre parten uten ugrunnet opphold. Må utleier avlyse en bekreftet booking av slike grunner, mottar leietaker full refusjon.',
  },
  {
    title: 'Personopplysninger',
    content:
      'Utleier behandler personopplysninger i samsvar med personopplysningsloven og GDPR. Booking-data, kontaktinfo og dokumentasjon knyttet til leieforholdet lagres så lenge det er nødvendig for å oppfylle avtalen og lovpålagte regnskaps- og forsikringskrav.',
  },
  {
    title: 'Tvister',
    content:
      'Tvister forsøkes løst i minnelighet. Hvis dette ikke fører frem, kan saken bringes inn for Forbrukerrådet eller alminnelige norske domstoler. Verneting er Salten tingrett.',
  },
  {
    title: 'Angrerett',
    content:
      'Leie av maskin gjelder for en bestemt dato eller leieperiode. Slik tidsbestemt utleie er unntatt fra den lovbestemte angreretten etter angrerettloven § 22 bokstav m. Leietaker har derfor ikke 14 dagers angrerett på bestillingen. Leietaker kan likevel avbestille etter avbestillingsvilkårene over.',
  },
  {
    title: 'Kontakt',
    content:
      'Utleier kan kontaktes på {{contactEmail}} eller {{contactPhone}}. Nettside: {{siteUrl}}.',
  },
];

// Default bedrift (B2B) TOC. Same structure as the consumer set but the
// risk allocation is flipped to reflect that the renter is a professional
// undertaking that becomes the operating employer under arbeidsmiljøloven.
// Key deltas vs. consumer terms:
//   - no angrerett section (only applies to consumers)
//   - explicit M2/dokumentert opplæring requirement + employer/HMS duties
//   - bareboat framing: utleier delivers without operator
//   - full uncovered-loss liability, no consumer-style caps beyond egenandel
const BUSINESS_DEFAULTS: DefaultSection[] = [
  {
    title: 'Partene',
    content:
      'Disse leievilkårene gjelder mellom {{businessName}} (utleier) og leietakeren, som er et registrert foretak med gyldig organisasjonsnummer (heretter «leietaker» eller «bedriften»). Den som bekrefter bookingen bekrefter samtidig å ha fullmakt til å forplikte bedriften. Vilkårene er bindende fra det tidspunktet bookingen bekreftes, eller fra utleier aksepterer tilbud/forespørsel der dette er avtalt særskilt.',
  },
  {
    title: 'Hvem kan leie',
    content:
      'Leie tilbys kun til næringsdrivende med gyldig organisasjonsnummer. Utleier kan kreve fremlagt firmaattest, gyldig legitimasjon for den som henter/mottar utstyret, og dokumentasjon på relevant kompetanse før utlevering. Utleier kan avslå eller stille vilkår etter eget skjønn.',
  },
  {
    title: 'Utleie uten fører (bareboat)',
    content:
      'Utstyret leies ut uten fører/operatør. Utleier stiller maskinen til rådighet, men utfører ikke arbeid og leder ikke arbeidet på leietakers oppdrag. Leietaker disponerer og bruker utstyret for egen regning og risiko i hele leieperioden.',
  },
  {
    title: 'Sertifisering og dokumentert opplæring (M2)',
    content:
      'Maskiner med motoreffekt over 15 kW (herunder gravemaskiner i denne klassen) krever dokumentert sikkerhetsopplæring etter forskrift om utførelse av arbeid kapittel 10 (modul-/maskinklasse M2 for masseforflyttingsmaskiner). Leietaker er ansvarlig for at enhver som betjener utstyret har gyldig og dokumentert opplæring for den aktuelle maskintypen før bruk. Utleier utleverer utstyret i tillit til leietakers bekreftelse på dette og er ikke ansvarlig for manglende eller mangelfull opplæring hos leietakers personell. Manglende dokumentert opplæring regnes som vesentlig mislighold og brudd på bruksvilkårene.',
  },
  {
    title: 'Arbeidsgiveransvar og HMS',
    content:
      'Når utstyret er overlevert, er leietaker arbeidsgiver og ansvarlig for arbeidet som utføres med det. Leietaker har det fulle ansvaret for helse, miljø og sikkerhet, herunder risikovurdering/SJA, verneutstyr, sikker bruk, varsling og sikring av arbeidsområdet, og for at gjeldende krav i arbeidsmiljøloven med forskrifter overholdes. Utleier har intet arbeidsgiver- eller HMS-ansvar for leietakers bruk av utstyret.',
  },
  {
    title: 'Bruksrestriksjoner',
    content:
      'Følgende bruk er ikke tillatt og dekkes ikke av forsikring: riving uten skriftlig forhåndsgodkjenning, bruk i vann dypere enn 30 cm, kjøring på offentlig vei uten lovlig grunnlag, bruk under påvirkning av rusmidler eller legemidler som påvirker arbeidsevnen, bruk som overskrider maskinens kapasitet, og videreutleie/fremleie til tredjepart uten skriftlig samtykke. Brudd gir utleier rett til full erstatning utover forsikringens dekning.',
  },
  {
    title: 'Gravemelding og infrastruktur',
    content:
      'Leietaker er ansvarlig for å sende gravemelding til relevante netteiere før gravearbeid, og for å undersøke om det finnes kabler, rør eller annen underjordisk infrastruktur. Utleier er ikke ansvarlig for skader på underjordisk infrastruktur som oppstår under leietakers bruk. Den nasjonale gravemeldingstjenesten driftes av Geomatikk (geomatikk.no). Utleier er ikke ansvarlig for innhold på eller tilgjengelighet av tredjeparts nettsteder det vises til i disse vilkårene.',
  },
  {
    title: 'Geografisk område',
    content:
      'Levering og henting skjer innenfor {{maxDeliveryRadius}} km fra utleiers utgangspunkt. Utstyret skal ikke transporteres ut av dette området uten skriftlig samtykke.',
  },
  {
    title: 'Levering og henting',
    content:
      'Levering og henting avtales i tilbudet. Med mindre annet er avtalt er levering/henting inkludert inntil {{deliveryIncludedKm}} km hver vei, deretter {{deliveryPerKm}} kr per km. Minimumsgebyr: {{minDeliveryFee}} kr. Leveringsområde: {{serviceArea}}.',
  },
  {
    title: 'Drivstoff og forbruksmateriell',
    content:
      'Med mindre annet avtales i tilbudet leveres utstyret med drivstoff for leieperioden. Smøremidler og forbruksmateriell som påkreves ved normal bruk dekkes av utleier.',
  },
  {
    title: 'Forsikring og egenandel',
    content:
      'Maskinen er forsikret med kasko-/maskinskadedekning og ansvarsforsikring overfor tredjepart. Forsikringen dekker ikke skader som oppstår ved brudd på bruksvilkårene eller på krav om dokumentert opplæring. Leietaker er ansvarlig for egenandelen ved skader vedkommende forårsaker, inntil {{egenandel}} kr per skadetilfelle. Fører forsikringsbrudd hos leietaker til at forsikringen avkortes eller faller bort, er leietaker fullt ut ansvarlig for hele det udekkede tapet, uten begrensning til egenandelen.',
  },
  {
    title: 'Sikkerhet og utlevering',
    content:
      'Ved utlevering gjennomføres en overlevering med gjennomgang av maskinens grenser og bruksrestriksjoner. Utstyret inspiseres sammen med leietaker, og eksisterende skader dokumenteres med foto. Leietaker bekrefter mottak og forsvarlig stand ved signatur på utleveringsprotokollen.',
  },
  {
    title: 'Betaling',
    content:
      'Pris og betalingsbetingelser fremgår av tilbudet/bekreftelsen. Der ikke annet er avtalt forfaller leien til betaling før utlevering. Avtales fakturering, gjelder forfall netto per avtale; ved forsinket betaling påløper forsinkelsesrente etter forsinkelsesrenteloven samt purregebyr.',
  },
  {
    title: 'Avbestilling',
    content:
      'Gratis avbestilling inntil {{cancelFreeLabel}} før avtalt leiestart. Senere avbestilling: {{cancelLatePercent}} % av leieprisen. Samme dag eller no-show: {{cancelSameDayPercent}} % av leieprisen. For særskilt tilrettelagte tilbud kan egne avbestillingsvilkår avtales i tilbudet.',
  },
  {
    title: 'Skader og leietakers ansvar',
    content:
      'Leietaker er ansvarlig for skader forårsaket av uforsvarlig bruk, brudd på disse vilkårene, manglende dokumentert opplæring eller manglende vedlikehold under leieperioden. Normal slitasje er utleiers ansvar. Leietaker er ansvarlig for å sikre utstyret mot tyveri og hærverk i leieperioden. Skader og tyveri skal rapporteres til utleier umiddelbart, og senest ved retur.',
  },
  {
    title: 'Retur og rengjøring',
    content:
      'Utstyret skal returneres i rimelig ren stand til avtalt tid. Vask av normal jord og skitt etter ordinært gravearbeid er inkludert. Unødig skitten retur ut over dette medfører rengjøringsgebyr på 500 kr. Herdende eller klebrige materialer (asfalt, betong, tjære, maling, lim, fugemasse, kjemikalier og liknende) regnes ikke som normal skitt; leietaker er ansvarlig for å fjerne alle rester før retur, og faktisk rengjørings- og utbedringskostnad faktureres i sin helhet i tillegg til eventuell skade dette har påført utstyret. Forsinket retur kan medføre tilleggsgebyr tilsvarende overtidspris frem til faktisk retur.',
  },
  {
    title: 'Ansvarsbegrensning',
    content:
      'Utleier er ikke ansvarlig for leietakers indirekte tap, herunder driftsavbrudd, tapt fortjeneste, forsinkelser i leietakers prosjekter eller krav fra leietakers oppdragsgivere. Utleiers samlede ansvar er under enhver omstendighet begrenset til leiebeløpet for det aktuelle leieforholdet.',
  },
  {
    title: 'Personopplysninger',
    content:
      'Utleier behandler personopplysninger i samsvar med personopplysningsloven og GDPR. Booking-data, kontaktinfo og dokumentasjon knyttet til leieforholdet lagres så lenge det er nødvendig for å oppfylle avtalen og lovpålagte regnskaps- og forsikringskrav.',
  },
  {
    title: 'Tvister',
    content:
      'Tvister forsøkes løst i minnelighet. Hvis dette ikke fører frem, avgjøres tvisten av de alminnelige norske domstoler. Verneting er Salten tingrett.',
  },
  {
    title: 'Kontakt',
    content:
      'Utleier kan kontaktes på {{contactEmail}} eller {{contactPhone}}. Nettside: {{siteUrl}}.',
  },
];

/**
 * Seed default forbruker TOC sections if and only if no consumer sections
 * exist. Idempotent: safe to call on every boot.
 */
export async function ensureDefaultTermsSeeded(): Promise<{ seeded: boolean; count: number }> {
  const existing = await db.termsSection.count({ where: { audience: 'consumer' } });
  if (existing > 0) return { seeded: false, count: existing };
  await db.termsSection.createMany({
    data: DEFAULTS.map((s, i) => ({
      title: s.title,
      content: s.content,
      sortOrder: i,
      isActive: true,
      audience: 'consumer',
    })),
  });
  return { seeded: true, count: DEFAULTS.length };
}

/**
 * Seed default bedrift (B2B) TOC sections if and only if no business
 * sections exist. Idempotent.
 */
export async function ensureDefaultBusinessTermsSeeded(): Promise<{ seeded: boolean; count: number }> {
  const existing = await db.termsSection.count({ where: { audience: 'business' } });
  if (existing > 0) return { seeded: false, count: existing };
  await db.termsSection.createMany({
    data: BUSINESS_DEFAULTS.map((s, i) => ({
      title: s.title,
      content: s.content,
      sortOrder: i,
      isActive: true,
      audience: 'business',
    })),
  });
  return { seeded: true, count: BUSINESS_DEFAULTS.length };
}
