# Phase 1c — payments as state machines (F) + cancellation and refunds (G)

Scope: `src/lib/booking-service.ts` (`updateBookingStatus`,
`confirmBookingPaidFromStripe`), `src/lib/stripe.ts`, `src/lib/vipps-payments.ts`,
the five Stripe routes, the four Vipps routes, `POST /api/booking/cancel`, and
the Stripe redirect URL built by `POST /api/tilbud/[token]` (flag F-5 only).

150 tests across 7 files. As written during the audit: 137 passing and 11
`it.fails` demonstrating eight findings. After the fix phase: **149 passing and
one `it.fails`**, which is not a defect left open but the deferred redesign
**R-8** (settling a Vipps payment from a GET — see the section below) held red
on purpose. Every test runs through the harness in `tests/helpers` — per-worker
scratch database, `mockStripe` + `signedEvent` (Stripe's real HMAC scheme, so
`verifyStripeWebhook` runs unmocked), `mockVipps` (only the six HTTP functions;
`verifyWebhookSignature` runs unmocked against a real canonical string),
`mockEmail`, `mockClock`. No network call, no live database, no TOTP, no mail.

| File | Tests | Expected fails (as written) | Expected fails (after the fixes) |
| --- | --- | --- | --- |
| `tests/service/payment-state-machine-stripe.test.ts` | 25 | 3 | 0 |
| `tests/service/payment-state-machine-vipps.test.ts` | 25 | 1 | 0 |
| `tests/service/payment-sequences.test.ts` | 17 | 1 | 0 |
| `tests/service/cancellation.test.ts` | 18 | 1 | 0 |
| `tests/api/payment-stripe.test.ts` | 22 | 3 | 0 |
| `tests/api/payment-vipps.test.ts` | 26 | 2 | 1 (R-8) |
| `tests/api/booking-cancel.test.ts` | 17 | 0 | 0 |

Shared builders live in `tests/helpers/payments.ts` (config bundles, signed
Stripe envelopes, signed Vipps envelopes, a `waitFor` that survives a frozen
clock).

> **A shared-helper regression interrupted this phase (now repaired).**
> Midway through, the refactor that extracted `tests/helpers/db-prepare.ts`
> moved `import crypto from 'node:crypto'` out of `tests/helpers/db.ts` while
> `refSuffix()` still called `crypto.randomBytes(5)`. Node's global `crypto` is
> Web Crypto and has no `randomBytes`, so `bookingReference()` — and therefore
> the `booking()` factory — threw for *every* DB-touching test: a full
> `npx vitest run` at 22:33 was 201 failed / 746 passed across 18 files, 188 of
> those failures being that single `TypeError`. The import was restored while
> this phase was finishing; the final full run is clean. Worth keeping in mind
> for the next refactor of that file: the whole DB layer of the suite hangs off
> one un-imported symbol, and nothing but a run catches it.

---

## Findings

New finding ids start at **51** so they cannot collide with the pre-existing
global flag list (F-1 … F-17, see `docs/audit/phase-minus-1.md`). F-3, F-4 and
F-5 are the flags this phase was asked to close; all three are **confirmed**.

| id | severity | title | source | demonstrating test | status |
| --- | --- | --- | --- | --- | --- |
| F-51 | high | `updateBookingStatus` has no legal-transition table: every status → status write is performed, so a cancelled booking can be walked back to `confirmed` (re-freezing the contract, re-mailing the customer) with its date locks already deleted | `src/lib/booking-service.ts:807` (compare-and-set on the *current* status only); reachable from `src/app/api/bookings/[id]/route.ts:37` which validates only that the target is one of the four names | `payment-state-machine-stripe.test.ts` → "rejects every transition that is not part of the lifecycle" and "never leaves a confirmed booking without its date locks" | **fixed** — `updateBookingStatus` consults an explicit `LEGAL_TRANSITIONS` table (pending→confirmed/cancelled, confirmed→cancelled/completed; `cancelled` and `completed` terminal) and throws `BookingClientError` before any side effect; the admin PATCH route already maps that to 400. Same-status calls stay the idempotent no-op |
| G-51 | high | Cancelling a **completed** booking charges no cancellation fee and refunds 100 %: the fee branch is gated on `previousStatus === 'confirmed'` while the refund branch is gated only on `fullyPaidAt` | `src/lib/booking-service.ts:779` (fee) vs `:924` (refund) | `cancellation.test.ts` → "does not hand a completed rental a full refund" | **fixed** — resolved by F-51: `completed` is terminal, so the completed → cancelled write that reached the refund branch without the fee branch is refused outright |
| F-53 | medium | A Vipps payment is stored as a Stripe one: `settleAuthorizedPayment` confirms through `confirmBookingPaidFromStripe`, which hard-codes `paymentProvider: 'stripe'` and overwrites the `'vipps'` that `createVippsPaymentForBooking` wrote. Any revenue split grouped by provider counts Vipps money as Stripe money | `src/lib/booking-service.ts:984`, overwriting `src/lib/vipps-payments.ts:67` | `payment-state-machine-vipps.test.ts` → "keeps paymentProvider = vipps after a Vipps capture confirms" | **fixed** — `confirmBookingPaidFromStripe` takes `paymentProvider` (default `stripe`); `settleAuthorizedPayment` passes `vipps`, so the provider Vipps stamped survives confirmation |
| F-3 | medium | `GET /api/payment/stripe/cancel` is not a safe method: one unauthenticated request opens a new Stripe Checkout session, increments `paymentRetries`, re-stamps `paymentDeadline` and sends two e-mails. It shares the retry budget with the webhook, so a single hit burns the customer's only second chance and the next expiry cancels the booking. The route has no rate limiter, unlike every other money-touching route | `src/app/api/payment/stripe/cancel/route.ts:19` (no limiter), `:47-88` (side effects) | `payment-stripe.test.ts` → "never initiates a financial side effect from a GET" and "changes nothing at all, however many times it is hit" | **fixed** — the route is redirect-only: it validates `bid`, resolves the booking, and 302s to `/?stripe=cancelled&ref=<reference>` (`?stripe=error` when there is no such booking). No session, no `paymentRetries`, no `paymentDeadline`, no mail. The customer's retry is the one they ask for — the "Prøv igjen" button already in the cancelled state of the confirmation dialog, which POSTs the booking id to `/api/payment/{vipps,stripe}/create` (rate limited, reuses a live session, 410 once the booking can no longer be paid) — and the retry *e-mail* still comes from the webhook's `checkout.session.expired` branch. No limiter was added: a lookup and a redirect is not what needed bounding, and the second test now pins idempotence (5 hits, nothing moves) instead. One deliberate loss: the abandonment notice to the admin that this route used to send. It fired on prefetches too, so it was never a trustworthy signal; the expiry mail on the eventual cancellation is |
| F-4 | medium | `GET /api/payment/vipps/return` **captures money** from an unauthenticated GET keyed on the payment reference, and has no rate limiter while `POST /api/payment/vipps/create` is capped at 5 per 15 min. Idempotency keys stop a double charge; they do not make the request safe or bounded | `src/app/api/payment/vipps/return/route.ts:35` → `src/lib/vipps-payments.ts:156` | `payment-vipps.test.ts` → "never captures money in response to a GET" and "throttles a client that hammers the return URL" | **mitigated; the redesign is deferred as R-8** — the route is now bounded at 10 per client identity per 15 minutes (`clientIdentity`, then a plain-text 429 with `Retry-After`), and its idempotence in effect is pinned rather than assumed: five returns on one reference produce exactly one capture, one confirmation mail, one admin mail and one contract. The GET still settles, so "never captures money in response to a GET" stays `it.fails` — relabelled `// DEFERRED R-8` |
| F-5 | medium | With `siteUrl` unset, `POST /api/tilbud/[token]` builds the Stripe `success_url` / `cancel_url` from the `X-Forwarded-Host` / `Origin` request headers, so a spoofed host receives the customer's post-payment redirect and booking reference. `POST /api/payment/stripe/create` refuses exactly this and falls back to `request.nextUrl.origin` | `src/app/api/tilbud/[token]/route.ts:13-18` vs `src/app/api/payment/stripe/create/route.ts:48` | `payment-stripe.test.ts` → "never lets a spoofed X-Forwarded-Host reach the Stripe redirect URL" | **fixed** — `resolveOrigin` in the tilbud route is now `siteUrl \|\| request.nextUrl.origin`, the same rule as `POST /api/payment/stripe/create`; the forwardable headers are never read |
| F-54 | low | The expiry branch increments `paymentRetries` and extends `paymentDeadline` *before* discovering it cannot build a retry link: with `siteUrl` unset it never calls `createCheckoutSession`, only warns, and the customer's single second chance is spent on a retry that was never sent — the next expiry then cancels the booking. The Vipps webhook has the same shape | `src/app/api/payment/stripe/webhook/route.ts:144` + `:160-166` + `:176`; `src/app/api/payment/vipps/webhook/route.ts:164-175` | `payment-sequences.test.ts` → "does not spend the retry budget when no retry link can be sent" | **fixed** — both webhooks now build the retry first and spend only on success. Stripe: no `retryUrl` (siteUrl unset, or Stripe unconfigured) → warn and return with the budget and the deadline untouched; a `createCheckoutSession` that *throws* is still left to propagate, so the 500 releases the idempotency claim and Stripe redelivers rather than the retry being silently swallowed. Vipps: a blank siteUrl returns before anything is written, and `createVippsPaymentForBooking` is handed `paymentRetries + 1` in memory so the `-r2` reference is still derived from the attempt this retry *will* be, while the row is only incremented once the payment exists. The Vipps branch also stopped writing `paymentDeadline` altogether: `createVippsPaymentForBooking` stamps its own 60-minute window and, in the old order, overwrote the 30-minute Stripe grace written just before it — so the effective deadline was always the Vipps one. Reordering without dropping that write would have halved it and let the cleanup sweep cancel a booking with a live Vipps payment open; a test now pins the deadline to the Vipps window. A Vipps counterpart to the budget test lives in `payment-vipps.test.ts` → "does not spend the retry budget when no retry payment can be created" |
| F-52 | low | `confirmBookingPaidFromStripe` returns the booking (not `null`) to the loser of a confirm race: the lost-race branch returns the *current* row, which is already `confirmed`, so the final `updated.status === 'confirmed'` test passes for both callers. Its own contract says a caller should treat a `null` as already-handled | `src/lib/booking-service.ts:989` | `payment-state-machine-stripe.test.ts` → "confirmBookingPaidFromStripe hands null to the loser of a confirm race" | **fixed** — the return is gated on `transitioned`, so the loser of a confirm race gets the documented `null` |

### Notes that are not findings

- `cancelTokenExpiry && expiry < now` skips the expiry check entirely when the
  column is null. Minting always sets 30 days (`src/lib/email.ts:517`) and the
  cleanup sweep nulls the token together with the expiry, so no live row reaches
  that shape. Pinned by a passing test rather than flagged.
- F-3's and F-4's triggers need a booking id (a cuid) or a payment reference.
  Neither is guessable, which is what keeps both at medium rather than high.
- F-5 and F-54 are both inert while `siteUrl` is configured, which it is in
  production (`graveklar.no`). Both become live the moment that row is blanked.
- The Vipps return route's `acceptedFromIp` still reads
  `x-real-ip || x-forwarded-for[0]`, which is the identity shape H-5 (phase 1d)
  replaced everywhere it was used as a *rate-limit key*. It is not a key here —
  it is the acceptance IP recorded on the frozen contract — so it was left
  alone rather than swapped for `clientIdentity()`, which would write the
  string `'unknown'` where the column now holds `null`. Worth a decision of its
  own; not a finding of this phase.

---

## R-8 — deferred: settle a Vipps payment from a POST, not the return GET

**This is the other half of F-4, and it is a design change rather than a
patch.** It is deferred because it cannot be validated here: production runs
Vipps test credentials, the audit copy has Vipps switched off, and no part of
this audit is allowed to reach Vipps over the network — so the one thing that
would justify the change (watching a real authorization settle through the new
path) is not available. Shipping it blind would trade a bounded, idempotent,
well-tested route for an unexercised one.

**What is wrong.** `GET /api/payment/vipps/return` calls
`settleAuthorizedPayment`, which captures the reservation and confirms the
booking. A GET must be safe. Anything that follows a link without a human
behind it — a prefetcher, a link scanner, a mail-security proxy, the customer's
own history restore — can move money, and the only thing gating it is knowing
the payment reference.

**The intended design.**

- The **webhook is the only settler.** It already re-reads the payment from
  Vipps and is the path that must work when the customer closes the browser on
  the way back, so nothing is lost by making it the sole one.
- The **return URL becomes a read**: resolve the reference to a booking, and
  redirect to the site with the booking's *current* state
  (`?vipps=success|processing|cancelled`). No capture, no confirm.
- The **return page** may ask for settlement explicitly — a `POST` from the
  landing page (same-origin, rate limited, reference in the body) — for the
  case where the customer beats the webhook back and a two-second spinner is
  worse than a nudge. That POST calls the same idempotent
  `settleAuthorizedPayment`, so webhook and page still converge.
- Failure mode to keep in mind: if the webhook is misconfigured, today's GET
  quietly covers for it. Removing that cover means a broken webhook becomes a
  visible "processing" state instead of an invisible dependency — which is the
  point, but it wants the webhook registration checked first
  (`vippsWebhookSecret` present, the subscription live).

**What landed instead, and what it buys.** The route is bounded at 10 per
client identity per 15 minutes (`clientIdentity()` from `src/lib/client-ip.ts`,
then a plain-text 429 with `Retry-After: 900`), so a reference can no longer be
used to drive unbounded outbound Vipps calls, and the idempotence that keeps a
repeat harmless is now asserted rather than assumed: five returns on one
reference produce exactly one `capturePayment`, one confirmation mail, one
admin mail and one `AcceptedContract`. The residual exposure is the first hit
by someone who is not the customer, which is bounded by the reference being
unguessable and by the capture amount being pinned to the booking total.

`payment-vipps.test.ts` → "never captures money in response to a GET" stays
`it.fails`, marked `// DEFERRED R-8`, so this stays visible until it is done.

---

## The transition matrix that was tested

`updateBookingStatus(id, to)` — "performed" means `transitioned: true` and the
row moved.

| from ↓ / to → | pending | confirmed | cancelled | completed |
| --- | --- | --- | --- | --- |
| **pending** | no-op (idempotency short-circuit) | ✅ legal — clears `paymentDeadline`, stamps `fullyPaidAt`, freezes the contract, 1 customer + 1 admin mail | ✅ legal — deletes locks, **no** fee, expiry mail, no refund | ⛔ performed anyway (F-51) — issues a RETUR code for a booking that never paid |
| **confirmed** | ⛔ performed anyway (F-51) | no-op — no second contract, no second mail | ✅ legal — fee by the table below, refund of the remainder, locks deleted | ✅ legal — RETUR code + review request, once |
| **cancelled** | ⛔ performed anyway (F-51) | ⛔ performed anyway (F-51) — re-freezes, re-mails, **locks are not recreated** | no-op | ⛔ performed anyway (F-51) |
| **completed** | ⛔ performed anyway (F-51) | ⛔ performed anyway (F-51) | performed with **no fee and a 100 % refund** (G-51) | no-op |

**Since F-51 and G-51 were fixed**, every ⛔ cell above (and the G-51 cell) is
refused with a `BookingClientError` before any side effect runs — no fee, no
refund, no lock deletion, no mail, no audit row — and the admin PATCH route
answers 400. The ✅ cells and every no-op cell are unchanged.

Also asserted: a missing booking raises `BookingClientError` and creates
nothing; `refundBookingPayment` returns `null` for a booking with no
`fullyPaidAt`; `confirmBookingPaidFromStripe` returns `null` for a cancelled
booking and touches nothing.

### Racing

| race | result |
| --- | --- |
| two `updateBookingStatus(…, 'confirmed')` | exactly one `transitioned: true`, one `AcceptedContract`, one confirmation mail, one admin mail |
| confirm vs cancel | exactly one winner; the row ends in the winner's state |
| two `confirmBookingPaidFromStripe` | one contract, one mail, and (since F-52 was fixed) exactly one non-null return — the loser gets `null` |
| two `settleAuthorizedPayment` | one contract, one mail, one capture idempotency key |
| two `POST /api/booking/cancel` | one refund, one cancellation mail |

### Stripe events → effect

| event | precondition | result |
| --- | --- | --- |
| `checkout.session.completed` (`payment_status: paid`) | pending | confirm |
| `checkout.session.completed` (`unpaid`) | pending | ignored; the later `async_payment_succeeded` confirms |
| `checkout.session.async_payment_succeeded` (paid) | pending | confirm |
| `checkout.session.expired` / `async_payment_failed` | pending, `paymentRetries < 1` | new 30-min session, `paymentRetries++`, retry mail |
| `checkout.session.expired` / `async_payment_failed` | pending, `paymentRetries >= 1` | cancel — locks released, expiry mail |
| `checkout.session.expired` | already confirmed | no-op |
| `checkout.session.expired` | pending, `siteUrl` unset | no retry link is built, and **nothing is spent** — `paymentRetries` and `paymentDeadline` are untouched, a warning is logged (was F-54) |
| `charge.refunded` | booking already at that cumulative amount and refund id | short-circuit, no write, no audit row |
| `charge.refunded` | new cumulative amount | `refundAmount` + `stripeRefundId` updated, `booking.refunded_externally` audit row |
| `charge.dispute.created` | any | audit row only, booking untouched |
| `payment_intent.payment_failed` | any | audit row only, booking untouched |
| any type, replayed with the same `event.id` | — | `{ ok: true, duplicate: true }`, handler never runs |
| unhandled type (`invoice.paid`) | — | claimed, `{ ok: true }` |
| wrong signature / no signature / no configured secret | — | 400, **nothing claimed** |
| handler throws | — | 500 and the claim row is deleted; the replay then does the work exactly once |
| claim released *after* a successful confirm, then replayed | — | no second contract, no second mail |

`GET /api/payment/stripe/cancel` used to share the same budget — one hit spent
the retry and the following `checkout.session.expired` cancelled the booking.
Since F-3 it spends nothing, so the sequence "customer closes Checkout → the
abandoned session expires" now grants the one retry the customer is owed, and
it is the *second* expiry that cancels.

### Vipps events → effect

| event / state | result |
| --- | --- |
| `AUTHORIZED`, authorized == `toMinorUnits(totalPrice)`, captured 0 | capture with key `capture-<id>-<expectedMinor>`, `vippsCapturedAt`, confirm |
| `AUTHORIZED`, captured already >= expected | no capture call, `vippsCapturedAt` stamped, confirm |
| `AUTHORIZED`, authorized != expected | **no capture**, `vipps.amount_mismatch` audit row with both amounts, booking stays pending, 200 to Vipps |
| `AUTHORIZED`, booking no longer pending | `already_handled`, no second mail, no second contract |
| `CREATED` | `pending`, never captures |
| `ABORTED` / `EXPIRED` / `TERMINATED`, `paymentRetries < 1` | `vippsState` recorded, new payment reference (`…-r2`), `paymentDeadline` = the Vipps payment window, retry mail |
| `ABORTED` / `EXPIRED` / `TERMINATED`, `siteUrl` unset or the Vipps create fails | `vippsState` recorded (an observation, not a spend); **no** reference burned, `paymentRetries`/`paymentDeadline` untouched, warning logged (was F-54) |
| `ABORTED` / `EXPIRED` / `TERMINATED`, budget spent | cancel, locks released |
| failure event on an already-confirmed booking | ignored |
| `CAPTURED` | stamps `vippsCapturedAt` once; a second delivery does not move it |
| `REFUNDED` | audit row; `refundAmount` only ever widens |
| `CANCELLED` | audit row only |
| unknown reference | 200, nothing written |
| bad HMAC / body swapped after signing | 401, nothing claimed |
| no `vippsWebhookSecret` configured | 503 |
| unparseable JSON / missing `reference` or `name` | 400, nothing claimed |
| same `${name}-${pspReference}` twice | `{ ok: true, duplicate: true }` |

### Cancellation fee (G) — `basePrice`, never `totalPrice`

Free window `cancelFreeWeeks * 168 + cancelFreeDays * 24` hours; the fixture
below is 48 h with `cancelLatePercent` 50 and `cancelSameDayPercent` 100, on a
rental starting 2026-09-08 at Oslo midnight and a 2490 kr base.

| cancelled at | hours until start | fee |
| --- | --- | --- |
| 2026-09-05 23:00 | 49 | none (`cancellationFee` stays null) |
| 2026-09-06 00:00 — exactly the cutoff | 48 | none — the boundary is inclusive of "free" |
| 2026-09-06 01:00 | 47 | 1245 (50 %) |
| 2026-09-07 12:00 | 12 | 1245 (50 %) |
| 2026-09-08 08:00 — the start day | −8 | 2490 (100 %) |
| 2026-09-09 08:00 — after the start | −32 | 2490 (100 %) |
| from `pending` at any time | — | none, and no refund call |

Also asserted: `cancelFreeWeeks: 1` gives a 168-hour window; a 2495 kr base with
a 505 kr delivery fee rounds to **1248**, not 1500; the refund is
`totalPrice − fee − alreadyRefunded`, floored at zero (no negative refund, no
`refunds.create` call when the remainder is ≤ 0); the Stripe refund is capped at
`charge.amount − charge.amount_refunded`; the idempotency key is
`refund-<bookingId>-<ore>`, identical on a retry of the same outstanding amount
and different once the amount changes; every `BookingDateLock` is deleted; the
service never mints a goodwill RETUR code (that is the admin route's job) and
neither does `POST /api/booking/cancel`.

`POST /api/booking/cancel` further: token and reference+e-mail (case- and
whitespace-insensitive) both work; a wrong e-mail and an unknown reference
return the *same* 404 message; a token expiring exactly now is still valid and
one millisecond older is 410; `cancelled` and `completed` are 410 on both verbs;
the preview fee equals the fee actually charged; a second cancel is 410 rather
than a second refund; GET and POST share one 10-per-15-minute budget, keyed per
client address.

---

## Coverage after

`npm run test:coverage` scopes coverage to `src/lib/**`, so the route handlers
themselves (`src/app/api/**`) carry no coverage number — they are exercised
in-process by `tests/api/*` but never reported.

Two columns per file: the whole suite (`npm run test:coverage`, 947 passed /
55 expected fail / 38 skipped, 0 failed) and the seven files of this phase on
their own, which is what this phase can claim.

| file | stmts (suite) | branch (suite) | stmts (this phase alone) | branch (alone) |
| --- | --- | --- | --- | --- |
| `src/lib/booking-service.ts` (whole file) | 93.6 % | 86.0 % | 30.4 % | 27.1 % |
| └ `updateBookingStatus` (lines 739-965) | **88.7 %** | **85.6 %** | 88.7 % | 85.6 % |
| └ `confirmBookingPaidFromStripe` (971-990) | **100 %** | **91.7 %** | 100 % | 91.7 % |
| `src/lib/vipps-payments.ts` | 90.8 % | 82.1 % | 90.8 % | 82.1 % |
| `src/lib/vipps-config.ts` | 93.8 % | 68.2 % | 93.8 % | 68.2 % |
| `src/lib/stripe.ts` | 77.8 % | 66.7 % | 77.8 % | 66.7 % |
| `src/lib/cancellation.ts` | 100 % | 100 % | 84.6 % | 57.7 % |
| `src/lib/freeze-contract.ts` | 80.0 % | 57.7 % | 80.0 % | 57.7 % |
| `src/lib/vipps.ts` | 36.6 % | 31.4 % | 31.7 % | 25.5 % |

Notes on the gaps:

- `src/lib/vipps.ts` is low **by harness design**: the six HTTP functions and
  the token cache are replaced by `mockVipps`, so `authedFetch`, the webhook
  registration helpers and the error paths cannot be reached from this layer.
  The pure half (amounts, references, signature verification) is covered by
  `tests/lib/vipps.test.ts`.
- `src/lib/stripe.ts`'s uncovered block is the `vippsPreview` beta-header
  fallback (`:122-135`) and `getSessionPaymentMethodType`'s expanded-object
  branches (`:208-213`) — both need a Stripe response shape the fake client
  does not model.
- The uncovered lines inside `updateBookingStatus` are the `.catch()` handlers
  on the fire-and-forget audit/mail/refund calls plus the `reviewsEnabled: false`
  branch.
- The rest of `booking-service.ts` (`createPendingBooking`,
  `validateBookingInput`, `computeBookingPrices`, `generateBookingReference`,
  `getUnavailableDateStringsForRange`) belongs to other phases — which is the
  whole gap between the two `booking-service.ts` columns.
