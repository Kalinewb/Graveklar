# Test audit, September 2026

Started 2026-09-06 on the request "plan a full test audit on everything, every single feature and
function". This file is the consolidated record; the per-phase evidence lives next to it in
`docs/audit/` and the harness rules in `docs/testing.md` and `tests/helpers/README.md`. Nothing
in this audit depends on conversational memory: every claim below is backed by a test in the
repo or a command listed in a phase document.

## Rules the audit ran under

- The live database (`prisma/prisma/db/custom.db`), `.env` and the production service on :3000
  were never touched. Every test runs on a per-worker scratch SQLite file under the scratchpad,
  and the harness refuses any other path.
- Browser-driven checks ran against an isolated `next dev` instance on :3001 backed by a
  neutralised copy of the database (mail off, `siteUrl` localhost, TOTP cleared and never
  enrolled). Stripe in test mode only, Vipps mocked, no card numbers ever typed.
- A confirmed defect is recorded as `it.fails(...)` with `// FINDING <id>` so the suite stays
  green; the fix flips it to `it(...)` with `// FIXED <id>`. Tests assert the *correct*
  behaviour, never the defect.
- Findings are graded P0 (money or security), P1 (a customer or the admin is blocked), P2
  (wrong result or wrong message), P3 (robustness, consistency), P4 (polish).
- Fixes landed as soon as a P0/P1 was confirmed (Phase 1.5), not at the end.

## Phases

| Phase | What | Evidence |
|---|---|---|
| −1 | Reality check of production: timers, topology, backups, keys, webhook subscriptions | `docs/audit/phase-minus-1.md` |
| 0 | Harness: scratch-DB isolation per worker, route caller, mocks for Stripe/Vipps/mail/geocoding/clock, finding convention | `docs/testing.md`, `tests/helpers/` |
| 1 | Domain and API: pricing/discounts (1a), booking/availability/delivery (1b), payments/cancellation (1c), auth/config/uploads (1d) | `docs/audit/phase1*.md` |
| 1.5 | Fix pass for every confirmed P0/P1 | commits listed in the phase docs |
| 2 | Customer flows in a browser (2a), admin panel in a browser (2b), mail/terms/checklist/cron (2c), B2B/reviews/survey/SEO (2d); browser findings recorded as `tests/e2e/*.e2e.test.ts` | `docs/audit/phase2*.md` |
| 3 | Database and time invariants: cascades, enum-like columns, DST, month and deadline boundaries | `docs/audit/phase3-db-time-invariants.md` |
| 3.5 | Fix pass for the remaining P2/P3 findings | this file, "Findings" |
| 4 | Production build in a scratch copy: headers, gating, secret leakage, burst behaviour, Lighthouse | `docs/audit/phase4-prod-build.md` |
| 5 | Coverage gates in CI, this consolidation, cleanup | `.github/workflows/ci.yml`, `vitest.config.ts` |

## Findings

121 findings were recorded across the phase documents, each with a test that asserts the
correct behaviour. Severity: 3 P0, 11 P1, 40 P2, 56 P3, 9 P4, 2 unclassified (a harness bug and
a deliberate design note). Status at the end of the audit:

| Status | Count | What it means |
|---|---|---|
| fixed | 113 | product or harness change landed, the finding's test now runs as a normal `it` |
| mitigated | 1 | F-4 / R-8: settling a Vipps payment from the return GET is throttled rather than restructured |
| deferred | 3 | U-5 (per-connection PRAGMAs — no Prisma hook), W-2 (Turbopack traces the upload directory read; hints did not help), W-5 (CSP nonce) |
| accepted | 1 | W-8 (no back/forward cache on dynamic pages) |
| intended | 1 | W-9 (admin login is unindexed on purpose) |
| open | 2 | W-4 (image bytes on the home page), W-10 (home-page mobile performance: one 3 000-line client component) — both performance polish for a later round |

The P0 and P1 items, all fixed in Phase 1.5 before Phase 2 started (Phase 1 ids; the rows in
`docs/audit/phase1*.md` carry the evidence and the fix):

- **E-3 (P0)** — a campaign code's `maxUses` was checked by a read and spent by an unconditional increment in a separate transaction, so two concurrent redemptions both succeeded. Now an atomic conditional spend.
- **F-51 / G-51 (P0)** — `updateBookingStatus` had no legal-transition table, so a cancelled booking could be walked back to confirmed by a late webhook, and cancelling a *completed* booking refunded 100 %. Now `pending→confirmed|cancelled`, `confirmed→cancelled|completed`, terminal states final.
- **H-5 (P1)** — every rate limiter keyed on a header the client chooses (`x-real-ip`). Now `CF-Connecting-IP`, else the last `X-Forwarded-For` hop, never `x-real-ip`; a renter cannot pick its own limit identity.
- **H-6 (P1)** — `GET /api/uploads/[filename]` authenticated nothing, so every stored file (including renter checklist photos) was public. Renter files are now gated to the admin session or the owning renter session; filenames carry 16 random hex bytes (H-7/H-8).
- **F-53 (P1)** — a Vipps payment was stored as a Stripe one; the confirm path now records the real provider and the confirm race returns null to the loser (F-52).
- **F-3 / F-5 / F-54 (P1)** — the Stripe cancel GET opened a new Checkout session and spent a retry (now redirect-only), the B2B offer route built Stripe redirect URLs from spoofable `X-Forwarded-Host`, and the expiry branch spent a retry before knowing it could build a retry link.
- **A-3 (P1)** — a per-machine day or weekend price override was ignored for custom rentals.
- **C-4 (P1)** — deleting blocked dates compared UTC midnight against rows written at Oslo midnight, so the delete matched nothing (and reported success, C-5).
- **H-4, I-1, I-5, H-1..H-3, I-2..I-4 (P2/P3, fixed in the same pass)** — password change without 2FA, the public config endpoint filtering on a stale DB column instead of the code's public list, the config cache handed out by reference, case-sensitive `x-forwarded-proto`, the bare `/api/admin` path falling through the proxy gate, and non-JSON bodies answered 500 instead of 400.
- **H-1 (harness)** — the per-worker scratch database was copied over an open Prisma client, taking a random test file down on every full run; rebuilt as `tests/helpers/db-prepare.ts`.
- **P-16 (P1, Phase 2b)** — the admin panel crashed to its error boundary on the next dialog after a month change during the initial load; `fetchData` now carries a generation number and an abort controller.

Every remaining P2/P3 was fixed in the Phase 3.5 pass (four agents on disjoint files, then a
single verification run of the merged tree), except the eight rows above that are deliberately
not fixed and say why.

## Test suite

Final verification run of the merged tree (commit `1e00228`, 2026-09-07):

| Suite | Files | Result |
|---|---|---|
| Unit, service, API and invariant tests (`npx vitest run`) | 94 run, 17 skipped without an instance | 1 788 passed, 1 expected failure (R-8), 98 skipped |
| Live probes against the isolated instance (`tests/live/`) | 2 | 38 passed |
| Browser e2e against the isolated instance (`tests/e2e/`) | 15 | 56 passed, 2 skipped (maintenance-mode flip is opt-in via `AUDIT_ALLOW_CONFIG_FLIP=1`) |
| `npm run typecheck`, `npm run lint` | — | clean |

The suite grew from 165 tests before the audit to 1 887 (plus 94 live and e2e). Every browser
finding from Phase 2 is a recorded script, so the whole audit re-runs without a person at the
keyboard.

Run everything locally:

```bash
npm run typecheck && npm run lint && npm test
```

Browser and live-instance suites are skipped unless `AUDIT_BASE_URL` (and `AUDIT_DB_FILE` for
the e2e files) point at an isolated instance; see `docs/testing.md` for the launch recipe.

## Coverage gates

Gate A (risk) is closed by the findings table: every P0 and P1 is fixed with a regression test,
and the four items deliberately left open are P3/P4 with a written reason. Gate B (coverage)
is enforced by `vitest.config.ts` and runs in CI on every push (`npm run test:coverage`).

| Scope | Measured 2026-09-07 | CI floor (ratchet) | Target |
|---|---|---|---|
| P0 set (booking state, payments, discounts, auth, uploads, rate-limit identity, pricing; 33 files) | branches 83.96 %, lines 92.92 % | branches 83 %, lines 92 % | branches ≥ 90 % |
| Everything under `src/lib`, `src/app/api/**/route.ts`, `src/proxy.ts` (140 files) | branches 78.46 %, lines 87.64 %, functions 86.81 %, statements 87.08 % | branches 78 %, lines 87 %, functions 86 %, statements 87 % | branches ≥ 80 % |

The floors are the measured values rounded down, so the suite cannot regress silently; the
targets are what the next round of work should raise them to. The weakest P0 files by branch
coverage are `src/lib/upload-store.ts` (30 %: the size/type refusals are tested, the
filesystem error paths are not), `src/lib/mva.ts` (45 %), the Stripe webhook route (67 %,
the event types the endpoint is not yet subscribed to — see R-5) and `src/lib/stripe.ts` (67 %).
Outside the P0 set, four admin routes (`bookings/[id]/contract`, `contract-signing`,
`timeline`, `mock-booking`) and `src/lib/mock-booking.ts` have no unit coverage at all — the
first three are exercised only through the admin e2e scripts, which do not count here — and
`src/lib/geocode.ts` is covered only through its mock. Those are the first candidates for the
next raise.

## Go-live checklist (owner actions, not code)

These came out of Phase −1 and Phase 4 and cannot be closed from the repository:

- **R-2 — test keys.** The live site runs Stripe test keys and Vipps `test`. Accepted as
  intentional pre-launch (2026-09-06). Before the first real booking: swap to live keys in the
  admin panel (the `stripe`/`vipps` groups are 2FA-gated), re-run the Stripe webhook test, and
  confirm the Vipps return URL.
- **R-4 — backups.** Install the backup timer: `deploy/systemd/user/README.md` has the two
  commands. Verify the first nightly file exists the next morning.
- **R-1b — cleanup timer anchoring.** The enabled cleanup timer is monotonic; run
  `systemctl --user start graveklar-cleanup.service` once, or install the
  `OnCalendar=*:0/10` unit from `deploy/systemd/user/`.
- **R-5 — Stripe webhook events.** Subscribe the endpoint to `charge.refunded`,
  `charge.dispute.created` and `payment_intent.payment_failed` in the Stripe dashboard.
- **R-7 — origin exposure.** Answered 2026-09-07: the chain is Cloudflare → nginx on the
  homelab → Next on :3000. The app keys every rate limit on `CF-Connecting-IP` and decides the
  admin cookie's `Secure` flag from `X-Forwarded-Proto`, so nginx has to guarantee both:
  1. Accept only Cloudflare. Either `allow` the published Cloudflare ranges
     (`https://www.cloudflare.com/ips-v4`, `/ips-v6`) and `deny all` in the server block, or
     turn on Authenticated Origin Pulls (Cloudflare's origin-pull CA with
     `ssl_verify_client on`). Without one of these, anyone who finds the origin address can
     send his own `CF-Connecting-IP` and rotate it past every limiter.
  2. Forward the scheme explicitly: `proxy_set_header X-Forwarded-Proto https;` (the site is
     HTTPS-only; do not pass through what the client sent). Keep Cloudflare's SSL mode at
     Full (strict) with an origin certificate on nginx, because on Flexible nginx's own
     `$scheme` is `http` and the cookie loses `Secure`.
  3. Pass `Host` and `X-Forwarded-Host` unchanged, keep `CF-Connecting-IP` untouched (nginx
     forwards it by default), append `X-Forwarded-For` with `$proxy_add_x_forwarded_for`,
     and set `client_max_body_size` at or above the app's upload cap so checklist photos are
     refused by the app's 413 path, not by nginx's HTML error page.
- **R-8 — Vipps return throttling.** Deferred: the return URL is throttled (10/15 min per
  identity) rather than restructured; revisit if Vipps support reports customers hitting it.
- **W-5 — CSP nonce.** `script-src 'unsafe-inline'` stays until Next's inline bootstrap gets
  a nonce; tracked, not blocking.
