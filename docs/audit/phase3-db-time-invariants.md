# Phase 3 — database invariants (U) and the temporal boundary suite (V)

Two questions, one layer.

**U — what stops corruption when the application logic fails?** Every unique
constraint, every declared referential action, every transaction rollback, every
NOT NULL and default, every status vocabulary, and the storage class a DateTime
actually occupies — asserted at the database, through raw Prisma calls with no
service code in front of them.

**V — where exactly is each deadline?** A deadline is a comparison operator, and
`<` and `<=` differ by one millisecond. Every expiry, window and horizon in the
product is probed one unit before its edge, at the edge, and one unit after, plus
the two Europe/Oslo days that are not 24 hours long and the local-midnight edge
where the Oslo calendar date and the UTC calendar date disagree.

**192 tests across eight files: 181 passing, 11 `it.fails`.** Each `it.fails`
asserts the behaviour the product *should* have and carries its finding id in a
comment directly above it, so the fix phase flips it back to `it`.

| File | Tests | Expected fails | Layer |
| --- | --- | --- | --- |
| `tests/invariants/db-constraints.test.ts` | 25 | 0 | L3i |
| `tests/invariants/db-cascades.test.ts` | 15 | 3 | L3i |
| `tests/invariants/db-rollback.test.ts` | 8 | 0 | L3i |
| `tests/invariants/db-enums.test.ts` | 55 | 3 | L0 + L3i |
| `tests/invariants/db-datetimes.test.ts` | 6 | 0 | L3i |
| `tests/invariants/time-boundaries.test.ts` | 39 | 3 | L3i |
| `tests/invariants/time-dst.test.ts` | 39 | 1 | L1 + L3i |
| `tests/invariants/no-iso-split.test.ts` | 5 | 1 | L0 |

Supporting, not test files:

- `tests/invariants/time-clock.ts` — the named instants (local midnight ± 1 ms in
  both seasons, both DST transitions bracketed to the millisecond, month end,
  year end, leap day), `at(iso, fn)` / `atEach()` around `mockClock`, and three
  oracles that deliberately do **not** use `@/lib/dates`: `osloDateStr()` (ICU),
  `utcDateStr()` and `osloOffsetMinutes()` / `osloDayLengthMs()`. A test that
  checks the product's date formatting with the product's own formatter proves
  nothing.
- `tests/helpers/invariants.ts` — `expectP2002()`, `conflictTarget()`,
  `sqliteTypeOf()`, `sqliteRawInt()`, `orphanLockBookingIds()`,
  `expectNoOrphanLocks()`.

Nothing in `tests/setup.ts` or `tests/helpers/{db,route,mocks,booking,auth}.ts`
was modified. No network call, no live database, no mail, no TOTP enrolment
(`verifyTotpCodeAgainst` takes the secret directly, and `AdminTotp` is the one
model the DateTime fixture deliberately leaves empty).

Every DB-touching file in this phase ends on a global `afterAll` that asserts
zero orphan `BookingDateLock` rows, via `expectNoOrphanLocks()`.

---

## Findings

Ids continue the phase-1 convention: `U-n` for area U, `V-n` for area V. Note
the punctuation: a **dash** is a finding (`U-6`), a **dot** is a section of this
document (`U.6`, the DateTime work). They are unrelated.

| id | sev | title | src | demonstrated by | status |
| --- | --- | --- | --- | --- | --- |
| U-6 | **P1** (test harness) | `resetDb()` brackets its truncation with `PRAGMA foreign_keys = OFF … = ON`. The pragma is **per connection** and Prisma pools connections, so the closing `ON` is not guaranteed to reach the connection the opening `OFF` reached — leaving a pooled connection with foreign keys disabled for the rest of the worker's life. Every `onDelete: Cascade` / `SetNull` routed to it then silently does nothing. Measured at **3 failures in 40 iterations** of a plain phase-delete-cascades-items assertion, with `PRAGMA foreign_keys` reading `0` at the moment of failure. This makes every referential-action assertion anywhere in the suite unreliable, and it is invisible — the delete succeeds, the children are simply still there. The pragma is also unnecessary: `TRUNCATE_ORDER` already deletes children before parents, which is the reason it is maintained by hand | `tests/helpers/db.ts:118` and `:128` | `db-cascades.test.ts` → “the shared reset never disables foreign key enforcement” | fixed 2aa944f — resetDb() no longer toggles PRAGMA foreign_keys; TRUNCATE_ORDER already deletes children first |
| V-2 | P2 | At `paymentDeadline === now` the calendar has already released the day — `/api/availability` skips a pending booking at `<= now` and `getUnavailableDateStringsForRange` keeps one only at `> now` (both pinned in phase 1b) — while `runCleanup`'s strictly-`<` sweep has not yet cancelled it, so its `BookingDateLock` rows still hold the slot. `createPendingBooking` allocates slots from that table, so the customer is offered a green day and refused at submit with “En eller flere dager i perioden er opptatt”. The window is one millisecond wide *at equality*, but the whole interval between the deadline and the next sweep — throttled to once a minute and driven by incoming traffic, so unbounded on a quiet site — has exactly the same shape | `src/lib/cleanup.ts:56` (`lt`) vs `src/app/api/availability/route.ts:143` and `src/lib/booking-service.ts:261` (`<=` / `>`) | `time-boundaries.test.ts` → “an expired pending booking never leaves the calendar and the lock table disagreeing” | **fixed** — `runCleanup`’s strict `<` owns the deadline instant: a pending booking is expired strictly *after* `paymentDeadline`, and `/api/availability` (`< now`) and `getUnavailableDateStringsForRange` (`>= now`) both moved to that side, so no reader calls a day free while the lock table holds it |
| U-1 | P3 | Deleting a `Machine` **detaches** the bookings that rented it. `Booking.machine` is an optional relation with no `onDelete`, which Prisma defaults to SetNull, so the database nulls `Booking.machineId` and `QuoteRequest.machineId` without complaint — and `BookingDateLock.machineId` has no foreign key at all, so its rows keep pointing at a machine that no longer exists. The only thing standing in the way is the admin route's 409, and it counts `pending`/`confirmed` bookings only: a *completed* rental loses the record of which machine it was. (The legal artifact survives — `AcceptedContract.renderContext` freezes the machine name and model — but the admin list, the per-machine statistics and the checklist all read the relation.) | `prisma/schema.prisma:39` and `:140`; guard at `src/app/api/admin/machines/[id]/route.ts:111-122` | `db-cascades.test.ts` → “refuses to delete a machine that a completed booking still references” | fixed at the route (no migration) — `DELETE /api/admin/machines/[id]` now refuses with 409 while ANY booking or quote request references the machine, not just `pending`/`confirmed` ones. The schema is unchanged, so the db-cascades test moved its assertion from `machine.delete()` to the route handler |
| U-2 | P3 | `Booking.paymentMethod` is documented as `'card' \| 'vipps' \| future methods`, but three further values reach the column: `'invoice'` from the B2B accept route, `'mock'` from the admin mock-booking tool, and whatever string Stripe reported as the PaymentMethod type. Anything grouping revenue or reconciling by payment method has to know all of them, and nothing tells the reader they exist | `prisma/schema.prisma:66` vs `src/app/api/tilbud/[token]/route.ts:96`, `src/lib/mock-booking.ts:240`, `src/lib/vipps-payments.ts:183`, `src/lib/stripe.ts` `getSessionPaymentMethodType()` | `db-enums.test.ts` → “Booking.paymentMethod writes only documented values” | fixed — the `Booking.paymentMethod` schema comment names all four writers (card/vipps/invoice/mock) and says the `card` value is whatever Stripe reported; comment only, no column change |
| U-3 | P3 | `ChecklistItem.answerType` is the one status-shaped column written with **no whitelist**. `appliesTo`, `audience` and `intervalMode` are all checked against a literal list in their admin route; `answerType` is stored as `body.answerType \|\| 'checkbox'` on create and passed straight through on update. An unrecognised `answerType` renders as nothing the renter can fill, `isItemFilled` never returns true for it, and a phase carrying `isCompletionTrigger` can then never complete — so the booking never auto-completes | `src/app/api/admin/checklist-items/route.ts:14` and `src/app/api/admin/checklist-items/[id]/route.ts:15`, against `prisma/schema.prisma`'s `checkbox \| yesno \| number \| text \| photo \| measurement` | `db-enums.test.ts` → “ChecklistItem.answerType refuses a value outside the documented list” | fixed — both `/api/admin/checklist-items` write sites whitelist `answerType` against the six documented values and answer 400 otherwise |
| U-4 | P3 | Three documented values have no writer anywhere in `src/`. The worst is `Booking.contractSigningMethod = 'online'`: the schema comment states “Online Stripe bookings auto-set method=online, status=signed when AcceptedContract is frozen”, `freeze-contract.ts` writes neither column, and `resolveContractSigning` deliberately returns `pending` for a confirmed booking with a comment saying online payment is *not* the same as a signed contract. The schema is documenting a design the code contradicts. Also unreachable: `contractSigningStatus = 'not_required'` (derived at read time, never stored) and `AcceptedContract.acceptanceMethod = 'scroll-then-checkbox'` (on `freezeContractForBooking`'s input type, passed by no caller) | `prisma/schema.prisma:74`, `:337`; `src/lib/freeze-contract.ts:16`, `:77`; `src/lib/contract-signing.ts:47-56`; `src/lib/contract-signing-service.ts:52-80` | `db-enums.test.ts` → “every documented value of every column has a writer” | fixed by correcting the comments, not by adding writers — `contractSigningMethod='online'` is recorded as reserved (writing it would open `isHandoverAllowed` for every online booking, which `resolveContractSigning` deliberately refuses), `contractSigningStatus='not_required'` as derived-at-read-time, and `AcceptedContract.acceptanceMethod='scroll-then-checkbox'` as accepted-but-unused |
| U-5 | P3 | `src/lib/db.ts` applies `busy_timeout`, `journal_mode` and `synchronous` behind a **process**-level `prismaPragmasApplied` guard, commented “Apply SQLite PRAGMA once per process”. All three are **connection**-scoped and Prisma pools connections, so one execution reaches one connection. Measured on a warm pool: `synchronous` reads `NORMAL` on 12 of 16 connections in one run, 2 of 16 in another. The practical damage today is small — `busy_timeout` is already 5000 by Prisma's own default, and `journal_mode = WAL` is persisted in the database header — so only `synchronous` is actually left partial, and that is durability/latency rather than correctness. The finding is the mechanism: the next pragma added to that block (`foreign_keys`, `cache_size`, `recursive_triggers`, …) will silently apply to a fraction of the pool | `src/lib/db.ts:23-35` | `db-cascades.test.ts` → “the app client has synchronous = NORMAL on every pooled connection” | deferred — Prisma has no per-connection hook, so the PRAGMAs stay process-level; `busy_timeout` and WAL are the ones that matter and both are also set on the database file itself; revisit if a pooled connection is ever seen with `synchronous = FULL` in production. The `it.fails` was nondeterministic (it depended on how many pooled connections 32 parallel reads landed on and passed under coverage instrumentation), so it now asserts only what is guaranteed: the startup pragma reaches at least one connection |
| V-1 | P3 | `toISOString().split('T')[0]` survives in one place: the admin CSV export names the download `bookinger-${new Date().toISOString().split('T')[0]}.csv`, so an export run between local midnight and 02:00 (01:00 in winter) is filed under yesterday's date. No booking data is wrong — only the file name — but it is the exact pattern `src/lib/dates.ts` exists to prevent, it is the one place a reader would copy it from, and that file already imports `@/lib/dates`, so `todayStr()` is one line away | `src/app/admin/page.tsx:2279` | `no-iso-split.test.ts` → “the pattern appears nowhere in src/” | fixed — the download is named from `toDateStr(new Date())`, the Oslo-local day, spelled out rather than `todayStr()` because the component already binds that name to its own mounted-safe copy. `tests/invariants/no-iso-split.test.ts` now asserts the pattern is absent from all of `src/` (the `it.fails` is gone) and pins the replacement. `src/app/admin/page.tsx` |
| V-3 | P3 | `bookingMaxAdvanceDays` measures the horizon as `(startLocalMidnight − now) / 86_400_000`, but a calendar day is not always 86 400 000 ms. A window containing the October fall-back is one 25-hour day long, so a start date exactly `bookingMaxAdvanceDays` **calendar** days out measures 30.0417 and is refused. With `bookingMaxAdvanceDays = 30`, 2026-10-10 → 2026-11-09 is refused while 2026-06-15 → 2026-07-15 is accepted. The spring transition makes the same arithmetic an hour *generous*, which is why it has never been noticed. The identical expression appears in both the preview and the submit, so they agree with each other and both refuse a date the setting says is bookable | `src/lib/domain/quote.ts:164` and `src/lib/booking-service.ts:439-441` | `time-boundaries.test.ts` → “accepts exactly N calendar days ahead across the autumn transition too” | **fixed** — `calendarDaysUntil` counts whole calendar days between two local midnights and is used by both `checkBookable` and `validateBookingInput` (`src/lib/booking-service.ts`, `src/lib/domain/quote.ts`) |
| V-4 | P3 | `generateBookingReference`'s month window ends at `new Date(y, m + 1, 0, 23, 59, 59)` — 23:59:59.**000**, not `.999`. A booking created in the last 999 ms of a month falls outside `lte: monthEnd` and is not counted, so the next booking of that same month reuses its sequence number. The reference itself stays unique (the five-character random suffix sees to that), but the `GK-YYMM-NNN` number the admin and the customer quote to each other is no longer unique within the month | `src/lib/booking-service.ts:215` | `time-boundaries.test.ts` → “counts a booking created in the last millisecond of the month” | **fixed** — the month window is half-open, `lt: nextMonthStart`, so there is no last-millisecond edge (`src/lib/booking-service.ts`) |
| V-5 | P3 | `getCancelFreeHours` turns the admin's “2 dager” into a fixed 48 hours and `hoursUntil` is real elapsed hours, so when the 23-hour spring day sits inside the window, “two whole days before the rental” is only 47 elapsed hours and the customer is charged the 50 % late fee at a wall-clock moment the policy label (`getCancelFreeLabel` → “2 dager”) says is free. Same config, same lead time, free in June and 1 245 kr in March. The autumn day makes the window an hour longer than advertised — harmless, and the reason the asymmetry survives | `src/lib/cancellation.ts:4-9` and `src/lib/booking-service.ts:833-846` | `time-dst.test.ts` → “is free two whole calendar days before a rental across the spring transition” | **fixed** — `evaluateCancellationPolicy` anchors the cutoff at local midnight of the start day minus the configured window in **calendar** days, shared by `updateBookingStatus` and the `/api/booking/cancel` preview (`src/lib/cancellation.ts`) |

Severity key (same as phase 1b): **P0** money or safety can be wrong in
production today · **P1** a documented action silently does nothing · **P2**
divergence between what the customer/admin is shown and what the system does ·
**P3** correctness of an error shape, a report count, a documented vocabulary, or
a defence-in-depth gap with a working outer guard.

### Why U-6 is P1 even though it is “only” a test

Every phase of this audit has asserted, somewhere, that deleting a parent row
removes its children. Those assertions pass ~92 % of the time and are silently
vacuous the rest. The fix is a deletion, not an addition: drop lines 118 and 128
of `tests/helpers/db.ts`. `TRUNCATE_ORDER` is already child-before-parent and a
smoke test keeps it complete, which is exactly why the pragma was never needed.
Phase 3's own cascade file works around it by running every referential
assertion on a per-test `freshDb()` — a client on a brand-new file whose
connections have never had the pragma toggled.

---

## Area U — what was asserted

### U.1 · Unique constraints (`db-constraints.test.ts`)

Every one is exercised with a raw `create()`, asserts Prisma's `P2002`, and then
asserts the **first row survived** — a rejected write must not clobber or
half-apply. All 19 hold.

| constraint | also asserted |
| --- | --- |
| `BookingDateLock (machineId, date, slot)` | two independent bookings cannot take the same slot; a second machine, a second day and a second slot are all accepted |
| `Booking.reference` | the loser's row does not exist |
| `Booking.cancelToken` | many rows may sit at NULL at once — which is what makes the sweep's `cancelToken: null` write legal |
| `Booking.checklistToken` | same NULL rule |
| `Booking.vippsReference` | and the `…-r2` retry reference is accepted |
| `CampaignDiscountCode.code` | `usedCount` on the survivor is untouched |
| `RepeatDiscountCode.code` | the loser's e-mail did not overwrite the winner's binding |
| `ReferralCode.code` | the survivor keeps its `ownerEmail` |
| `WebhookEvent (provider, eventId)` | and Stripe and Vipps may legitimately share an event id |
| `AcceptedContract.bookingId` | the frozen `termsVersionHash` is not rewritten by the refused second freeze |
| `Review.bookingId`, `Review.token` | both, on separate bookings |
| `ChecklistSubmission (bookingId, phaseId, intervalKey)` | the stored `data` is the first submission's; next day / next phase / next booking all pass |
| `UnavailableDate.date` | and the column is an *instant*, not a day — a row at 12:00 is a second row |
| `AppConfig.key` (primary key) | the first value survives |
| `PricingConfig.key` | the first value survives |
| `SurveyQuestion.key` | the first label survives |
| `QuoteRequest.reference` | status stays `ny` |
| `QuoteRequest.acceptToken` | many NULLs allowed |

### U.2 · Referential actions (`db-cascades.test.ts`)

Everything below matches what `prisma/schema.prisma` declares. Each runs on its
own `freshDb()` — see U-6.

| delete | effect | verdict |
| --- | --- | --- |
| `Booking` | `ChecklistSubmission`, `AcceptedContract`, `Review`, `CampaignRedemption`, `ReferralRedemption` all cascade; `ChecklistPhase`, `CampaignDiscountCode` and `ReferralCode` survive | as declared |
| `Booking` | `RepeatDiscountCode.issuedForBookingId` **and** `redeemedByBookingId` both null out, the coupon row survives, and `redeemedAt` is what still says “used” — the reason `validateRepeatCode` checks it as well as the FK | as declared |
| `Booking` | `BookingDateLock` rows **remain** — the table has no foreign key | as declared; see below |
| `Machine` | `MachineDocument` cascades | as declared |
| `Machine` | `Booking.machineId` and `QuoteRequest.machineId` are nulled, `BookingDateLock.machineId` is left dangling | as declared, and **dangerous** — finding U-1 |
| `ChecklistPhase` | `ChecklistItem` and `ChecklistSubmission` cascade; the owning `Booking` survives | as declared |
| `CampaignDiscountCode` | `CampaignRedemption` cascades; the booking survives | as declared |
| `ReferralCode` | `ReferralRedemption` cascades; the referred booking survives | as declared |

**`BookingDateLock` carrying no foreign key is an accepted design, and the
compensating control holds.** A lock has to be able to outlive the row that
created it — the slot allocator reads the lock table, not the booking table, so a
lock that vanished with its booking would let a second customer in before the
first transaction settled. The reconciliation is `runCleanup`'s orphan sweep, and
this phase drives it rather than assuming it: after a booking delete strands one
lock, `runCleanup()` reports `orphanLocksReleased: 1` and the table is empty. The
cost while a lock is stranded is asserted too — the slot stays taken, so the day
is unbookable until the sweep runs, which is the same shape as finding V-2.

### U.3 · Transaction rollback (`db-rollback.test.ts`)

Five failure modes, all reachable in production, all asserted to leave **no
Booking, no lock, no repeat-code claim, no `CampaignRedemption`, no contract**:

| failure | where it lands |
| --- | --- |
| machine with `quantity: 0` | slot allocation, after `tx.booking.create` |
| a stranded lock already holding the only slot (invisible to the pre-flight conflict check, which reads Booking rows) | slot allocation, after `tx.booking.create` |
| the same, with a valid repeat code applied | the code is still unclaimed afterwards |
| **two checkouts racing for one repeat code** | the atomic `updateMany … where redeemedByBookingId: null` — the loser has already written its Booking row *and* its locks, so this is the path that exercises a rollback of a fully built booking. Exactly one rejection (`Rabattkoden er allerede brukt.`), exactly one Booking, exactly one lock, the code claimed by the winner |
| `PriceDriftError` | before the transaction opens; nothing at all is written |
| campaign code + a failing booking | `usedCount` stays 0 — the redemption is deliberately *outside* the transaction, so the thing to prove is that the failure path never reaches it |

`convertQuoteToBooking` has **no** pre-flight conflict check, so a stranded lock
puts its throw squarely inside the transaction, after `tx.booking.create`: no
Booking, no new lock, and the `QuoteRequest` still at `tilbud_sendt` with
`convertedBookingId` null. The happy path commits booking + locks together and
moves the quote to `akseptert`.

### U.4 · NOT NULL and defaults

Five representative required columns refuse NULL and nothing lands
(`Booking.email`, `Booking.startDate`, `Machine.model`, `AppConfig.label`,
`ChecklistItem.label`). Defaults apply on omission: `Booking.status = 'pending'`,
`customerType = 'consumer'`, `selfPickup = false`, `includedHours = 0`,
`paymentRetries = 0`, `checklistData = '{}'`, `createdAt`/`updatedAt` inside the
call window; `CampaignDiscountCode.usedCount = 0` / `isActive = true` /
`maxUses = null`; `ChecklistPhase` `isActive`/`appliesTo`/`audience`/
`intervalMode`/`isCompletionTrigger`; `ChecklistItem.answerType = 'checkbox'`;
`TermsSection.audience = 'consumer'`; `BookingDateLock.slot = 0`; `AppConfig`
`value`/`type`/`isPublic`/`sortOrder`.

> Worth knowing for any future clock-frozen test: `@default(now())` is evaluated
> by Prisma's **query engine** against the real system clock, so `mockClock`
> (which fakes JS `Date` only) does not reach it. `createdAt` has to be passed
> explicitly when a test cares about it.

### U.6 · DateTime storage (`db-datetimes.test.ts`)

The schema is parsed for every `DateTime` column, one row is created in every
model that has one (`AdminTotp` excluded — the suite never enrols 2FA), and:

- no DateTime column in any populated table is stored as `text` or `real`;
- every explicitly written instant round-trips to the millisecond, and the raw
  integer is epoch **milliseconds** (`.999` survives — which is what makes every
  probe in area V meaningful);
- `Booking.startDate` for 2026-06-15 is `2026-06-14T22:00:00.000Z`: Oslo local
  midnight, not UTC midnight;
- local midnight on both DST days stores as a real instant
  (`2026-03-28T23:00:00.000Z` and `2026-10-24T22:00:00.000Z`).

And the counter-example the repo rule exists for: a row inserted with raw SQL as
`'2026-06-15'` is accepted by SQLite, reads back with `typeof = text`, and is
then **invisible** to the month-range query every calendar read uses — in
SQLite's type ordering every TEXT value sorts after every INTEGER, so a `lte`
bound built from a real `Date` can never match it. The row is still there; it
just stops existing as far as the app is concerned. That is why a DateTime is
never inserted through the `sqlite3` CLI.

---

## Enum reconciliation (`db-enums.test.ts`)

SQLite has no enum type. Every column below is plain TEXT, and the test file
proves it by storing `'schrödinger'` in `Booking.status`, `'kvartalsleie'` in
`rentalType`, `'alien'` in `customerType`, `'nonsense'` in three
`ChecklistPhase` columns and `'paypal'` in `WebhookEvent.provider` — all
accepted, all `typeof = text`. The defence has to live in the application, per
column.

“documented” is transcribed from the schema comment and re-checked against the
live schema text on every run, so editing a comment without editing the table
fails the suite instead of drifting.

| model.field | documented in schema | written by code | verdict |
| --- | --- | --- | --- |
| `Booking.status` | pending, confirmed, cancelled, completed | same (`LEGAL_TRANSITIONS`) | ✅ |
| `Booking.customerType` | consumer, business | same | ✅ |
| `Booking.rentalType` | day, weekend, week, custom | same (`VALID_RENTAL_TYPES`) | ✅ |
| `Booking.paymentProvider` | vipps, stripe | same | ✅ |
| `Booking.paymentMethod` | card, vipps | card, vipps, **invoice**, **mock**, + Stripe's own type string | ❌ **U-2** |
| `Booking.vippsState` | CREATED, AUTHORIZED, ABORTED, EXPIRED, TERMINATED | same (`VippsPaymentState`) | ✅ |
| `Booking.contractSigningMethod` | online, digipost, paper | digipost, paper — **`online` never written** | ❌ **U-4** |
| `Booking.contractSigningStatus` | pending, sent, signed, paper, not_required | pending, sent, signed, paper — **`not_required` only derived** | ❌ **U-4** |
| `QuoteRequest.status` | ny, tilbud_sendt, akseptert, konvertert, avslatt, utlopt, trukket | same (`QUOTE_STATUSES`) | ✅ |
| `QuoteRequest.paymentMode` | card, invoice | same (coerced at the admin route) | ✅ |
| `Review.status` | pending, submitted, approved, rejected | same | ✅ |
| `ChecklistPhase.appliesTo` | all, delivery, selfPickup | same (whitelisted) | ✅ |
| `ChecklistPhase.audience` | operator, renter, split | same (`CHECKLIST_AUDIENCES`) | ✅ |
| `ChecklistPhase.intervalMode` | once, return, daily, hours | same (whitelisted) | ✅ |
| `ChecklistItem.answerType` | checkbox, yesno, number, text, photo, measurement | **any string the admin sends** | ❌ **U-3** |
| `TermsSection.audience` | consumer, business | same (coerced) | ✅ |
| `AcceptedContract.acceptanceMethod` | checkbox, scroll-then-checkbox | checkbox — **`scroll-then-checkbox` has no caller** | ❌ **U-4** |
| `WebhookEvent.provider` | stripe, vipps | same | ✅ |

Every documented value is also asserted to be *accepted* by the column, so a
legal value is never rejected by an accidental client-side constraint either.

---

## Area V — behaviour × edge × result

`−1` / `0` / `+1` are the probe instants relative to the edge, at millisecond
resolution unless stated. ✅ = the operator is where it should be.

### Deadlines and expiries

| behaviour | operator | −1 unit | at the edge | +1 unit | verdict |
| --- | --- | --- | --- | --- | --- |
| `runCleanup` cancels an expired pending booking (`cleanup.ts:56`) | `paymentDeadline < now` | cancelled | **kept** | kept | boundary is consistent in itself, but disagrees with the calendar — **V-2** |
| `runCleanup` stale fallback with no deadline | `createdAt < now − 60 min` | cancelled | kept | kept | ✅ |
| `runCleanup` releases the locks when it cancels | — | — | 0 locks left | — | ✅ |
| `runCleanup` clears a lapsed cancel token (`cleanup.ts:88`) | `cancelTokenExpiry < now` | cleared | kept | kept | ✅ — meets the cancel route's “valid at exactly now” exactly (phase 1c) |
| orphan upload sweep (`cleanup.ts:182`) | `age < 24 h` → keep | kept at 24 h − 1 ms | **deleted** at 24 h | deleted | ✅; a referenced file is never deleted at any age |
| repeat code expiry (`discount-engine.ts:196`) | `expiresAt < now` | valid | valid | expired | ✅, and the 365-day window is exact |
| campaign code expiry (`discount-engine.ts:181`) | `expiresAt < now` | valid | valid | expired | ✅ |
| offer accept — `acceptTokenExpiry` and `offerValidUntil` (`tilbud/[token]/route.ts:83-88`) | both `< now` | 200 `konvertert` | 200 `konvertert` | 410 `utlopt` | ✅; either half alone closes the offer |
| delivery-quote token, 6 h | `Date.now() > exp` | — | pinned in phase 1b | — | ✅ (re-probed across a DST jump) |
| renter session, 4 h | `Date.now() > exp` | — | pinned in `tests/lib/renter-session.test.ts` | — | ✅ (re-probed across a DST jump) |
| admin session, 7 d | `Date.now() > exp` | valid at exactly 7 d | — | invalid at +1 ms | ✅ (re-probed across a DST jump) |
| TOTP 30 s step | `floor(epoch/30)` | valid in step | valid in step | invalid next step | ✅, and epoch-only — the wall-clock hour jump is irrelevant |

### The cancellation fee

Rental starting 2026-06-15 at Oslo midnight, `cancelFreeDays = 2` (48 h),
`cancelLatePercent = 50`, `cancelSameDayPercent = 100`, base 2 490 kr.

| probe instant | rule under test | fee |
| --- | --- | --- |
| 2026-06-12 23:59:59.999 | `hoursUntil < free` | none |
| 2026-06-13 00:00:00.000 — the cutoff | `<` is strict | none |
| 2026-06-13 00:00:00.001 | | 1 245 |
| 2026-06-14 23:59:59.999 | not yet the start day | 1 245 |
| 2026-06-15 00:00:00.000 — local midnight | `bookingStart <= todayMidnight` | 2 490 |
| 2026-06-15 00:00:00.001 | | 2 490 |
| 2026-06-15 00:30 (UTC still says the 14th) | the “today” used is the Oslo day | 2 490 |
| 2026-06-14 23:30 | | 1 245 |
| **2026-03-28 00:00 for a 2026-03-30 rental** | 48 fixed hours across a 23-hour day | **1 245 — V-5** |
| 2026-10-23 23:30 / 2026-10-24 00:30 for a 2026-10-26 rental | 48 fixed hours across a 25-hour day | none (an hour of unadvertised grace) |
| the start day itself, on either DST day | same-day rule is calendar-based | 2 490 |

### The booking horizon

| behaviour | probe | result |
| --- | --- | --- |
| `minBookingDaysAhead = 2` at 23:59:59.999 | earliest is today + 2 | ✅ today+2 accepted, today+1 refused |
| …at exactly local midnight | the window has moved one whole day | ✅ |
| …one millisecond past midnight | behaves like midnight, not like the day before | ✅ |
| `bookingMaxAdvanceDays = 30`, no transition inside | N accepted, N + 1 refused | ✅ at midnight and at 23:59:59.999 |
| `bookingMaxAdvanceDays = 30`, autumn transition inside | N calendar days | ❌ refused — **V-3** |
| `bookingMaxAdvanceDays = 30`, spring transition inside | N accepted, N + 1 refused | correct by accident (the arithmetic is an hour generous) |

### Local midnight, DST and the calendar

| behaviour | probe | result |
| --- | --- | --- |
| `todayStr()` on both sides of midnight | −1 ms / 0 / +1 ms, summer and winter | ✅ Oslo day, not UTC day |
| `toDateStr` / `dbDateToStr` vs ICU | six instants on the two DST days | ✅ identical |
| `getRentalDateRange` week across 2026-03-29 (23 h) | 7 dates | ✅ 7 distinct |
| `getRentalDateRange` week across 2026-10-25 (25 h) | 7 dates | ✅ 7 distinct |
| weekend starting the day before either transition | 3 dates | ✅ |
| 8-week rental crossing a transition | 56 dates | ✅ 56 distinct, ends 2026-05-17 |
| `addDays ±1` at both transitions, month end, year end, both sides of a leap day | 8 edges | ✅ |
| `parseDateStr` noon anchoring | both DST days + leap day | ✅ hour is 12 |
| `dateToDbMidnight` round-trip | both DST days | ✅ |
| `BookingDateLock` for a week across the spring transition | 7 rows | ✅ 7 distinct dates and 7 distinct instants |
| `/api/availability` on either DST day | the day itself is blocked, neither neighbour | ✅ |
| `/api/availability` for a week across the spring transition | 5 in-month days blocked | ✅ |
| `/api/availability` pending → tentative at local midnight | Oslo day, not UTC day | ✅ |
| `cron/reminders` “tomorrow” before and inside both DST days | 23 h and 25 h days, including the repeated hour | ✅ |
| `cron/reminders` today / day-after-tomorrow | not reminded | ✅ |
| `cron/reminders` at −1 ms / 0 / +1 ms around local midnight | “tomorrow” flips at midnight, not at 22:00 | ✅ |
| `computeIntervalInfo` daily key at −1 ms / 0 / +1 ms around midnight | key and day number flip together | ✅ |
| `computeIntervalInfo` daily across both DST days | one key per calendar day; the repeated hour shares one key | ✅ |
| `computeIntervalInfo` hours mode, anchored at 07:00 across the 23-hour day | rolls at 24 **elapsed** hours = 08:00 local | ✅ by design — documented below |
| `computeIntervalInfo` hours mode inside the repeated autumn hour | `h19` then `h20` | ✅ no key collision |
| `generateBookingReference` prefix at month end / +1 ms | `GK-2606` then `GK-2607-001` | ✅ |
| `generateBookingReference` count in the last millisecond of a month | should be 002 | ❌ **V-4** |

### The fixture itself

`time-dst.test.ts` starts by proving the named instants are what they claim:
the spring pair is exactly 1 ms apart and straddles +01:00 → +02:00, the autumn
pair is exactly 1 ms apart and straddles +02:00 → +01:00 while landing on the
same Oslo calendar date, 2026-03-29 is 23 h long, 2026-10-25 is 25 h, and every
other day in the fixture is exactly 24 h.

---

## Verified fine — one-liners

- **Every unique constraint rejects its duplicate at the database and leaves the
  first row intact.** All 19, `P2002`, no partial application.
- **A `@unique` nullable column allows any number of NULLs**, which is what makes
  the cleanup sweep's bulk `cancelToken: null` write legal.
- **`WebhookEvent`'s replay guard is correctly scoped per provider** — Stripe and
  Vipps may share an event id.
- **Every declared referential action does what the schema says**, on a client
  whose foreign keys are actually on (see U-6 for the one where they are not).
- **A child row with a non-existent parent is refused**, so a cascade that
  appears to work is not an artefact of a missing FK in the DDL.
- **Both booking-creating transactions roll back completely.** Five failure modes
  for `createPendingBooking`, two for `convertQuoteToBooking`; no orphan row, no
  orphan lock, no spent code in any of them.
- **The repeat code is claimed at most once under a real race**, and the loser's
  fully built booking (row + locks) disappears with the rollback.
- **Zero orphan locks after every DB-touching file in this phase.**
- **Every DateTime is an INTEGER of epoch milliseconds and round-trips exactly**,
  including `.999`.
- **A booking date is Oslo local midnight in storage, not UTC midnight.**
- **SQLite accepts every documented enum value and every undocumented one**, so
  the vocabulary is an application concern by construction — now written down.
- **No `toISOString().split('T')[0]`, `.slice(0, 10)` or `.substring(0, 10)`
  anywhere under `src/lib/`, `src/app/api/` or `src/proxy.ts`**, and no server
  module mixes the two date semantics.
- **`getCancelFreeHours`'s free-window boundary is inclusive of “free”**, at
  millisecond resolution, matching the hour-granularity table in phase 1c.
- **The cancel-token sweep and the cancel route agree exactly at `expiry ===
  now`**: the route still honours the link and the sweep does not clear it.
- **The orphan-upload grace period never deletes a referenced file**, at any age.
- **Calendar arithmetic (`addDays`, `parseDateStr`, `getRentalDateRange`,
  `dateToDbMidnight`) is DST-proof**, because it is noon-anchored — a 7-day
  rental is 7 dates across a 23-hour day and across a 25-hour one.
- **Every signed-token lifetime is epoch arithmetic and therefore DST-immune** —
  the delivery quote's 6 h, the renter session's 4 h, the admin session's 7 d and
  the TOTP step all measure real elapsed time across a transition. Worth knowing:
  that means a 7-day admin session minted at 12:00 expires at 13:00 local, and a
  6-hour delivery quote minted at 01:59 CET dies at 08:59 CEST.
- **The reminder cron's “tomorrow” is a calendar day**, correct on a 23-hour day,
  a 25-hour day, inside the repeated hour, and at local midnight.
- **`computeIntervalInfo` in `hours` mode measures elapsed hours, not wall
  clock** — documented rather than filed. The mode is “every N hours” and elapsed
  time is the right meaning for a machine check; the consequence to know is that
  the wall-clock time of the check shifts by an hour twice a year (a 24-hour
  interval anchored at 07:00 rolls at 08:00 on the day after the spring
  transition, and at 06:00 after the autumn one).
- **`busy_timeout` is already 5000 on every connection Prisma opens**, so the
  explicit pragma in `src/lib/db.ts` is redundant rather than wrong; `journal_mode
  = WAL` is persisted in the database header. Only `synchronous` is left partial
  (U-5).

---

## How to run

```bash
export GRAVEKLAR_TEST_DB_DIR=/tmp/…/scratchpad/testdb   # any scratch directory
npx vitest run tests/invariants
```

Expected: **8 files, 181 passed, 11 expected fail**. Any *unexpected* failure in
`db-cascades.test.ts` that is not one of the three `it.fails` is almost certainly
U-6 resurfacing — check `PRAGMA foreign_keys` before assuming the schema changed.
