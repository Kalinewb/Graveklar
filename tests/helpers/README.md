# Test helpers

Everything a DB- or route-touching test needs. Import paths below assume a test
in `tests/` (`./helpers/…`); from `tests/api/` etc. use `../helpers/…`.

`tests/setup.ts` runs first in every worker and is what makes all of this safe —
see [docs/testing.md](../../docs/testing.md#isolation-rules).

---

## `tests/setup.ts`

Runs before any test module is imported. Points `DATABASE_URL` at
`<os.tmpdir()>/graveklar-test-db/worker-<VITEST_POOL_ID|pid>.db`, stubs the test
secrets, pins `TZ=Europe/Oslo`, sets `GRAVEKLAR_TEST_DB=1`, and **throws** if the
resolved database file is not inside the scratch directory, is inside the
repository, is `prisma/prisma/db/custom.db`, or matches `DATABASE_URL` in `.env`.

| Export | What it is |
| --- | --- |
| `REPO_ROOT`, `LIVE_DB_FILE` | Absolute paths. |
| `TEST_DB_DIR`, `TEST_DB_FILE`, `TEST_DB_URL`, `WORKER_KEY` | This worker's scratch database. |
| `prismaUrlToPath(url)` | `file:…` → absolute path (relative URLs resolve against `prisma/`). |
| `envFileDatabaseUrl()` | Reads `DATABASE_URL` out of `.env`. Read-only. |
| `assertScratchDatabase(url)` | The guard itself. Call it before opening any new database. |

Override the scratch root with `GRAVEKLAR_TEST_DB_DIR` — it is still guarded.

---

## `helpers/db.ts`

```ts
import { beforeAll, beforeEach } from 'vitest';
import { booking, db, ensureSchema, machine, resetDb, seedConfigDefaults } from './helpers/db';

beforeAll(() => ensureSchema());
beforeEach(() => resetDb());
```

### Schema and lifecycle

| Helper | Notes |
| --- | --- |
| `ensureSchema()` | Runs `prisma db push --skip-generate --accept-data-loss` **once per schema revision per machine** into a template file, then copies the template over this worker's database. The push runs with `cwd` and `--schema` inside the scratch directory so the Prisma CLI cannot see the repo's `.env`. Idempotent and cheap after the first call. |
| `resetDb(client?)` | Empties every table in FK-safe order (`TRUNCATE_ORDER`) and invalidates the config caches. Raw `DELETE` on a scratch database is deliberate. |
| `invalidateCaches()` | `invalidateAppConfigCache()` + `invalidateConfigCache()`. Every seeder calls it; call it yourself after writing `AppConfig`/`PricingConfig` by hand. |
| `TRUNCATE_ORDER` | The table order. A smoke test fails if a new model is missing from it. |
| `db` | Re-exported app singleton (`@/lib/db`) — the same client the routes use. |

### Isolated clients

```ts
const a = await freshDb();
try { await a.client.machine.create({ data: { name: 'A', model: 'A' } }); }
finally { await a.dispose(); }
```

| Helper | Notes |
| --- | --- |
| `freshDb()` | `{ client, file, url, dispose() }` — a PrismaClient on a brand-new file. Two of them are fully independent. For concurrency tests that must not see each other. |
| `sharedDbClient()` | A second client on **this worker's** file, for genuine write-lock contention. |

### Seeders and factories

| Helper | Default |
| --- | --- |
| `seedPricingDefaults()` | `DEFAULT_CONFIGS` from `src/lib/config-defaults.ts` → `PricingConfig`. |
| `seedAppConfigDefaults(overrides?)` | `APP_CONFIG_DEFAULTS` → `AppConfig`, minus the non-column `hint` field. `overrides` is `key → value`; unknown keys are inserted as plain text rows. |
| `seedConfigDefaults(overrides?)` | Both of the above. The usual precondition for a route test. |
| `machine(overrides?)` | Active minigraver, `quantity: 1`. |
| `booking(status?, overrides?)` | Valid `Booking` **plus its `BookingDateLock` rows**, exactly like `createPendingBooking`. `startDateStr: 'YYYY-MM-DD'` is stored as Oslo local midnight via `dateToDbMidnight`; `skipLocks: true` opts out of the locks. Creates/reuses a machine when `machineId` is omitted. |
| `campaignCode(overrides?)` | Active, 10 %, unlimited uses. |
| `repeatCode(overrides?)` | Unredeemed, bound to `test@example.com`. |
| `checklistPhase(overrides?)` | Operator phase + two items (`items: [...]` to control them). Returns the phase with `items` included. |
| `unavailableDate('2026-10-02', reason?)` | One blocked day at local midnight. |
| `bookingReference()`, `tomorrowStr()` | Same shape/semantics as the product's. |

Every date goes through Prisma (stored as an integer), never through the
`sqlite3` CLI.

---

## `helpers/route.ts`

```ts
import { adminCookieJar, call, proxyCall } from './helpers/route';

const { POST } = await import('@/app/api/quote/route');
const res = await call(POST, {
  method: 'POST',
  path: '/api/quote',
  body: { rentalType: 'week', startDate: '2026-10-05', selfPickup: true },
});
expect(res.status).toBe(200);
expect(res.json.totalPrice).toBeGreaterThan(0);
```

| Helper | Notes |
| --- | --- |
| `call(handler, opts)` | Builds a `NextRequest` at `http://localhost:3001<path>` and invokes the handler with `{ params: Promise.resolve(params) }` (Next 16 hands params over as a Promise). Returns `{ status, json, text, headers, response }`; `json` is `null` for empty/non-JSON bodies. |
| `buildRequest(opts)` | The `NextRequest` on its own, when you want to call something else with it. |
| `opts.body` | Object → JSON + `content-type: application/json`. String → raw. `FormData` → multipart (boundary set by fetch). Ignored for GET/HEAD. |
| `opts.cookies` / `opts.headers` / `opts.searchParams` / `opts.params` | Plain records. Cookies are merged into the `cookie` header. |
| `adminSessionToken()` / `adminCookie()` / `adminCookieJar()` | A **real** HMAC session from `@/lib/admin-auth` `createSessionToken()`: raw token / `"graveklar_admin_session=…"` / `{ [COOKIE_NAME]: token }`. |
| `renterBearer(bookingId, phone)` | `"Bearer …"` from `@/lib/renter-checklist-session`. |
| `totpHeader(code)` | `{ 'x-admin-totp': code }`. Never enrols anything. |
| `cronBearer()` | `"Bearer $CRON_SECRET"`. |
| `proxyCall(path, opts)` | Invokes `proxy()` from `src/proxy.ts` directly and returns the `NextResponse`, so a test can assert the 401 / redirect before any handler runs. A pass-through is `NextResponse.next()`: status 200 with `x-middleware-next: 1`. |
| `matcherMatches(pathname)` / `matcherToRegExp(pattern)` / `PROXY_MATCHER` | Whether Next would run the proxy at all. |

### Caveat on `matcherMatches`

`config.matcher` in `src/proxy.ts` is data; Next compiles it with
path-to-regexp. `matcherToRegExp` reimplements the subset the app actually uses
— literal segments plus `/:name`, `/:name?`, `/:name+`, `/:name*` — which is
exact for all seven current patterns. It is **not** general path-to-regexp: a
matcher with a custom regex group (`/:path(\\d+)`), a `has`/`missing` object
form, or a parameter that is not a whole segment would need this helper
revisited. Assert on the current patterns, not on hypothetical ones.

---

## `helpers/mocks.ts`

**Nothing in this file calls `vi.mock`.** Vitest hoists every `vi.mock` to the
top of the module it appears in, so a `vi.mock` hidden inside a helper would
silently mock Stripe/email/Vipps for *every* test file that imports the helper.
Each factory returns a replacement module shape and the test file registers it:

```ts
vi.mock('@/lib/email', async () => (await import('./helpers/mocks')).mockEmail());
vi.mock('stripe', async () => (await import('./helpers/mocks')).mockStripe());
vi.mock('@/lib/vipps', async (orig) =>
  (await import('./helpers/mocks')).mockVipps((await orig()) as Record<string, unknown>));
vi.mock('@/lib/geocode', async (orig) =>
  (await import('./helpers/mocks')).mockGeocode((await orig()) as Record<string, unknown>));

import { emailMock, stripeMock, vippsMock } from './helpers/mocks';
beforeEach(() => { emailMock.reset(); stripeMock.reset(); vippsMock.reset(); });
```

The dynamic `import()` inside the factory is what makes the hoisting safe — a
top-level binding would still be in its temporal dead zone. The recorders are
module singletons, so the factory and the test file share them.

| Helper | Notes |
| --- | --- |
| `mockEmail()` | Replaces all 13 senders in `@/lib/email` with recording stubs. `emailMock.sent` is `[{ fn, args }]` in order; `emailMock.by('sendBookingStatusEmail')` filters; `emailMock.reset()` clears. Nodemailer is never constructed. |
| `mockStripe()` | Replaces the `stripe` package: `checkout.sessions.create/retrieve/expire`, `paymentIntents.retrieve`, `charges.retrieve/list`, `refunds.create`, `webhooks.constructEvent`, plus `Stripe.errors`. `stripeMock.responses.*` controls return values, `stripeMock.calls` / `by(method)` record. `constructEvent` performs the same HMAC check as the real library — a mocked test still cannot pass an unsigned payload. |
| `signedEvent(payload, secret, t?)` | The `stripe-signature` header value: `t=<unix>,v1=<HMAC-SHA256 of "t.payload">`. This is Stripe's real scheme, so `verifyStripeWebhook` works **unmocked** against a `stripeWebhookSecret` seeded into `AppConfig`. Prefer that over mocking the package. |
| `stripeEventPayload(type, object, id?)` | A minimal JSON event envelope to sign. |
| `mockVipps(actual)` | Stubs only the six HTTP functions (`getAccessToken`, `createPayment`, `getPayment`, `capturePayment`, `cancelPayment`, `refundPayment`). Everything pure stays real. `vippsMock.responses[fn]` may be a value or a function of the call arguments. |
| `mockGeocode(actual)` | `geocodeAddress` returns `geocodeMock.fixture`; `normalizeAddress` stays real. |
| `stubRoutingFetch(fixture?)` | Stubs the **global fetch** that `/api/delivery` uses for Nominatim and OSRM (that route does not import `@/lib/geocode`). Returns `{ state, restore() }`; any other URL throws, so no test can quietly reach the network. Uses `vi.stubGlobal`, so it is safe in `beforeEach`. |
| `mockClock(iso, toFake?)` | `vi.useFakeTimers` + `vi.setSystemTime` with `TZ=Europe/Oslo`. Only `Date` is faked by default — faking `setTimeout` too would stall Prisma's SQLITE_BUSY backoff. Returns `{ now, set, advance, restore }`. |
