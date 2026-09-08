# Phase 2b — the admin panel, driven through a real browser (area P)

Scope: everything an owner touches after logging in — `/admin` (calendar,
bookings, Priser, Utstyr, Innhold, Sjekklister, Innstillinger), `/admin/login`,
`/admin/discount-codes`, `/admin/survey`, `/admin/audit-log`,
`/admin/bookings/[id]/contract`, `/admin/checklist/[bookingId]`, and the proxy
boundary that gates them.

Run against the neutralised audit instance on `http://localhost:3001` (a copy of
the production database, SMTP blank, Vipps disabled, Stripe in test mode). Two
constraints shaped the whole run and are worth stating up front:

- **2FA was never enrolled.** Every sensitive save was exercised by taking the
  refusal — `401 {requiresTotp, requiresTotpEnrollment}` → the "Sett opp 2FA"
  modal → *Avbryt* → assert nothing was written. `AdminTotp` held zero rows at
  the start of the run and holds zero rows now, and two tests assert that.
- **A second agent was auditing the customer site on the same instance.** No
  price, machine, rental type, booking rule or accent colour was left changed;
  each such assertion reverted immediately.

**17 findings, none of them fixed here** (this phase records; the fix phase
acts). Severity is P1 = money/data loss, P2 = the owner is misled about state,
P3 = real defect with a workaround, P4 = polish.

## Findings

| id | sev | title | where | repro | evidence | status |
| --- | --- | --- | --- | --- | --- | --- |
| P-1 | P2 | A cancelled booking disappears from the admin panel entirely, so the `Slett` button the code renders for it can never be reached | `src/app/admin/page.tsx:2566` (`['confirmed','pending','completed'].includes(b.status)`), counter at `:2286`, `Slett` at `:3802-3808`, drawer closed on cancel at `:1508-1511` | Cancel a booking from its drawer. The drawer closes. Search for it: the counter says **"1 resultat"** while the list underneath says **"Ingen bookinger matcher søket"**. There is no other booking list in the panel, so the row can only be deleted through the API. | `tests/e2e/admin-bookings.e2e.test.ts` → "drops the cancelled booking out of the only list the panel renders" | fixed — the sidebar list keeps cancelled rows behind a «Vis avbestilte» switch (auto-enabled right after a cancellation), one shared predicate now feeds both the counter and the list, and the empty state names the rows it is hiding. `src/app/admin/page.tsx` |
| P-2 | P3 | The drawer's price breakdown hardcodes 25 % MVA and ignores the configured `mvaRate` | `src/app/admin/page.tsx:3596` (`Math.round(total / 1.25)`), literal `MVA 25 %` at `:3633` | Change `mvaRate` in Priser; the drawer and the printed contract keep splitting at 25 %. The Priser tab itself reads the live rate (`:1816`), so the two disagree the moment the rate is not 25. | source + arithmetic (2 695 / 1.25 = 2 156, which is what the drawer showed) | fixed — the drawer splits on the configured `mvaRate` and labels the line with it; a deliberate 0 is honoured, 25 is only the fallback for a missing row. `src/app/admin/page.tsx` |
| P-3 | P3 | "Prisbrudd" does not add up — subtotal and total differ with no reconciling line | (a) `src/lib/mock-booking.ts:178-179` stores `quote.totalPrice` but never `discountKr`/`discountLabel`, which the drawer reads at `:3592-3593`; (b) real bookings are off by 1 kr | Open any booking drawer: `Leiepris 2 995 / Subtotal 2 995 / Totalt 2 695`, nothing explains the 300 kr. For real customer rows the gap is ±1 kr (`base + extras + delivery − discount − total = −1` on GK-2609-003…006) — the per-line kroner rounding already filed as **A-6** in phase 1a. | DB + drawer | fixed — (a) mock bookings store `discountKr`/`discountLabel` alongside the quote total (`src/lib/mock-booking.ts`); (b) the drawer prints the residual, as «Avrunding» for the ±1 kr per-line rounding (A-6) and «Avvik (ikke spesifisert)» above 2 kr, where an older row never recorded its discount. `src/app/admin/page.tsx` |
| P-4 | P2 | The test-email button reports success while no mail was sent | `src/app/api/admin/app-config/test-email/route.ts:72` returns `{success:true}` unconditionally; `src/lib/email.ts:114-119` returns `undefined` after `console.warn('SMTP not configured — skipping email to', …)` | With `smtpHost` empty, press any "Send testmail". Response `200 {"success":true,"to":"kontakt@graveklar.no"}`, toast **"✓ Sendt: new-booking-admin"**. The owner's only way to check SMTP therefore always says yes. | live probe | fixed — every sender the route uses returns whether the message actually left the process (`send()` in `src/lib/email.ts` returns false when SMTP is unconfigured), and the route answers 400 "Ingen e-post ble sendt…" instead of `{success:true}`; `tests/api/admin-test-email.test.ts` |
| P-5 | P3 | The audit-log action filter matches by substring, not equality | `src/app/api/admin/audit-log/route.ts:30` — `where.action = { contains: action }` | Select `auth.login` in the dropdown: `GET /api/admin/audit-log?action=auth.login` answered **49 rows — 33 `auth.login` + 16 `auth.login_failed`**, and `total` reports 49 too. Every filter whose value is a prefix of another action is similarly wrong. | live probe | fixed — the `action` filter is an exact match (`where.action = action`); `actor` stays a substring search because it is a free-text box. `tests/api/admin-audit-log.test.ts` |
| P-6 | P3 | "Marker som betalt" ignores the response and reloads regardless | `src/app/admin/page.tsx:3760-3770` — `await fetch(...)` with no `res.ok` check, then `window.location.reload()` | Make the PATCH fail (expired session, 500). The page reloads exactly as it does on success; there is no toast and no error. A failed manual payment is indistinguishable from a successful one. | source | fixed — the PATCH response decides: a non-2xx toasts the route's error and the page does not reload. `src/app/admin/page.tsx` |
| P-7 | P4 | No UI writes `Machine.sortOrder`, so fleet ordering cannot be changed | `src/app/api/admin/machines/route.ts:11` orders by `sortOrder, createdAt`; nothing in the Utstyr form or list sets it | Every machine sits at `sortOrder = 0`; ordering falls through to creation time. The PATCH route accepts `sortOrder`, so only the UI is missing. | DB (`SELECT DISTINCT sortOrder FROM Machine` → 0) + `tests/e2e/admin-machines.e2e.test.ts` | fixed — «Flytt opp»/«Flytt ned» on each Utstyr card renumber the whole list 0…n-1 through `PATCH /api/admin/machines/[id]` (swapping two zeroes would have changed nothing). `src/app/admin/page.tsx` |
| P-8 | P3 | The "Ikke lagret — … krever 2FA" banner is stale: it survives *Forkast endringer* and switching groups | banner set at `src/app/admin/page.tsx:4500-4502`, never cleared by the reset or the group switch | Trigger the 2FA refusal on a sensitive group, press Avbryt, then *Forkast endringer*. The SaveBar correctly returns to "Alt er lagret" while the red banner above still claims the change is unsaved — the two halves of the same panel disagree until the page is reloaded. | `tests/e2e/admin-settings.e2e.test.ts` → "refuses a sensitive group with requiresTotp…" (final expectation) | fixed — the banner is cleared by *Forkast endringer* and by every group switch, on both the Priser and the Innstillinger panels. `src/app/admin/page.tsx` |
| P-9 | P4 | The MVA-rate field gets a nonsensical price helper: "MVA-sats (%) … ≈ 20 kr eks. MVA" | `src/app/admin/page.tsx:1807-1808` — `isPriceLike` matches any key containing `Rate`, which includes `mvaRate`; helper built at `:1819-1822` | Open Priser → tax group. The percentage 25 is rendered as if it were kroner (25 / 1.25 = 20). | live probe | fixed — `isPriceLike` no longer matches on `Rate`; the two rate keys that really hold kroner are named explicitly. `src/app/admin/page.tsx` |
| P-10 | P3 | The operator checklist's contract gate is silent: items look enabled and swallow clicks | `src/app/admin/checklist/[bookingId]/ChecklistClient.tsx:164-170` — `setValue` early-returns on `!handoverAllowed`, but the controls' `disabled` prop is `locked` (`:193`), which does not include it (`:430`, `:464`, `:488`, `:508`, `:526`, `:597`) | Open the checklist for a booking whose contract is not signed. Every item has full opacity and a default cursor, taps do nothing, and only a banner explains why. | live probe | fixed — the controls' `disabled` prop is now the same expression `setValue` obeys, contract gate included, and a banner gives the reason for *every* status the handover rule refuses, not only an unsigned contract on a confirmed booking. `ChecklistClient.tsx` |
| P-11 | P4 | Cancelling the 2FA prompt for a *machine* price edit says nothing, unlike every other gated save | `src/app/admin/page.tsx:4492-4503` — `onClose` handles `kind: 'pricing'` and `'app-config'`, not `'machine'` | Edit a machine's dagpris → Lagre endringer → Avbryt in the modal. The drawer stays open with the edited number and no message; the pricing and settings panels both say "Ikke lagret" in the same situation. | `tests/e2e/admin-machines.e2e.test.ts` → "demands 2FA for a price field…" | fixed — cancelling the prompt sets an «Ikke lagret …» banner in the still-open machine drawer, in the same words the pricing and settings panels use. `src/app/admin/page.tsx` |
| P-12 | P4 | Six of the twenty `KEY_OVERRIDES` entries can never run, and one of them hides a setting the site still reads | `src/components/admin/ConfigFieldControl.tsx:56-80` | `imgVignette` and `mvaRate` are not `AppConfig` keys at all (`imgVignette` was deliberately removed at `src/lib/app-config-defaults.ts:154` — yet `src/lib/equipment-bg.tsx:66` still reads it, so the vignette is permanently 0 with no way to set it; `mvaRate` is a `PricingConfig` key with its own slider in `PricingFieldControl.tsx:23`). `baseAddress` is rendered by `AdminBaseAddressField` instead (`src/app/admin/page.tsx:1851-1857`). `firstTimeDiscountPercent`, `repeatDiscountPercent` and `discountHardCap` sit in the `discounts` group, which `APP_CONFIG_GROUP_ORDER` deliberately omits (`app-config-defaults.ts:231-243`), so they only ever render on `/admin/discount-codes`. | source | fixed — the five genuinely unreachable overrides are gone (`mvaRate`, `baseAddress` and the three `discounts` keys), each replaced by a note naming the component that does render it. `imgVignette` is kept deliberately and documented: the key is absent from `app-config-defaults.ts` while `src/lib/equipment-bg.tsx:66` still reads it, the coordinator then honoured the recorded product decision (the knob was removed on purpose) and dropped the stale read in `src/lib/equipment-bg.tsx` together with the sixth override. `src/components/admin/ConfigFieldControl.tsx`, `src/lib/equipment-bg.tsx` |
| P-13 | P3 | The booking timeline calls every payment "Betalt via Stripe", including manual and Vipps ones | `src/components/admin/BookingTimeline.tsx:57` — the event is emitted from `fullyPaidAt` alone, with no reference to `paymentMethod` | Mark a booking as paid from the drawer — whose own confirm text says "Dette hopper over Stripe" — and the timeline records "Betalt via Stripe" while `paymentMethod` is empty. Mock bookings store `'mock'` and are labelled the same way, and with native Vipps now the primary method every Vipps payment is mislabelled too. | `tests/e2e/admin-bookings.e2e.test.ts` → "marks a pending booking as paid, skipping Stripe" | fixed — the payment event is named from `paymentMethod`: Vipps / Stripe / faktura / testbooking, and «Betalt — registrert manuelt» when no method was recorded, which is exactly the drawer's own mark-paid path. `src/components/admin/BookingTimeline.tsx` |
| P-14 | P4 | The block-dates confirmation does not warn which of the selected dates are already booked | dialog at `src/app/admin/page.tsx:3331-3372`; the skip is only reported afterwards, from the response, at `:1424-1429` | Select a range covering a booked day and press *Marker utilgjengelig*. The dialog lists all dates as if all will be blocked; only the toast afterwards says "1 dato(er) hoppet over (allerede booket)". | live probe | fixed — the confirmation marks each already-booked date «allerede booket, hoppes over» from the booking maps the calendar already holds, and sums up how many will actually be blocked. `src/app/admin/page.tsx` |
| P-15 | P4 | The 2FA refusal on `/admin/discount-codes` sends the admin somewhere that cannot help, and the page renders percentages differently from the rest of the panel | toast at `src/app/admin/discount-codes/page.tsx:134`; Steppers at `:265`, `:279`, `:286`, `:512`, `:517` | Saving the settings tab returns `401 requiresTotp` and toasts "Endring krever 2FA-kode. Åpne admin-panelet og lagre derfra." — the admin panel demands enrollment for the same keys, so the instruction leads nowhere, and it never mentions enrollment. Separately, these percentages are Steppers here while every other bounded percentage in the panel (`cancelLatePercent`, `cancelSameDayPercent`) is a Slider — the Slider overrides for these three keys exist but are unreachable (P-12). | live probe | fixed — the page mounts the same `TotpPromptModal` the panel uses, so the gated save can be completed where it was started (or refused, leaving an «Ikke lagret» banner) instead of pointing at a panel that cannot perform it; the three percentages are Sliders now, matching every other bounded percentage. `src/app/admin/discount-codes/page.tsx` |
| P-16 | P1 | Changing the calendar month while `/admin` is still loading poisons the panel: the next dialog or sheet you open crashes it to "Noe gikk galt" | trigger: `src/app/admin/page.tsx:699-732` — `fetchData` is keyed on `calendarMonth` with no sequence guard, so a month change starts a second run over the first; symptom: an infinite update loop inside `usePresence` (`@radix-ui/react-presence@1.1.5`) reached from `setRef` → `safelyDetachRef` during `commitMutationEffectsOnFiber`, under React 19 | Load `/admin` (a normal, already-compiled load), click the next-month chevron immediately, select a day, press *Marker utilgjengelig*. The confirmation never opens; the panel is replaced by "Noe gikk galt — Vi beklager – en uventet feil oppstod", and the selection is gone. React logs **"Maximum update depth exceeded"**. It is not the dialog: *Opprett testbooking* (a Sheet) crashes the same way, so once poisoned the panel cannot open any overlay. Waiting does not heal it — a 9-second pause after the month change still crashes. Blocking a date in the month the panel opens on is unaffected, which is why the e2e tests stay there. Not observed but worth checking during the fix: `page.tsx:418-436` changes the month by itself when the month the panel opens on has no bookings, which is the same trigger without a click. | `…/scratchpad/agent-2b/p16-repro.mjs` — `node p16-repro.mjs full 1` (crashes 3/3), `node p16-repro.mjs mocksheet 1` (the Sheet), `node p16-repro.mjs slownav`/`nosecondnav`/`full 0` (no crash) | fixed — `fetchData` carries a request-sequence + `AbortController` guard, and the auto-advance effect no longer overrides a month the admin picked. Pinned by `tests/e2e/admin-calendar.e2e.test.ts` → "still opens its dialogs and sheets after a month change during the load", which drives the trigger deliberately and opens both the Dialog and the Sheet. `src/app/admin/page.tsx` |
| P-17 | P3 | `fetchData` has no request-sequence guard, so a slower earlier month can overwrite the month the admin is looking at | `src/app/admin/page.tsx:699-732` | Every `calendarMonth` change starts a fresh `GET /api/bookings` + `GET /api/unavailable?month=…` pair, and whichever resolves last wins — including a stale one. `setIsLoading(false)` in its `finally` likewise clears the spinner while a later fetch is still running. This is also the trigger for P-16. | source | fixed — same guard: only the newest run writes state or clears the spinner, and it aborts the run it supersedes. Pinned by `tests/e2e/admin-calendar.e2e.test.ts` → "a slower earlier month does not overwrite the month being viewed", which holds every other month's answer back 2.5 s; verified to fail against the unguarded code. `src/app/admin/page.tsx` |
Known defects were **not** re-filed: H-1…H-8 and I-1…I-5 (phase 1d, all fixed),
C-4 and C-5 (phase 1b, both fixed — re-verified live here), A-6 (phase 1a, open
— referenced by P-3).

## Flows recorded as tests

`tests/e2e/admin-*.e2e.test.ts`, 28 tests over 6 files (the fix phase added three), plus the shared harness
`tests/e2e/admin-helpers.ts`. They drive a real Chromium (`puppeteer-core`,
`/usr/bin/chromium`, headless) against the audit instance and assert on both the
DOM and the database. Each file skips itself unless both switches are set:

```
AUDIT_BASE_URL=http://localhost:3001 \
AUDIT_DB_FILE=…/scratchpad/testdb/audit.db \
npx vitest run tests/e2e/admin
```

Green twice in a row on the final code (04:37:46 and 04:39:41), 6 files / 25
tests each; the logs are in `…/scratchpad/agent-2b/final-run-A.log` and
`final-run-B.log`.

| File | Tests | What it pins |
| --- | --- | --- |
| `admin-login.e2e.test.ts` | 5 | proxy redirect carries `?from=`; wrong password → 401 + "Feil passord" + an `auth.login_failed` row + no cookie; right password honours `from`, sets an httpOnly cookie, and logout empties it so `/admin` bounces again; an unauthenticated `fetch('/api/admin/app-config')` → 401 |
| `admin-settings.e2e.test.ts` | 3 | a non-sensitive group (Innhold) saves without a second factor, reaches `/api/app-config`, and survives a reload; `beforeunload` is prevented exactly while dirty; a sensitive group (Behovsundersøkelse) is refused with 401, the modal is cancelled, the row is unchanged, the change stays pending, `AdminTotp` stays empty, and the banner clears on both a group switch and *Forkast endringer* (P-8) |
| `admin-machines.e2e.test.ts` | 6 | create from the drawer (201, `sortOrder` 0, no price); edit a description on the session alone; a price edit → 401 → cancel → nothing written, no `machine.price_change` audit row and an «Ikke lagret» banner in the drawer (P-11); a move in the fleet order renumbers `sortOrder` (P-7); delete refused with **409** while a confirmed booking references the machine, then accepted once it does not |
| `admin-bookings.e2e.test.ts` | 5 | mark-paid skips Stripe (status `confirmed`, `fullyPaidAt` set, `paymentDeadline` cleared, and the timeline says "Betalt — registrert manuelt", not Stripe — P-13); cancel requires a reason (the button is disabled without one); the reason lands in `adminNote` and a `RETUR-…` goodwill code is minted for the paid booking; the cancelled row is reachable again behind «Vis avbestilte» (P-1) and is deleted **from its own drawer** |
| `admin-calendar.e2e.test.ts` | 5 | block a date with a reason (the row reads back through the app as the day that was clicked, not its UTC neighbour — the C-4 regression); the cell renders struck through; unblock the same date from the same calendar. Plus the two month-race tests the fix phase added: after four month changes landed during the initial load the panel still opens both a Dialog and a Sheet (P-16), and with every other month's `/api/unavailable` answer held back 2.5 s the month on screen keeps its own blocked days (P-17) |
| `admin-faq.e2e.test.ts` | 4 | create, edit (without blanking the other fields), deactivate, delete — each asserted in the database and in the refreshed list |

Design notes that matter for anyone extending them:

- **The login budget is real, and it is the one thing that will make this suite
  look flaky.** `POST /api/admin/login` is limited to 10 attempts per 15 minutes
  and the limiter counts *every* attempt on a key that is `'unknown'` for direct
  localhost — one bucket for the whole machine. The harness caches the session
  cookie next to the audit database and re-logs in only when it has expired, so
  only `admin-login.e2e.test.ts` spends attempts deliberately: two per run, four
  for the two consecutive runs this phase required. Running the suite more often
  than that inside a 15-minute window exhausts the budget, and
  `loginWithPassword` then throws a message saying exactly that rather than
  failing on a baffling assertion.
- **Fields are set through the native value setter, not by typing.** The admin
  page re-renders its whole tree per keystroke; against the dev server that is
  most of a second per character, which turned a 40-character field into a test
  timeout. `setInput` writes the value and dispatches one `input` event.
- **…and it checks React's props, not the DOM value.** Before hydration an
  element has no `__reactProps$…` key at all: the write lands in the DOM, a
  naive "did it stick" check passes, and the component's state is still empty.
  That is how the login form came to post a blank password and answer **400**,
  which looked for a while like a rate limit and then like a broken form. So
  `setInput` waits for hydration, sets, and re-reads the value React itself
  holds, retrying until they agree.
- **Assert on the response you caused.** `lastCall` alone races the request and
  can match an *earlier* call to the same endpoint — the machine test's 2FA
  refusal briefly "passed" against the previous PATCH. `waitForApi(page, url,
  method, { since: seenMark(page) })` waits for a response recorded after the
  click.
- **Do not wait for text the page always shows.** The settings panel carries a
  permanent "Sett opp 2FA" button in its security banner, so waiting for that
  string proved nothing about the modal; the tests wait for the 401 and for an
  open dialog containing it.
- **Every dialog selector carries `[data-state="open"]`.** Radix keeps a
  dismissed sheet mounted through its exit animation, and a stale closed sheet
  answered for the open one — this cost one bogus finding (a "Rediger FAQ"
  dialog apparently titled "Legg til FAQ") before it was understood.
- **Row-scoped clicks pick the innermost match.** An outer match is the whole
  card, whose first "Rediger" belongs to somebody else's row. An early version
  of the FAQ test would have edited a real FAQ entry.
- Pages that must have no session get their own `BrowserContext`; pages from
  `browser.newPage()` share one cookie jar.
- **P-16 and P-17 are pinned by tests now.** The fix phase stopped trying to
  *catch* the race and drove it instead: `changeMonthDuringLoad` waits for
  hydration and nothing else, then clicks the chevron four times while the
  panel's first fetch is still in flight, and the P-17 test delays every
  month's answer but the target's through request interception so the stale
  ones are guaranteed to land last. Both were checked against the unguarded
  code — P-17 fails there — so neither passes vacuously.
- **Hydration is a real wait.** A click that lands on the server-rendered
  markup before React attaches is swallowed in silence, which reads as a broken
  control rather than an early click; `waitForHydration` looks for React's own
  props, the same signal `setInput` uses.
- The database is read through the `sqlite3` CLI, never Prisma, and the harness
  refuses an `AUDIT_DB_FILE` inside the repository or named `custom.db`. The
  only write not made through the app's own HTTP surface is the removal of the
  goodwill discount code a cancellation mints, which has no admin endpoint.

## Verified fine

Login and boundary: proxy redirect to `/admin/login?from=…` for both `/admin`
and `/admin/audit-log`; wrong password 401 with the message rendered; correct
password lands on `from`; logout clears the cookie and the gate holds again;
admin APIs 401 without a session.

Calendar: month navigation; Dag / Uke / Måned selection modes; multi-select;
block with a reason; the already-booked skip warning ("1 dato(er) hoppet over
(allerede booket): 12. mai — De øvrige 2 dato(er) ble blokkert"); unblock by id
**and** by date, with rows stored at Oslo local midnight (C-4 and C-5 fixes
confirmed live); striped turnaround days render (both `blockDayBeforeBooking`
and `blockDayAfterBooking` are `false` on this instance, so the *rule* was not
exercised — see "Not done").

Bookings: search across name / reference / phone / e-mail (the phone branch
compares the lowercased query against a digit string, which is harmless);
drawer status actions; cancel requires a reason; CSV export content, including
the BOM and the quoted header; fuel panel; timeline; contract print link.

Priser: SaveBar dirty count, *Forkast endringer*, the 2FA prompt, and the
cross-group hint ("Lagrer alle prisgrupper — du har også endringer i en annen
gruppe").

Innstillinger: all 11 rendered groups show the control types listed below;
non-sensitive groups save without 2FA and persist across a reload; sensitive
groups prompt and refuse; per-group dirty counts; the `beforeunload` guard
(`defaultPrevented === true` while dirty).

Utstyr: create with image upload (stored under a random-hex filename —
`upload-c80937cf6a35023e.png`, the H-7 fix); description edit without 2FA; price
edit gated; active toggle; delete 409 → 200.

Innhold: FAQ and insurance CRUD; terms for both audiences with every
`{{token}}` resolved on `/vilkar`.

Sjekklister: phase and item builder; HTML5 drag reorder
(`POST /api/admin/checklist-items/reorder` 200, `sortOrder` swapped 0↔1);
sandbox presets; the QR panel URL (`http://localhost:3001/sjekkliste`).

Rabattkoder: regex rejection 400; create 200; duplicate **409 "Koden eksisterer
allerede."**; toggle; delete; the settings tab's `401 {requiresTotp:true,
requiresTotpEnrollment:true}`.

Behovsundersøkelse: question CRUD, reorder, responses list. Revisjonslogg:
actor filter. Kontrakt: frozen HTML, `?autoprint=1` firing `window.print()`
exactly once with the title `Kontrakt - …`. Operatørsjekkliste: fill, lock a
phase, six-photo upload, and auto-completion on the Retur phase → status
`completed` plus a `booking.completed` audit row written by `system`; the
drawer's `Slett` then works on the completed booking. Theme menu Lys / Mørk /
System. **The Forespørsler tab is absent while `b2bEnabled = false`**, as
intended.

## Settings control inventory

79 `AppConfig` keys. Control resolved from `KEY_OVERRIDES` in
`src/components/admin/ConfigFieldControl.tsx` first, then `cfg.type`. Groups
in sidebar order; `delivery` has no sidebar entry (`baseAddress` renders inside
the Priser tab), and `discounts` is edited on `/admin/discount-codes`.

**business**

| key | label | type | control |
| --- | --- | --- | --- |
| `bookingCount` | Gjennomførte bookinger (vises på nettside) | number | Stepper |
| `bookingCountMin` | Vis «gjennomførte bookinger» først ved (minimum) | number | Stepper |
| `businessAddress` | Forretningsadresse | text | AddressAutocomplete |
| `businessName` | Virksomhetsnavn | text | TextInput |
| `contactEmail` | Kontakt-e-post | email | TextInput (email) |
| `contactPhone` | Telefon | text | PhoneInput |
| `logoAsFavicon` | Bruk logo som faneikon (nettleser) | boolean | Toggle |
| `logoInHeader` | Bruk logo i nettside-header | boolean | Toggle |
| `logoOnContract` | Vis logo på kontraktutskrift | boolean | Toggle |
| `logoUrl` | Logo | image | ImageDropzone |
| `orgNumber` | Organisasjonsnummer | text | TextInput |
| `serviceArea` | Tjenesteområde | text | TextInput |
| `siteUrl` | Nettside-URL | url | TextInput (prefix https://) |


**rental-types**

| key | label | type | control |
| --- | --- | --- | --- |
| `dayAllowedDays` | Døgn – tillatte ukedager | day-toggles | WeekdayPicker |
| `daySchedule` | Døgn – visningstekst | text | TextInput |
| `enabledRentalTypes` | Aktive leietyper | rental-type-toggles | ChipMultiSelect |
| `weekendSchedule` | Helg – visningstekst | text | TextInput |
| `weekendStartDay` | Helg – startdag | weekday | WeekdayPicker (single) |
| `weekSchedule` | Uke – visningstekst | text | TextInput |
| `weekStartDay` | Uke – startdag | weekday | WeekdayPicker (single) |


**booking**

| key | label | type | control |
| --- | --- | --- | --- |
| `blockDayAfterBooking` | Blokker dagen etter booking (vask/retur) | boolean | Toggle |
| `blockDayBeforeBooking` | Blokker dagen før booking (klargjøring) | boolean | Toggle |
| `bookingMaxAdvanceDays` | Maks forhåndsbestilling (dager) | number | Stepper |
| `cancelFreeDays` | Gratis avbestilling (dager før start) | number | Stepper |
| `cancelFreeWeeks` | Gratis avbestilling (uker før start) | number | Stepper |
| `cancelLatePercent` | Gebyr under frist (%) | number | Slider (0–100) |
| `cancelSameDayPercent` | Gebyr samme dag / no-show (%) | number | Slider (0–100) |
| `defaultMachineId` | Standardutstyr (forvalgt) | machine-select | MachineDropdown |
| `egenandel` | Egenandel ved skade (kr) | number | Stepper |
| `minAge` | Minimumsalder leietaker | number | Stepper |
| `minBookingDaysAhead` | Minimum dager i forveien (0 = ingen) | number | Stepper |
| `renterChecklistEnabled` | Aktiver QR-sjekkliste for leietakere | boolean | Toggle |


**discounts**

| key | label | type | control |
| --- | --- | --- | --- |
| `discountHardCap` | Maksimal samlet rabatt (%) | number | Slider (0–100) on `/admin/discount-codes`; the dead `KEY_OVERRIDES` entry is gone (P-12, P-15) |
| `enableFirstTimeDiscount` | Aktiver førstegangskunde-rabatt | boolean | Toggle — on `/admin/discount-codes` |
| `enableRepeatDiscount` | Aktiver returkunde-kode etter leie | boolean | Toggle — on `/admin/discount-codes` |
| `firstTimeDiscountPercent` | Førstegangskunde-rabatt (%) | number | Slider (0–50) — as above |
| `repeatDiscountPercent` | Returkunde-rabatt (%) | number | Slider (0–50) — as above |


**delivery**

| key | label | type | control |
| --- | --- | --- | --- |
| `baseAddress` | Utgangsadresse for levering | text | `AdminBaseAddressField` (address autocomplete) inside the Priser tab; the dead `address` override is gone (P-12) |


**stripe**

| key | label | type | control |
| --- | --- | --- | --- |
| `stripeEnabled` | Aktiver Stripe | boolean | Toggle |
| `stripePublishableKey` | Publishable Key (pk_…) | text | TextInput |
| `stripeSecretKey` | Secret Key (sk_…) | password | PasswordField |
| `stripeVippsPreview` | Vipps via Stripe (forhåndsvisning – krever tilgang fra Stripe) | boolean | Toggle |
| `stripeWebhookSecret` | Webhook Secret (whsec_…) | password | PasswordField |


**vipps**

| key | label | type | control |
| --- | --- | --- | --- |
| `vippsClientId` | Client ID | text | TextInput |
| `vippsClientSecret` | Client Secret | password | PasswordField |
| `vippsEnabled` | Aktiver Vipps | boolean | Toggle |
| `vippsEnvironment` | Miljø | text | SegmentedControl (Test/Produksjon) |
| `vippsMsn` | Merchant Serial Number | text | TextInput |
| `vippsSubscriptionKey` | Subscription Key (Ocp-Apim) | password | PasswordField |
| `vippsWebhookSecret` | Webhook Secret | password | PasswordField |


**smtp**

| key | label | type | control |
| --- | --- | --- | --- |
| `adminEmail` | Admin-e-post (mottar nye bookinger) | email | TextInput (email) |
| `smtpFrom` | Avsenderadresse (Navn <e-post>) | text | TextInput |
| `smtpHost` | SMTP-server | text | TextInput |
| `smtpPass` | SMTP-passord | password | PasswordField |
| `smtpPort` | SMTP-port | number | PortQuickSelect |
| `smtpSecure` | TLS/SSL (bruk port 465) | boolean | Toggle |
| `smtpUser` | SMTP-brukernavn | text | TextInput |


**content**

| key | label | type | control |
| --- | --- | --- | --- |
| `heroHeading` | Hero-overskrift (bruk {kategori} for rullerende ord) | text | TokenizedTextInput |
| `heroSubtext` | Hero-undertekst (bruk {pris} for dynamisk dagspris) | textarea | TokenizedTextInput (multiline) |
| `heroTagline` | Hero-tagline (linjen under overskriften) | text | TokenizedTextInput |
| `seoDescription` | SEO-beskrivelse (maks ~160 tegn) | textarea | TextArea |
| `seoKeywords` | SEO-nøkkelord (kommaseparert – tom = auto fra utstyr/område) | text | TagInput |
| `seoTitle` | SEO-tittel (Google/sosiale medier) | text | TextInput |


**ui**

| key | label | type | control |
| --- | --- | --- | --- |
| `contactFormEnabled` | Vis kontaktskjema (/kontakt) | boolean | Toggle |
| `reviewsEnabled` | Be om kundeomtaler + vis dem på forsiden | boolean | Toggle |
| `showFaqSection` | Vis FAQ-seksjon | boolean | Toggle |
| `showInsuranceSection` | Vis forsikringsseksjon | boolean | Toggle |
| `showTermsSection` | Vis vilkårsseksjon | boolean | Toggle |


**theme**

| key | label | type | control |
| --- | --- | --- | --- |
| `accentColor` | Aksentfarge (hex) | color | ColorPicker |
| `defaultTheme` | Standard fargetema | text | SegmentedControl (Lys/Mørk/System) |
| `heroImageUrl` | Hero-bakgrunnsbilde | image | ImageDropzone |


**survey**

| key | label | type | control |
| --- | --- | --- | --- |
| `surveyLeadDiscountCode` | Rabattkode som deles ut (opprett den under Rabattkoder) | text | TextInput |
| `surveyLeadDiscountEnabled` | Tilby rabattkode for e-postpåmelding | boolean | Toggle |
| `surveyLeadDiscountPercent` | Rabattprosent som vises i undersøkelsen | number | Stepper |
| `surveyMode` | Undersøkelsesmodus (vis undersøkelsen på forsiden) | boolean | Toggle |


**system**

| key | label | type | control |
| --- | --- | --- | --- |
| `b2bEnabled` | Aktiver bedriftsutleie (B2B) | boolean | Toggle |
| `maintenanceMessage` | Vedlikeholdsmelding | textarea | TextArea |
| `maintenanceMode` | Vedlikeholdsmodus | boolean | Toggle |
| `showMockBookingPanel` | Vis testbooking i admin | boolean | Toggle |


`KEY_OVERRIDES` used to map two keys that are not in this table at all —
`imgVignette` and `mvaRate` — and four more whose rows above are rendered by
some other component. Five of those six are gone; `imgVignette` stays on
purpose, because the site still reads it. See **P-12**.

## Not done, and why

- **Turnaround-day *rules*.** `blockDayBeforeBooking` and
  `blockDayAfterBooking` are both `false` on this instance. They are booking
  rules, and a second agent was auditing the customer booking flow against the
  same database for the whole window, so flipping them would have changed
  availability underneath it. The striped turnaround rendering was verified;
  the rules themselves were not.
- **`mvaRate` mutation for P-2.** Confirming the hardcoded 25 % by changing the
  configured rate is a price change; same reason. P-2 rests on the source and
  on arithmetic that matches the rendered numbers.
- **CSV and contract *downloads*.** The browser sandbox makes `<a download>`
  inert. The generated CSV was asserted from the blob the click builds, not
  from a file on disk.
- **2FA-gated saves were never completed**, by instruction — only refused and
  cancelled. So the *success* path of every sensitive group, of PricingConfig,
  and of machine price fields is unexercised here; it is covered in-process by
  phase 1d.

## Environment left as found

`AdminTotp` is empty. `seoDescription` is back to `''`,
`surveyLeadDiscountPercent` to `15`, `showMockBookingPanel` to `true`,
`maintenanceMode` to `false` — it was switched on for about ten seconds to
confirm that the customer site then serves the maintenance page ("Vedlikehold"
plus the configured message) while `/admin`, `/admin/login` and
`/api/admin/machines` all still answer 200, then switched straight back. Machines are Rippa and Bobcat, both active, and
every `AUDIT2B` artefact — bookings, machine, FAQ item, insurance card,
campaign code, checklist phase and items, survey question — is deleted. The
pre-existing `[TESTBOOKING]` rows from earlier sessions were left untouched.
The admin password is unchanged (`Testadmin-2026!`); no forced password change
was demanded.
