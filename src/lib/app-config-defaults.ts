export interface AppConfigItem {
  key: string;
  value: string;
  label: string;
  group: string;
  type: string;
  isPublic: boolean;
  sortOrder: number;
  /** Optional short explanation shown next to the field label in admin — what
   *  the setting does and its practical effect. Only add where the label
   *  alone leaves the effect ambiguous; most fields don't need one. */
  hint?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config taxonomy invariants
//
// A key MUST belong to exactly one semantic axis. When adding a new key,
// pick the bucket by what the value REPRESENTS, not where it's rendered:
//
//   business      Identity & contact facts about the business itself.
//   rental-types  Which rental forms exist + their schedule shape.
//   booking       Time/availability/lifecycle rules on bookings.
//   pricing       Reserved — numeric prices live in PricingConfig table.
//   stripe        Payment provider configuration. SENSITIVE.
//   smtp          Outgoing email configuration. SENSITIVE.
//   content       Text only — copy, headings, SEO keywords.
//   ui            Toggles only — render / no render. Boolean type.
//   theme         Visual system — colors, image effects, hero image.
//   signals       Data that influences defaults (popular machine, etc.).
//   terms         Cancellation policy & contract policy.
//   system        Operational toggles — maintenance, geo origin.
//
// The split between content/ui/theme/signals exists so a single feature
// change doesn't accidentally couple text edits to visual or behavioural
// changes. If you find yourself wanting to put a toggle into `signals` or
// a color into `content`, the bucket is wrong — fix the bucket.
// ─────────────────────────────────────────────────────────────────────────────

export const APP_CONFIG_DEFAULTS: AppConfigItem[] = [
  // ── Virksomhet (Business) ─────────────────────────────
  { key: 'businessName',    value: 'Graveklar', label: 'Virksomhetsnavn',        group: 'business', type: 'text',   isPublic: true,  sortOrder: 0 },
  { key: 'orgNumber',       value: '',          label: 'Organisasjonsnummer',    group: 'business', type: 'text',   isPublic: true,  sortOrder: 1 },
  { key: 'contactEmail',    value: '',          label: 'Kontakt-e-post',         group: 'business', type: 'email',  isPublic: true,  sortOrder: 2 },
  { key: 'contactPhone',    value: '',          label: 'Telefon',                group: 'business', type: 'text',   isPublic: true,  sortOrder: 3 },
  { key: 'serviceArea',     value: '',          label: 'Tjenesteområde',         group: 'business', type: 'text',   isPublic: true,  sortOrder: 4 },
  { key: 'businessAddress', value: '',          label: 'Forretningsadresse',     group: 'business', type: 'text',   isPublic: true,  sortOrder: 5 },
  { key: 'siteUrl',         value: '',          label: 'Nettside-URL',           group: 'business', type: 'url',    isPublic: true,  sortOrder: 6 },
  { key: 'bookingCount',    value: '0',         label: 'Gjennomførte bookinger (vises på nettside)', group: 'business', type: 'number', isPublic: true, sortOrder: 7 },
  { key: 'bookingCountMin', value: '10',        label: 'Vis «gjennomførte bookinger» først ved (minimum)', group: 'business', type: 'number', isPublic: true, sortOrder: 7 },
  // Brand logo + where it's used. Upload once, then toggle each surface on/off.
  // Image type → ImageDropzone; the toggles → Toggle controls, rendered right
  // under the logo in the Virksomhet settings.
  { key: 'logoUrl',         value: '',          label: 'Logo',                              group: 'business', type: 'image',   isPublic: true, sortOrder: 8 },
  { key: 'logoInHeader',    value: 'true',      label: 'Bruk logo i nettside-header',       group: 'business', type: 'boolean', isPublic: true, sortOrder: 9 },
  { key: 'logoAsFavicon',   value: 'false',     label: 'Bruk logo som faneikon (nettleser)', group: 'business', type: 'boolean', isPublic: true, sortOrder: 10 },
  { key: 'logoOnContract',  value: 'true',      label: 'Vis logo på kontraktutskrift',      group: 'business', type: 'boolean', isPublic: true, sortOrder: 11 },

  // ── Leietyper (Rental types) ──────────────────────────
  { key: 'enabledRentalTypes', value: 'day,weekend,week',        label: 'Aktive leietyper',        group: 'rental-types', type: 'rental-type-toggles', isPublic: true, sortOrder: 0 },
  { key: 'dayAllowedDays',     value: '1,2,3,4',                 label: 'Døgn – tillatte ukedager', group: 'rental-types', type: 'day-toggles',         isPublic: true, sortOrder: 1 },
  { key: 'daySchedule',        value: '07:00 – 07:00 neste dag', label: 'Døgn – visningstekst',    group: 'rental-types', type: 'text',                isPublic: true, sortOrder: 2 },
  { key: 'weekendStartDay',    value: '5',                       label: 'Helg – startdag',         group: 'rental-types', type: 'weekday',                isPublic: true, sortOrder: 3, hint: 'Styrer hvilken ukedag helgeprisen begynner på. Sammen med «Uke – startdag» avgjør denne hvilke dager som regnes som helg (høyere pris) og hvilke som er vanlige dager — og påvirker dermed hvilke dager som er tillatt for Døgn-leie (dayAllowedDays).' },
  { key: 'weekendSchedule',    value: 'Fre 15:00 – Man 07:00',   label: 'Helg – visningstekst',    group: 'rental-types', type: 'text',                isPublic: true, sortOrder: 4 },
  { key: 'weekStartDay',       value: '1',                       label: 'Uke – startdag',          group: 'rental-types', type: 'weekday',                isPublic: true, sortOrder: 5, hint: 'Styrer hvilken ukedag ukeleien begynner på. Brukes sammen med «Helg – startdag» for å avgjøre hvilke dager som regnes som helg vs. vanlige dager — og påvirker dermed hvilke dager som er tillatt for Døgn-leie (dayAllowedDays).' },
  { key: 'weekSchedule',       value: 'Man 07:00 – Man 07:00',   label: 'Uke – visningstekst',     group: 'rental-types', type: 'text',                isPublic: true, sortOrder: 6 },

  // ── Booking ───────────────────────────────────────────
  // Lifecycle + cancellation rules (the old Vilkår group was merged here:
  // cancellation IS a booking lifecycle rule, not a legal-text concept).
  // bookingEnabled removed — maintenanceMode is the single switch that gates
  // both customer page AND booking creation. Two flags created
  // "which one is off?" confusion with no operational upside.
  { key: 'bookingMaxAdvanceDays', value: '365',  label: 'Maks forhåndsbestilling (dager)',   group: 'booking', type: 'number',         isPublic: true, sortOrder: 1 },
  { key: 'minBookingDaysAhead',   value: '0',    label: 'Minimum dager i forveien (0 = ingen)', group: 'booking', type: 'number',     isPublic: true, sortOrder: 2 },
  { key: 'defaultMachineId',      value: '',     label: 'Standardutstyr (forvalgt)',         group: 'booking', type: 'machine-select', isPublic: true, sortOrder: 3 },
  { key: 'cancelFreeWeeks',       value: '0',    label: 'Gratis avbestilling (uker før start)',  group: 'booking', type: 'number',   isPublic: true, sortOrder: 4 },
  { key: 'cancelFreeDays',        value: '2',    label: 'Gratis avbestilling (dager før start)', group: 'booking', type: 'number',   isPublic: true, sortOrder: 5 },
  { key: 'cancelLatePercent',     value: '50',   label: 'Gebyr under frist (%)',             group: 'booking', type: 'number',         isPublic: true, sortOrder: 6 },
  { key: 'cancelSameDayPercent',  value: '100',  label: 'Gebyr samme dag / no-show (%)',     group: 'booking', type: 'number',         isPublic: true, sortOrder: 7 },
  // Contract variables — surfaced in the rendered TOC via {{egenandel}} /
  // {{minAge}}. Previously hardcoded in terms-template.ts which meant the
  // legal contract drifted from admin reality.
  { key: 'egenandel',             value: '5000', label: 'Egenandel ved skade (kr)',          group: 'booking', type: 'number',         isPublic: true, sortOrder: 8 },
  { key: 'minAge',                value: '21',   label: 'Minimumsalder leietaker',           group: 'booking', type: 'number',         isPublic: true, sortOrder: 9 },
  // Turnaround buffer: auto-reserve the prep day before and/or the cleanup
  // day after each booking so back-to-back rentals leave room for delivery
  // inspection and wash/return. Default on (matches prior hardcoded
  // behaviour); turn off to allow bookings on adjacent days.
  { key: 'blockDayBeforeBooking', value: 'true', label: 'Blokker dagen før booking (klargjøring)',  group: 'booking', type: 'boolean', isPublic: true, sortOrder: 10, hint: 'Blokkerer kalenderdagen rett før bookingen automatisk, som buffer til klargjøring/levering. Hindrer at neste kunde kan booke inntil denne bookingen starter.' },
  { key: 'blockDayAfterBooking',  value: 'true', label: 'Blokker dagen etter booking (vask/retur)', group: 'booking', type: 'boolean', isPublic: true, sortOrder: 11, hint: 'Blokkerer kalenderdagen rett etter bookingen automatisk, som buffer til vask/retur. Hindrer at neste kunde kan booke rett etter at denne bookingen slutter.' },
  { key: 'renterChecklistEnabled', value: 'true', label: 'Aktiver QR-sjekkliste for leietakere', group: 'booking', type: 'boolean', isPublic: true, sortOrder: 12 },

  // ── Stripe (SENSITIVE) ────────────────────────────────
  { key: 'stripePublishableKey', value: '',      label: 'Publishable Key (pk_…)',   group: 'stripe', type: 'text',     isPublic: false, sortOrder: 0 },
  { key: 'stripeSecretKey',      value: '',      label: 'Secret Key (sk_…)',        group: 'stripe', type: 'password', isPublic: false, sortOrder: 1 },
  { key: 'stripeWebhookSecret',  value: '',      label: 'Webhook Secret (whsec_…)', group: 'stripe', type: 'password', isPublic: false, sortOrder: 2 },
  { key: 'stripeEnabled',        value: 'false', label: 'Aktiver Stripe',           group: 'stripe', type: 'boolean',  isPublic: false, sortOrder: 3 },
  // Vipps in Stripe Checkout is still a Stripe beta: the account must be
  // granted the `vipps_preview` header by Stripe first. Off by default — with
  // it on but no access, Checkout creation falls back to the stable API and
  // logs a warning rather than failing the payment.
  { key: 'stripeVippsPreview',   value: 'false', label: 'Vipps via Stripe (forhåndsvisning – krever tilgang fra Stripe)', group: 'stripe', type: 'boolean', isPublic: false, sortOrder: 4 },

  // ── Vipps MobilePay (SENSITIVE) ──────────────────────
  // Native ePayment API integration — independent of the Stripe beta above.
  // Credentials come from portal.vippsmobilepay.com → Utvikler.
  { key: 'vippsEnabled',         value: 'false', label: 'Aktiver Vipps',            group: 'vipps', type: 'boolean',  isPublic: false, sortOrder: 0 },
  { key: 'vippsEnvironment',     value: 'test',  label: 'Miljø',                    group: 'vipps', type: 'text',     isPublic: false, sortOrder: 1, hint: 'test = apitest.vipps.no (testbrukere, ingen ekte penger). production = ekte betalinger.' },
  { key: 'vippsClientId',        value: '',      label: 'Client ID',                group: 'vipps', type: 'text',     isPublic: false, sortOrder: 2 },
  { key: 'vippsClientSecret',    value: '',      label: 'Client Secret',            group: 'vipps', type: 'password', isPublic: false, sortOrder: 3 },
  { key: 'vippsSubscriptionKey', value: '',      label: 'Subscription Key (Ocp-Apim)', group: 'vipps', type: 'password', isPublic: false, sortOrder: 4 },
  { key: 'vippsMsn',             value: '',      label: 'Merchant Serial Number',   group: 'vipps', type: 'text',     isPublic: false, sortOrder: 5, hint: '6-sifret salgsenhetsnummer.' },
  // Returned once when the webhook is registered (scripts/register-vipps-webhook.ts)
  // and never readable again. Without it every incoming webhook is rejected.
  { key: 'vippsWebhookSecret',   value: '',      label: 'Webhook Secret',           group: 'vipps', type: 'password', isPublic: false, sortOrder: 6, hint: 'Vises kun én gang ved registrering av webhook.' },

  // ── E-post / SMTP (SENSITIVE) ────────────────────────
  { key: 'smtpHost',   value: '',      label: 'SMTP-server',                          group: 'smtp', type: 'text',     isPublic: false, sortOrder: 0 },
  { key: 'smtpPort',   value: '587',   label: 'SMTP-port',                            group: 'smtp', type: 'number',   isPublic: false, sortOrder: 1 },
  { key: 'smtpSecure', value: 'false', label: 'TLS/SSL (bruk port 465)',              group: 'smtp', type: 'boolean',  isPublic: false, sortOrder: 2 },
  { key: 'smtpUser',   value: '',      label: 'SMTP-brukernavn',                      group: 'smtp', type: 'text',     isPublic: false, sortOrder: 3 },
  { key: 'smtpPass',   value: '',      label: 'SMTP-passord',                         group: 'smtp', type: 'password', isPublic: false, sortOrder: 4 },
  { key: 'smtpFrom',   value: '',      label: 'Avsenderadresse (Navn <e-post>)',      group: 'smtp', type: 'text',     isPublic: false, sortOrder: 5 },
  { key: 'adminEmail', value: '',      label: 'Admin-e-post (mottar nye bookinger)',  group: 'smtp', type: 'email',    isPublic: false, sortOrder: 6 },

  // ── Innhold (Content) — TEXT ONLY ─────────────────────
  { key: 'heroHeading', value: '{kategori} levert på døra.',                                                                                              label: 'Hero-overskrift (bruk {kategori} for rullerende ord)', group: 'content', type: 'text',     isPublic: true, sortOrder: 0 },
  { key: 'heroTagline', value: 'Alt inkludert.',                                                                                                          label: 'Hero-tagline (linjen under overskriften)',              group: 'content', type: 'text',     isPublic: true, sortOrder: 1 },
  { key: 'heroSubtext', value: 'Velg dato, vi leverer, du graver. Fastpris fra {pris} kr – inkludert levering, drivstoff, forsikring og vask. Ingen overraskelser.', label: 'Hero-undertekst (bruk {pris} for dynamisk dagspris)', group: 'content', type: 'textarea', isPublic: true, sortOrder: 2 },
  { key: 'seoTitle',       value: '',                                                                                                                        label: 'SEO-tittel (Google/sosiale medier)',                     group: 'content', type: 'text',     isPublic: true, sortOrder: 3 },
  { key: 'seoDescription', value: '',                                                                                                                        label: 'SEO-beskrivelse (maks ~160 tegn)',                       group: 'content', type: 'textarea', isPublic: true, sortOrder: 4 },
  // Editable front-page notes. `{{token}}` pulls the live number so the copy
  // can never drift from the settings the booking form actually charges —
  // that drift is exactly what put "179 kr" in the terms while admin billed
  // 500. `**bold**` marks the phrase the card leans on. Tokens available:
  // deliveryIncludedKm, deliveryPerKm, minDeliveryFee, maxDeliveryRadius,
  // preOrderHourRate, overtimeRate, serviceArea, businessName.
  { key: 'pricingIncludedNote', value: '**Hva er inkludert?** **Drivstoff for hele leieperioden**, levering og henting (inntil {{deliveryIncludedKm}} km), forsikring, vask og personlig opplæring. Trenger du litt ekstra tid? Forbestill ekstra timer til kun {{preOrderHourRate}} kr per time.', label: 'Notat under prisene', group: 'content', type: 'textarea', isPublic: true, sortOrder: 6, hint: 'Bruk {{deliveryIncludedKm}}, {{preOrderHourRate}} osv. for tall som følger innstillingene. **tekst** blir uthevet.' },
  { key: 'deliveryNote',        value: '**Prøv det!** Skriv inn adressen din i booking-skjemaet nedenfor for å se nøyaktig leveringspris. Prisen dekker både levering og henting — avstanden måles én vei fra basen vår, og de første {{deliveryIncludedKm}} km er inkludert.', label: 'Notat under leveringsprisen', group: 'content', type: 'textarea', isPublic: true, sortOrder: 7, hint: 'Samme tokens som notatet under prisene.' },
  { key: 'seoKeywords',    value: '',                                                                                                                        label: 'SEO-nøkkelord (kommaseparert – tom = auto fra utstyr/område)', group: 'content', type: 'text', isPublic: true, sortOrder: 5 },

  // ── Visning (UI) — TOGGLES + DISPLAY SIGNALS ─────────
  // Forretningssignaler (popular*) merged in here — they are display
  // defaults, same family as toggles.
  { key: 'showFaqSection',         value: 'true',    label: 'Vis FAQ-seksjon',                group: 'ui', type: 'boolean', isPublic: true, sortOrder: 0 },
  { key: 'showInsuranceSection',   value: 'false',   label: 'Vis forsikringsseksjon',         group: 'ui', type: 'boolean', isPublic: true, sortOrder: 1 },
  { key: 'showTermsSection',       value: 'true',    label: 'Vis vilkårsseksjon',             group: 'ui', type: 'boolean', isPublic: true, sortOrder: 2 },
  { key: 'contactFormEnabled',     value: 'true',    label: 'Vis kontaktskjema (/kontakt)',   group: 'ui', type: 'boolean', isPublic: true, sortOrder: 3 },
  { key: 'reviewsEnabled',         value: 'true',    label: 'Be om kundeomtaler + vis dem på forsiden', group: 'ui', type: 'boolean', isPublic: true, sortOrder: 4 },
  // showNoExperienceClaim, showInsurerLabel, showMostPopular,
  // popularRentalType, popularMachineId removed: a one-machine operator
  // doesn't need 5 knobs for marketing copy. "Mest populær" is now
  // auto-applied to the weekend rental tile (the default popular type)
  // when there's more than 1 machine. The "Ingen erfaring nødvendig"
  // claim, if needed, belongs in the hero copy field, not as a toggle.

  // ── Utseende (Theme) — VISUAL SYSTEM ──────────────────
  { key: 'accentColor',      value: '', label: 'Aksentfarge (hex)',              group: 'theme', type: 'color',  isPublic: true, sortOrder: 0 },
  { key: 'heroImageUrl',     value: '', label: 'Hero-bakgrunnsbilde',            group: 'theme', type: 'image',  isPublic: true, sortOrder: 1 },
  { key: 'defaultTheme',     value: 'light', label: 'Standard fargetema',        group: 'theme', type: 'text',   isPublic: true, sortOrder: 2 },
  // equipmentBgColor and imgVignette removed: niche aesthetic knobs that
  // never moved the needle. Equipment frame now uses the accent color.

  // ── Rabatter (Discounts) — rendered in Priser tab as its own card ───
  // Returns to discount engine: each toggle on its own, percentages capped
  // by the hard ceiling so no stacking explosion can occur.
  { key: 'enableFirstTimeDiscount', value: 'true',  label: 'Aktiver førstegangskunde-rabatt',     group: 'discounts', type: 'boolean', isPublic: false, sortOrder: 0 },
  { key: 'firstTimeDiscountPercent', value: '10',   label: 'Førstegangskunde-rabatt (%)',         group: 'discounts', type: 'number',  isPublic: false, sortOrder: 1 },
  { key: 'enableRepeatDiscount',    value: 'true',  label: 'Aktiver returkunde-kode etter leie',  group: 'discounts', type: 'boolean', isPublic: false, sortOrder: 2 },
  { key: 'repeatDiscountPercent',   value: '10',    label: 'Returkunde-rabatt (%)',               group: 'discounts', type: 'number',  isPublic: false, sortOrder: 3 },
  { key: 'discountHardCap',         value: '40',    label: 'Maksimal samlet rabatt (%)',          group: 'discounts', type: 'number',  isPublic: false, sortOrder: 4, hint: 'Øvre tak for samlet rabatt uansett hvor mange rabattkoder eller -typer som kombineres — ingen kunde kan få mer enn dette, selv om flere rabatter stables.' },

  // ── Delivery (Levering) — rendered in Priser tab, not in sidebar ───
  // baseAddress is the canonical admin-editable origin. On save we geocode
  // it and cache lat/lng in the SystemState.delivery_origin row, never
  // here in AppConfig. AppConfig holds intent; SystemState holds machine
  // state.
  { key: 'baseAddress', value: '', label: 'Utgangsadresse for levering', group: 'delivery', type: 'text', isPublic: false, sortOrder: 0 },

  // ── Behovsundersøkelse (Survey) ───────────────────────
  // surveyMode hides the normal homepage (like maintenanceMode); the lead
  // settings give away a real discount — both belong in a sensitive group.
  { key: 'surveyMode',                value: 'false', label: 'Undersøkelsesmodus (vis undersøkelsen på forsiden)',        group: 'survey', type: 'boolean', isPublic: true,  sortOrder: 0 },
  { key: 'surveyLeadDiscountEnabled', value: 'false', label: 'Tilby rabattkode for e-postpåmelding',                     group: 'survey', type: 'boolean', isPublic: true,  sortOrder: 1 },
  { key: 'surveyLeadDiscountCode',    value: '',      label: 'Rabattkode som deles ut (opprett den under Rabattkoder)',  group: 'survey', type: 'text',    isPublic: false, sortOrder: 2, hint: 'Koden må allerede finnes under Rabattkoder før den fungerer — denne innstillingen oppretter ikke en ny kode automatisk, den bare velger hvilken eksisterende kode som deles ut.' },
  { key: 'surveyLeadDiscountPercent', value: '15',    label: 'Rabattprosent som vises i undersøkelsen',                  group: 'survey', type: 'number',  isPublic: true,  sortOrder: 3 },

  // ── System ────────────────────────────────────────────
  { key: 'maintenanceMode',     value: 'false',                                                  label: 'Vedlikeholdsmodus',       group: 'system', type: 'boolean',  isPublic: true,  sortOrder: 0 },
  { key: 'maintenanceMessage',  value: 'Vi er midlertidig utilgjengelige. Prøv igjen snart.',    label: 'Vedlikeholdsmelding',     group: 'system', type: 'textarea', isPublic: true,  sortOrder: 1 },
  { key: 'showMockBookingPanel', value: 'true',                                                label: 'Vis testbooking i admin', group: 'system', type: 'boolean',  isPublic: false, sortOrder: 2 },
  // Master switch for the B2B/bedrift quote-request flow. Off by default —
  // keep it off until insurance confirms B2B cover in writing and the
  // business terms are reviewed. When off: /bedrift 404s and the public
  // Privat/Bedrift toggle is hidden.
  { key: 'b2bEnabled',          value: 'false',                                                 label: 'Aktiver bedriftsutleie (B2B)', group: 'system', type: 'boolean', isPublic: true,  sortOrder: 3 },
];

// ─────────────────────────────────────────────────────────────────────────────
// Sensitive groups — saves to these require 2FA (Step 4 of the cleanup).
// Anything that affects money flow, time/availability of the booking
// system, or breaks public access goes here.
// ─────────────────────────────────────────────────────────────────────────────
export const SENSITIVE_GROUPS = new Set<string>([
  'stripe',
  'vipps',
  'smtp',
  'pricing',        // PricingConfig table — see config-defaults.ts
  'booking',        // now includes cancellation (was the Vilkår group)
  'rental-types',
  'delivery',       // baseAddress; affects delivery distance math
  'discounts',      // discount % + toggles directly affect revenue
  'survey',         // surveyMode hides the public site; lead discount affects revenue
  'system',
]);

export const APP_CONFIG_GROUP_LABELS: Record<string, string> = {
  business:       'Virksomhet',
  'rental-types': 'Leietyper',
  booking:        'Booking',
  discounts:      'Rabatter',
  stripe:         'Stripe',
  vipps:          'Vipps MobilePay',
  smtp:           'E-post (SMTP)',
  content:        'Innhold',
  ui:             'Visning',
  theme:          'Utseende',
  survey:         'Behovsundersøkelse',
  system:         'System',
  // delivery is intentionally absent — `baseAddress` is rendered inside
  // the Priser tab next to the numeric delivery rates, not as its own
  // Innstillinger sidebar entry.
};

// 'discounts' is intentionally excluded — the 5 discount keys are still
// stored in AppConfig (so the engine can read them) but the UI for editing
// them lives on /admin/discount-codes, not the Innstillinger sidebar.
export const APP_CONFIG_GROUP_ORDER = [
  'business',
  'rental-types',
  'booking',
  'vipps',
  'stripe',
  'smtp',
  'content',
  'ui',
  'theme',
  'survey',
  'system',
];

/**
 * The shipped default for a config key.
 *
 * Used as the render-time fallback for the editable front-page notes: a
 * database created before the key existed has no row for it, and a blank card
 * is a worse outcome than the copy the release shipped with.
 */
export function configDefault(key: string): string {
  return APP_CONFIG_DEFAULTS.find((item) => item.key === key)?.value ?? '';
}
