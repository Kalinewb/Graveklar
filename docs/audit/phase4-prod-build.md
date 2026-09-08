# Phase 4 — production build, headers, Lighthouse, bundle hygiene

Snapshot: commit `9c6a3b0` (end of Phase 2), built with `next build` (Turbopack) in a scratch
copy outside the repo (`~/.cache/graveklar-buildcheck`, node_modules hard-linked, a fresh
`node_modules/.cache`), served with `next start -p 3003` against a copy of the neutralised
audit database. The live checkout, its `.next`, port 3000 and the live database were not
touched. Scripts: `scratchpad/phase4-checks.sh`, `scratchpad/lh-run.sh` (Lighthouse 12,
system Chromium, mobile = default preset with 4× CPU slowdown, desktop = `--preset=desktop`).

## Build

| Check | Result |
|---|---|
| `next build` | exit 0, 2 warnings (both the same NFT trace warning, see W-2) |
| `.next/static` | 2.2 MB, 46 chunks |
| `.next/server` | 41 MB — inflated by W-2 (the whole project is traced into the server output) |
| Prod start | ready in 1.9 s, `/` answers 200 after 6 s cold |

## Response headers (every route)

`Content-Security-Policy` (default-src 'self'; script-src 'self' 'unsafe-inline' js.stripe.com;
connect-src self + api.stripe.com + nominatim + osrm; frame-ancestors 'none'; form-action self +
checkout.stripe.com; object-src 'none'), `Strict-Transport-Security` 2 y + preload,
`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy:
strict-origin-when-cross-origin`, `Permissions-Policy` (camera, microphone, geolocation,
interest-cohort off). Dynamic HTML is `private, no-cache, no-store`; manifest, robots and
sitemap are `public, max-age=0, must-revalidate`.

## Gating and side-effect-free GETs

| Request | Status | Verdict |
|---|---|---|
| `/admin` unauthenticated | 307 → `/admin/login?from=/admin` | ok |
| `/api/admin`, `/api/admin/bookings` | 401 | ok (F-13) |
| `/api/bookings/x`, `/api/uploads/renter-…` | 401 | ok (F-2) |
| `/finnes-ikke` | 404 | ok |
| `/bedrift` with `b2bEnabled=false`, `/tilbud/<bad token>` | **200** | Q-6 confirmed on the production build — not a dev-server artefact |
| `GET /api/payment/stripe/cancel?bid=x`, `/callback?…` | 307 → `/?stripe=error`, no write | ok (F-3) |
| `GET /api/payment/vipps/return?ref=x` | 307 → `/?vipps=error` | ok |
| `/api/payment/*/status` with unknown id | 200 `{enabled}` only | ok, no booking data |

## Rate limiting under a burst

| Endpoint | Limit | 25 rapid requests |
|---|---|---|
| `POST /api/quote` | 60 / min | 25 × 200 (inside the window, as designed) |
| `GET /api/booking/cancel?token=x` | 10 / 15 min | 10 × 404 then 429 from the 11th (Q-12 splits the preview off this budget) |

## Secrets never leave the server

The scratch database still carried the Stripe test keys, the webhook secret and the Vipps
client secret / subscription key (lengths 107, 38, 40, 32). Their values were grepped in the
served HTML of `/`, `/vilkar`, `/bedrift`, `/kontakt`, `/sjekkliste`, in `/api/app-config`,
in `/manifest.webmanifest` and in every file under `.next/static`: **0 hits**. The secret *key
names* (`smtpPass`, `stripeSecretKey`, `stripeWebhookSecret`, `vippsClientSecret`,
`vippsSubscriptionKey`, `adminPasswordHash`, …) also do not occur in any public response or
client chunk (the admin config editor only learns the key names from the API at runtime).

## Lighthouse

| Page | Form | Perf | A11y | Best practices | SEO | LCP | TBT | CLS |
|---|---|---|---|---|---|---|---|---|
| `/admin/login` | desktop | 97 | 100 | 100 | 66 | 0.7 s | 140 ms | 0 |
| `/admin/login` | mobile | 69 | 100 | 100 | 66 | 3.8 s | 770 ms | 0 |
| `/` | desktop | 94 | 100 | 100 | 100 | 1.0 s | 170 ms | 0.005 |
| `/` | mobile | 50 | 100 | 100 | 100 | 5.4 s | 2,250 ms | 0 |
| `/vilkar` | desktop | 98 | 100 | 100 | 100 | 0.8 s | 130 ms | 0 |
| `/vilkar` | mobile | 72 | 100 | 100 | 100 | 2.5 s | 1,380 ms | 0 |

Accessibility, best practices and SEO are 100 on every public page after W-3, W-6 and W-7; the admin login scores SEO 66 only because it is unindexed on purpose (W-9). Performance on the throttled mobile profile is the open W-10.

The first run happened while four agents were running test suites on the same 4-core machine
(load average 14); those numbers were discarded and the table above is from a re-run on the
rebuilt snapshot of the fixed tree with the machine idle.

## Findings

| ID | Sev | Finding | Where | Status |
|---|---|---|---|---|
| W-1 | P4 | `X-Powered-By: Next.js` is sent on every response; `poweredByHeader` is not set in `next.config.ts` | `next.config.ts` | fixed — `poweredByHeader: false` |
| W-2 | P3 | Turbopack's file trace pulls the whole project into the server output (41–44 MB) because the upload directory is derived from `DATABASE_URL` at runtime and then read with `readdir`; the warning names `next.config.ts` as the unexpected traced file, via `src/lib/cleanup.ts` → `/api/cron/cleanup` and `instrumentation.ts` | `src/lib/cleanup.ts`, `src/lib/upload-store.ts` | deferred — `/*turbopackIgnore: true*/` hints on the `path.resolve`/`path.join`/`readdir`/`stat`/`unlink` calls (kept, they document the intent) did not stop the trace on Next 16.2.6; the durable fix is to scope the directory statically (`path.join(process.cwd(), 'uploads')` only), which moves uploads for existing deployments and is a deliberate ops change, not an audit fix. Impact is disk only: the served bundle is 2.2 MB and unchanged |
| W-3 | P3 | Dark theme, home page: the accent text (`--primary-text-dark` #a47c5a) is lightened until it clears 4.5:1 on the page background, but the equipment picker paints it on `bg-primary/5` over `--card`, which composites to #262018, where it reads at 4.31:1; the `text-destructive` overtime rate (#e74c3c) reads at 4.22:1 on the same surface and 3.7:1 on `--secondary` | `src/app/layout.tsx` (now `src/lib/accent-style.ts`), `src/app/globals.css:122` | fixed — accent text is computed against the lightest dark surface (`--secondary` #302a22); dark `--destructive` is #ef7a6d (5.2:1 on `--secondary`) and `--destructive-foreground` now exists (#16130f dark, #fff light) so the previously undefined `text-destructive-foreground` utility resolves. Verified on the rebuilt snapshot: the served CSS carries `--primary-text-dark: #af8b6d` (4.55:1 on #302a22, 5.17:1 on #262018) and `--destructive: #ef7a6d` (5.19:1) |
| W-4 | P4 | Machine images are requested at 640 px for a 310 px slot (`sizes` missing on the picker `<Image>`), ~39 KiB per image on mobile; the hero webp is served at q=45 and Lighthouse still asks for more compression | `src/app/HomePage.tsx` picker image, hero | open — perf polish, no user impact beyond bytes |
| W-5 | P3 | CSP allows `script-src 'unsafe-inline'`; Next's inline bootstrap scripts need a nonce-based CSP to drop it | `src/proxy.ts` / `next.config.ts` headers | deferred — needs the nonce plumbing through the root layout; tracked for the go-live checklist |
| W-6 | P3 | Dark theme, `/vilkar`: every clause number ("1.1", "2.1", …) is `text-muted-foreground/50`, which composites to #696054 on the #16130f page ground — 2.99:1, failing WCAG AA. 23 flagged nodes, the only accessibility failure on the page | `src/app/vilkar/VilkarClient.tsx:141` | fixed — the clause numbers use plain `text-muted-foreground` (6.5:1 in both themes); asserted in `tests/e2e/page-gates.e2e.test.ts` |
| W-7 | P3 | With `seoDescription` empty, `buildSeoDescription()` returned `heroTagline` for any tagline ≤160 chars — and the configured tagline is "Alt inkludert.", so graveklar.no shipped `<meta name="description" content="Alt inkludert.">` (14 characters) and the same string in the web manifest: no keywords, no place, nothing a search snippet can use | `src/lib/seo.ts` `buildSeoDescription()` | fixed — the tagline path requires ≥50 characters (`MIN_TAGLINE_CHARS`, next to the 160 cap) and otherwise falls through to the generated sentence (business name, service area, equipment). An explicit `seoDescription` is still used however short it is. `tests/lib/seo.test.ts` |
| W-8 | P4 | `/vilkar` cannot enter the back/forward cache: the document and the JSON it fetches are `Cache-Control: no-store` | Next dynamic rendering | accepted — every page reads live config; a `private, max-age=0` policy would need per-page opt-in and gains only bfcache on a two-page site |
| W-9 | — | `/admin/login` scores SEO 66 because it is not crawlable | `<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">` | intended — the admin surface is deliberately unindexed |
| W-10 | P3 | Home page performance on a throttled phone (idle-machine run): LCP 5.4 s on the hero image, TBT 2.25 s and TTI 6.6 s, of which 2.6 s is script evaluation of the single home-page chunk (71 KiB, 25 KiB never executed) — `src/app/HomePage.tsx` is one ~3 000-line client component, so every visitor parses the whole booking flow before the first tap; desktop scores 90+ | `src/app/HomePage.tsx`, hero `<Image>` priority/sizes | open — the fix is structural (split the booking flow out of the landing markup, lazy-load the calendar, picker and terms dialog; give the hero image `priority` and a tighter `sizes`), tracked for a performance round; accessibility, best-practices and SEO are 100 on every audited page |
