# Testing

Vitest 4, `vitest.config.ts`, everything under `tests/`. Helper reference:
[`tests/helpers/README.md`](../tests/helpers/README.md).

## Layers

| Layer | What it proves | Where | Touches |
| --- | --- | --- | --- |
| **L0 — static** | Facts about the source text: wiring invariants, config shape, no forbidden pattern. Never executes the app. | `tests/` root (`harness.guard.test.ts`) | nothing |
| **L1 — unit** | Pure functions: pricing, discount math, dates, MVA, cancellation fees, token formats, validation. | `tests/lib/` | nothing |
| **L2 — route** | A real route handler called in-process through `call()`: status codes, auth gates, masking, request validation, error shapes. | `tests/api/` | scratch DB |
| **L3 — service** | Multi-step service behaviour end to end below HTTP: `createPendingBooking`, `updateBookingStatus`, the discount engine, the webhook confirm paths. | `tests/service/` | scratch DB |
| **L3i — invariants** | Properties that must hold across whole flows regardless of path: one lock per machine/date/slot, a single-use code redeemed at most once, quote total == charged total, no negative refund. | `tests/invariants/` | scratch DB |
| **L4 — e2e** | The running app over HTTP against the scratch instance on `:3001` — booking form to payment redirect, admin login, renter QR kiosk. | `tests/e2e/` | scratch instance |
| **L5 — non-functional** | Concurrency, rate limiting, SQLITE_BUSY behaviour, payload limits, timing-safety. | `tests/e2e/` or `tests/service/`, named `*.nonfunctional.test.ts` | scratch DB / instance |

Directories are created as each layer gets its first test; `tests/lib/` and the
two harness files at the `tests/` root exist today.

## Isolation rules

These are not conventions, they are enforced.

- **Scratch database per worker.** `tests/setup.ts` sets `DATABASE_URL` to
  `<os.tmpdir()>/graveklar-test-db/worker-<VITEST_POOL_ID|pid>.db` before any
  module is imported, so no PrismaClient can be constructed against anything
  else. Override the directory with `GRAVEKLAR_TEST_DB_DIR`.
- **The guard.** `assertScratchDatabase()` throws unless the resolved file is
  inside that scratch directory, and refuses outright if it is inside the
  repository, is `prisma/prisma/db/custom.db`, or matches `DATABASE_URL` in
  `.env` (read for comparison only, never written).
- **`DATABASE_URL` is the only switch.** `src/lib/db.ts` is the single
  PrismaClient construction site under `src/` and passes no `datasources` /
  `datasourceUrl` override. `tests/harness.guard.test.ts` fails if that changes.
- **The live database is never opened.** Not by a test, not by a helper, not by
  `prisma db push` — the schema push runs with `cwd` and `--schema` inside the
  scratch directory so the Prisma CLI cannot pick up the repo's `.env`.
- **2FA is never enrolled.** No test writes `AdminTotp`. Admin endpoints are
  reached with a real session cookie from `adminCookie()`; the 2FA-gated saves
  are asserted on their *refusal* path (`requiresTotpEnrollment`), or by seeding
  an `AdminTotp` row inside a single test that also deletes it.
- **Stripe: test mode only, and offline.** No network call. Webhook tests sign
  payloads with `signedEvent()` (Stripe's real HMAC scheme) against a
  `stripeWebhookSecret` seeded into `AppConfig`; client calls use `mockStripe()`.
- **Vipps: never live.** `mockVipps()` replaces the six HTTP functions and keeps
  the pure ones real. No token is ever fetched.
- **No email.** `mockEmail()` replaces every sender with a recorder; nodemailer
  is never constructed.
- **No outbound HTTP.** `stubRoutingFetch()` answers Nominatim and OSRM and
  throws on any other URL.
- **Clock.** `TZ=Europe/Oslo` is pinned in setup; `mockClock()` freezes time
  (only `Date` is faked, so Prisma's backoff still runs).

## Running

```bash
npm test                    # everything
npm run test:watch          # watch mode
npm run test:coverage       # vitest run --coverage (v8, src/lib/**, db.ts excluded)
npm run typecheck           # tests are inside tsconfig's include
npm run lint

npx vitest run tests/lib                       # L1
npx vitest run tests/api                       # L2
npx vitest run tests/service tests/invariants   # L3 + L3i
npx vitest run tests/e2e                       # L4/L5 — needs the :3001 instance
npx vitest run tests/harness.guard.test.ts     # L0

# two workers, to prove they do not collide on the scratch DB
npx vitest run --pool=forks --maxWorkers=2   # vitest 4 dropped --poolOptions
```

Never run `npm run build`, `next build`, `next dev` or `next start` from this
directory as part of a test run: production serves `next start` from here on
`:3000` as the `graveklar.service` user unit, and rebuilding swaps the chunk
hashes out from under live customers.

`jsdom` is **not** installed, so there are no `.tsx` component tests yet. The
config already includes `tests/**/*.test.tsx`; a component test would need
`npm i -D jsdom @testing-library/react` and a per-file
`// @vitest-environment jsdom`.

## Scratch instance on :3001 (L4/L5)

A throwaway copy of production, on a port nothing else uses, with every
outbound channel neutralised. The live database is only ever *read*, through
SQLite's own backup API.

```bash
SCRATCH=/tmp/claude-1000/-home-deller-Documents-graveklar/<session>/scratchpad/testdb

# 1. Consistent copy of the live DB (read-only on the source; never cp a live SQLite file)
sqlite3 /home/deller/Documents/graveklar/prisma/prisma/db/custom.db ".backup $SCRATCH/audit.db"

# 2. Neutralise the copy — no mail, no production URL, no inherited 2FA,
#    and a known admin password hash (or none, to use the ADMIN_PASSWORD fallback)
sqlite3 "$SCRATCH/audit.db" "
  UPDATE AppConfig SET value='' WHERE key LIKE 'smtp%';
  UPDATE AppConfig SET value='http://localhost:3001' WHERE key='siteUrl';
  DELETE FROM AppConfig WHERE key='adminPasswordHash';
  DELETE FROM AdminTotp;
"
```

Then start it with the `graveklar-audit` launch configuration in
`.claude/launch.json`, which runs `next dev -p 3001 -H 127.0.0.1` with
`DATABASE_URL` pointed at `audit.db`, `ADMIN_PASSWORD='Testadmin-2026!'`,
throwaway `ADMIN_SESSION_SECRET`/`CRON_SECRET`, and `TZ=Europe/Oslo`.

Rules for the instance: bind `127.0.0.1` only, port 3001 only, keep TOTP
un-enrolled for the whole run (the 2FA-gated saves are exercised on their
refusal path), leave Stripe on `sk_test_…` and Vipps on `vippsEnvironment=test`,
and delete `audit.db` when the run is over. It is a copy — nothing done to it
can reach production — but it still holds real customer rows, so it does not
leave the scratch directory.

## Production build check (Phase 4)

Never run `next build` in the checkout: production serves `.next` from this directory and a
rebuild under a running `next start` breaks the chunks customers already hold. Build a snapshot
elsewhere instead:

```bash
B=~/.cache/graveklar-buildcheck; rm -rf "$B"; mkdir -p "$B"
git archive HEAD | tar -x -C "$B"
cp -al node_modules "$B/node_modules"; rm -rf "$B/node_modules/.cache"; mkdir "$B/node_modules/.cache"
sqlite3 <scratch-audit-db> ".backup '<scratch-dir>/buildcheck.db'"     # never the live db
printf 'DATABASE_URL="file:<scratch-dir>/buildcheck.db"\nADMIN_PASSWORD=Testadmin-2026!\nADMIN_SESSION_SECRET=x\nCRON_SECRET=y\n' > "$B/.env"
(cd "$B" && NODE_ENV=production npx next build && npx next start -p 3003 -H 127.0.0.1)
```

`node_modules` is hard-linked, so nothing under it may be regenerated from the snapshot (no
`prisma generate` there — the client is shared with the checkout). Checks that ran against
:3003 in September 2026, all scripted in `docs/audit/phase4-prod-build.md`: response headers,
proxy gating, secret values and secret key names absent from every public response and every
client chunk, limiter behaviour under a burst, GET callbacks free of side effects, Lighthouse
(`npm i lighthouse` in a cache directory, `CHROME_PATH=/usr/bin/chromium`). Lighthouse
performance numbers are only meaningful on an idle machine; accessibility, best-practice and
SEO audits are load-independent. Stop the server with `fuser -k 3003/tcp` and delete the
snapshot afterwards.

## Coverage gate (Gate B)

`npm run test:coverage` enforces the thresholds in `vitest.config.ts`: a global floor and a
stricter one for the P0 set (booking state, payments, discounts, auth, uploads, rate-limit
identity, pricing). They are ratchets: each is the measured value on 2026-09-07 rounded down,
so removing tests or adding untested branches fails CI. Raise a floor when a measured value
passes it; lower one only with a note in `docs/test-audit-2026-09.md`. The `json-summary`
reporter writes `coverage/coverage-summary.json`, which is what a per-file review reads.
