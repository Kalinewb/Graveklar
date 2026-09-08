# Phase 1d — auth, sessions, 2FA, rate limits, uploads, proxy boundary (area H); app config, pricing config, machines (area I)

Scope: `src/lib/admin-auth.ts`, `src/lib/totp.ts`, `src/lib/rate-limit.ts`,
`src/lib/renter-checklist-session.ts`, `src/lib/const-time.ts`,
`src/lib/machine-pricing-guard.ts`, `src/lib/app-config.ts`, `src/proxy.ts`,
and the routes `POST /api/admin/login|logout|change-password|reset`,
`GET /api/admin/totp/status`, `GET|DELETE /api/admin/totp/setup`,
`POST /api/admin/totp/verify`, `GET /api/admin/audit-log`,
`POST /api/admin/upload`, `POST /api/checklist/upload`,
`GET /api/uploads/[filename]`, `GET /api/app-config`,
`GET|POST /api/admin/app-config`, `POST /api/admin/app-config/test-email`,
`GET|POST /api/admin/machines`, `PATCH|DELETE /api/admin/machines/[id]`.

299 tests across 14 files: 261 in-process (248 passing, **13 `it.fails`**) and
38 live probes that skip without `AUDIT_BASE_URL` (37 passing, **1 `it.fails`**
— the live half of H-5). Each `it.fails` asserted the behaviour the
product *should* have and carried its finding id in a comment beside it, so the
fix phase flips `it.fails` back to `it`. Where a defect was more legible as a
recording than as a refusal, a second passing test right next to it pinned what
the code did.

**Status: all thirteen findings are fixed** — every `it.fails` here is now a
passing `FIXED <id>` test, and the file count is 16 — two new files:
`tests/lib/client-ip.test.ts` and `tests/api/admin-route-gating.test.ts`. See
*Fix phase — what changed* at the end, and **R-7** for the one control that is
operational rather than code.

| File | Tests |
| --- | --- |
| `tests/lib/admin-auth-session.test.ts` | 31 (1 `it.fails`) |
| `tests/lib/totp.test.ts` | 12 |
| `tests/lib/rate-limit.test.ts` | 12 |
| `tests/lib/renter-session.test.ts` | 10 |
| `tests/lib/const-time.test.ts` | 6 |
| `tests/lib/machine-pricing-guard.test.ts` | 13 |
| `tests/api/proxy-boundary.test.ts` | 37 (1) |
| `tests/api/admin-auth-routes.test.ts` | 48 (3) |
| `tests/api/uploads.test.ts` | 28 (3) |
| `tests/api/app-config.test.ts` | 28 (3) |
| `tests/api/admin-machines.test.ts` | 23 (1) |
| `tests/service/app-config-load.test.ts` | 13 (1) |
| `tests/live/proxy-matcher-probes.test.ts` | 32 — live only |
| `tests/live/rate-limit-identity.test.ts` | 6 (1) — live only |

New helper, owned by this phase: `tests/helpers/auth.ts` — a forger's toolkit
(hand-sign an admin or renter payload with any expiry, tamper a signature,
rotate the secret) plus `seedTotpSecret()` / `totpCodeFor()`. **No test in this
phase enrols 2FA.** The "enrolled" state is an `AdminTotp` row written straight
into the per-worker scratch database, and codes come from otplib in isolation;
`POST /api/admin/totp/verify`'s successful enrollment branch is deliberately
exercised only up to its last refusal.

Live probes ran once against the neutralised audit instance on
`http://localhost:3001`:

```
AUDIT_BASE_URL=http://localhost:3001 npx vitest run tests/live
  tests/live/proxy-matcher-probes.test.ts   32 passed
  tests/live/rate-limit-identity.test.ts     5 passed | 1 expected fail
```

---

## Findings

| id | sev | title | src | demonstrated by | status |
| --- | --- | --- | --- | --- | --- |
| H-5 | P1 | **The rate-limit identity is a request header the client chooses.** Every limited route keys on `x-real-ip \|\| x-forwarded-for[0] \|\| 'unknown'`. Next never sets `x-real-ip`, and supplies `x-forwarded-for` only when the client omits it — it does not overwrite a client-supplied value, and this deployment has no reverse proxy in front. An attacker varies one header per request and the 10-attempts-per-15-minutes login budget never engages, leaving the admin password open to unthrottled online guessing. The same six lines are copy-pasted into `/api/bookings`, `/api/quote`, `/api/delivery`, `/api/address-suggest`, `/api/check-discount-eligibility`, `/api/payment/*/create`, `/api/booking/cancel`, both upload routes, `/api/admin/change-password`, `/api/admin/totp/verify` and `/api/admin/reset`. Correct behaviour: key on something the client cannot set — the socket peer, or `CF-Connecting-IP` / the last (proxy-appended) `X-Forwarded-For` hop once a trusted proxy really is in front | `src/app/api/admin/login/route.ts:19-25` and 12 further copies | `tests/api/admin-auth-routes.test.ts` → “FINDING H-5: rotating x-real-ip does not defeat the login budget”; `tests/live/rate-limit-identity.test.ts` → “FINDING H-5: a rotating X-Real-IP does not defeat the quote budget” | fixed — one `clientIdentity()` helper (`src/lib/client-ip.ts`): `CF-Connecting-IP`, else the LAST `X-Forwarded-For` hop, else `unknown`; `x-real-ip` is never read. Wired into 15 of the 17 limited routes (see R-7 and the follow-ups below) |
| H-6 | P1 | **`GET /api/uploads/[filename]` authenticates nothing.** The path is outside the proxy matcher and the handler checks no session, so every stored file — renter checklist damage photos tied to a named, addressed customer, equipment manuals, anything an admin dropped into the settings form — is served in full to any anonymous caller who can name it. Correct behaviour: a renter file is readable only through that renter's session (or a signed, expiring URL), an admin upload only with an admin session | `src/app/api/uploads/[filename]/route.ts:24-48`; matcher gap at `src/proxy.ts:50-59` | `tests/api/uploads.test.ts` → “FINDING H-6: refuses a renter upload to a caller with no session”, plus the paired recording test that reads a renter photo back byte-for-byte with no credentials | fixed — `GET /api/uploads/[filename]` now gates every `renter-` name in the handler (the path is outside the proxy matcher): admin session cookie, or the renter bearer token whose bookingId matches the one in the filename (401 unauthenticated, 403 wrong booking). `upload-` files stay public by design |
| H-7 | P2 | **Stored filenames are a millisecond timestamp.** `upload-<Date.now()>.<ext>` / `renter-<Date.now()>.<ext>` is the only thing protecting an unauthenticated file. Knowing one name yields its neighbours for free, and a whole day is 86.4 M candidates against an endpoint with no rate limit and no auth. This is what turns H-6 from "needs the exact URL" into "enumerable". Correct behaviour: a random, unguessable suffix, on top of the access control in H-6 | `src/app/api/admin/upload/route.ts:49`, `src/app/api/checklist/upload/route.ts:58` | `tests/api/uploads.test.ts` → “FINDING H-7: stored names are not derived from a guessable timestamp” | fixed — both writers name files `upload-<16 hex>` / `renter-<bookingId>-<16 hex>` from `crypto.randomBytes` (`src/lib/upload-store.ts`) |
| H-4 | P2 | **Changing the admin password needs no second factor, even with 2FA enrolled.** Every other credential-level operation demands one — removing the TOTP secret wants code *and* password, `/api/admin/reset` wants code *and* the confirmation string — so a stolen session cannot disable 2FA, but it can set a new password and lock the real admin out of their own account. Correct behaviour: require a valid `x-admin-totp` here too whenever a secret is enrolled | `src/app/api/admin/change-password/route.ts:13-54` (no `requireTotp`) | `tests/api/admin-auth-routes.test.ts` → “FINDING H-4: refuses a password change without a TOTP code when 2FA is enrolled” | fixed — `POST /api/admin/change-password` runs `requireTotp()` on the same terms as `DELETE /api/admin/totp/setup`; `not-enrolled` still passes so the first-login forced change is untouched |
| I-1 | P2 | **The anonymous `GET /api/app-config` filters on the DB row's `isPublic` column, not on the code's public list.** `loadAppConfig()` never re-syncs metadata onto existing rows — it inserts missing keys and deletes undeclared ones, nothing else — so a row whose flag was `true` under an older `APP_CONFIG_DEFAULTS`, or was written by any other path, keeps publishing its value to the world for ever. The fail-closed helper that fixes this (`publicAppConfig()`) already exists and is used everywhere else; this one route does not call it | `src/app/api/app-config/route.ts:9` (`where: { isPublic: true }`) vs `src/lib/app-config.ts:126` | `tests/api/app-config.test.ts` → “FINDING I-1: a DB row with isPublic=true cannot publish a secret key”, plus the recording test that shows `publicAppConfig()` dropping the same key | fixed — `GET /api/app-config` now returns `publicAppConfig(await loadAppConfig())`; the DB `isPublic` column no longer decides anything |
| I-5 | P2 | **`loadAppConfig()` hands out the cached object itself, not a copy.** A caller that writes into the returned map rewrites the cache for every other reader in the process until the 2-second TTL expires. `src/app/page.tsx:135` does exactly that (`appConfig['bookingCount'] = String(completedCount)`), so a homepage render leaks its derived value into whatever the admin API, the terms renderer or a PDF read next — intermittently, which is the worst kind. Correct behaviour: return a copy (or a frozen map) | `src/lib/app-config.ts:105-106` | `tests/service/app-config-load.test.ts` → “FINDING I-5: a caller mutating the returned map cannot poison the cache”, plus the recording test showing the value surviving into the next read and vanishing after the TTL | fixed — `loadAppConfig()` returns a copy on both the cache-hit and the miss path, and `src/app/page.tsx` builds a derived `pageConfig` instead of writing into the loader’s map |
| H-1 | P3 | `isSecureRequest` compares `x-forwarded-proto` case-sensitively. A terminating proxy that emits `HTTPS` (the value is an opaque token; appliances do upper-case it) makes the function return `false`, and the admin session cookie is issued **without `Secure`** on a genuinely HTTPS-terminated site — the exact failure the function exists to prevent. Correct behaviour: compare case-insensitively | `src/lib/admin-auth.ts:193` | `tests/lib/admin-auth-session.test.ts` → “FINDING H-1: treats `x-forwarded-proto: HTTPS` as secure” | fixed — the `x-forwarded-proto` comparison lower-cases the token before matching |
| H-2 | P3 | The bare path `/api/admin` is inside the proxy matcher, so `proxy()` runs — but every branch tests `startsWith('/api/admin/')`, so the request falls through to `NextResponse.next()` and is served with no session. There is no handler at that exact path today (it answers 404, not 401 — proof the refusal comes from the router, not the gate), so nothing leaks yet; the moment someone adds `src/app/api/admin/route.ts` it is public. Correct behaviour: the bare collection path is admin-only too | `src/proxy.ts:34` | `tests/api/proxy-boundary.test.ts` → “FINDING H-2: refuses GET /api/admin without a session”; live confirmation in `tests/live/proxy-matcher-probes.test.ts` | fixed — the proxy branch reads `pathname === '/api/admin' \|\| pathname.startsWith('/api/admin/')`, and `tests/api/admin-route-gating.test.ts` now walks the route tree so the matcher cannot drift again |
| H-3 | P3 | A request body that is not JSON is answered `500 "Innlogging feilet"`. `await request.json()` throws inside the `try` and the catch-all maps every failure to a server error, so a client mistake is indistinguishable from a real outage in the logs and in monitoring. Correct behaviour: 400 | `src/app/api/admin/login/route.ts:36` + `:112` | `tests/api/admin-auth-routes.test.ts` → “FINDING H-3: answers 400 for a body that is not JSON” | fixed — the login body is parsed in its own try/catch that answers 400 |
| H-8 | P3 | Two uploads inside the same millisecond produce the same filename and the second silently overwrites the first — `writeFile` with no existence check. The first uploader's URL then serves someone else's file, and the original bytes are gone. Correct behaviour: names unique regardless of timing (subsumed by the random suffix in H-7) | `src/app/api/admin/upload/route.ts:49-52`, `src/app/api/checklist/upload/route.ts:58-61` | `tests/api/uploads.test.ts` → “FINDING H-8: a same-millisecond second upload does not overwrite the first”, plus the recording test showing the stored bytes replaced | fixed — files are created with the `wx` flag under a random name, so a second write can neither collide nor overwrite |
| I-2 | P3 | The password mask is a sentinel with no escape hatch. The write loop skips **any** update whose value equals `PASSWORD_MASK`, not just those on a password-type key, so saving a text field whose content happens to be `●●●●●●` is silently discarded while the request still answers 200. Correct behaviour: only treat the sentinel specially for `password`/`hidden` types | `src/app/api/admin/app-config/route.ts:95` | `tests/api/app-config.test.ts` → “FINDING I-2: saves a text field whose value equals the password mask” | fixed — the mask sentinel is honoured only for `password`/`hidden` keys (`isMaskedEcho()`), on the write loop, the sensitive-key gate and the audit log alike |
| I-3 | P3 | Same shape as H-3 on the settings route: a body that is not JSON is answered `500 "Lagring feilet"`, so the admin UI cannot tell "your browser sent nonsense" from "the database is down". Correct behaviour: 400 | `src/app/api/admin/app-config/route.ts:38` + `:176` | `tests/api/app-config.test.ts` → “FINDING I-3: answers 400 for a body that is not JSON” | fixed — the settings body is parsed before the catch-all and an unparseable one is a 400 |
| I-4 | P3 | A wrong-typed field on machine create is a 500, not a 400. `body.name?.trim()` (and the same for `category`/`model`/`year`/`description`/`imageUrl`) has no type check, so a JSON number where the UI sends a string throws a `TypeError` into the catch-all. `PATCH` has the same gap one layer down, at Prisma. Correct behaviour: 400 naming the offending field | `src/app/api/admin/machines/route.ts:38-43` | `tests/api/admin-machines.test.ts` → “FINDING I-4: answers 400 when a string field arrives as a number”, plus the recording test asserting nothing is written | fixed — both create and PATCH refuse a non-string `name`/`category`/`model`/`year`/`description`/`imageUrl` with a 400 naming the field (`src/lib/machine-input.ts`), and a non-object body with 400 |

---

## R-7 — ops requirement: the origin must accept only Cloudflare traffic

**This is a deployment control, not a code one, and finding H-5 is only half
closed without it.**

`clientIdentity()` (`src/lib/client-ip.ts`) keys every rate limit on
`CF-Connecting-IP` when present, else the LAST `X-Forwarded-For` hop. Behind
Cloudflare that is exactly right: the edge sets `CF-Connecting-IP` itself and
replaces whatever the client sent, and it appends the connecting IP to a
client-supplied `X-Forwarded-For` rather than trusting the head of the list.
(`X-Real-IP` is passed through from the client untouched, which is why nothing
reads it any more.)

On a **directly exposed** origin the residual hole stays open: Next passes a
client-supplied `X-Forwarded-For` through untouched, so a client can still
append a hop of its choosing and rotate it, and no header a handler can read
tells that apart from a real proxy hop. The live probe
`records that a rotating X-Forwarded-For still bypasses a directly exposed
origin` pins that shape deliberately, so nobody mistakes it for a code defect.

What closes it:

- restrict the origin to Cloudflare's published IP ranges (firewall/nftables,
  or the host's own allow-list), **or** front it with `cloudflared` so the only
  inbound path is the tunnel; and
- once that holds, `CF-Connecting-IP` is authoritative and a forged forwarded
  chain buys nothing.

Until then, every per-IP budget in the app is advisory against a determined
attacker — better than before (a rotating `X-Real-IP` no longer works, and a
header-less client is now correctly bucketed by socket peer), but not a
boundary. Worth a line in the deployment checklist.

---

**Owner answer, 2026-09-07:** :3000 is reached through an nginx reverse proxy on the
homelab, behind Cloudflare. That makes the control concrete: nginx must accept only
Cloudflare (IP allow-list or Authenticated Origin Pulls) and forward
`X-Forwarded-Proto https` explicitly. The exact server-block requirements are in the go-live
checklist of `docs/test-audit-2026-09.md`.

## F-13 — the security model of the un-rechecked admin routes

**Verdict: sound as it stands, and structurally fragile.**

Only seven admin routes call `isAdminAuthenticated()` themselves (audit-log,
discount-codes, quote-requests, reviews, survey, checklist-submissions,
contract-signing). Every other `/api/admin/*` handler — app-config, machines,
upload, reset, totp/*, change-password, bookings/[id]/* — has no session check
in its own body and is protected solely by `src/proxy.ts` refusing the request
before Next dispatches to it.

That is safe because a route handler in the App Router is reachable **only**
through Next's router, and the router runs the proxy first for every path the
matcher selects. There is no second entry point: no direct file serving, no
alternate rewrite, and (per `tests/harness.guard.test.ts`) no second
PrismaClient or side-channel. The proxy's own decision table is exhaustive —
`src/proxy.ts` measures **100 % statements, branches and functions** under
`tests/api/proxy-boundary.test.ts` alone.

So the whole model rests on one thing: *the matcher selecting every path that
reaches an admin handler.* That is a text list in a config object, and it is
not derived from the route tree — nothing fails if the two drift apart. The
live probes exist to attack precisely that seam. Twenty-three spellings of
`/api/admin/app-config` were sent down a raw socket, bypassing every
normalisation a `fetch()` or a synthetic `NextRequest` would apply:

| spelling class | probes | result |
| --- | --- | --- |
| canonical, query string, fragment, `;` param, trailing `%20` | 5 | 401 |
| trailing slash, doubled slash (`/api//admin/…`, `/api/admin//…`) | 3 | 308 → canonical → 401 |
| raw `..` and `.` segments (`/api/admin/../admin/app-config`, `/x/../api/admin/…`) | 4 | 401 |
| case variants (`/API/ADMIN/…`, `/Api/Admin/…`) | 2 | 404 |
| percent-encoded letters (`%61dmin`, `%61pp-config`, `%2561dmin`) | 3 | 404 |
| Unicode homoglyphs (Cyrillic `а`, fraction slash, fullwidth hyphen) | 3 | 404 |
| leading `//`, leading `/./` | 2 | 401 / 401 |
| methods GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS | 7 | 401 each |
| forged, empty, duplicated and valueless session cookies | 5 | 401 each |

**Not one probe returned 200, and no response body contained a settings key.**
The 404s are Next matching its route table on the raw segment, so an encoded or
homoglyph spelling never becomes `admin` in the first place — it resolves to no
route rather than to an ungated one.

Two things worth knowing rather than fixing:

- `TRACE` on any path returns 500. undici refuses to construct a `Request` for
  `TRACE`, which happens inside Next's middleware adapter — so the proxy never
  runs and neither does the handler. It fails **closed**. (The dev server
  renders the stack in that 500; a production build does not.)
- `/api/admin` answers 404 rather than 401 — see finding H-2. It is the one
  place where the matcher selects a path the proxy then declines to gate.

**Recommendation, not a finding:** keep the model but remove the drift risk —
either add `isAdminAuthenticated()` to the handlers as defence in depth, or add
an L0 test that walks `src/app/api/admin/**/route.ts` and asserts every
resulting pathname is selected by `config.matcher` and lands on a gating branch.

**Done (fix phase):** `tests/api/admin-route-gating.test.ts` derives a pathname
from every `route.ts` under `src/app/api/admin` (dynamic segments filled with a
sample value) and asserts, for each: `config.matcher` selects it, an anonymous
`proxyCall()` is refused 401 on GET/POST/PATCH/DELETE, and a session passes
through — with `/api/admin/login` and `/api/admin/logout` as the two declared
exemptions. A new admin route is covered the moment its file lands.

---

## F-7 — live results, verbatim

`/api/quote` is limited to 60 requests per minute per key
(`createRateLimiter(60, 60_000)`), which makes it a clean 61-request probe.
Captured against the neutralised audit instance:

```
== probe run 2026-09-06T22:45:00+02:00 against http://localhost:3001 ==
A  fixed     x-real-ip: 198.51.100.161            (61 requests)
         60 200
          1 429
B  rotating  x-real-ip: 192.0.2.$i                 (61 requests)
         61 200
C  rotating  x-forwarded-for: 203.0.113.$i         (61 requests)
         61 200
D  no forwarding headers at all                  (61 requests)
         60 200
          1 429
E  after D, x-forwarded-for: 127.0.0.1 -> 429
F  after D, x-real-ip: 127.0.0.1        -> 429
G  after D, x-forwarded-for: ::ffff:127.0.0.1 -> 200
```

Reading it:

- **A** — with a stable identity the limiter works exactly as designed.
- **B** — the same 61 requests, from the same client, all succeed as soon as the
  client varies a header it was never entitled to set. Nothing between the
  socket and the handler corrects it. This is finding H-5.
- **C** — `x-forwarded-for` is honoured verbatim too, so removing `x-real-ip`
  from the key derivation would fix nothing on its own.
- **D** — a header-less client *does* get a stable identity: Next fills
  `x-forwarded-for` when the client omits it, so the budget engages.
- **E / F** — that identity is `127.0.0.1` for a loopback client, and both a
  claimed `x-forwarded-for: 127.0.0.1` and a claimed `x-real-ip: 127.0.0.1`
  land in the bucket D exhausted. Next's fallback value is therefore
  indistinguishable from a value the client simply asserts.
- **G** — any other claimed value is a fresh, unexhausted bucket.

**What Next puts in `x-forwarded-for` when the client sends none:** the socket
peer address (`127.0.0.1` here), proven by E landing in D's bucket. It is a
*fallback*, not an override: C proves a client-supplied value survives
untouched, so Next only fills the header in, never corrects it.

**After the fix** (same instance, `AUDIT_BASE_URL=http://localhost:3001 npx
vitest run tests/live` — 38 passed): B now behaves like A, because a rotating
`X-Real-IP` leaves the request effectively header-less and every one of the 61
lands in the socket-peer bucket. A fixed `CF-Connecting-IP` under a *rotating*
`X-Forwarded-For` gives 60 × 200 + 1 × 429 — the edge identity wins. Appending
hops no longer moves the bucket, because the key is the last hop. C is
unchanged and stays that way by design: see R-7.

---

## Flags

| flag | verdict |
| --- | --- |
| **F-2** — uploads | **Confirmed, P1 — now fixed (H-6/H-7/H-8).** Split into H-6 (no authentication on the public read), H-7 (guessable names make it enumerable) and H-8 (same-millisecond overwrite). The *write* side is in good shape: the stored extension comes from magic bytes only, never the client's MIME type or filename; SVG, HTML and executables are refused for both writers; PDF is admin-only; a file under 12 bytes is refused; both size caps hold exactly at the limit and reject limit + 1. Traversal on the read side is closed — 8 literal `..`/slash spellings are 400s, and 4 encoded/backslash/homoglyph spellings become ordinary (non-existent) filenames, verified against a canary file planted outside the upload directory. |
| **F-7** — rate-limit identity | **Confirmed, P1** → finding H-5, now fixed in code for 15 of 17 limited routes. Live evidence above, before and after. The remaining exposure is deployment shape, not code: see **R-7**. |
| **F-12** — `/api/config` GET is public | **Closed, not a defect.** The proxy gates POST and leaves GET open by design (the booking form prices from it). What makes that safe is that `PricingConfig` only ever holds prices: `tests/api/proxy-boundary.test.ts` asserts no `DEFAULT_CONFIGS` key intersects a non-public sensitive `AppConfig` group and none matches `/secret\|password\|token\|apikey\|hash/i`, so the invariant is now enforced rather than assumed. (The route's own behaviour is phase 1a's.) |
| **F-13** — admin routes without their own session check | **Closed as a model, with a recommendation.** See the verdict above: the proxy is exhaustively covered and no live spelling reached a handler. The residual risk is matcher/route-tree drift, which H-2 already demonstrates in miniature. |

---

## Coverage after

`npm run test:coverage` (full suite, v8):

| module | % stmts | % branch | % funcs | uncovered |
| --- | --- | --- | --- | --- |
| `src/lib/admin-auth.ts` | 90.48 | 79.10 | 100 | 23-39 (the `ADMIN_PASSWORD`-as-HMAC-key fallback and the production throw — both need `NODE_ENV=production`), 102 (the `password === 'admin'` dev default) |
| `src/lib/app-config.ts` | 96.36 | 88.24 | 94.12 | 110 (`appCfg` fallback branch) |
| `src/lib/rate-limit.ts` | 94.44 | 90.91 | 100 | 16 (the sweep's `map.delete`) |
| `src/lib/totp.ts` | 94.12 | 100 | 87.50 | 25-26 (`persistTotpSecret` — deliberately never called; this phase does not enrol 2FA) |
| `src/lib/const-time.ts` | 100 | 100 | 100 | — |
| `src/lib/machine-pricing-guard.ts` | 100 | 100 | 100 | — |
| `src/lib/renter-checklist-session.ts` | 97.92 | 88.46 | 100 | — |
| `src/lib/upload-sniff.ts` | 100 | 100 | 100 | — |

`src/proxy.ts` is **outside** the coverage config's `include`
(`src/lib/**/*.ts`), so it does not appear in the report above. Measured
separately with `--coverage.include='src/**/*.ts'` over
`tests/api/proxy-boundary.test.ts` + `tests/api/admin-auth-routes.test.ts`:

| module | % stmts | % branch | % funcs |
| --- | --- | --- | --- |
| `src/proxy.ts` | 100 | 100 | 100 |

Worth widening the config's `include` to `src/lib/**` **plus** `src/proxy.ts` —
it is the single most security-relevant file in the app and it is currently
invisible to the coverage gate.

---

## Fix phase — what changed

All thirteen findings above are fixed; every `it.fails` in this phase's files
has been flipped to `it` and renamed `FIXED <id>`. New code: `src/lib/client-ip.ts`
(one rate-limit identity), `src/lib/upload-store.ts` (upload naming + the
renter filename grammar the read gate parses), `src/lib/machine-input.ts`
(machine payload shape checks). New tests: `tests/lib/client-ip.test.ts` (17)
and `tests/api/admin-route-gating.test.ts` (6, the F-13 recommendation).

Tests that recorded the old wrong behaviour were rewritten to assert the new
behaviour rather than deleted — the anonymous renter-photo read, the
same-millisecond overwrite, the timestamped filename shapes, the drifted
`isPublic` leak, the cache-poisoning read, the 500 on a wrong-typed machine
field, the pass-through on bare `/api/admin` (in-process and live), and the
first-hop / `x-real-ip` precedence probes (in-process and live).

Two follow-ups this phase could not take, both because the tests that own them
belong to another agent's concurrent work:

- `POST /api/payment/stripe/create` and `POST /api/payment/vipps/create` still
  derive the identity inline from `x-real-ip`. Switching them breaks
  `tests/api/payment-{stripe,vipps}.test.ts`, which give each test a distinct
  identity via `ipHeaders()` in `tests/helpers/payments.ts` (an `x-real-ip`
  map). The fix is mechanical once those files are free: import
  `clientIdentity`, and point the tests at `tests/helpers/client-ip.ts`.
- `POST /api/bookings`, `POST /api/delivery`, `POST /api/tilbud/[token]` and
  `POST /api/payment/vipps/return` likewise. `src/lib/audit-log.ts` still
  records the client-chosen `x-real-ip` as the actor IP — same class, no
  rate-limit consequence, worth folding into the same follow-up.

- **The `it.fails` convention.** Every `it.fails` states the behaviour the
  product should have; flipping it back to `it` is the acceptance test for the
  fix.
- **H-6 and H-7 are one change.** Fixing the filename without the access
  control leaves the files world-readable to anyone who has ever seen a URL
  (they are pasted into machine documents and checklist submissions); fixing
  the access control without the filename leaves an enumerable namespace behind
  any future bug in the check. Do both.
- **H-5 has thirteen call sites.** The key derivation is copy-pasted, not
  shared. The fix is one exported `clientIdentity(request)` helper plus a
  decision about what is actually in front of Next in production — the answer
  today is "nothing", which is why the headers are trustworthy only when absent.
- **Deliberately not covered:** the successful 2FA enrollment path
  (`POST /api/admin/totp/verify` with a matching secret + code + password). The
  harness rule is that no test enrols 2FA; the route is exercised through every
  refusal it has — already-enrolled 409, missing password 400, wrong password
  401, non-matching code 400 — and stops one step short of persisting.
- **Harness observation (not a finding against product code).** During this
  phase the full suite intermittently failed with
  `PrismaClientUnknownRequestError: Engine is not yet connected` from
  `tests/helpers/db.ts:156` (`tableNames` inside `resetDb`), taking whole files
  down at a time. It moves between files run to run, reproduces with
  `--maxWorkers=1`, and reproduces with **this phase's files excluded** — so it
  is in the shared `ensureSchema()` disconnect-then-copy sequence, not in any
  one test. The suspected mechanism is a query racing the reconnect after
  `db.$disconnect()`, whose failure the following
  `$queryRawUnsafe('PRAGMA busy_timeout').catch(() => {})` swallows. The suite
  passes cleanly when the machine is otherwise idle (57 files, 947 passed, 55
  expected fail, 38 skipped). Worth an `await db.$connect()` after the copy, or
  a retry around the first query — a harness owner's call, not this phase's.
- **Typecheck.** All files in this phase are clean. `npm run typecheck` still
  reports two errors in other phases' files
  (`tests/api/bookings-id.test.ts:48`, `tests/api/payment-stripe.test.ts:458`
  and `:482`) from the same root cause this phase hit: the shared
  `RouteHandler` type widens `params` to `Promise<RouteParams>`, which is not
  assignable to a route's own `Promise<{ id: string }>`. Handled here with a
  single documented `asRoute()` cast per file; the tidier fix is to loosen
  `RouteHandler` in `tests/helpers/route.ts`, which this phase did not own.
