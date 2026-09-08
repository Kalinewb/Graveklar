# Phase 2a — the customer surface (area Q)

Scope: everything a customer sees and clicks. The home-page booking funnel
(`src/app/HomePage.tsx`, `src/app/page.tsx`), the Stripe return states, the
self-service cancellation page, and the standalone public pages — `/vilkar`,
`/personvern`, `/kontakt`, `/bedrift`, `/undersokelse`, `/sjekkliste`,
`/omtale/<token>`, the 404 page, the theme toggle, and the maintenance and
survey take-overs.

Method: a real Chromium driven with `puppeteer-core` against the audit instance
on `:3001` (a neutralised copy of production — SMTP blank, `siteUrl`
`http://localhost:3001`, Vipps off, Stripe on real **test** keys). Assertions
are made against the DOM **and** the instance's own SQLite file. No card number
was ever entered: the browser is walked to Stripe-hosted Checkout, the redirect
is asserted, and the money side is driven by a signed
`checkout.session.completed` posted to the app's own webhook.

**32 recorded browser tests across 9 files** — 30 in the eight default
files, plus 2 in the opt-in take-over file. The original 26 passed twice in a
row at audit time; the six added while fixing the findings below (a new
`booking-checkout-ui` file and one survey case) pass against the same instance.
**15 findings: 8 × P2, 7 × P3, no P0/P1.**

Findings already filed in phase 1 are referenced by their existing id and not
re-filed. Two phase-1 findings were leaned on deliberately: **H-5** (the
rate-limit identity is a client-chosen header) is what lets a re-run of these
tests get a fresh budget, and **A-4 / B-3** (the self-pickup delivery-fee guard)
is the server-side backstop that stops Q-5 from becoming a money bug.

---

## Findings

Every `shots/…` and `evidence/…` path below is relative to
`/tmp/claude-1000/-home-deller-Documents-graveklar/d7508d86-8a4a-4455-95e3-e75daf5e6598/scratchpad/agent-2a/`
(the audit's scratch directory — it holds real customer names from the copied
database, so it never leaves that directory).

| id | sev | title | where | reproduce | evidence | status |
| --- | --- | --- | --- | --- | --- | --- |
| **Q-1** | P2 | **A customer who has already paid is told the booking was never confirmed, and then that it expired.** `/?stripe=cancelled&ref=<ref>` renders “Betaling avbrutt — Betalingen ble ikke fullført, så bookingen er ikke bekreftet” for a booking whose row is `confirmed` and `fullyPaidAt`. Clicking the “Prøv igjen” button then POSTs `/api/payment/stripe/create`, which correctly answers 410 for a non-pending booking, and the UI turns that into “Bookingen utløp fordi betalingen ikke ble fullført innen 30 minutter. Velg datoer på nytt for å booke.” — an invitation to re-book dates the customer already owns. The server ships the row's `status` to the client (`src/app/page.tsx:101`); the dialog never reads it. Reachable by pressing Back onto the Checkout page and using its own back arrow (`cancel_url` → `/api/payment/stripe/cancel`), and by any prefetcher that follows that link | `src/app/HomePage.tsx:3265` (the `stripeStatus === 'cancelled'` arm ignores `confirmationData.status`) and `:3267-3272` (the `retryExpired` copy) | pay a booking (or inject the webhook), then open `/?stripe=cancelled&ref=<reference>` and click “Prøv igjen” | `shots/cancelled-on-paid-booking.png`, `shots/retry-on-paid-booking.png` | fixed — the mount effect in `src/app/HomePage.tsx` resolves the return status against the booking row (`confirmed`/`completed` → success, `cancelled` → the "start over" copy) instead of trusting the query string. |
| **Q-2** | P2 | **A failed payment can return the customer to a completely silent home page.** Five branches of the Stripe callback redirect to `/?stripe=error` or `/?stripe=cancelled` with **no** `ref` — missing `session_id`/`bid`, a metadata mismatch, `payment_status !== 'paid'`, an unknown booking, and the outer `catch`. With no `ref` the server resolves no booking, so `stripeReturn.booking` is null; the mount effect only calls `setShowConfirmation(true)` for `status === 'success'`, then strips the query string. The customer lands on the ordinary home page with no dialog, no message and no URL to go back to — their payment failed and the site says nothing | `src/app/api/payment/stripe/callback/route.ts:24, 41, 45, 49, 69` produce the ref-less URLs; `src/app/HomePage.tsx:355-364` shows nothing for them | open `http://localhost:3001/?stripe=cancelled` or `/?stripe=error` | `shots/q2-stripe-cancelled-silent.png` (0 dialogs, URL rewritten to `/`) | fixed — every failure branch of `src/app/api/payment/stripe/callback/route.ts` now carries `ref` (derived from `bid`), and `src/app/HomePage.tsx` opens an honest "Betalingen ble ikke fullført" dialog with a way back for the returns that have none. |
| **Q-3** | P3 | **`?stripe=success` with an unresolvable reference claims a paid booking, with an empty `()`.** The deliberate “don't leave the customer in limbo” fallback shows the full success dialog — “Booking bekreftet og betalt! Betaling og booking **()** er registrert. Du får bekreftelse på e-post.” — for a reference that resolves to nothing. The empty parenthesis is the reference placeholder with no value, and the claim itself is unverified | `src/app/HomePage.tsx:357-361` (`else if (stripeReturn.status === 'success') setShowConfirmation(true)`), copy at `:3149` | open `/?stripe=success&ref=GK-0000-000-XXXXX` | `shots/q3-success-unknown-ref.png` | fixed — an unresolvable reference gets its own "Vi fant ikke bookingen" dialog in `src/app/HomePage.tsx` (`returnDialog`) instead of the success copy with an empty `()`. |
| **Q-4** | P2 | **`BookingDateLock` rows are never released when a booking becomes `completed`, so the calendar offers days the submit endpoint refuses.** `updateBookingStatus` deletes the locks only for `cancelled`. `GET /api/availability` counts only `confirmed` and `pending` bookings, and `checkBookable` agrees — so a completed rental's days are green in the calendar and `/api/quote` answers `bookable: true` — but `createPendingBooking`'s lock insert still collides and the customer is refused with “En eller flere dager i perioden er opptatt. Velg en annen dato.” It bites whenever a rental is completed before its last day (an early return marked done in the admin), which permanently kills the remaining days | `src/lib/booking-service.ts:893-895` (`if (status === 'cancelled')` — no `completed` arm) vs `src/app/api/availability/route.ts:56` and `:69` | confirm a booking, PATCH it to `completed`, then quote (`bookable: true`) and POST the same dates (400 “opptatt”) | `evidence/q4-stale-locks.txt` | **fixed** — `updateBookingStatus` releases the `BookingDateLock` rows for `completed` as well as `cancelled`, on the transition and on a replayed same-status call (`src/lib/booking-service.ts`) |
| **Q-5** | P2 | **Toggling “Hent selv” and back to “Levering til deg” leaves the typed address on screen, drops the delivery quote, and the guard that should stop the submit is bypassed — the confirmation dialog then promises a 68 km delivery for 0 kr.** “Hent selv” clears `deliveryInfo`; “Levering til deg” only flips `selfPickup`, which is **not** in `handleFormSubmit`'s dependency array, so the callback keeps the stale `selfPickup: true` and skips its own `!selfPickup && !deliveryInfo` guard. The dialog reads live state and prints “Leveringsadresse: Storgata 1B, 8006 Bodø · **Leveringspris: 0 kr** · Totalt inkl. mva 5 391 kr”. `handleConfirmBooking` (same missing dependency, plus `selectedMachineId`, `discountCode`, `weekCount`, `quote`) then posts `deliveryFee: 0` with no `deliveryQuoteToken`. Only the phase-1b drift check saves it: the server answers 400 “Leveringsprisen må beregnes på nytt…”, so the customer reaches a dead end after agreeing to a wrong price | `src/app/HomePage.tsx:1006` (deps of `handleFormSubmit`, missing `selfPickup`), `:1080` (deps of `handleConfirmBooking`), `:2217` / `:2226` (the two toggle buttons) | pick a date → type an address → pick a suggestion → wait for the fee → “Hent selv” → “Levering til deg” → “Bekreft booking” | `shots/stale-selfpickup.png`, `shots/delivery-toggle-trap.png` | fixed — `src/app/HomePage.tsx`: "Levering til deg" re-quotes (or clears) the address it comes back to, and `handleFormSubmit` / `handleConfirmBooking` list `selfPickup`, `selectedMachineId`, `weekCount`, `discountCode` and `quote` in their dependency arrays. |
| **Q-6** | P2 | **A page switched off with `notFound()` answers HTTP 200.** `/bedrift` (B2B off) and `/kontakt` (contact form off) render the 404 body with a **200** status line, as does `/tilbud/<bad token>`; a genuinely unmatched route (`/finnes-ikke`) correctly answers 404. Reproduced on the running production build on `:3000` as well, so it is not a dev-server artefact. Crawlers index the disabled page, and every link checker and uptime monitor reads it as healthy | the three `notFound()` call sites on `export const dynamic = 'force-dynamic'` pages: `src/app/bedrift/page.tsx:24`, `src/app/kontakt/page.tsx:23`, `src/app/tilbud/[token]/page.tsx:28` | `curl -s -o /dev/null -w '%{http_code}' http://localhost:3001/bedrift` → `200` | `evidence/q6-notfound-status.txt` | fixed — `src/app/loading.tsx` is gone; the root Suspense boundary it created flushed a 200 shell before any page could call `notFound()`. `/bedrift`, `/kontakt` and `/tilbud/<bad token>` now answer 404. |
| **Q-7** | P2 | **The calendar tells the customer a free machine is “already booked”.** With `weekend` selected, the Saturday and Sunday of a weekend that is blocked only by `minBookingDaysAhead` — or only by being in the past — are labelled “Opptatt – utstyret er allerede booket”, while the Friday of that same weekend correctly says “Booking må gjøres minst 7 dager i forveien”. The reason ladder puts `weekendFriBlocked \|\| weekStartBlocked` above `isTooSoon`, and those two helpers return `true` for the past and lead-time cases too. Same for every day of a `week` whose Monday is merely too soon. Nothing is booked on those dates; the aria-label is what a screen reader and a touch user get | `src/app/HomePage.tsx:2019-2029` (the `dayUnavailableReason` ladder) with `:1959-1978` (`weekendFriBlocked`) and `:1993-2005` (`weekStartBlocked`) | open `/`, select “Helg”, read the aria-labels of the Sat/Sun after a too-soon Friday | `shots/q7-calendar-opptatt.png`, `evidence/q7-calendar-aria-labels.txt` | fixed — `src/app/HomePage.tsx`: the weekend-Friday / week-Monday helpers return a *reason* instead of a boolean, so a day blocked only by the lead-time window or by the span having started says so rather than "Opptatt". |
| **Q-8** | P2 | **The equipment picker headlines a per-day price for a rental type the business has switched off.** With `enabledRentalTypes = weekend,week`, the “Bytt utstyr” panel prints “**2 995 kr** fra/dag” under each machine while every single day in the calendar is refused with “Ikke tilgjengelig for denne leietypen”. The cheapest thing the customer can actually buy is the 5 990 kr weekend. `eqPrice` falls back to the day price with no regard for `enabledRentalTypes` | `src/app/HomePage.tsx:1713` (`const eqPrice = m.dayPrice ?? PRICES.day.price`) and `:1769-1770` (the “fra/dag” label) | open `/`, scroll to the booking form, click “Bytt utstyr” | `shots/machine-picker.png` | fixed — `src/app/HomePage.tsx`: the picker headlines the cheapest *enabled* rental type (`fra/dag` · `fra/helg` · `fra/uke`) instead of always the day price. |
| **Q-9** | P2 | **A campaign code that is applied *and spent* is reported to the customer as saved for next time.** When a first-time discount is also in play, the code field renders “ⓘ Førstegangskunde-rabatten brukes denne gangen – **koden tas vare på til neste booking**”. The summary immediately below it shows the code applied — “Førstegangskunde (-10%) −599 kr / **Rabattkode (-10%) −599 kr**” — and `createPendingBooking` calls `redeemCampaignCode`, which increments `usedCount` and writes a `CampaignRedemption` row. The message was written for single-use *repeat* codes (which really are mutually exclusive with the first-time discount, phase-1a **E-4**) and is applied to `campaign` codes, where it is simply false | `src/app/HomePage.tsx:2444-2470` (`hasFirstTime` branch covers `kind === 'repeat' \|\| 'campaign'`); redemption at `src/lib/booking-service.ts:633` → `src/lib/discount-engine.ts:259` | pick a date, enter a never-seen e-mail, tick “Jeg har en rabattkode”, type an active campaign code | `shots/q9-code-message.png` | fixed — `src/app/HomePage.tsx`: a code line in the quote means the code is charged and spent, and is reported as such; "koden tas vare på til neste booking" now only appears when the code produced no line because the first-time discount won (which is the case where it really is unredeemed). |
| **Q-10** | P3 | **The terms dialog's read-through hint never disappears.** “Bla ned for å se godta-knappen” is still rendered after the customer has scrolled the terms container to the very bottom (`scrollTop + clientHeight === scrollHeight`) with the “Jeg godtar” button on screen. `reachedBottom` never flips: the effect captures `scrollRef.current` on the render where `open` becomes true and returns early when it is still null, and `open` is its only dependency, so the scroll listener and the `ResizeObserver` are never attached. A hand-dispatched `scroll` event and a viewport resize both leave the hint in place, which rules out the condition being wrong | `src/components/TermsDialog.tsx:44-69` (`if (!root) return;`, deps `[open]`) | open the booking confirm dialog → the terms checkbox → wheel-scroll the terms to the bottom | `shots/terms-bottom.png` | fixed — `src/components/TermsDialog.tsx` uses a state-backed callback ref, so the scroll listener and the ResizeObserver attach when the portal mounts and `reachedBottom` can flip. |
| **Q-11** | P3 | **The extra-hours stepper sells hours the rental period cannot contain.** `maxExtraHours = rentalDays * 24 - includedHours`, so a weekend allows 52 pre-ordered extra hours on top of 20 included — 72 machine-hours inside a rental the same page describes as “Fre 15:00 – Man 07:00”, i.e. 64 elapsed hours. At 300 kr/h that is up to 15 600 kr of pre-paid hours the rental has no room for | `src/app/HomePage.tsx:579` | select “Helg”, pick a date, hold “+” on the extra-hours stepper until it disables | `shots/q11-extra-hours-max.png`, `evidence/q11-extra-hours.txt` | fixed — `src/app/HomePage.tsx` bounds the extra hours by the schedule’s elapsed hours (`rentalPeriodHours`, 64 for "Fre 15:00 – Man 07:00") instead of days × 24, and the hint quotes the period. |
| **Q-12** | P3 | **The read-only cancellation preview spends the same budget as the cancellation itself.** `/api/booking/cancel` puts one 10-per-15-minutes limiter in front of both the `GET` preview and the destructive `POST`. Every load of the emailed link costs one; a customer who opens it a few times, or mistypes their reference on the reference+e-mail form, is answered “For mange forsøk. Prøv igjen om litt.” **on the cancel button** — while the free-cancellation deadline keeps running. Hit during this audit by ordinary page reloads | `src/app/api/booking/cancel/route.ts:11` (one `createRateLimiter(10, 15 * 60 * 1000)` shared by `:45` and `:103`) | reload `/booking/cancel?token=…` ten times, then try to cancel | `evidence/q12-cancel-rate-limit.txt` | **fixed** — the read-only GET preview has its own 60-per-15-minutes limiter; the destructive POST keeps 10 (`src/app/api/booking/cancel/route.ts`) |
| **Q-13** | P3 | **The booking summary's end date contradicts the schedule printed beside it.** For a weekend the summary and the confirmation dialog say “Periode fredag 18. september – **søndag 20. september**” / “Sluttdato: søndag 20. september”, while the pricing card, the terms and the FAQ on the same page all say the weekend runs “Fre 15:00 – **Man 07:00**”. The renter checklist agrees with the summary, not the schedule: a week starting Monday offers its return phase “Tilgjengelig ved retur (søn. 13. sep.)” although the week is sold as “Man 08:00 – Man 07:00”. The code comment at `src/app/api/booking/cancel/route.ts:13` records that this exact fre–man vs fre–søn mismatch has already confused customers once; the *label* was unified, the date was not | `src/app/HomePage.tsx` summary/confirm “Sluttdato”, `src/lib/renter-checklist.ts:70` (`getBookingRentalBounds`) vs `weekendSchedule` / `weekSchedule` in AppConfig | book a weekend and read the summary next to the pricing card | `shots/confirm-dialog.png` | fixed — `src/app/HomePage.tsx`: the summary and the confirm dialog print the return day (last rental day + 1) and the schedule text beside it, so "fredag – mandag" matches "Fre 15:00 – Man 07:00". The renter QR checklist's return phase, which opens on the last rental day, now says "Tilgjengelig siste leiedag, før retur (<dato>)" instead of "ved retur (<dato>)" so its date is no longer read as the return day (`src/lib/renter-checklist.ts`). |
| **Q-14** | P3 | **`/vilkar` publishes a B2B terms tab for a service that 404s.** The tab bar offers “Privat / Bedrift / Manualer” regardless of `b2bEnabled`, and the Bedrift tab states “Gjelder ved utleie til næringsdrivende (B2B)” — while `/bedrift` is `notFound()` and the insurance cover is consumer-only. A visitor who reads it has been told, in the operator's own terms, that business rental is on offer | `src/app/vilkar/page.tsx` / `VilkarClient.tsx` (no `b2bEnabled` gate) vs `src/app/bedrift/page.tsx:24` | open `/vilkar` and click “Bedrift” with `b2bEnabled = false` | `evidence/q14-vilkar-tabs.txt` | fixed — `src/app/vilkar/page.tsx` sends no business terms while `b2bEnabled` is off, which hides the Bedrift tab and its "Gjelder ved utleie til næringsdrivende (B2B)" claim. |
| **Q-15** | P3 | **The survey's refusal names no question, and one question type starts in a state that reads as answered.** “Neste” answers every incomplete step with the same “Vennligst svar på spørsmålene før du går videre.” with no marker on the offending question — on a step with five questions that is a hunt. Worst on the last step, where the *optional* e-mail (“Helt valgfritt”) plus an unticked consent box produces the same generic sentence with no required question visible anywhere. The `range` question compounds it: the slider is pre-positioned at the midpoint but the gate is `touchedRanges`, so a respondent whose answer *is* the midpoint must drag it away and back | `src/components/survey/SurveyExperience.tsx:76-98` (`stepValid`), `:203-207` (the message), `:91-92` + `:373-380` (the range gate and its pre-positioned thumb) | open `/undersokelse`, press “Start”, then “Neste”; and on the last step type an e-mail without ticking consent | `evidence/q15-survey-gate.txt` | fixed — `src/components/survey/SurveyExperience.tsx` names and marks each blocking question (`Mangler svar` / `Mangler samtykke`), and a range answer left at the pre-positioned midpoint now counts, with an explicit "Ikke besvart" state until it does. |

Severity key follows phase 1: **P0** money or safety can be wrong in production
today · **P1** a documented action silently does nothing · **P2** divergence
between what the customer is shown and what the system does · **P3** correctness
of an error shape, a disclosure, or a defence-in-depth gap with a working outer
guard.

### Why nothing is P0 or P1

Every mis-priced or mis-stated offer found here is caught by a server-side
backstop before money moves: Q-5's 0 kr delivery is refused by the delivery-quote
drift check, Q-1's retry is refused with 410 by the non-pending guard, and Q-4
fails closed (a refusal, not a double booking). What the customer is *shown* is
wrong in all three; what is *charged* is not.

The one finding here with a real, uncompensated cost to the customer is **Q-9**:
the campaign code is genuinely spent on the booking the customer is told it was
*not* spent on. It is one discount use on one code, which is why it sits at P2
rather than higher — but it is the only one of the fifteen where the customer is
measurably worse off, so it is the one to fix first.

---

## Flows recorded

`tests/e2e/helpers.ts` is shared by all of them: browser launch, DOM helpers
that survive the page's scroll animations, `node:sqlite` access to the
instance's database (with a guard that refuses `prisma/prisma/db/custom.db` and
anything inside the repository), booking fixtures built through the product's
own endpoints, Stripe's HMAC signature scheme, and a cross-file advisory lock.

It deliberately does **not** import `tests/helpers/db.ts`: that module opens the
per-vitest-worker scratch database, which is a different file from the one the
running instance serves.

| file | flow | tests |
| --- | --- | --- |
| `tests/e2e/booking-checkout.e2e.test.ts` | home page → rental type → calendar day → self-pickup → details → quote → terms dialog → confirm dialog → **Stripe-hosted Checkout redirect** → signed `checkout.session.completed` → `confirmed` + `AcceptedContract` + cancel token; webhook replay is idempotent | 3 |
| `tests/e2e/booking-checkout-ui.e2e.test.ts` | what the same funnel *says*: calendar reasons, the picker's headline price, the extra-hours cap against the schedule, the period the summary prints, the terms dialog's read-through hint, and the three payment-return states where the query string and the booking row disagree (Q-1, Q-2, Q-3, Q-7, Q-8, Q-10, Q-11, Q-13) | 5 |
| `tests/e2e/cancel-token.e2e.test.ts` | `/booking/cancel?token=…`: preview, fee text, the two-step “Er du sikker?”, the cancel, the released date locks, the spent token, an unknown token | 3 |
| `tests/e2e/cancel-ref-email.e2e.test.ts` | `/booking/cancel` by reference + e-mail: a wrong e-mail is refused and leaks nothing, the right one cancels, an unknown reference gets the same wording | 2 |
| `tests/e2e/survey.e2e.test.ts` | `/undersokelse`: per-step validation (the refusal names and marks the blocking questions — Q-15), a range answer left on the midpoint, the consent gate on the optional e-mail, an anonymous submit, a consented submit that stores the address | 5 |
| `tests/e2e/checklist.e2e.test.ts` | `/sjekkliste`: phone lookup refused with no active rental, then lookup → phase → photo upload → submit, asserted down to the stored upload URL | 2 |
| `tests/e2e/review.e2e.test.ts` | `/omtale/<token>`: unknown token, the star-rating requirement, the honeypot, one stored review, single-use in both directions | 4 |
| `tests/e2e/page-gates.e2e.test.ts` | `/vilkar` tabs (Bedrift hidden while `b2bEnabled` is off — Q-14 — and the clause-number contrast, W-6), `/personvern`, `/kontakt` on and off with the matching footer link, `/bedrift` and `/tilbud/<bad token>` 404, the contact honeypot, and the Q-6 status codes | 6 |
| `tests/e2e/maintenance.e2e.test.ts` | `maintenanceMode` and `surveyMode` whole-site take-overs, each restored immediately | 2 |

### Running them

```bash
SCRATCH=/tmp/claude-1000/-home-deller-Documents-graveklar/<session>/scratchpad/testdb

AUDIT_BASE_URL=http://localhost:3001 AUDIT_DB_FILE=$SCRATCH/audit.db \
  npx vitest run tests/e2e/booking-checkout.e2e.test.ts \
                 tests/e2e/booking-checkout-ui.e2e.test.ts \
                 tests/e2e/cancel-token.e2e.test.ts \
                 tests/e2e/cancel-ref-email.e2e.test.ts \
                 tests/e2e/survey.e2e.test.ts \
                 tests/e2e/checklist.e2e.test.ts \
                 tests/e2e/review.e2e.test.ts \
                 tests/e2e/page-gates.e2e.test.ts

# the two whole-site take-overs are opt-in — they blank the site for every
# other client of the instance while they run
AUDIT_BASE_URL=http://localhost:3001 AUDIT_DB_FILE=$SCRATCH/audit.db \
  AUDIT_ALLOW_CONFIG_FLIP=1 npx vitest run tests/e2e/maintenance.e2e.test.ts
```

Every file is `describe.skipIf(!process.env.AUDIT_BASE_URL)`, so a plain
`npm test` skips the whole directory instead of failing.

### Things the harness has to get right

- **One file at a time.** Vitest runs test *files* in parallel, but these share
  one app and one database. Each file takes a cross-file advisory lock
  (`<tmp>/graveklar-audit-e2e.lock`, stolen after 10 minutes so a crashed run
  cannot wedge the next one) in `beforeAll` and releases it in `afterAll`. The
  hooks are given a 900 s timeout because the last file in a run waits for the
  six before it.
- **A fresh rate-limit identity per browser and per fetch.** Every limited route
  keys on `x-real-ip || x-forwarded-for[0]` (phase-1d **H-5**), so each run sends
  a random private-range address. Without it the second pass trips 429 on
  `/api/booking/cancel` and `/api/checklist/lookup`.
- **Fixture dates come from `BookingDateLock`, not from the calendar.** The lock
  table is the constraint that actually decides, so `firstFreeStartDate()` reads
  it and steps forward a week at a time. At audit time this was also a
  work-around for Q-4 (the calendar offered days the insert refused); with the
  locks now released on `completed` it is simply the right source.
- **DOM clicks, not coordinate clicks.** Several sections scroll-animate into
  place and a mouse click computed before the scroll settles lands on the wrong
  element (this silently swallowed calendar clicks for the first hour of the
  audit).
- **`setInput` selects-all before typing** and verifies the result. `page.type`
  appends and Backspace does nothing useful against a React-controlled input; a
  previous audit run mis-filed the resulting `wrong@example.coaudit@…` as a
  product bug. It is not one.
- **Config writes are followed by a 2.5 s wait** — `loadAppConfig()` caches for
  two seconds — and every one of them is reverted in `afterAll`, including on
  failure.
- **`page.evaluate` is awaited before `finally` closes the browser.** Returning
  the promise itself lets `browser.close()` race the evaluation and produces a
  `TargetCloseError` that looks like an app failure.

---

## Verified fine

- **The money path end to end.** Form → server quote → `POST /api/bookings` →
  `POST /api/payment/stripe/create` → Stripe-hosted Checkout (`cs_test_…` in the
  URL and on the row) → signed webhook → `confirmed`, `fullyPaidAt`,
  `paymentProvider: 'stripe'`, a cancel token, and one frozen `AcceptedContract`
  (`acceptanceMethod: 'checkbox'`, a 64-hex terms hash, ~15 kB of HTML).
- **The webhook is idempotent from the browser's side too.** Replaying the same
  event leaves one contract and one `confirmed` row.
- **Every money figure on the page comes from `/api/quote`.** Base price, extra
  hours, delivery, MVA, discount lines and the total all move together, and the
  confirmation dialog repeats the server's number, not a locally recomputed one.
- **The submit button is disabled with a visible reason whenever the server's
  quote says `bookable: false`,** and the pay buttons stay disabled until the
  terms are accepted.
- **Honeypots.** The booking form (`name="website"`, `class="hidden"`,
  `tabIndex={-1}`), the contact form and the review form all carry one, none is
  rendered, and `POST /api/kontakt` and `POST /api/omtale/<token>` both answer
  400 “Ugyldig forespørsel” when it is filled.
- **Calendar rules.** Past days, `minBookingDaysAhead`, “weekend must start
  Friday” and “week must start Monday” are all enforced in the grid (only the
  *wording* was wrong — Q-7, since fixed), a Sat/Sun click snaps to its Friday,
  and the day rental type is absent from the tiles because `enabledRentalTypes`
  excludes it.
- **Address autosuggest → fee.** Typing three characters queries
  `/api/address-suggest`, picking a suggestion produces “Levering: +1 551 kr
  (68.2 km – utover 40 km inkludert)” and the same number appears in the summary
  and in the confirmation dialog. “Hent selv” zeroes it and relabels the line
  “Selvhenting · Inkludert”.
- **The rejected discount code** answers “✗ Ugyldig kode.” and leaves the total
  untouched; the accepted one moves the total (its *message* is Q-9).
- **The multi-week stepper** caps itself (8 weeks on this instance) instead of
  running away, and the hours breakdown adds up at every step.
- **Cancellation.** Both entry paths work, the destructive step is behind a
  second confirmation, the fee preview matches the fee charged, the date locks
  are released, the token is single-use, and a wrong e-mail and an unknown
  reference produce the same refusal with nothing about the real booking in it.
- **The QR checklist.** An unknown phone is refused with a message that reveals
  nothing; the renter phases stay locked behind the operator's handover; submit
  stays disabled until every required item — including the minimum photo count —
  is satisfied; the upload is stored as
  `renter-<bookingId>-<random>.<sniffed ext>` (phase-1d **H-7**/**H-8** both
  addressed) and the submission row carries the phase, the day's interval key
  and the renter's phone.
- **The review link.** Refuses a submission with no rating, stores it as
  `submitted` rather than published, greets a second visit with the thank-you
  state, and refuses a replayed POST with “Denne anmeldelsen er allerede sendt
  inn.” — the first submission stands.
- **The survey** stores exactly one row per completed run, keeps the e-mail out
  of it when none is given, and blocks submission when an e-mail is typed
  without consent (the *message* is Q-15).
- **Page gates.** `/kontakt` and its footer link appear and disappear together
  with `contactFormEnabled` — the polarity the plan predicted would be inverted
  is **correct**: `src/components/Footer.tsx:64` shows the link while the value
  is not `'false'` and `src/app/kontakt/page.tsx:23` serves the page while it is
  `'true'`, which agree for both boolean values and for an unset key. (They
  diverge only for a third value such as `'0'`, which nothing writes.) The
  *status code* is wrong for both (Q-6).
- **Maintenance and survey take-over.** Each replaces the home page outright —
  `#booking` is gone from the DOM, not hidden — and the page comes back intact
  when the flag is cleared.
- **Dark mode.** Follows `prefers-color-scheme` before any choice is made, the
  toggle writes `localStorage.theme`, the choice survives a reload, and the
  button's `aria-label` flips with it.
- **Mobile (375 × 812).** No horizontal overflow anywhere on the home page, the
  booking funnel completes, the submit button is full width, and both dialogs fit
  the viewport with their own internal scroll.
- **404.** An unmatched route renders the Norwegian 404 page with a link home
  and a contact link, and nothing in the customer surface exposed a stack trace
  or an internal path during the whole run.
- **The contact form degrades honestly** with SMTP unset: 503 and “Kontaktskjema
  er ikke konfigurert. Ta kontakt på telefon eller e-post.” next to the phone
  number and address, rather than a silent success.
- **`/vilkar`** rendered all three tabs with real content and `/personvern`
  renders the privacy notice. (The Bedrift tab's *existence* was Q-14; it is now
  served only while `b2bEnabled` is on, so the audit instance shows two tabs.)
- **The machine picker stays in sync.** Selecting a machine from the showcase
  tabs or advancing the carousel updates the booking form's machine, its price
  tiles and the summary header together.

## What was not done, and why

- **No card number was entered anywhere**, per the audit rules. Everything past
  the Checkout redirect is driven by a signed webhook, so Stripe-side states
  that only a real payment produces — `payment_intent` expansion,
  `payment_method` capture, `charge.refunded` — are not exercised here. Phase 1c
  covers them below HTTP.
- **The refund leg of a cancellation is untested end to end.** The injected
  webhook leaves `stripePaymentIntentId` null, so `updateBookingStatus` has
  nothing to refund; the fee arithmetic and the “floored at zero” rule are
  phase-1c's.
- **`/bedrift` was never enabled.** It is off by design and the audit did not
  turn it on, so only its 404 behaviour is recorded.
- **TOTP was never enrolled**, and the admin session was used exactly twice —
  to walk one booking to `completed` so the review link could be minted. The
  admin surface itself is agent 2b's.
- **The error boundary was never reached.** `src/app/error.tsx` is a client
  boundary that only renders when a client render throws; nothing in the
  customer surface could be made to throw from the outside during this run.
  Read rather than exercised, it is clean: a Norwegian apology, `error.digest`
  (an opaque id, not a message), a retry and a link home — no stack, no path.
  Recorded as unverified, not as passing.
- **Screenshot capture through the interactive browser pane was unreliable**
  below roughly 4 000 px of scroll (blank frames), so every screenshot in the
  table was taken by the puppeteer scripts instead.
