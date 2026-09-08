# Phase 1a — pricing & quote (area A), discounts & codes (area E)

Scope: `src/lib/domain/quote.ts`, `src/lib/booking-service.ts` (pricing half),
`src/lib/pricing.ts`, `src/lib/mva.ts`, `src/lib/config-server.ts`,
`src/lib/discount-engine.ts`, and the routes `POST /api/quote`,
`GET|POST /api/config`, `GET /api/check-discount-eligibility`,
`/api/admin/discount-codes(/[id])`.

266 tests across nine files, 254 passing and **12 `it.fails`** — each of those
states the behaviour the product *should* have and is annotated in place with
its finding id, so the fix phase flips `it.fails` back to `it`.

| File | Tests |
| --- | --- |
| `tests/lib/quote.test.ts` | 54 (5 `it.fails`) |
| `tests/lib/quote-shape.test.ts` | 10 — the local `distribute()` copy is gone; the distribution invariant now runs through the real `buildQuote` + `computeDiscount` |
| `tests/lib/mva-boundaries.test.ts` | 23 (1) |
| `tests/lib/pricing-custom.test.ts` | 33 (1) |
| `tests/service/discount-engine.test.ts` | 64 (3) |
| `tests/api/quote.test.ts` | 18 |
| `tests/api/config.test.ts` | 13 |
| `tests/api/check-discount-eligibility.test.ts` | 22 (1) |
| `tests/api/admin-discount-codes.test.ts` | 29 (1) |

New shared-free helper: `tests/helpers/pricing.ts` (calendar-relative dates so
no test hard-codes a bookable weekday).

---

## Findings

| id | sev | title | src | demonstrated by | status |
| --- | --- | --- | --- | --- | --- |
| A-1 | P2 | `readMvaSettings` coerces a deliberately configured `mvaRate = 0` to 25 %, so an MVA-exempt or reverse-charge configuration silently charges 25 % VAT | `src/lib/mva.ts:25` (`rate: rate \|\| 25`) | `tests/lib/mva-boundaries.test.ts` → “mvaRate = 0 must mean zero MVA, not the 25 % fallback”; `tests/lib/quote.test.ts` → “mvaRate 0 must charge no MVA” | **fixed** — `readMvaSettings` returns the configured rate and clamps only a negative one; `getConfigValue` already supplies the 25 % default, so `mvaRate = 0` now charges no MVA (`src/lib/mva.ts`) |
| A-2 | P2 | A non-numeric `deliveryFee` becomes `NaN` and propagates through `subtotal` → `totalPrice`; the quote serialises every money field as `null`, and `POST /api/quote` returns it as a 200 | `src/lib/domain/quote.ts:227` (`Math.max(0, Math.round(NaN))`), reachable from `src/app/api/quote/route.ts:48` (`Number(body.deliveryFee)`) | `tests/lib/quote.test.ts` → “a NaN delivery fee must not poison the quote”; `tests/api/quote.test.ts` → “a non-numeric deliveryFee becomes NaN…” | **fixed** — a non-finite delivery fee is treated as 0 in `buildQuote`, in `computeBookingPrices` and at the `/api/quote` boundary, so no money field can be NaN (`src/lib/domain/quote.ts`, `src/lib/booking-service.ts`, `src/app/api/quote/route.ts`) |
| A-3 | P1 | A per-machine `dayPrice` / `weekendPrice` override is ignored for `custom` rentals — `calculateCustomPrice` only reads the global hourly rates, while the machine’s `dayIncludedHours` override *is* honoured. A 4 000 kr/day machine costs 4 000 kr for one day and 4 980 kr for a two-day custom rental | `src/lib/pricing.ts:98` (`calculateCustomPrice`), fed by `mergeEquipmentConfig` in `src/lib/booking-service.ts:122` | `tests/lib/pricing-custom.test.ts` → “a machine dayPrice override must apply to custom rentals too” | **fixed** — `calculateCustomPrice` now bills each day from the merged per-day price (`dayPrice` for a weekday, `weekendPrice` scaled from `weekendIncludedHours` down to one `dayIncludedHours` day for a weekend day), falling back to hourly × included hours |
| A-4 | P2 | `buildQuote` zeroes the delivery fee for self-pickup *before* `checkBookable` sees it, so the “Selvhenting skal ikke ha leveringsgebyr” branch is unreachable. `/api/bookings` does **not** zero it, and `validateBookingInput` refuses the same input — the customer is shown a bookable quote the submit endpoint rejects | `src/lib/domain/quote.ts:227` + `:194`; the refusing side is `src/lib/booking-service.ts:392` | `tests/lib/quote.test.ts` → “a self-pickup quote carrying a delivery fee must not claim to be bookable” (+ the paired test that runs `validateBookingInput` on the identical input) | **fixed** — `checkBookable` is handed the fee as the caller supplied it, before self-pickup zeroes it, so the “Selvhenting skal ikke ha leveringsgebyr” branch fires and agrees with `validateBookingInput` (`src/lib/domain/quote.ts`) |
| A-5 | P2 | `checkBookable` bounds `custom` to 2…90 days but places no ceiling on a `week` rental’s `customDays`. A 700-day (100-week) rental is priced at 100 × the weekly tier and reported `bookable: true`; `bookingMaxAdvanceDays` only checks the *start* date, and `getRentalDateRange` would mint 700 `BookingDateLock` rows | `src/lib/domain/quote.ts:184`; same gap in `src/lib/booking-service.ts:387` | `tests/lib/quote.test.ts` → “a week rental must not be quotable beyond the 8-week form ceiling” | **fixed** — a shared `checkRentalLength` caps a `week` rental at `MAX_WEEK_RENTAL_WEEKS` (8) × 7 days, in both gates (`src/lib/booking-service.ts`, `src/lib/domain/quote.ts`) |
| A-6 | P3 | The per-line discount kroner are each rounded, but `discountKr` is rounded once from the summed percentage, so the lines the customer reads can sum to 1 kr more than the discount actually applied (subtotal 2 495, two 10 % lines → 250 + 250 shown, 499 charged) | `src/lib/domain/quote.ts:269-280` vs `src/lib/discount-engine.ts:104` | `tests/lib/quote.test.ts` → “the discount lines must sum to discountKr” | **fixed** — the last discount line takes the remainder, so the lines always sum to `discountKr` (`src/lib/domain/quote.ts`) |
| E-1 | P3 | `isFirstTimeEligible` matches the email column with plain equality against the normalised (lower-cased) query value. Any stored row that is not already lower-case — a legacy row, an admin-tool write, a future import — is invisible, and the customer re-qualifies for the first-time discount | `src/lib/discount-engine.ts:139` | `tests/service/discount-engine.test.ts` → “a stored mixed-case email must still disqualify” | **fixed** — `isFirstTimeEligible` keeps the indexed equality as a fast path and falls back to a pass that normalises email *and* phone in JS (`src/lib/discount-engine.ts`) |
| E-2 | P2 | The phone-only repeat check reads `take: 1000` with no ordering. Past 1 000 confirmed/completed bookings a returning customer whose row falls outside the window qualifies as first-time again — silently, and forever after | `src/lib/discount-engine.ts:156` | `tests/service/discount-engine.test.ts` → “the phone check must not be bounded to the first 1000 bookings” | **fixed** — that pass is cursor-paged by `id`, 500 rows at a time, instead of an unordered `take: 1000`, so it is complete at any table size (`src/lib/discount-engine.ts`) |
| E-3 | **P0** | Campaign `maxUses` is enforced by a read (`validateRepeatCode`) and spent by an unconditional `increment` in a separate transaction, with no uniqueness guard on `CampaignRedemption`. Two redemptions that interleave between the read and the write **both succeed**: a `maxUses: 1` code reaches `usedCount: 2` with two redemption rows | `src/lib/discount-engine.ts:244-254` (compare the correct pattern at `:236`, `redeemCode`’s conditional `updateMany`) | `tests/service/discount-engine.test.ts` → “two concurrent redemptions of a maxUses=1 code: exactly one may succeed” (+ the paired test recording that both win today) | **fixed** — `redeemCampaignCode` spends the use with a conditional `updateMany` (`isActive`, `usedCount < maxUses`) and writes the `CampaignRedemption` row in the same transaction, only after a successful spend; it returns `false` to the loser instead of over-spending |
| E-4 | P2 | `GET /api/check-discount-eligibility` reports the first-time gate and the code gate independently, but `computeDiscount` treats first-time and repeat as mutually exclusive (first-time wins). A first-time customer holding a RETUR code is previewed as eligible for both while only one is ever charged. The route’s own header comment says the gate semantics must match | `src/app/api/check-discount-eligibility/route.ts:42-67` — no equivalent of `src/lib/discount-engine.ts:93-98` | `tests/api/check-discount-eligibility.test.ts` → “a first-time customer holding a repeat code: the two must not disagree” | **fixed** — the preview applies `computeDiscount`’s first-time-wins precedence and reports a superseded repeat code as `{ valid: false, reason: 'superseded' }` (`src/app/api/check-discount-eligibility/route.ts`) |
| E-5 | P3 | `POST /api/admin/discount-codes` wraps neither `req.json()` nor the Prisma write, so an unparseable body or an unparseable `expiresAt` escapes as an unhandled exception (a bare 500) instead of the 400 every other shape error returns. `PATCH`/`DELETE` on `[id]` have the same gap | `src/app/api/admin/discount-codes/route.ts:82`, `src/app/api/admin/discount-codes/[id]/route.ts:25` | `tests/api/admin-discount-codes.test.ts` → “malformed input must be answered, not thrown” | **fixed** — POST/PATCH/DELETE parse the body and `expiresAt` defensively and wrap the Prisma write, answering 400 / a generic 500 instead of throwing (`src/app/api/admin/discount-codes/**`) |
| H-1 | P1 (harness) | `ensureSchema()` calls `db.$disconnect()` and copies the template over the open SQLite file; the next query throws `PrismaClientUnknownRequestError: Engine is not yet connected` and takes a whole test file down. It hits a **different, random** file on every full-suite run (observed on `tests/lib/totp.test.ts`, `tests/service/app-config-load.test.ts`, `tests/service/payment-sequences.test.ts`, `tests/api/check-discount-eligibility.test.ts`). It reproduces only at full-suite scale — the same files pass in isolation, in pairs, and with `--maxWorkers=1` — and it still happens with all nine phase-1a files excluded, so it predates this work | `tests/helpers/db.ts:139-151` (`ensureSchema`) → surfaces at `:156` (`tableNames`) | any `npx vitest run` of the whole suite | fixed — Phase 0 harness: `tests/helpers/db-prepare.ts` provisions the per-worker database synchronously before the first import and `resetDb()` truncates in a global `beforeAll`; `ensureSchema()` no longer disconnects or copies over an open client (four consecutive green full runs) |

Severity key: **P0** money/data can be wrong in production today · **P1** wrong
number or wrong gate under a reachable configuration · **P2** divergence between
what the customer is shown and what the system will do · **P3** correctness of
presentation, error shape or a narrow edge.

### On E-3 and the brief

The brief asked for the concurrent-redemption test on a `freshDb()`.
`redeemCampaignCode` and `validateRepeatCode` bind to the app singleton
(`@/lib/db`), so they cannot be pointed at a `freshDb()` client — the test runs
the two redemption sequences concurrently against the worker database, which is
where the interleaving actually happens in production. Both win.

### On the repeat-code claim

The claim is the **last statement inside `createPendingBooking`’s transaction**
(`src/lib/booking-service.ts:596-606`). There is no step after it that can fail,
so "released when the booking fails" is only observable on the failure paths
*before* the claim; both are covered:

- a date conflict (thrown ahead of the transaction) leaves the code unredeemed;
- two concurrent bookings on one code → exactly one commits, and the loser’s
  booking row **and** its `BookingDateLock` rows roll back with it;
- reusing an already-claimed code is caught by the drift guard
  (`PriceDriftError`), never silently charged at full price.

---

## Closed flags — checked, correct

**Calendar / spans**

- DST is handled: `calculateCustomPrice` walks with `setDate`, so the 23-hour
  day (2026-03-29) and the 25-hour day (2026-10-25) neither shift a date nor
  drop or duplicate a weekend day; a 14-day span across either transition bills
  exactly 4 weekend days.
- A custom rental spanning Sat+Sun bills `weekendHourly` for exactly those two
  days and `weekdayHourly` for the rest.
- `week` with `customDays` 14 / 21 / 56 scales price *and* included hours by 2 /
  3 / 8 weeks.
- `week` with `customDays` 10 (not a multiple of 7) charges **one** week and
  `rentalDayCount` reserves **7** days — price and locks agree; 0 and negative
  values fall back to one week too.
- `custom` 2 and 90 days are accepted, 1 and 91 refused with the Norwegian
  message; the day/weekend/week weekday gates and the past-date,
  `minBookingDaysAhead` and `bookingMaxAdvanceDays` gates all return the right
  reason and still price the rental.
- `maxDeliveryRadius` is inclusive: exactly 150 km is inside.

**Pricing**

- `getConfigValue` prefers a stored value, falls back to `DEFAULT_CONFIG`, and
  honours an explicit `0` (`??`, not `||`); an unknown key is 0.
- A machine that overrides only `dayPrice` keeps the global included hours; a
  `null` column leaves the global value alone; machine-level `preOrderHourRate`
  and `weekIncludedHours` land correctly (the latter scales with the week
  multiplier).
- An unknown **or inactive** `machineId` is still priced at global rates and
  comes back `bookable: false` with `Valgt utstyr er ikke tilgjengelig.` — the
  inactive machine’s override is not applied.
- `extraHours`: `computeBookingPrices` clamps negatives to 0, bills at
  `preOrderHourRate` (not `overtimeRate`), and prices 720 hours in full;
  `POST /api/quote` clamps to 0…720, floors floats and maps non-numerics to 0.
- Delivery fee: negatives clamp to 0, fractions round, `null` is 0, self-pickup
  forces 0.

**MVA**

- `exMva + mvaAmt === totalPrice` for **every** net 0…3 000 kr in both storage
  modes, and `mvaAmt` never drifts more than 1 kr from the exact VAT — the
  remainder krone is absorbed, not lost.
- `pricesIncludeMva` 1 → the stored price is the charged total (2 490 = 1 992 +
  498); 0 → VAT is added on top (2 490 → 3 113 = 2 490 + 623); any positive
  value counts as incl-MVA, a negative one as ex-MVA.
- A non-default rate (12 %) flows straight through to the charged total.

**Discounts**

- `discountHardCap = 0` means uncapped (deliberate), and the cap otherwise
  scales every displayed line proportionally so the percents shown sum to
  `effectivePercent`.
- A discount over 100 % clamps the net to 0 rather than going negative; the MVA
  breakdown goes to 0/0 with it.
- First-time wins over a repeat code; campaign codes are independent of
  `enableRepeatDiscount`; a negative `firstTimeDiscountPercent` clamps to 0
  instead of becoming a surcharge; `excludeBookingId` works on both paths.
- `validateRepeatCode` trims and upper-cases; campaign is looked up before
  repeat; the refusal precedence is inactive → expired → exhausted for campaigns
  and redeemed → expired → mismatched-email for RETUR codes; **expiry is
  exclusive** — `expiresAt` exactly `now` is still valid, one millisecond
  earlier is expired; `maxUses: null` is unlimited and `usedCount === maxUses`
  is exhausted.
- `redeemCode` is idempotent and cannot be moved to a second booking; an unknown
  id is a no-op, not a throw.
- `issueRepeatCode` mints `RETUR-` + 8 characters from the no-confusable
  alphabet, normalises the email, sets the 365-day expiry both call sites pass,
  and returns `null` when the toggle is off or the email is empty.
- The eligibility preview and `computeDiscount` agree on the first-time gate and
  the code gate across 8 seeded cases (new / returning × no code / campaign /
  repeat / repeat-with-toggle-off / bogus / exhausted / anonymous).

**Routes**

- `POST /api/quote`: 400 on a non-JSON body, an empty body, a missing or unknown
  `rentalType`, and any `startDate` that is not exactly `YYYY-MM-DD`; a
  syntactically valid but impossible date is priced and refused by the gate, not
  by a 500. The 61st request from one IP inside a minute is 429; buckets are
  per-IP and fall back to the first `x-forwarded-for` hop. The response key set
  is pinned by an inline snapshot (18 keys).
- `POST /api/config`: the `configs`-is-an-array check runs **before** the TOTP
  gate (400 without needing 2FA); with 2FA un-enrolled it returns 401 with
  `requiresTotp: true` **and** `requiresTotpEnrollment: true`, writes nothing and
  logs no audit row; an unparseable body is a 500 with the generic Norwegian
  message. The proxy 401s an unauthenticated POST before the handler runs.
- `loadConfigValues` self-seeds a deleted default and prunes a key that is no
  longer declared.
- `/api/admin/discount-codes`: the `^[A-Z0-9-]{3,32}$` regex (accepts `ABC`,
  `A-1`, 32 chars; refuses empty, 2 chars, 33 chars, space, underscore, `Ø`,
  `!`, `null`); input is trimmed and upper-cased; 409 on a collision with an
  existing campaign **or** an issued RETUR code; `percent` clamps into 1…100 on
  create and patch; `percent` is frozen once `usedCount > 0` (409) and that 409
  aborts the whole patch, while re-sending the *same* percent is a no-op; audit
  rows are written on create/update/delete and skipped when nothing changed;
  delete cascades `CampaignRedemption` and frees the code value for reuse; every
  handler 401s on its own without a session, and the proxy 401s the path.

## Flags — documented behaviour, decide before changing

- **F-12** `GET /api/config` is public. `src/proxy.ts:7` demands an admin session
  only when the method is POST, so the whole price list — including
  `maxDeliveryRadius` and the MVA settings — is readable anonymously. It is the
  same data the public booking form needs; recorded, not filed as a defect.
- **F-E6** Nothing under `src/` calls `/api/check-discount-eligibility` any more
  (the booking form previews through `POST /api/quote`). The route still answers,
  unauthenticated, whether an arbitrary email address has rented before, at 15
  requests/min per IP. Either delete it or keep it and keep E-4 fixed.
- **F-E7** The eligibility preview never applies `discountHardCap` — it returns
  raw per-source percents. With the shipped 40 % cap, first-time 10 + campaign 50
  previews as 60 % while the engine charges 40 %. A caller must not sum them.
- **F-E8** `isAdminAuthenticated()` reads the **ambient** cookie store
  (`cookies()` from `next/headers`), not the `NextRequest` it was handed. Admin
  handlers therefore cannot be called in-process without mocking `next/headers`
  (this suite does), and they ignore cookies set on the request object itself.
- **F-E9** `POST /api/admin/discount-codes` with `maxUses` **omitted** creates a
  single-use code: `body.maxUses === null` is false for `undefined`, so the else
  branch lands on `Number(undefined) || 1`. Only an explicit `null` or `''` means
  unlimited.
- **F-A7** `issueRepeatCode` is not idempotent per booking — a second call mints
  a second code. Safe today only because both call sites guard on a status
  transition (`status === 'completed' && previousStatus !== 'completed'`).
- **F-A8** `custom` is not in the shipped `enabledRentalTypes`
  (`day,weekend,week`), so a custom quote is priced but never bookable out of the
  box. This is what limits the blast radius of A-3.
- **F-A9** A per-machine price override of `0` is honoured as free (`??`, not
  `||`). Deliberate, but worth knowing before someone "fixes" the nullish
  coalescing.
- **F-A10** `buildQuote` echoes `inputs.customDays: 10` for a `week` rental that
  is priced and locked as 7 days. The only place the echoed input and the
  charged/reserved reality disagree; a UI that renders `inputs.customDays` would
  mislead.
- **F-A11** A campaign code stored in lower case can never be redeemed (lookup
  upper-cases the typed value). The admin route upper-cases on write, so the
  table only ever holds upper-case codes — a note for any future seeding tool.

---

## Coverage after

`npx vitest run --coverage` over the nine phase-1a files (a whole-suite coverage
run cannot currently complete — see **H-1**; other agents’ tests add to these
modules on top of what is shown):

| Module | % Stmts | % Branch | % Funcs | % Lines | Uncovered |
| --- | --- | --- | --- | --- | --- |
| `src/lib/domain/quote.ts` | 98.76 | 85.05 | 100 | 98.70 | `195` |
| `src/lib/discount-engine.ts` | 98.93 | 95.69 | 100 | 98.68 | `220` |
| `src/lib/pricing.ts` | 83.72 | 88.23 | 80 | 82.92 | `19-27` |
| `src/lib/mva.ts` | 93.33 | 54.54 | 80 | 93.33 | `78` |

What is left uncovered is uncovered for a reason:

- `quote.ts:195` — the `Selvhenting skal ikke ha leveringsgebyr` return, which is
  **unreachable** because of A-4. Fixing A-4 covers it.
- `discount-engine.ts:220` — the collision-retry line inside `issueRepeatCode`,
  reachable only by forcing a 40-bit code collision.
- `pricing.ts:19-27` — `getConfig()`, the browser-side `fetch('/api/config')`
  helper. No DOM in this environment (`jsdom` is not installed).
- `mva.ts:78` — `formatKr`, a presentation helper with no callers in these
  modules.
