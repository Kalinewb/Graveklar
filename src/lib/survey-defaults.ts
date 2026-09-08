// survey-defaults.ts
// Seeded default question set for the Behovsundersøkelse (Graveklar).
// Seed into SurveyQuestion when the table is empty (mirror faq-defaults.ts).
// `options` and `config` are serialized to JSON when written to the String columns.
// Everything here is editable in the admin builder after seeding.
//
// Ordering renders as ~8 wizard steps grouped by `section`, in sortOrder.
// Implementation notes for the seeder/components:
//   - price-callout pulls helg/uke prices LIVE from PricingConfig; the {{helgpris}}
//     / {{ukepris}} tokens are substituted at render time. Do not hardcode prices.
//   - The forvpris_helg range should render with NO pre-set handle (start unset and
//     require the user to move it). A default value would anchor the answer.
//   - `epost` is the only field that de-anonymizes a response. Keep it last and
//     optional; the consent checkbox is required only if an email is entered.

export type SeedQuestion = {
  key: string;
  type:
    | "intro"
    | "radio"
    | "check"
    | "likert"
    | "range"
    | "text"
    | "email"
    | "price-callout";
  section: string;
  label: string;
  hint?: string;
  options?: string[];
  config?: Record<string, unknown>;
  required: boolean;
  sortOrder: number;
};

export const surveyDefaults: SeedQuestion[] = [
  // ── Intro ────────────────────────────────────────────────────────────────
  {
    key: "intro",
    type: "intro",
    section: "Intro",
    label: "Hjelp oss å forme Graveklar",
    hint:
      "Vi vurderer å tilby selvbetjent leie av minigraver til private i Salten-regionen. " +
      "Undersøkelsen tar omtrent to minutter. Svarene er anonyme med mindre du selv legger " +
      "igjen e-post til slutt.[[rabatt]] Legger du igjen e-post, får du {{rabatt}} rabatt ved lansering.[[/rabatt]]",
    required: false,
    sortOrder: 0,
  },

  // ── Behov (demand – the core signal) ──────────────────────────────────────
  {
    key: "hatt",
    type: "radio",
    section: "Behov",
    label:
      "Har du de siste to årene hatt et prosjekt hjemme der en minigraver hadde vært nyttig?",
    options: [
      "Ja, og jeg gjorde det selv (leide eller lånte maskin)",
      "Ja, men jeg leide inn noen til å gjøre jobben",
      "Ja, men jeg lot det være eller gjorde det for hånd",
      "Nei",
    ],
    required: true,
    sortOrder: 10,
  },
  {
    key: "planlagt",
    type: "radio",
    section: "Behov",
    label:
      "Har du et konkret prosjekt de neste 12 månedene der du kunne trengt å grave, planere eller drenere?",
    hint: "Tenk for eksempel drenering, grøft, planering, grunnarbeid eller hagearbeid.",
    options: ["Ja, innen 6 måneder", "Ja, i løpet av året", "Kanskje", "Nei"],
    required: true,
    sortOrder: 20,
  },
  {
    key: "jobber",
    type: "check",
    section: "Behov",
    label: "Hvilke typer arbeid kunne dette vært? Velg det som passer.",
    options: [
      "Drenering",
      "Grøft for vann, strøm eller avløp",
      "Planering eller masseflytting",
      "Grunnarbeid (platting, grunnmur, støttemur)",
      "Hage og uteområde",
      "Fjerne stubber, røtter eller stein",
      "Snørydding",
      "Annet",
    ],
    required: false,
    sortOrder: 30,
  },
  {
    key: "leieperiode",
    type: "check",
    section: "Behov",
    label: "Hvilke leieperioder ville vært aktuelle for deg?",
    hint: "Velg gjerne flere.",
    options: [
      "Et døgn",
      "En helg (fredag–mandag)",
      "En hel uke",
      "Lengre enn en uke",
    ],
    required: false,
    sortOrder: 35,
  },
  {
    key: "prosjekt",
    type: "text",
    section: "Behov",
    label: "Vil du beskrive prosjektet kort? (valgfritt)",
    hint:
      "Et par ord hjelper oss å forstå behovet – for eksempel «drenere rundt huset» " +
      "eller «planere tomt til garasje».",
    required: false,
    sortOrder: 40,
  },

  // ── Om deg (segment) ──────────────────────────────────────────────────────
  {
    key: "bolig",
    type: "radio",
    section: "Om deg",
    label: "Hva slags bolig bor du i?",
    options: [
      "Enebolig",
      "Rekkehus eller tomannsbolig",
      "Leilighet",
      "Hytte eller fritidsbolig",
      "Gård eller landbrukseiendom",
      "Annet",
    ],
    required: true,
    sortOrder: 50,
  },
  {
    key: "postnr",
    type: "text",
    section: "Om deg",
    label: "Hvilket postnummer bor du i?",
    hint:
      "Vi bruker dette kun til å forstå hvor i regionen behovet er – ikke til å kontakte deg.",
    config: { placeholder: "8000", maxLength: 4, inputMode: "numeric" },
    required: true,
    sortOrder: 60,
  },
  {
    key: "alder",
    type: "radio",
    section: "Om deg",
    label: "Hvor gammel er du?",
    hint: "Leie krever at du er minst 21 år.",
    options: ["Under 21", "21–29", "30–44", "45–59", "60 eller eldre"],
    required: true,
    sortOrder: 70,
  },

  // ── Praktisk (dry-hire qualifiers) ────────────────────────────────────────
  {
    key: "selvkjore",
    type: "radio",
    section: "Praktisk",
    label: "Hvor komfortabel ville du vært med å kjøre minigraveren selv, uten fører?",
    hint:
      "Maskinen er under 5 tonn, så det kreves ikke maskinførerkort for privat bruk.",
    options: [
      "Helt komfortabel",
      "Litt usikker, men ville prøvd",
      "Usikker – ville trengt opplæring først",
      "Ville ikke kjørt selv",
    ],
    required: true,
    sortOrder: 80,
  },
  {
    key: "transport",
    type: "radio",
    section: "Praktisk",
    label: "Hvordan ville du fått maskinen til og fra arbeidsstedet?",
    hint:
      "Maskin og tilhenger veier til sammen mer enn 750 kg, så selvhenting krever førerkort klasse BE.",
    options: [
      "Jeg har klasse BE og kan hente med tilhenger selv",
      "Jeg vil at maskinen leveres og hentes",
      "Jeg er usikker",
    ],
    required: true,
    sortOrder: 90,
  },

  // ── Forventet pris (unprompted WTP — its OWN step, before any price is shown
  //    so the real price can't anchor the answer) ──────────────────────────────
  {
    key: "forvpris_helg",
    type: "range",
    section: "Forventet pris",
    label:
      "Hva ville du forventet at det koster å leie en minigraver en helg (fredag–mandag, {{helgtimer}} timer inkludert), med forsikring og levering?",
    hint: "Dra i glidebryteren. Det finnes ikke noe fasitsvar – vi er ute etter hva du tenker.",
    config: { min: 500, max: 10000, step: 250, unit: "kr" }, // no `def`: start unset
    required: true,
    sortOrder: 100,
  },

  // ── Vår pris (reveal → reaction — a SEPARATE step after the slider) ──────────
  {
    key: "pris_faktisk",
    type: "price-callout",
    section: "Vår pris",
    label: "Slik tenker vi å prise det",
    hint:
      "En helg (fredag kl. 12 til mandag kl. 09) koster {{helgpris}} inkludert forsikring, " +
      "diesel og levering innenfor 40 km. En hel uke koster {{ukepris}}.",
    config: { source: "pricing", periods: ["helg", "uke"] },
    required: false,
    sortOrder: 110,
  },
  {
    key: "prisreaksjon",
    type: "likert",
    section: "Vår pris",
    label: "Hvordan opplever du den helgeprisen?",
    options: ["Altfor dyrt", "Litt dyrt", "Helt greit", "Billigere enn ventet"],
    required: true,
    sortOrder: 120,
  },

  // ── Hva er viktig (priorities + self-service validation) ───────────────────
  {
    key: "viktig",
    type: "check",
    section: "Hva er viktig",
    label: "Hva er viktigst for deg når du leier? Velg inntil tre.",
    options: [
      "Lav pris",
      "Enkel bestilling på nett",
      "Levering til arbeidsstedet",
      "Forsikring inkludert",
      "Fleksible hente- og leveringstider",
      "Hjelp og opplæring ved behov",
      "At maskinen er ledig når jeg trenger den",
    ],
    config: { max: 3 },
    required: true,
    sortOrder: 130,
  },
  {
    key: "booking",
    type: "likert",
    section: "Hva er viktig",
    label:
      "Hvor komfortabel er du med å bestille og betale alt på nett, uten å snakke med noen?",
    options: ["Helt komfortabel", "Greit nok", "Vil helst ringe først", "Ville ikke gjort det"],
    required: true,
    sortOrder: 140,
  },

  // ── Hvordan finner du oss (acquisition + seasonality) ──────────────────────
  {
    key: "finne",
    type: "check",
    section: "Hvordan finner du oss",
    label: "Hvor ville du lett etter en slik tjeneste? Velg det som passer.",
    options: [
      "Google-søk",
      "Facebook",
      "Lokale Facebook-grupper",
      "Finn.no",
      "Anbefaling fra noen jeg kjenner",
      "Annet",
    ],
    required: false,
    sortOrder: 150,
  },
  {
    key: "sesong",
    type: "check",
    section: "Hvordan finner du oss",
    label: "Når på året er det mest aktuelt for deg?",
    options: ["Vår", "Sommer", "Høst", "Vinter"],
    required: false,
    sortOrder: 160,
  },

  // ── Hva stopper deg (barriers – structured + free text) ────────────────────
  {
    key: "stopper",
    type: "check",
    section: "Hva stopper deg",
    label: "Hva ville eventuelt holdt deg tilbake fra å leie en minigraver selv?",
    options: [
      "Prisen er for høy",
      "Jeg vet ikke hvordan jeg skal bruke den / er usikker",
      "Jeg har ikke klasse BE eller får ikke fraktet den",
      "Jeg har ingen måte å transportere den på",
      "Redd for å skade maskinen eller egenandelen",
      "Prosjektet mitt er for lite",
      "Visste ikke at man kunne leie uten fører",
      "Vil heller leie inn noen til å gjøre jobben",
      "Ingenting – jeg ville gjerne leid",
    ],
    required: false,
    sortOrder: 170,
  },
  {
    key: "stopper_fri",
    type: "text",
    section: "Hva stopper deg",
    label: "Noe annet som stopper deg? (valgfritt)",
    required: false,
    sortOrder: 180,
  },

  // ── Få rabatten (lead capture – LAST, after all demand/pricing answers) ─────
  {
    key: "epost",
    type: "email",
    section: "Til slutt",
    label: "Vil du få beskjed når vi åpner?",
    hint:
      "Legg igjen e-posten din, så sender vi deg beskjed når vi åpner for booking. " +
      "Helt valgfritt – du kan sende inn svarene uten.[[rabatt]] Du får også {{rabatt}} rabatt ved lansering.[[/rabatt]]",
    config: {
      consentRequired: true,
      consentLabel:
        "Meld meg på e-postlisten[[rabatt]] og send meg rabattkoden[[/rabatt]] ved lansering. Jeg kan melde meg av når som helst.",
    },
    required: false,
    sortOrder: 190,
  },
];

// ───────────────────────────────────────────────────────────────────────────
// OPTIONAL: rigorous pricing block (Van Westendorp Price Sensitivity Meter).
// Swap these four in PLACE OF forvpris_helg + prisreaksjon in the "Pris" section
// if you want a defensible acceptable-price range / optimal price point instead
// of the lighter expectation→reveal→reaction. Four neutral questions, no anchor.
// Keep the price-callout AFTER these if you still want to show the real price.
// ───────────────────────────────────────────────────────────────────────────
export const priceSensitivityVanWestendorp: SeedQuestion[] = [
  {
    key: "vw_billig",
    type: "range",
    section: "Pris",
    label:
      "Til hvilken helgepris ville du tenkt at maskinen er så billig at du ble usikker på kvaliteten?",
    config: { min: 0, max: 10000, step: 250, unit: "kr" },
    required: true,
    sortOrder: 100,
  },
  {
    key: "vw_rimelig",
    type: "range",
    section: "Pris",
    label: "Til hvilken helgepris ville du tenkt at dette er rimelig – et godt kjøp?",
    config: { min: 0, max: 10000, step: 250, unit: "kr" },
    required: true,
    sortOrder: 102,
  },
  {
    key: "vw_dyrt",
    type: "range",
    section: "Pris",
    label:
      "Fra hvilken helgepris begynner det å bli dyrt, men fortsatt noe du ville vurdert?",
    config: { min: 0, max: 10000, step: 250, unit: "kr" },
    required: true,
    sortOrder: 104,
  },
  {
    key: "vw_fordyrt",
    type: "range",
    section: "Pris",
    label:
      "Fra hvilken helgepris er det så dyrt at du ikke ville vurdert det i det hele tatt?",
    config: { min: 0, max: 10000, step: 250, unit: "kr" },
    required: true,
    sortOrder: 106,
  },
];
