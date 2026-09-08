# Phase 1b — booking validation & creation (B), availability (C), delivery (D)

Scope: `src/lib/booking-service.ts`, `src/lib/availability.ts`,
`src/lib/domain/quote.ts` (`checkBookable` only — the pricing half is phase 1a),
and the routes `POST|GET /api/bookings`, `PATCH|DELETE /api/bookings/[id]`,
`GET /api/availability`, `GET|POST|DELETE /api/unavailable`,
`POST /api/delivery`, `POST /api/address-suggest`. Auth on the admin paths is
enforced by `src/proxy.ts`, so each handler is called directly and the gate is
asserted separately with `proxyCall()`.

**141 tests across nine files: 122 passing, 19 `it.fails`.** Every `it.fails`
states the behaviour the product *should* have and carries its finding id in a
comment directly above it, so the fix phase flips it back to `it`.

| File | Tests | Layer |
| --- | --- | --- |
| `tests/lib/booking-validation-parity.test.ts` | 35 (7 `it.fails`) | L1 + DB |
| `tests/service/booking-creation.test.ts` | 17 | L3 |
| `tests/service/booking-concurrency.test.ts` | 2 | L5 |
| `tests/api/bookings.test.ts` | 19 | L2 |
| `tests/api/bookings-id.test.ts` | 15 (5) | L2 |
| `tests/api/availability.test.ts` | 16 (3) | L2 |
| `tests/api/unavailable.test.ts` | 11 (2) | L2 |
| `tests/api/delivery.test.ts` | 20 (2) | L2 |
| `tests/api/address-suggest.test.ts` | 6 | L2 |

New area-local helper: `tests/helpers/booking.ts` — a `CreateBookingInput`
factory, the `QuoteInputs` projection of it, `setPricing()` (PricingConfig rows,
which `seedConfigDefaults` does not cover), `daysInMonth()`, `haversineKm()`,
and a redirectable `db` proxy so `createPendingBooking` — which binds the
`@/lib/db` singleton — can be pointed at a `freshDb()` file for the concurrency
test. Nothing in `tests/setup.ts` or `tests/helpers/{db,route,mocks}.ts` was
modified.

---

## Findings

| id | sev | title | src | demonstrated by | status |
| --- | --- | --- | --- | --- | --- |
| D-1 (flag F-1) | **P0** | `POST /api/delivery` accepts caller-supplied `lat`/`lng`, skips geocoding entirely, and still signs a delivery-quote token over the *address string* the caller sent. Post the depot's own coordinates with any address and the response is a valid 0 km / 0 kr proof for that address — which `POST /api/bookings` accepts. A delivery to Trondheim (≈600 km, far outside the 150 km insured radius) is booked at no charge, and the signed proof makes it look measured | `src/app/api/delivery/route.ts:87` (the `lat`/`lng` branch) → `:164` (`signDeliveryQuoteToken` over the unverified `address`), consumed by `src/app/api/bookings/route.ts:82` | `tests/api/delivery.test.ts` → “does not issue a usable proof for an address it never geocoded” (the booking is created, 201) | **fixed** — `POST /api/delivery` always geocodes the address before signing; caller-supplied `lat`/`lng` are a precision hint accepted only when the server’s own geocode of that address lands within 1 km of them, else 400 |
| C-4 | P1 | `DELETE /api/unavailable { dates: [...] }` builds `new Date(d + 'T00:00:00.000Z')` — **UTC** midnight — while every row is written at Oslo local midnight (`dateToDbMidnight`). The `deleteMany` matches nothing, and the response is still `{ success: true, deleted: 1 }`. Un-blocking a date from the admin calendar silently does nothing | `src/app/api/unavailable/route.ts:131` | `tests/api/unavailable.test.ts` → “deletes by date string” | **fixed** — the delete-by-date branch matches `dateToDbMidnight(d)` (Oslo local midnight), the same value the rows are written at |
| C-1 | P2 | The calendar marks a turnaround (buffer) day unavailable when it is **still free** — the inverse of the intent stated in the comment above it. On a machine with `quantity > 1` the buffer days around a single booking are hidden from customers even though `createPendingBooking` would take them | `src/app/api/availability/route.ts:129-132` | `tests/api/availability.test.ts` → “agrees about turnaround days when quantity is 2” | **fixed** — a buffer day consumes a slot in the same tally as a rental day, exactly as `getUnavailableDateStringsForRange` counts it (`src/app/api/availability/route.ts`) |
| C-2 | P2 | The calendar looks back exactly 90 days, sized for the 90-day cap `validateBookingInput` puts on `custom`. A `week` rental takes any positive multiple of 7 with no upper bound, so a 14-week booking starting outside the window is invisible to the calendar while the conflict check still blocks its days: the customer picks a green day and is refused at submit | `src/app/api/availability/route.ts:51-57` vs `src/lib/availability.ts:20` (uncapped `week`) | `tests/api/availability.test.ts` → “agrees about a rental longer than the 90-day lookback” | **fixed** — the lookback is `max(90, longest customDays on a live booking + 1)` rather than a fixed 90 days (`src/app/api/availability/route.ts`) |
| C-3 | P2 | The booking query is bounded at `startDate <= monthEnd`, so a booking starting on the **1st of the next month** never contributes its day-before buffer. The calendar offers the last day of the month as free; `getUnavailableDateStringsForRange` then refuses it | `src/app/api/availability/route.ts:57` and `:70` | `tests/api/availability.test.ts` → “agrees about the buffer day before a booking in the next month” | **fixed** — the booking query reaches one day past the month end, so a booking starting on the 1st of the next month contributes its day-before buffer (`src/app/api/availability/route.ts`) |
| B-3 | P2 | `checkBookable` zeroes the delivery fee for self-pickup *before* testing `deliveryFee > 0`, so its own self-pickup guard is unreachable. The quote says `bookable: true`; `validateBookingInput` refuses the identical input with “Selvhenting skal ikke ha leveringsgebyr.” **Same defect as phase-1a finding A-4**, recorded here because the parity table is what pins both sides | `src/lib/domain/quote.ts:229` + `:194`, refused at `src/lib/booking-service.ts:394` | `tests/lib/booking-validation-parity.test.ts` → “agrees about self-pickup carrying a delivery fee” | **fixed** — same change as A-4: `checkBookable` sees the fee before self-pickup zeroes it (`src/lib/domain/quote.ts`) |
| B-4 | P2 | `checkBookable` never recomputes the delivery fee, so a quote is `bookable: true` for any fee the client supplies; `validateBookingInput` recomputes it and refuses anything outside `max(2, ceil(perKm × 0.1) + 1)`. The preview promises a purchase the submit endpoint rejects — the exact drift `buildQuote` exists to prevent | `src/lib/domain/quote.ts:189-196` (no fee branch) vs `src/lib/booking-service.ts:403-413` | `tests/lib/booking-validation-parity.test.ts` → “agrees about a delivery fee 3 kr off at perKm=0” and “…12 kr off at perKm=100” | **fixed** — both gates recompute the fee through the shared `calculateDeliveryFee` / `deliveryFeeTolerance` pair in `src/lib/pricing.ts` |
| B-6 | P2 | `getConfigValue(config, 'deliveryIncludedKm') \|\| 30` treats a deliberately configured **0** as “unset” and reinstates 30 free kilometres — in the fee calculator and in the drift check alike. An admin cannot bill from km 0; the setting silently does the opposite of what it says | `src/lib/booking-service.ts:403` and `src/app/api/delivery/route.ts:81` | `tests/lib/booking-validation-parity.test.ts` → “honours deliveryIncludedKm = 0 (bill every kilometre)” | **fixed** — `deliveryIncludedKm` is read through `getConfigValue` alone inside the shared helper, so a configured 0 bills from the first kilometre in booking-service, the quote and `/api/delivery` (`src/lib/pricing.ts`) |
| B-7 | P2 | `updateBookingStatus` fires `sendBookingExpiredEmail` for **every** pending → cancelled transition, guarded only by `skipEmails`. The admin route never passes it, so an admin cancelling an unpaid booking sends the customer two mails: the cancellation with the admin's reason, and “your booking expired”. The comment at that branch says it is meant for the silent-expiry path only | `src/lib/booking-service.ts:953-961`, called from `src/app/api/bookings/[id]/route.ts:51` with no `skipEmails` | `tests/api/bookings-id.test.ts` → “sends exactly one customer mail when an admin cancels a pending booking” | **fixed** — the admin route passes `skipEmails` on the cancel path and sends its own mail, exactly as `/api/booking/cancel` does (`src/app/api/bookings/[id]/route.ts`) |
| B-8 | P2 | The one-shot guard on cancel covers the goodwill code but not the mail: a re-submitted or double-clicked cancel is `transitioned: false`, falls into the `else if (EMAIL_STATUSES.has(status))` branch and mails the customer a **second** cancellation — this time with no reason and no goodwill code | `src/app/api/bookings/[id]/route.ts:90-94` | `tests/api/bookings-id.test.ts` → “does not re-mail the customer when a cancel is submitted twice” | **fixed** — the `else if (EMAIL_STATUSES…)` arm is gone; only a cancel that actually transitioned mails the customer (`src/app/api/bookings/[id]/route.ts`) |
| F-11 | P2 | `checklistData: body.checklistData ?? '{}'` is written verbatim: no size cap, no type check, no JSON validation. One authenticated request parks megabytes of arbitrary text on a `Booking` row (and every later read — admin list, PDF, checklist parse — carries it); a non-string value reaches Prisma as a type error and returns a 500 | `src/app/api/bookings/[id]/route.ts:22-25` | `tests/api/bookings-id.test.ts` → “caps the size and type of a checklist payload” | **fixed** — `checklistData` must be a string, at most 64 KB and parseable JSON, else 400 (`src/app/api/bookings/[id]/route.ts`) |
| F-9 | P2 | An unknown booking id is answered inconsistently, and the checklist branch leaks the server's own source. The status branch returns **400** “Booking ikke funnet.”; the checklist branch returns **500** whose `error` is Prisma's full message — including the absolute path `/home/deller/Documents/graveklar/src/app/api/bookings/[id]/route.ts:22:40` and a four-line excerpt of the handler. `DELETE` on the same id correctly returns 404. All three should be 404 with a fixed string | `src/app/api/bookings/[id]/route.ts:22` (no existence check) and `:98-101` (`error.message` passed straight to the client) | `tests/api/bookings-id.test.ts` → “answers 404 for a status change on a booking that does not exist” and “answers 404 without leaking Prisma internals on a checklist save” | **fixed** — PATCH resolves the booking before either branch and answers 404; a non-client error answers a generic Norwegian message instead of Prisma’s (`src/app/api/bookings/[id]/route.ts`) |
| D-2 | P3 | An address outside `maxDeliveryRadius` is refused with HTTP **200** and `{ error, distance, fee: null }`. Every generic `if (!res.ok)` caller reads it as a successful quote and has to know to test `fee === null` instead | `src/app/api/delivery/route.ts:142-148` | `tests/api/delivery.test.ts` → “answers with a 4xx status” | **fixed** — an address outside `maxDeliveryRadius` is answered with HTTP 400, same body shape (`src/app/api/delivery/route.ts`) |
| B-1 | P3 | `validateBookingInput` does not enforce `enabledRentalTypes`; only the route does. `createPendingBooking` is therefore not self-sufficient — a second caller (a seed script, an admin tool, a future endpoint) can create a booking for a rental type the business has switched off | `src/lib/booking-service.ts:314` (`VALID_RENTAL_TYPES` is the static list, not the configured one) vs `src/lib/domain/quote.ts:135-139` | `tests/lib/booking-validation-parity.test.ts` → “agrees about a rental type the admin switched off” | **fixed** — `validateBookingInput` enforces `enabledRentalTypes` whenever the caller passes `appConfig` (`src/lib/booking-service.ts`) |
| B-2 | P3 | Same shape for the booking horizon: `bookingMaxAdvanceDays` is checked in `createPendingBooking` and in `checkBookable`, but not in `validateBookingInput`, so the function that names itself the validator passes a date 400 days out | `src/lib/booking-service.ts:438` (in the caller, not the validator) | `tests/lib/booking-validation-parity.test.ts` → “agrees about a start date past bookingMaxAdvanceDays” | **fixed** — the `bookingMaxAdvanceDays` horizon moved out of `createPendingBooking`’s pre-check and into `validateBookingInput` (`src/lib/booking-service.ts`) |
| B-5 | P3 | Same shape again for the machine: `checkBookable` refuses an unresolvable `machineId`, `validateBookingInput` does not (`createPendingBooking` catches it a few lines later) | `src/lib/booking-service.ts:450` vs `src/lib/domain/quote.ts:141-143` | `tests/lib/booking-validation-parity.test.ts` → “agrees about an unknown machineId” | **fixed** — `validateBookingInput` takes a `{ machineResolved }` context (the caller has already resolved the machine to price the booking) and refuses an unresolvable `machineId` (`src/lib/booking-service.ts`) |
| C-5 | P3 | `DELETE /api/unavailable` reports `deleted: ids.length` / `deleted: dates.length` — the length of the *request*, not the number of rows removed. The admin UI cannot tell a delete from a no-op, which is what hides C-4 | `src/app/api/unavailable/route.ts:125` and `:136` | `tests/api/unavailable.test.ts` → “reports how many rows were actually removed” | **fixed** — both DELETE branches report `deleteMany`’s own `count` |

Severity key: **P0** money or safety can be wrong in production today · **P1** a
documented admin action silently does nothing · **P2** divergence between what
the customer/admin is shown and what the system does · **P3** correctness of an
error shape, a report count, or a defence-in-depth gap with a working outer
guard.

### Flags closed without a finding

| flag | outcome |
| --- | --- |
| **F-8** — `GET /api/bookings` with no `?limit=` returns every row | Documented, not filed as a defect. The `MAX_PAGE_SIZE = 1000` cap applies only once a caller opts into pagination (`src/app/api/bookings/route.ts:166`), so the unpaginated response is unbounded and grows with the business. It is the admin list's current contract and is behind the admin session. Pinned by `tests/api/bookings.test.ts` → “returns every row when ?limit= is omitted — the cap is opt-in (F-8)”, alongside “clamps ?limit= into 1…1000” which proves the cap on the paginated path with 1 001 rows |
| pending `paymentDeadline` exactly `now` | **No off-by-one.** The route drops a pending booking at `paymentDeadline <= now` (`availability/route.ts:143`) and the service keeps one at `paymentDeadline > now` (`booking-service.ts:261`). The two rules meet exactly: at equality both treat the booking as expired. Pinned under a frozen clock by `tests/api/availability.test.ts` → “agrees about a pending booking whose deadline is exactly now” |
| double-booking under concurrency | **Holds.** 12 simultaneous `createPendingBooking` calls for one machine/date on an isolated `freshDb()`: exactly 1 winner at `quantity: 1`, exactly 2 at `quantity: 2`, every loser rejected with the “opptatt” message, one lock per machine/date/slot, no duplicate slot keys and no orphan locks. `tests/service/booking-concurrency.test.ts` |
| delivery fee ↔ drift-check tolerance | **Holds** on both the OSRM path and the haversine fallback. `/api/delivery` rounds the distance to 0.1 km *before* the fee math (`delivery/route.ts:140`), and the fee it returns passes `validateBookingInput` unchanged. `tests/api/delivery.test.ts` → “produces a fee the booking drift check accepts” (×2) |
| delivery-quote token binding + lifetime | **Holds.** The token binds the whitespace/case-normalised address, the 0.1-km distance and the fee, and expires at exactly 6 h (valid at 6 h − 1 ms, refused at 6 h + 1 ms, frozen clock). Worth knowing: it signs the *raw* address the customer typed, not Nominatim's `display_name`, so the booking has to carry the same string back. `tests/api/delivery.test.ts` |
| `POST /api/address-suggest` never fails | **Holds.** Short query, non-string query, malformed body, dead upstream, upstream returning a non-array, and the 429 path all answer `{ results: [...] }`; the 429 keeps the same body shape. `tests/api/address-suggest.test.ts` |

### Harness note

Mid-phase, the concurrent H-1 harness refactor dropped
`import crypto from 'node:crypto'` from `tests/helpers/db.ts`, so
`bookingReference()` resolved `crypto.randomBytes` against the global WebCrypto
object and every factory-built booking threw. It broke 25 phase-1b tests (and
any other file using `booking()`); it has since been restored and the full suite
is green again. Recorded only so a stale log from that window is read correctly.

---

## Coverage after

Whole-suite v8 run, `src/lib/**` plus `src/app/api/**` (`vitest.config.ts`
limits coverage to `src/lib/**`, so the route numbers come from a run with
`--coverage.include='src/app/api/**/*.ts'` added):

| file | % stmts | % branch | % funcs | % lines | uncovered |
| --- | --- | --- | --- | --- | --- |
| `src/lib/booking-service.ts` | **93.60** | 85.97 | 77.77 | 94.20 | the Vipps/Stripe auto-refund arms and the review-request side effect (897, 915, 944, 960) |
| `src/lib/availability.ts` | **93.75** | 92.85 | 100 | 92.85 | line 25 — `rentalDayCount`'s unreachable `default` |
| `src/app/api/delivery/route.ts` | **96.25** | 92.30 | 85.71 | 97.29 | 171-172 — the outer `catch` |
| `src/app/api/bookings/route.ts` | 91.93 | 72.52 | 75 | 95 | 141, 185-186 |
| `src/app/api/bookings/[id]/route.ts` | 75 | 80 | 40 | 74 | 77-84, 88, 92, 120 — the paid-cancellation goodwill-code arm |
| `src/app/api/availability/route.ts` | 96 | 95.45 | 50 | 97.22 | 178-179 — the outer `catch` |
| `src/app/api/unavailable/route.ts` | 88.88 | 70.96 | 100 | 88.46 | 107-108, 144-145 — the two `catch` arms |
| `src/app/api/address-suggest/route.ts` | 93.61 | 72.09 | 75 | 95.55 | 65, 67 — the `pedestrian`/`suburb` label branches |
| `src/lib/domain/quote.ts` | 98.76 | 87.35 | 100 | 98.70 | **line 195** — the self-pickup fee branch, unreachable by construction (finding B-3) |

Whole-suite totals for the covered set: 61.30 % statements, 53.02 % branches.
