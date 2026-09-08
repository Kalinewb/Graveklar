-- Graveklar terms fixes (audit follow-up)
-- 1) Fix org number typo in AppConfig footer (matches insurance + terms §1)
UPDATE AppConfig SET value = '937719868' WHERE key = 'orgNumber';

-- 2) Remove duplicated payment paragraphs from "Leieperiode og tider" (sortOrder 2).
--    The payment lines live in their own section "Betaling og priser" (sortOrder 3).
UPDATE TermsSection
SET content = 'Leieperioden starter ved utlevering av utstyret og slutter ved tilbakelevering og kontroll.
Inkluderte driftstimer: døgn – {{dayIncludedHours}} timer; helg (fre–man) – {{weekendIncludedHours}} timer; uke – {{weekIncludedHours}} timer.
Overskridelse av inkluderte timer faktureres med {{overtimeRate}} kr per påbegynt time. Forhåndsbestilte timer koster {{preOrderHourRate}} kr/time.
Utstyret skal returneres til avtalt tidspunkt. Ved forsinket retur uten forhåndsvarsel faktureres {{overtimeRate}} kr per påbegynt time.
Utleier er ikke ansvarlig for forsinkelser ved levering som skyldes trafikk, vær eller andre forhold utenfor utleiers kontroll.',
    updatedAt = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE sortOrder = 2;

-- 3) Close the owner-liability gap in "Skader og leietakers ansvar" (sortOrder 11):
--    if renter breach causes insurer to reduce/deny coverage, renter owes the full
--    uncovered loss (not just the deductible). Also add a theft-securing duty.
UPDATE TermsSection
SET content = 'Normal driftsslitasje er utleiers ansvar.
Leietaker er ansvarlig for skade på utstyret som skyldes uaktsom bruk, brudd på disse vilkårene eller annet klanderverdig forhold.
Ved skade som leietaker er ansvarlig for, og som forsikringen dekker, kan leietaker belastes forsikringens egenandel på opptil 12 000 kr per skadetilfelle.
Dersom leietakers bruk i strid med disse vilkårene fører til at forsikringsselskapet reduserer eller avslår dekning, er leietaker ansvarlig for hele det udekkede tapet, ikke begrenset til egenandelen.
Leietaker plikter å sikre utstyret mot tyveri og skade når det ikke er i bruk. Ved tyveri eller skade som skyldes mangelfull sikring, er leietaker ansvarlig etter de samme reglene som over.
Ved grov uaktsomhet eller forsettlig skade kan utleier kreve full erstatning utover forsikringens dekning.
Reparasjoner skal kun utføres av utleier eller utleiers godkjente verksted. Leietaker skal aldri forsøke å reparere utstyret selv.',
    updatedAt = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE sortOrder = 11;

-- 4) Mirror the reduction/denial wording in "Forsikring" (sortOrder 12) so the
--    insurance section and the liability section line up with how insurers act.
UPDATE TermsSection
SET content = 'Utstyret er forsikret med kasko- og maskinskadedekning.
Ansvarsforsikring dekker skader på tredjepersoner og tredjeparts eiendom i henhold til forsikringsavtalen.
Egenandel ved skade som forsikringen dekker: opptil 12 000 kr per skadetilfelle. Egenandelen belastes leietaker kun dersom leietaker er ansvarlig for skaden.
Forsikringsdekningen kan reduseres eller bortfalle i samsvar med forsikringsavtalen dersom leietaker forsettlig eller uaktsomt bryter disse vilkårene, herunder ved bruk i strid med bruksrestriksjonene (pkt. 8), bruk under påvirkning av rusmidler, bruk av uautoriserte operatører eller forsettlig skade. I slike tilfeller er leietaker ansvarlig for det udekkede tapet, jf. punktet «Skader og leietakers ansvar».
Forsikringsdetaljer, vilkår og dekningsbeløp kan oppgis på forespørsel.',
    updatedAt = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE sortOrder = 12;
