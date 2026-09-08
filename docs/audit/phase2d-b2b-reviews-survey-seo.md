# Phase 2d — B2B quote requests + offers, reviews, survey, contact, FAQ/insurance (area M/N); SEO, brand assets, special routes (area R)

Scope: `src/lib/quote-request.ts`; routes `POST /api/bedrift`,
`POST /api/tilbud/[token]`, `GET /api/admin/quote-requests` (+
`PATCH`/`DELETE /[id]`); `src/lib/review.ts`; routes `POST /api/omtale/[token]`,
`GET /api/admin/reviews` (+ `PATCH`/`DELETE /[id]`); `src/lib/survey-service.ts`;
routes `GET /api/survey/questions`, `POST /api/survey`, `GET /api/admin/survey`
(+ `DELETE /[id]`), `GET|POST|PUT /api/admin/survey/questions` (+
`PATCH`/`DELETE /[id]`); `POST /api/kontakt`; the public/admin FAQ and
insurance CRUD routes; `src/lib/seo.ts`, `src/lib/brand-icon.ts`, the
(unexported) accent-mixing logic in `src/app/layout.tsx`; and the special
routes `sitemap.ts`, `robots.ts`, `manifest.ts`, `llms.txt/route.ts`,
`brand-icon.svg`/`brand-mark.svg`/`/api/icon`, plus light shape checks on
`GET /api/machines` and `GET /api/app-config`.

311 tests across 15 files, all green. **16 `it.fails`** demonstrate **12** of
the **14** findings below (4 already known from the master list — F-5, now
fixed; F-10, F-6, F-14 — plus 10 newly discovered here: M-1, M-2, N-1…N-5,
R-1…R-3). F-14 and N-5 each carry 3 `it.fails` because the same defect shape
recurs across FAQ and insurance, or across several handlers of the same
route; F-5 (fixed) and R-3 (a testability recommendation, not a runtime
defect) have none. Each `it.fails` asserts the behaviour the product *should*
have and carries its finding id in a comment beside it, so a fix phase flips
it back to `it`. Every `it.fails` is paired with a plain `it` right next to it
that pins down what the code does *today*, so the fix phase has a clean
before/after.

| File | Tests |
| --- | --- |
| `tests/service/quote-request.test.ts` | 34 (1 `it.fails`) |
| `tests/api/bedrift.test.ts` | 15 |
| `tests/api/tilbud.test.ts` | 16 (1) |
| `tests/api/admin-quote-requests.test.ts` | 19 (1) |
| `tests/service/review.test.ts` | 24 (1) |
| `tests/api/omtale.test.ts` | 8 |
| `tests/api/admin-reviews.test.ts` | 13 |
| `tests/service/survey-service.test.ts` | 14 (1) |
| `tests/api/survey.test.ts` | 37 (3) |
| `tests/api/kontakt.test.ts` | 13 |
| `tests/api/content-routes.test.ts` | 24 (6) |
| `tests/lib/seo.test.ts` | 43 (2) |
| `tests/lib/brand-icon.test.ts` | 25 |
| `tests/lib/accent-style.test.ts` | 5 |
| `tests/api/special-routes.test.ts` | 21 |

`tests/helpers/marketing.ts` was **not** created — everything needed
(`booking`, `campaignCode`, `repeatCode`, `machine`, `adminCookie`/ambient
`next/headers` mock, `mockEmail`, `mockStripe`, `mockClock`, `waitFor`/`settle`
from `tests/helpers/payments.ts`) already existed in `tests/helpers/{db,route,
mocks,payments}.ts`.

A note on the `next/headers` ambient-cookie-store mock used in
`tests/api/admin-quote-requests.test.ts`, `admin-reviews.test.ts`,
`survey.test.ts` and `content-routes.test.ts`: `isAdminAuthenticated()` reads
the ambient `cookies()` from `next/headers`, not the `NextRequest` the harness
builds, so each of those files carries the same small `vi.mock('next/headers',
...)` shim first introduced in `tests/api/admin-discount-codes.test.ts`
(Phase 1). `tests/api/kontakt.test.ts` uses a different, narrower shim: it
mocks only the `nodemailer` package (not `@/lib/email`), so the real
`sendContactMessageEmail` logic — the SMTP-unconfigured 503 gate, the exact
`to`/`replyTo` fields — runs unmocked, with no email module ever mocked away
and no socket ever opened.

---

## Findings

| id | sev | title | src | demonstrating test | status |
| --- | --- | --- | --- | --- | --- |
| F-5 | — | **Fixed, verified.** `POST /api/tilbud/[token]` builds the Stripe Checkout redirect from the configured `siteUrl` (falling back to the request's own origin), never from `X-Forwarded-Host`/`Origin` | `src/app/api/tilbud/[token]/route.ts:19-21` (`resolveOrigin`) | `tests/api/tilbud.test.ts` → "builds the Checkout redirect from siteUrl, never from a forwarded host (FIXED F-5)" | fixed (commit 3b9cc42) |
| F-10 | P3 | **`DELETE /api/admin/quote-requests/[id]` throws instead of 404ing on an unknown id.** `db.quoteRequest.delete()` runs with no existence check and no try/catch, so Prisma's `P2025` escapes the handler as an unhandled rejection (a bare 500 in production) rather than the 404 every sibling admin-CRUD route in this codebase gives for the same case — including `DELETE /api/admin/reviews/[id]` right next to it, which catches and ignores the same failure | `src/app/api/admin/quote-requests/[id]/route.ts:110-117` | `tests/api/admin-quote-requests.test.ts` → "404s on an unknown id instead of throwing" | fixed — `DELETE /api/admin/quote-requests/[id]` checks the row exists first and answers 404 instead of letting P2025 escape |
| F-6 | P2 | **`POST /api/survey` has no size cap and no key whitelist.** The handler stores `JSON.stringify(body)` verbatim into `SurveyResponse.data` — an anonymous, only rate-limited (10/15 min per IP, trivially spread across identities) endpoint that will persist an arbitrarily large payload on every request with no cap at all | `src/app/api/survey/route.ts:36-41` | `tests/api/survey.test.ts` → "refuses a payload above a sane size cap (e.g. 64 KB)" | fixed — `POST /api/survey` bounds the body three ways before storing it: 64 KB cap, keys restricted to the survey's own question keys plus `epost`/`samtykke`, and values limited to scalars or a list of ≤2000-char strings (`src/app/api/survey/route.ts`) |
| F-14 | P3 | **A number where the admin UI always sends a string is a 500, not a 400, on FAQ and insurance CRUD.** `POST` does `body.question?.trim()` (`.trim` is not a function on a number); `PATCH` hands the raw value straight to Prisma, which throws its own validation error for the wrong JS type. Both land in the generic catch-all as a 500. Confirmed on FAQ `POST`+`PATCH` and insurance `POST` | `src/app/api/admin/faq/route.ts:18-19`, `src/app/api/admin/faq/[id]/route.ts:14`, `src/app/api/admin/insurance/route.ts:18` | `tests/api/content-routes.test.ts` → "POST/PATCH answers 400, not 500, when question/label arrives as a number" (×3) | fixed — FAQ and insurance create/update shape-check every field and answer 400 naming it; an unknown id is a 404 (four routes under `src/app/api/admin/{faq,insurance}`) |
| M-1 | P2 | **A card-mode B2B booking never reaches `konvertert`, even after it is paid.** `QUOTE_STATUSES` documents `konvertert` as "turned into a real Booking", and the tilbud accept route does set that status on the invoice path — but `convertQuoteToBooking` (the only code that ever runs for the card path; nothing touches `QuoteRequest` from the Stripe webhook) sets `'akseptert'` instead. A card-mode quote is therefore stuck at `akseptert` forever: the admin UI keys "Send tilbud"/"Revider tilbud" and "Trekk tilbake" off `status !== 'konvertert'` (`src/app/admin/page.tsx:3081`, `:3110`), so both stay available on a quote that is fully paid and already has a real, locked `Booking` behind it | `src/lib/quote-request.ts:254-257` | `tests/service/quote-request.test.ts` → "reaching convertedBookingId also moves the status to konvertert"; `tests/api/tilbud.test.ts` → "creates a booking (still pending) and returns the Stripe Checkout url" (records the same `akseptert` status) | **fixed at payment time** — `updateBookingStatus` moves the quote to `konvertert` with a conditional `updateMany` (`convertedBookingId` + status `akseptert`) when the booking is confirmed, so a paid card quote no longer sits at `akseptert` (`src/lib/booking-service.ts`). `convertQuoteToBooking` deliberately leaves a card-mode quote at `akseptert` at conversion time: the pending booking can still expire unpaid, and `konvertert` must mean a paid booking exists (the invoice path sets it at accept because the invoice is the commitment). The conversion-time `it.fails` in `tests/service/quote-request.test.ts` was rewritten to assert exactly that |
| M-2 | P3 | **Declining an offer that is not `tilbud_sendt` still answers `{status:'avslatt'}`, even though nothing was written.** The write is correctly guarded by `quote.status === 'tilbud_sendt'`, but the response is built unconditionally — a customer (or a replayed/double-clicked request) declining an offer that is `ny`, `konvertert`, `akseptert`, `utlopt` or `trukket` is told the offer is now declined while the stored status never changes | `src/app/api/tilbud/[token]/route.ts:60-65` | `tests/api/tilbud.test.ts` → "the response only claims avslatt when the write actually happened" | fixed — declining a non-`tilbud_sendt` offer echoes the stored status and `changed: false`; only a real write answers `{status:'avslatt', changed:true}` (`src/app/api/tilbud/[token]/route.ts`) |
| N-1 | P3 | **`reviewerName` has no length cap.** Unlike `comment` (explicitly sliced to 2000 characters), `firstName()` only ever splits on whitespace — a single unbroken token of any length (an attacker's payload, or simply no spaces) passes straight through to the public reviews list with no truncation at all | `src/lib/review.ts:6-8`, `:96`, `:103` | `tests/service/review.test.ts` → "reviewerName is capped at a sane display length" | fixed — `firstName()` slices to 40 characters, so an unbroken token can no longer reach the public reviews list whole (`src/lib/review.ts`) |
| N-2 | P2 | **The survey question set can stop seeding forever, silently.** `seeded` in `survey-service.ts` is a process-local boolean with no reset and no re-check of `count === 0` once true — it exists only to skip a COUNT query per request. If `SurveyQuestion` ever becomes empty again after the first seed (an admin deleting every question one row at a time through the admin builder, which the DELETE route allows with no floor), `seedSurveyQuestionsIfEmpty()` never seeds again for the life of the running process: `GET /api/survey/questions` silently serves an empty question set to every customer until the next deploy/restart | `src/lib/survey-service.ts:64`, `:70` | `tests/service/survey-service.test.ts` → "reseeds the defaults if the table is empty again after the first seed" | fixed — the process-local `seeded` flag is gone; `seedSurveyQuestionsIfEmpty()` re-counts every call, so an emptied table reseeds (`src/lib/survey-service.ts`) |
| N-3 | P3 | **`DELETE /api/admin/survey/[id]` (survey response rows) throws instead of 404ing on an unknown id.** Same shape as F-10: no existence check, no try/catch, Prisma's `P2025` escapes unhandled | `src/app/api/admin/survey/[id]/route.ts:7-14` | `tests/api/survey.test.ts` → "404s on an unknown id instead of throwing" | fixed — `DELETE /api/admin/survey/[id]` checks the row exists first and answers 404 |
| N-4 | P3 | **`PUT /api/admin/survey/questions` (reorder) throws instead of answering 400 on an unknown id in the list.** `db.$transaction(ids.map(...update...))` has no try/catch, so one stale id (a question deleted in another tab) 500s the whole reorder instead of a clean 400 — an all-or-nothing transaction where nothing in the list gets reordered, but the caller cannot tell that from a thrown error | `src/app/api/admin/survey/questions/route.ts:109-113` | `tests/api/survey.test.ts` → "an unknown id in the list fails cleanly (400), not with an unhandled throw" | fixed — `PUT /api/admin/survey/questions` resolves every id before the transaction and answers 400 naming the unknown one; a refused reorder writes nothing |
| N-5 | P2 | **The FAQ and insurance admin routes have no auth check of their own.** Every other `/api/admin/*` handler in this codebase (discount-codes, quote-requests, reviews, machines, app-config, survey…) calls `isAdminAuthenticated()` itself as defense-in-depth alongside the proxy matcher. `GET`/`POST /api/admin/faq`, `PATCH`/`DELETE /api/admin/faq/[id]`, and the insurance mirror have none at all — they are safe today only because the proxy matcher happens to cover every `/api/admin/*` path, the exact single point of failure `H-2` (`docs/audit/phase1d-auth-config-uploads.md`) already demonstrated once for the bare `/api/admin` path | `src/app/api/admin/faq/route.ts`, `src/app/api/admin/faq/[id]/route.ts`, `src/app/api/admin/insurance/route.ts`, `src/app/api/admin/insurance/[id]/route.ts` | `tests/api/content-routes.test.ts` → "GET/POST /api/admin/faq refuses a direct call with no session", "POST /api/admin/insurance refuses a direct call with no session" | fixed — all eight FAQ/insurance admin handlers call `isAdminAuthenticated()` themselves (401), so the proxy matcher is no longer the only gate |
| R-1 | P3 | **A protocol-relative `heroImageUrl` resolves to a malformed URL.** `absoluteUrl` special-cases a path starting with `"http"`; a protocol-relative image link (`"//cdn.example.com/x.jpg"`) starts with `"/"` instead, so it takes the "already has a leading slash" branch and gets the site's own origin PREPENDED — `resolveOgImage` then hands the `og:image`/Twitter-card crawler `"https://graveklar.no//cdn.example.com/x.jpg"`, which resolves to the site's own (non-existent) path, not the intended CDN image | `src/lib/seo.ts:89-98` | `tests/lib/seo.test.ts` → "a protocol-relative heroImageUrl resolves to a valid URL on the current scheme" | fixed — `absoluteUrl` resolves a protocol-relative path against the base URL's scheme instead of prepending our own origin (`src/lib/seo.ts`) |
| R-2 | P2 | **A `siteUrl` without a scheme crashes metadata generation, site-wide, with no guard anywhere in the call chain.** `buildSiteMetadata` does `new URL(siteUrl)` for `metadataBase` with no try/catch, and `siteBaseUrl`/`absoluteUrl` never check for (or add) a scheme. Every page's `generateMetadata()` calls this — `src/app/layout.tsx:74`, `src/app/page.tsx:26`, and every static page — so an admin saving `siteUrl = "graveklar.no"` (a very plausible typo: leaving off `"https://"`) throws on every single page render | `src/lib/seo.ts:119` | `tests/lib/seo.test.ts` → "a siteUrl without a scheme does not crash metadata generation" | fixed — `siteBaseUrl()` reads a schemeless `siteUrl` as https and falls back to the default origin (with one warning) for anything unparseable, so `new URL()` in `buildSiteMetadata` can no longer throw |
| R-3 | P3 | **The accent → CSS-variable mixing logic is unexported and duplicated.** `buildAccentStyle` (`src/app/layout.tsx:31-64`), plus the `hexLuminance`/`contrastRatio` helpers it depends on, are module-local — the only caller is `RootLayout`, a Server Component this harness cannot render (no `jsdom`/`@testing-library` in this repo). The same relative-luminance/contrast-ratio math already exists, exported and tested, in `src/lib/brand-icon.ts`. Recommend extracting the shared math (and ideally `buildAccentStyle` itself) into a `src/lib/` module so it is unit-testable without a rendered page | `src/app/layout.tsx:16-64` | `tests/lib/accent-style.test.ts` — the whole file: it re-implements the algorithm from a comment-pinned copy of the source because there is nothing to import | fixed — `buildAccentStyle` + `hexLuminance`/`contrastRatio` extracted to `src/lib/accent-style.ts` and imported by `layout.tsx`; `tests/lib/accent-style.test.ts` imports the real thing instead of a replica. The dark contrast target moved from the card (#201c16) to the lightest dark surface (#302a22, `--secondary`/`--muted`) — the accent text failed AA at 4.31:1 on the equipment picker's tinted panel |

---

## Verified fine (no defect — recorded so a future change doesn't silently regress)

- **`b2bEnabled` ships `'false'` in `APP_CONFIG_DEFAULTS`**, and `POST
  /api/bedrift` 404s on anything other than the exact string `'true'`
  (`'1'`, `'yes'`, `'TRUE'`, `' true'`, `''` all 404) — the insurance-driven
  P0 requirement that B2B stays off unless deliberately enabled holds.
- **`createQuoteRequest`** validates company/org-number (9 digits, tolerant of
  embedded spaces)/contact name/email/phone/the M2 training confirmation
  before touching the database, validates an optional machine
  (unknown/inactive → refused), drops an out-of-whitelist `rentalType` to
  `null` rather than storing it, and clamps `customDays` to 1…365 (floored)
  only when `rentalType === 'custom'`.
- **`generateQuoteReference`** is `BQ-YYMM-NNN-XXXX`, the suffix alphabet
  excludes ambiguous glyphs (0/O/1/I/L), and the sequence number reflects the
  count of quotes already created this month.
- **`convertQuoteToBooking`**: refuses with no offer amount, no start date, a
  deleted or deactivated machine; creates the `Booking` + one
  `BookingDateLock` per rental day atomically; refuses cleanly (and leaves
  nothing behind) when every slot for a day is already locked; composes
  `notes` from the company/org number/original reference/project
  description; defaults `customDays` by `rentalType` when the offer never
  pinned one.
- **`POST /api/tilbud/[token]`**: 404 on an unknown token; decline moves
  `tilbud_sendt` → `avslatt`; 409 on accept when the status is not
  `tilbud_sendt` and nothing has converted yet; 410 + `utlopt` on either
  `acceptTokenExpiry` or `offerValidUntil` having passed, with the exact
  strictly-less-than boundary verified at "now" (not yet expired) vs. "now +
  1 ms" (expired); accept is idempotent for both invoice (`alreadyAccepted`,
  no second booking) and card (re-resolves the same Checkout session) once
  `convertedBookingId` is set; invoice mode confirms the booking and skips
  Stripe entirely; card mode 503s when Stripe is disabled, while still having
  created the (still-pending) booking so a retry once Stripe is re-enabled
  picks it back up idempotently; the 10/15-min limiter holds.
- **`PATCH /api/admin/quote-requests/[id]`**: `send_offer` requires a
  positive `offerAmount`, whitelists `rentalType` (an out-of-list value is
  dropped, not refused, leaving the prior value), clamps `customDays` 1…365
  for `custom`, reuses an existing `acceptToken` across revisions rather than
  minting a new one, defaults `offerValidUntil` to +14 days and
  `acceptTokenExpiry` to `offerValidUntil` + 7 days, and falls back to that
  default rather than 400ing on an unparseable `offerValidUntil` string;
  `set_status` accepts only the admin-settable subset of `QUOTE_STATUSES`
  (`akseptert`/`konvertert` are correctly refused — those are reachable only
  through the accept flow); `note` sets/clears freely; every action 404s on
  an unknown id (`send_offer`/`note`/`set_status` all check first — only
  `DELETE` does not, see F-10).
- **`ensureReviewRequest`** is one-per-booking under a genuine race
  (`Promise.all` of two concurrent calls yields exactly one token and one
  row); **`submitReview`** requires `pending` status, rounds a fractional
  rating and refuses anything outside 1…5, truncates `comment` to 2000
  characters (blank → `null`, not `''`), and defaults `reviewerName` to the
  booking's first name.
- **`getApprovedReviews`**/**`getReviewAggregate`** only ever surface
  `approved` rows, newest first, respect the `limit`, default a blank
  `reviewerName` to `"Anonym"`, and round the average to 1 decimal place with
  the documented 4.65 → 4.7 round-half-up case (13×5 + 7×4 = 93/20 exactly).
- **`POST /api/omtale/[token]`**: honeypot, a `ReviewError` maps to 400 with
  its message, a second submission on an already-submitted token is refused
  and does not overwrite the first, the 10/15-min limiter holds.
- **Admin reviews `GET`/`PATCH`/`DELETE`**: the list excludes `pending`
  (unfilled) rows; `PATCH` 400s on an action outside approve/reject, 404s on
  an unknown id, and 400s when the review has not been submitted yet;
  `DELETE` is a graceful no-op on an unknown id (unlike F-10/N-3 right next
  to it in spirit).
- **`seedSurveyQuestionsIfEmpty`** is race-safe under two genuinely
  concurrent callers on an empty table (the loser's `createMany` hits the
  unique-key constraint and is swallowed, per its own docstring) and seeds
  exactly the `surveyDefaults` set with no duplicates on a second call.
- **`loadActiveSurveyQuestions`** orders by `sortOrder`, returns only
  `isActive` rows, parses `options`/`config` JSON with a safe `[]`/`{}`
  fallback on garbage, substitutes `{{helgpris}}`/`{{ukepris}}`/
  `{{helgtimer}}`/`{{uketimer}}` from **live** `PricingConfig` in both label
  and hint (verified it changes when the underlying price does), strips the
  `[[rabatt]]…[[/rabatt]]` span entirely when the lead discount is disabled
  (the default) and substitutes the configured percent (defaulting to 15 %
  on a non-numeric value) when enabled — including inside
  `config.consentLabel`.
- **`loadSurveyLabels`** includes inactive questions so historical answers
  still render a label.
- **`POST /api/survey`**: stores the email extracted from `body.epost` (null
  when absent), only hands out the configured lead-discount code when the
  feature is enabled, `samtykke === true` exactly, the email is present and
  well-formed, AND the configured value validates as a **campaign** code (a
  repeat/email-bound code, or one that does not exist, is correctly
  withheld) — with the email sent only in that case.
- **Admin survey question builder**: `POST` enforces the `^[a-z0-9_]+$` key
  regex (after lower-casing/trimming — a same-key-different-case submission
  is accepted, not rejected, and the trim/lowercase is intentional per the
  route's own logic), the type whitelist, required section/label, and 409s
  on a duplicate key; `sortOrder` is `max + 10`; `PATCH` 400s on an empty
  patch and an out-of-whitelist type, and — unlike `PUT` reorder (N-4) —
  404s cleanly on an unknown id; `DELETE` is a graceful no-op on an unknown
  id.
- **`POST /api/kontakt`**: gated by `contactFormEnabled` (ships `'true'`);
  honeypot; name ≥ 2 chars, a well-formed email, message 10…5000 chars
  (5000 accepted, 5001 refused); 503, with the real (unmocked)
  `sendContactMessageEmail`, when no SMTP host/user/pass and no
  adminEmail/contactEmail are configured (the out-of-the-box state); once
  SMTP is configured, `Reply-To` is the sender's own address (never the
  business inbox), and the recipient is `adminEmail`, falling back to
  `contactEmail` when blank; the 5/15-min limiter holds.
- **Public `GET /api/faq` / `GET /api/insurance`**: only active
  items/cards, ordered by `sortOrder` then `createdAt`.
- **Admin FAQ/insurance `PATCH`/`DELETE`**: partial updates only touch the
  fields present in the body; deletes work.
- **`src/lib/seo.ts`**: `parseSeoKeywords` drops empty entries between
  commas; `buildDefaultKeywords` includes the business name/area-derived
  phrases (lowercased) and every machine's name/category/"name model", capped
  at 24; `resolveSeoKeywords` prefers manual keywords over the generated set;
  `buildSeoTitle`/`buildSeoDescription` fall back through
  override → heroTagline (only when ≤ 160 chars, verified at the exact 160
  vs. 161-char boundary) → generated sentence, itself always sliced to 160;
  `siteBaseUrl` strips one-or-more trailing slashes and defaults to
  `https://graveklar.no`; `absoluteUrl` passes an already-absolute path
  through and joins a relative one onto the base with exactly one slash;
  `buildSiteMetadata` sets `alternates.canonical` from the path (or the bare
  site URL with none) except when `noIndex` is set, in which case it sets
  `robots.index=false` instead and omits `alternates`.
- **JSON-LD builders**: `buildLocalBusinessJsonLd`/`buildWebSiteJsonLd`
  include optional fields (`telephone`/`email`/`address`/`identifier`) only
  when the corresponding config value is present; `buildFaqPageJsonLd` is
  `null` with no items, else the `Question`/`Answer` shape;
  `buildAggregateRatingJsonLd` is `null` at `count <= 0`, else the fixed
  1…5 `bestRating`/`worstRating` shape; **`jsonLdScriptHtml`** escapes every
  `<` (not just the literal `</script>`) so a business name containing
  `</script><script>…` cannot break out of the inline JSON-LD block, and the
  escape round-trips cleanly through `JSON.parse`.
- **`src/lib/brand-icon.ts`**: `normalizeAccent` falls back to
  `DEFAULT_ACCENT` for anything that is not a well-formed 6-digit hex (empty,
  `null`, `'red'`, `'#12345'`, a missing `#`, …); `contrastRatio` is
  symmetric and gives black-on-white ≈ 21:1; `markColorFor` darkens the raw
  accent until it clears the target contrast (default 9:1) against the tile
  ground, returns the accent unscaled when it already clears the target, and
  always returns a well-formed hex; `iconWeights`' three thresholds (16/32/48)
  are inclusive (`<=`) and each boundary+1 crosses into the next bucket;
  `buildBrandIconSvg` produces a `0 0 {size} {size}` viewBox, a rounded vs.
  square tile background, a `TILE_GROUND` fill independent of the accent, and
  paths filled with the *darkened* accent; `buildBrandMarkSvg` uses
  `MARK_BBOX` as its viewBox, has no `<rect>` background (transparent), and
  fills paths with the *raw*, undarkened accent (correctly — it is drawn on
  the page's own background, not a fixed tile).
- **The accent-mixing logic replicated from `layout.tsx`** (see R-3): a
  30-accent sweep (golden-angle hue spread × 3 saturations × 5 lightness
  levels) confirms every derived `--primary-text-light` clears 4.5:1 against
  `#f5f0e6` and every `--primary-text-dark` clears 4.5:1 against `#201c16`;
  `--primary-foreground` picks white or near-black, whichever contrasts more
  with the raw accent; an invalid/missing accent yields `undefined`.
- **`sitemap.ts`**: the 3 base entries (`/`, `/vilkar`, `/personvern`) always
  appear; `/kontakt` is included only when `contactFormEnabled === 'true'`
  (the default) and `/bedrift` only when `b2bEnabled === 'true'`; the home
  entry's `lastModified` is the newest **active** machine's `updatedAt`
  (falling back to "now" with no active machines); every URL is built from
  `siteBaseUrl`.
- **`robots.ts`**: every listed user agent (`*`, Googlebot(-Image), Bingbot,
  GPTBot, ChatGPT-User, OAI-SearchBot, ClaudeBot, PerplexityBot) gets the same
  `disallow: ['/admin','/api','/sjekkliste','/omtale','/tilbud']` and
  `allow: ['/','/api/icon']`; the sitemap URL is `{siteBaseUrl}/sitemap.xml`.
- **`manifest.ts`**: `name`/`short_name`/`theme_color` come from
  `AppConfig` (`theme_color` normalized through `normalizeAccent`, so a
  garbage `accentColor` cannot leak into the manifest); exactly the 3
  installable icon sizes, and each one's file genuinely exists under
  `public/`; the 512 maskable icon is the only one flagged
  `purpose: 'maskable'`.
- **`GET /llms.txt`**: `text/plain`, `Cache-Control: public, max-age=300`,
  includes active machine names/models and the four formatted price tiers,
  and excludes inactive machines.
- **`brand-icon.svg` / `brand-mark.svg` / `/api/icon`**: all three are
  `image/svg+xml`, `Cache-Control: public, max-age=3600` (plus a
  stale-while-revalidate window), parseable SVG, and the mark's rendered
  colour changes with the configured `accentColor`.
- **`GET /api/machines`**: active machines only, ordered by `sortOrder` then
  `createdAt`.
- **`GET /api/app-config`**: a known public key is present, known private
  keys (`smtpPass`, `adminPasswordHash`) are absent — full depth already
  covered by Phase 1d's `I-1` work; this file is a shape check only, as
  scoped.

---

## Coverage after (src/lib/**, this phase's files only — `npx vitest run --coverage` scoped to the 15 files above)

| module | % stmts | % branch | % funcs | uncovered |
| --- | --- | --- | --- | --- |
| `src/lib/quote-request.ts` | 99.03 | 93.33 | 100 | line 69 (the 20-collision `Date.now()` reference fallback — impractical to force 20 real collisions); branch gaps at 67 (`quote.machine ?? …` single-fetch fallback), 174/179 (machine-null vs. machine-inactive sub-paths), 203 (`rentalType==='week' && customDays>7`, i.e. a negotiated >1-week rental), 232 (a date that already has ≥1 existing lock — only single-collision exercised) |
| `src/lib/review.ts` | 100 | 93.33 | 100 | branch gap at line 7 (`firstName`'s `full \|\| ''` guard for a falsy `full`, which `submitReview` never passes) |
| `src/lib/survey-service.ts` | 100 | 86.48 | 100 | branch gaps at 28/38 (`parseOptions`/`parseConfig`'s "valid JSON but wrong shape" branch — object where an array was expected and vice versa), 72 (`seeded===false` with `count>0`, i.e. a fresh process attaching to an already-seeded table — inherently hard to reach from a single test file's module instance), 107 (a `surveyLeadDiscountPercent` branch not distinguished from the ones tested), 136 (`?? r.label` — `discount()` returning `null`, which cannot happen since `r.label` is a non-null column) |
| `src/lib/seo.ts` | 100 | 92.3 | 100 | branch gaps at 41 (one of `m.name`/`m.category`/`m.model` being absent — only "all present" and implicitly "all absent" via no machines were exercised), 119 (`siteUrl ? … : undefined` — the `undefined` side is **dead code**: `siteBaseUrl` never returns an empty string, so `metadataBase` can never actually be `undefined` in practice), 125/154/155/184/220 (the `cfg['businessName'] \|\| 'Graveklar'` / `cfg['contactEmail'] ? … : {}`-style default-fallback sides not separately exercised in every builder — every test in this phase supplies a `businessName`) |
| `src/lib/brand-icon.ts` | 97.87 | 93.54 | 100 | line 54 (`markColorFor`'s final `return '#1A1410'` — reached only if no shade down to f=0.05 clears the target, not forced by any realistic accent tested); branch gaps at 117/139 (the `s.transform ? … : ''` ternary in both SVG builders' path-mapping — depends on whether a given `GRAVEKLAR_MARK_PATHS` entry happens to carry a transform, not something a test should force) |

---

## Not done / could not verify

- Live-instance (`:3001`) verification of any of the above was not run — this
  phase is entirely in-process (L1–L3), per the harness rules.
- `tests/helpers/marketing.ts` was not created — nothing in this phase needed
  a helper beyond what already existed.
- The exact wire behaviour of `sendQuoteOfferEmail`/`sendNewQuoteRequestAdminNotification`/
  `sendQuoteRequestReceivedEmail`/`sendReviewRequestEmail`'s HTML bodies
  (escaping, preheader safety) is out of this phase's scope — `src/lib/email.ts`
  belongs to Phase 2c (`tests/lib/email-templates.test.ts`), which already
  covers the preheader-escaping defect (`J-2`) that would also apply to the
  three B2B senders touched here.
- `src/app/admin/page.tsx`'s rendering of quote-request/review/survey admin
  UI (the `q.status !== 'konvertert'` gates cited under M-1) was read, not
  exercised — there is no component-test layer in this repo
  (`jsdom`/`@testing-library` not installed).
