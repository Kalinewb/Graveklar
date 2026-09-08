# src/lib/domain

Pure business rules. Functions in this folder must:

1. **Be deterministic.** Same inputs → same outputs. No `Date.now()` unless passed
   in via parameter. No `Math.random()`.
2. **Touch nothing infrastructural.** No HTTP, no email, no file I/O, no Stripe
   SDK. DB reads are allowed for *reference data* (config, machine catalogue);
   writes are not.
3. **Be testable without a server.** Vitest + plain inputs.

What lives here:

- `quote.ts` — the canonical commercial document (price + discount + MVA +
  warnings). Everything monetary the customer sees flows through this.
- `booking-timeline` (future) — pure event-merge function once the route
  endpoint stabilises.

What does NOT live here:

- Route handlers (`src/app/api/**`) — they're orchestration.
- Side-effect callers — `lib/email.ts`, `lib/stripe.ts`, etc. live in
  `lib/adapters/` once they're wrapped.
- The booking service (`lib/booking-service.ts`) — it does DB writes,
  email side effects, and contract freezing. Its pure sub-functions
  (`computeBookingPrices`, `validateBookingInput`) belong here and will
  migrate opportunistically. For now they're re-exported from
  booking-service as the implementation home; new pure logic goes
  directly here.

## Why this seam matters

If the app ever needs to:
- Spin out a worker process (compute quotes for batch pricing exports)
- Share booking rules with a mobile app or partner integration
- Migrate to a multi-tenant SaaS where pricing must be parameterised
  per tenant

…then domain code is what gets lifted into a shared package. The seam
between `domain` and the rest is the line where that lift happens.

For now (Lane A: local-tool maturity) the seam is documented and
honoured for new code. We do not reshuffle the existing 800-line
`booking-service.ts` for the sake of layering; we move pieces here only
when a real refactor justifies the touch.
