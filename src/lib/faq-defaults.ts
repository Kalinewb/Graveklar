// Canonical starter FAQ for Graveklar. Single source of truth shared by:
//   - the homepage fallback (rendered only when no FaqItem rows exist), and
//   - scripts/seed-faq.ts (writes these into the DB so they're editable and
//     individually togglable from the admin panel).
//
// Answers reflect the current operating policy (forbruker-only, fixed price
// incl. delivery/fuel/insurance/wash). The numbers below are the seed values
// — once seeded, the admin edits them per-row, so treat these as defaults,
// not the live source of truth. Keep in sync with the AppConfig/PricingConfig
// defaults (minAge, egenandel, cancellation, delivery km/rate, included hours).

export interface FaqDefault {
  question: string;
  answer: string;
}

export const FAQ_DEFAULTS: FaqDefault[] = [
  {
    question: 'Trenger jeg kurs eller maskinførerbevis?',
    answer:
      'Nei. For privat bruk på egen eiendom kreves ikke maskinførerbevis. Du får en enkel sikkerhetsgjennomgang ved levering slik at du kommer trygt i gang. Du må være fylt 21 år og kunne fremvise gyldig legitimasjon.',
  },
  {
    question: 'Hva er inkludert i prisen?',
    answer:
      'Fastprisen inkluderer levering og henting (inntil 40 km), drivstoff, forsikring og vask. Ingen skjulte gebyrer – det du ser i bookingen er det du betaler.',
  },
  {
    question: 'Hvordan beregnes leveringsprisen?',
    answer:
      'Levering og henting er inkludert inntil 40 km fra basen vår. For lengre avstander beregnes 37 kr per km, og prisen regnes ut automatisk når du skriver inn adressen i bookingskjemaet. Vi leverer i Bodø og Salten og områdene rundt, inntil 150 km.',
  },
  {
    question: 'Er drivstoff inkludert?',
    answer:
      'Ja. Maskinen leveres med full tank – nok drivstoff for hele leieperioden. Du trenger ikke fylle selv.',
  },
  {
    question: 'Er utstyret forsikret?',
    answer:
      'Ja. Alt utstyr har full kasko- og maskinskadedekning samt ansvarsforsikring. Ved skade er egenandelen 5 000 kr. Merk at forsikringen ikke dekker skader som oppstår ved brudd på bruksvilkårene.',
  },
  {
    question: 'Hva gjør jeg hvis maskinen får problemer under leien?',
    answer:
      'Ring oss med en gang, så hjelper vi deg videre. Utstyret er forsikret, og vi finner en løsning så du kan fullføre jobben.',
  },
  {
    question: 'Hvor lenge kan jeg leie?',
    answer:
      'Du velger mellom døgn (10 timer inkludert), helg fra fredag til mandag (20 timer inkludert) eller uke (60 timer inkludert). Trenger du mer brukstid kan du forhåndsbestille ekstra timer i bookingen.',
  },
  {
    question: 'Hva er reglene for avbestilling?',
    answer:
      'Gratis avbestilling inntil 5 dager før avtalt leiestart. Avbestilling senere enn dette koster 50 % av leieprisen, og samme dag eller ved manglende oppmøte belastes 100 %.',
  },
  {
    question: 'Hvordan betaler jeg?',
    answer:
      'Du betaler trygt med kort (Visa eller Mastercard) ved booking. Betalingen håndteres av Stripe, og du får en bekreftelse på e-post så snart bookingen er bekreftet.',
  },
  {
    question: 'Er det noe maskinen ikke kan brukes til?',
    answer:
      'Utstyret leies kun ut til private (forbrukere). Det kan ikke brukes til riving uten forhåndsgodkjenning, ikke i vann dypere enn 30 cm, og ikke til arbeid som overstiger maskinens kapasitet.',
  },
];
