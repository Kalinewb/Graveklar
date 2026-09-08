# Phase 2c — email, terms templating + frozen contracts, checklists, cron (areas J/K/L/O)

Scope: `src/lib/email.ts` (13 senders) + `src/lib/email-sample-booking.ts`;
`src/lib/terms-template.ts`, `src/lib/terms-defaults.ts`,
`src/lib/freeze-contract.ts`, `src/lib/contract-signing-service.ts`; routes
`GET /api/terms`, `GET|POST /api/admin/terms(+[id])`,
`GET /api/admin/bookings/[id]/contract`,
`PATCH /api/admin/bookings/[id]/contract-signing`; `src/lib/checklist.ts`,
`src/lib/renter-checklist.ts`, `src/lib/renter-checklist-db.ts`,
`src/lib/checklist-sandbox.ts`; routes `POST /api/checklist/lookup`,
`GET /api/checklist/session`, `POST /api/checklist/submit`,
`GET|POST /api/admin/checklist-phases(+[id], reorder)`,
`GET|POST /api/admin/checklist-items(+[id], reorder)`,
`GET /api/admin/bookings/[id]/checklist-submissions`; the completion-trigger
autocomplete in `src/lib/booking-service.ts`; and `src/lib/cleanup.ts` +
`GET /api/cron/cleanup`, `GET /api/cron/reminders`.

220 tests across 10 files, all green (**10 `it.fails`**, one per confirmed
defect below plus three extra instances of the same email-preheader bug).
Each `it.fails` asserts the behaviour the product *should* have and carries
its finding id in a comment beside it, so a fix phase flips it back to `it`.

| File | Tests |
| --- | --- |
| `tests/lib/email-templates.test.ts` | 51 (5 `it.fails`) |
| `tests/lib/terms-template.test.ts` | 20 |
| `tests/lib/checklist-branches.test.ts` | 40 |
| `tests/service/freeze-contract.test.ts` | 11 |
| `tests/api/terms.test.ts` | 15 (3 `it.fails`) |
| `tests/api/checklist-renter.test.ts` | 22 |
| `tests/api/admin-checklist.test.ts` | 25 |
| `tests/service/checklist-autocomplete.test.ts` | 7 |
| `tests/service/cleanup.test.ts` | 20 (2 `it.fails`) |
| `tests/api/cron.test.ts` | 9 |

`tests/lib/checklist-branches.test.ts` grew from 30 to 40 tests in a final
coverage-driven pass: `formatChecklistAnswerValue`/`formatStatNumber`
(`src/lib/checklist.ts`, used by the admin checklist-submissions UI) and
`hoursUntilNextInterval` (`src/lib/renter-checklist.ts` — confirmed dead code,
unreferenced anywhere under `src/`) were entirely uncovered; two
`filterRenterPhases` branches (an inactive renter phase, a
self-pickup-only phase on a delivery booking) were also gap-filled.

No `tests/helpers/content.ts` was needed — every helper already in
`tests/helpers/{db,route,mocks}.ts` and `tests/helpers/booking.ts`
(`setPricing()`, for the `mvaRate` finding below) covered what these tests
needed.

`tests/api/app-config.test.ts` already covers `POST
/api/admin/app-config/test-email` (the 6-template whitelist, the 400 without
`adminEmail`, the non-whitelisted-template fallback, and the sender-failure
500) — not duplicated here.

---

## Findings

| id | sev | title | src | demonstrating test | status |
| --- | --- | --- | --- | --- | --- |
| J-1 | P3 | **The admin new-booking notification hardcodes 25% MVA.** `sendNewBookingAdminNotification` computes `mvaIncluded = Math.round(totalPrice - totalPrice / 1.25)` and prints a literal `"MVA (25 %)"` label. It never reads `PricingConfig.mvaRate` (the single source of truth used everywhere else — `src/lib/mva.ts`), so a business running at a different VAT rate gets a silently wrong breakdown in the one place an operator reconciles the booking against its ledger. Correct behaviour: read the configured `mvaRate` the same way `readMvaSettings()` does | `src/lib/email.ts:438` and `:486` | `tests/lib/email-templates.test.ts` → "reflects the configured mvaRate, not a hardcoded 25%" | fixed — the admin new-booking notification splits `totalPrice` with `readMvaSettings()`/`splitMva()` from the live `PricingConfig`, and the label prints the configured rate (`src/lib/email.ts`) |
| J-2 | P2 | **The email preheader (the `<title>` and the hidden accessibility `<span>`) is never HTML-escaped, and four senders build it directly from a user-controlled field.** `layout()`'s `preheader` argument is interpolated verbatim into both the page `<title>` and a `display:none` `<span>` — the latter is still real markup: an email client parses it, and an `<img src=x onerror=…>` fires its handler even while hidden. Affected: `sendContactMessageEmail` (`Henvendelse fra ${input.name}`), `sendNewQuoteRequestAdminNotification` (`Ny bedriftsforespørsel fra ${quote.company}`), `sendNewBookingAdminNotification` (`Ny booking fra ${booking.name}`), and the admin copy of `sendBookingStatusEmail`'s cancelled path (`${booking.name} har avbestilt …`). Every one of these bodies already escapes the same field correctly — only the preheader was missed. Correct behaviour: HTML-escape `preheader` inside `layout()` itself, or escape at every call site | `src/lib/email.ts:154` (`layout()`), called unescaped at `:314`, `:359`, `:500`, `:646` | `tests/lib/email-templates.test.ts` → "booking.name is also escaped in the preheader of the ADMIN copy", "booking.name is escaped in the admin new-booking notification (preheader included)", "the contact form name is escaped everywhere, including the preheader", "quote.company is escaped everywhere in the admin notification, including the preheader" | fixed — `layout()` HTML-escapes its `preheader` argument once, covering the `<title>` and the hidden `<span>` for all 17 call sites (`src/lib/email.ts`); no caller passes intentional markup there |
| K-1 | P3 | **`PATCH /api/admin/terms/[id]` answers 500, not 400, when a field arrives with the wrong JS type.** The handler builds Prisma's `data` object directly from the raw request body (`sortOrder`, `isActive`, `content`, …) with no validation; a wrong-typed value reaches Prisma's own validator, which throws `PrismaClientValidationError`, and the catch-all turns that into a 500 carrying Prisma's internal error text instead of a clean 400 naming the bad field | `src/app/api/admin/terms/[id]/route.ts:11` | `tests/api/terms.test.ts` → "answers 400, not 500, when a field is sent with the wrong type" | fixed — `PATCH /api/admin/terms/[id]` shape-checks `title`/`content`/`sortOrder`/`isActive`/`audience` before Prisma and answers 400 naming the field |
| K-2 | P3 | **Neither `PATCH` nor `DELETE /api/admin/terms/[id]` checks the row exists before calling Prisma.** A missing id throws `P2025` ("record to update/delete not found"), and the catch-all maps that to a 500 instead of the 404 every other admin CRUD route in this codebase gives for the same case | `src/app/api/admin/terms/[id]/route.ts:11` (PATCH), `:34` (DELETE) | `tests/api/terms.test.ts` → "a missing section id answers 404, not the generic 500" (PATCH), "answers 404 for an id that does not exist" (DELETE) | fixed — both `PATCH` and `DELETE /api/admin/terms/[id]` look the row up first and answer 404, like every other admin CRUD route |
| O-1 | P2 | **The orphan-upload sweep does not know about `AcceptedContract.renderedHtml` or `Review.comment`.** `cleanupOrphanUploads()` collects live references from `Machine.imageUrl`, `MachineDocument.fileUrl`, `Booking.checklistData`, `ChecklistSubmission.data` and `AppConfig.value` — but not the two tables that can also embed an `/api/uploads/<file>` URL as a photo reference: the frozen legal contract snapshot and a customer's post-rental review. Once such a file passes the 24h grace period with no OTHER reference, the sweep deletes it out from under a contract that has already been signed (or a published review), silently breaking the historical record it exists to preserve. Correct behaviour: also collect references from `AcceptedContract.renderedHtml` and `Review.comment` | `src/lib/cleanup.ts:161-172` (the reference-collection `Promise.all`) | `tests/service/cleanup.test.ts` → "a file referenced only in AcceptedContract.renderedHtml survives the sweep", "a file referenced only in Review.comment survives the sweep" | **fixed** — `cleanupOrphanUploads` also collects references from `AcceptedContract.renderedHtml` and `Review.comment` (`src/lib/cleanup.ts`) |

---

## Verified fine (no defect — recorded so a future change doesn't silently regress)

- **Token regex tolerates spaces** (`{{ businessName }}`) and an **empty-string
  context value is treated as missing**, same as an unknown token — both
  render `[mangler verdi: key]` and land in `missing[]`
  (`renderTermsString`).
- **Every documented terms token** (`businessName`, `orgNumber`,
  `contactEmail`, `contactPhone`, `serviceArea`, `siteUrl`, `cancelFreeLabel`,
  `cancelLatePercent`, `cancelSameDayPercent`, `deliveryIncludedKm`,
  `deliveryPerKm`, `minDeliveryFee`, `maxDeliveryRadius`, `preOrderHourRate`,
  `overtimeRate`, `day/weekend/weekIncludedHours`, `egenandel`, `minAge`)
  resolves correctly from a fully-configured context and falls back to the
  documented defaults from an empty one.
- **`termsVersionHash`** is stable across context-key reordering, changes on
  any section title/content/order edit or context-value edit, and is
  unchanged by a byte-identical re-render.
- **`renderAcceptedTerms` HTML-escapes `&`, `<`, `>`** in both static section
  content and substituted token values (unlike the email preheader — see
  J-2).
- **Default-terms seeding is audience-independent and idempotent**: consumer
  seeding only fires when the consumer table is empty (even one custom row
  blocks it), business seeding is unaffected by the consumer table's state,
  and `renderAcceptedTerms('business')` lazy-seeds only the business set.
- **`freezeContractForBooking` is idempotent by `bookingId`** (a second call
  returns `created:false` and never touches the original row), **picks the
  business default TOC for `customerType:'business'`**, and **every path to
  `confirmed`** — a raw `updateBookingStatus()` call, a repeated call with
  different options, and the admin PATCH route hit twice — produces exactly
  one `AcceptedContract` row (the `previousStatus !== 'confirmed'` guard in
  `updateBookingStatus` prevents a second freeze attempt outright, on top of
  `freezeContractForBooking`'s own existence check).
- **A throwing contract freeze does not block the confirmed transition** — it
  is caught, logged (`console.error('Contract freeze failed:', …)`), and the
  booking still flips to `confirmed`.
- **`buildContractSigningUpdate`/`applyContractSigningUpdate`** action matrix,
  404/400 refusals and Digipost-reference/note handling were already
  exhaustively covered by `tests/lib/contract-signing-service.test.ts` — not
  duplicated.
- **Checklist branch coverage**: `yesno` counts both `true` and `false` as
  filled while `checkbox` requires `true` specifically; photo items respect
  `minPhotos` (defaulting to 1); a conditional item whose controlling item
  has been deleted from the pool defaults to "condition met" (never traps the
  user); an inactive-but-still-present controlling item still gates its
  child by its last stored answer; `split` audience flips `operator`↔`renter`
  purely on `booking.selfPickup`; the `hours` interval mode clamps elapsed
  time to zero before the 07:00 anchor and keeps counting straight across
  midnight (no reset); `findCompletionTriggerPhase`'s legacy name-regex
  fallback matches "Henting" and an English "Return"; `computeChecklistStats`
  pairs numeric readings across phases by `statKey` (falling back to the
  normalized label), needs ≥2 points to emit a row, and tolerates Norwegian
  decimal commas via `parseNumericAnswer`.
- **Renter checklist routes**: `/api/checklist/lookup` gates on
  `renterChecklistEnabled`, requires a phone that normalises to ≥8 digits,
  handles the multi-booking `needsSelection` fork correctly, and rejects a
  `bookingId` that isn't one of the caller's own bookings. `/api/checklist/session`
  401s a tampered bearer, 403s an inactive rental, and correctly derives
  `available`/`lockedReason` from the operator handover lock
  (`__phase_locked_<id>`) and, separately, the return-mode phase's end-date
  gate. `/api/checklist/submit` filters submitted keys down to the phase's own
  active item ids (a foreign item id or a `__locked` meta key never reaches
  storage), requires `isSubmissionComplete`, 409s a duplicate
  `(bookingId, phaseId, intervalKey)`, and recomputes `intervalKey`
  server-side for all four interval modes (`once`, `day-YYYY-MM-DD`,
  `return`, `h<n>` anchored at 07:00 on the start date) rather than trusting
  anything the client sent.
- **`maybeAutoCompleteOnReturDone`** fires exactly once when every active item
  of the completion-trigger phase is filled (inactive items are correctly
  excluded from the requirement), never on a cancelled booking, and never a
  second time once the booking is already `completed`. The resulting
  completion transition issues the repeat-discount code and the review
  request the same way any other completion does.
- **Admin checklist-phase/-item CRUD + reorder**: enum fields
  (`appliesTo`/`audience`/`intervalMode`) fall back to a safe default on an
  invalid value on both create and update; setting
  `isCompletionTrigger:true` on one phase clears it from every other phase
  (create and PATCH); deleting a phase cascades its items; both reorder
  endpoints require the *complete* id set for their scope and reject a
  foreign id.
- **`GET /api/admin/bookings/[id]/checklist-submissions`** resolves phase
  name/interval label/item metadata for each stored submission and falls
  back to "Ukjent fase" when the submission's phase is no longer an
  *active renter* phase (deactivated or reassigned to `operator`).
- **`runCleanupIfDue`**'s 60s throttle and `inFlight` guard: two calls in the
  same instant only run once, advancing the clock 61s re-arms it, and two
  genuinely concurrent callers serialise (the second observes `inFlight` and
  returns immediately without running a second sweep).
- **`runCleanup`**'s expiry sweep respects the strict `paymentDeadline < now`
  boundary (exactly-now survives, one ms past does not) and the equivalent
  60-minute boundary for a null deadline; it never touches a
  confirmed/cancelled/completed booking; it routes every expiry through
  `updateBookingStatus` one at a time (so the expiry email + audit log fire
  per booking) and a single failure does not stop the rest of the batch; it
  deletes only `BookingDateLock` rows whose booking no longer exists; and it
  nulls `cancelToken`/`cancelTokenExpiry` only once `cancelTokenExpiry` has
  passed.
- **`cleanupOrphanUploads`** correctly protects a referenced file from every
  column it DOES scan (`Machine.imageUrl`, `MachineDocument.fileUrl`,
  `Booking.checklistData`, `ChecklistSubmission.data`, `AppConfig.value`),
  skips anything younger than the 24h grace period, and survives a missing
  upload directory — see O-1 for the two columns it misses.
- **`GET /api/cron/cleanup` / `GET /api/cron/reminders`**: both 503 without
  `CRON_SECRET` configured and 401 on a wrong bearer. Reminders selects
  exactly the confirmed, not-yet-reminded bookings starting tomorrow in Oslo
  local time — verified correct straddling both 2026 DST transitions
  (2026-03-29 spring-forward, 2026-10-25 fall-back) — sends, then stamps
  `reminderSentAt`; a send failure for one booking leaves its
  `reminderSentAt` null and does not stop the rest of the batch.

---

## Coverage after (src/lib/**, `npm run test:coverage`)

Coverage: not measured, run blocked. A repo-wide `--coverage` run collides on
the shared `coverage/` reportsDirectory when other audit phases run their own
`--coverage` pass concurrently (hit once already — `rm -rf coverage` and a
retry recovered). A second, final attempt (redirected to a private
`--coverage.reportsDirectory` to avoid that collision) was still in flight
when this phase was called to wrap up, so no final numbers are recorded here.

What is known: a scoped `vitest run --coverage` limited to just this phase's
10 files (220 tests, all green, own reportsDirectory) confirmed
`formatChecklistAnswerValue`, `formatStatNumber` and
`hoursUntilNextInterval` are now exercised (0% before this phase's last
pass), and a full-repo coverage run taken earlier in this phase (before that
last pass) reported, for this phase's six target files: `email.ts`
93.50%/69.04%/95.34%/93.19% (stmt/branch/func/line), `terms-template.ts`
100%/86.27%/100%/100%, `freeze-contract.ts` 100%/76.92%/100%/100%,
`checklist.ts` 93.43%/82.44%/93.33%/93.87%, `renter-checklist.ts`
75%/62.66%/94.11%/80.23%, `cleanup.ts` 93.25%/83.33%/100%/94.73%. Those
numbers predate this phase's final 10 tests, so `checklist.ts` and
`renter-checklist.ts` in particular are undercounts of where things actually
landed (the three now-covered functions above were part of that gap); the
other four files were untouched by that last pass and should still be
accurate.

## Not done / could not verify

- Live-instance (`:3001`) verification of any of the above was not run — this
  phase is entirely in-process (L1–L3), per the harness rules.
- `tests/helpers/content.ts` was not created; nothing in this phase needed a
  helper beyond what already exists.
