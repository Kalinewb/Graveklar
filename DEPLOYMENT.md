# Deployment Runbook — Graveklar

Production deployment guide for a Proxmox LXC/VM or a VPS, fronted by
**Nginx Proxy Manager (NPM)** for TLS.

> Architecture: `Internet → :443 NPM (Let's Encrypt TLS) → :3000 app (plain HTTP) → SQLite file`
> Single instance only — SQLite is single-writer/single-node. Do **not** run
> multiple replicas against the same database.

---

## 0. What you're deploying

- **App:** Next.js 16, started with `next start` on port `3000`.
- **Database:** SQLite, one file on disk (`DATABASE_URL=file:/var/lib/graveklar/custom.db`).
- **Secrets:** `ADMIN_SESSION_SECRET`, `CRON_SECRET`, `ADMIN_PASSWORD` via env.
- **Stripe + SMTP keys:** set in **Admin → Innstillinger** after first login
  (stored in the DB, 2FA-gated), *not* in env.
- **Scheduled jobs:** two HTTP cron endpoints + a DB backup — you wire these up.

---

## 1. Server prerequisites

- Debian/Ubuntu LXC or VM (Proxmox) or a VPS.
- **Node.js 20+** (the app is built/tested on 20/25) and `npm`.
- `sqlite3` and `gzip` (for backups): `apt install -y sqlite3 gzip`.
- `git`, `openssl`, `ca-certificates`.
- DNS: point `graveklar.no` (A/AAAA) at the server's public IP.
- Firewall: allow `80`/`443` from the internet; **block `3000` from the
  internet** (see §5).

---

## 2. Get the code + build

```bash
sudo mkdir -p /opt/graveklar /var/lib/graveklar
sudo chown "$USER" /opt/graveklar /var/lib/graveklar
git clone <your-repo-or-copy-the-files> /opt/graveklar
cd /opt/graveklar

npm ci
export DATABASE_URL="file:/var/lib/graveklar/custom.db"
npx prisma db push        # creates/migrates the SQLite schema (non-destructive)
npm run build
```

Keep the DB **outside** the code dir (`/var/lib/graveklar`) so code updates
never touch it. Avoid the legacy nested `prisma/prisma/db/` path on a fresh box.

---

## 3. Generate real secrets

Never reuse the dev values. Create `/etc/graveklar.env` (root-owned, `chmod 600`):

```bash
sudo tee /etc/graveklar.env >/dev/null <<EOF
NODE_ENV=production
TZ=Europe/Oslo
PORT=3000
DATABASE_URL=file:/var/lib/graveklar/custom.db
ADMIN_PASSWORD=$(openssl rand -base64 24)
ADMIN_SESSION_SECRET=$(openssl rand -hex 32)
CRON_SECRET=$(openssl rand -hex 32)
EOF
sudo chmod 600 /etc/graveklar.env
sudo cat /etc/graveklar.env   # note ADMIN_PASSWORD + CRON_SECRET; you'll need them
```

- `ADMIN_PASSWORD` is the login password (until you change it in the UI, which
  stores a hash in the DB and takes over).
- `ADMIN_SESSION_SECRET` signs session cookies — keep it stable or everyone is
  logged out.
- `CRON_SECRET` authorizes the cron endpoints (§6).
- `TZ=Europe/Oslo` pins local time: booking-day boundaries, weekend detection
  and same-day cancellation fees are computed in the process timezone, so a
  UTC-default host would shift them by 1–2 hours.

---

## 4. Run the app

### Option A — systemd (recommended; mirrors the proven setup)

`/etc/systemd/system/graveklar.service`:

```ini
[Unit]
Description=Graveklar (Next.js)
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/graveklar
EnvironmentFile=/etc/graveklar.env
ExecStart=/opt/graveklar/start-npm.sh
Restart=on-failure
RestartSec=3
# Optional hardening:
# DynamicUser=no
# User=graveklar

[Install]
WantedBy=multi-user.target
```

> `start-npm.sh` is the direct-run entrypoint: it loads secrets (real env wins,
> else an optional `.env.production`), applies pending schema changes
> (`prisma db push`), builds only if there's no `.next` yet, then runs
> `next start` on `:3000`. `npm run start` invokes the same script.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now graveklar
sudo systemctl status graveklar
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/   # expect 200
```

**Updating later:** `git pull && npm ci && npx prisma db push && npm run build && sudo systemctl restart graveklar`.

### Option B — Docker

The [Dockerfile](Dockerfile) and [docker-compose.yml](docker-compose.yml) are
verified to **build and run** (`next start` mode, non-standalone). Bring it up:

```bash
./start-docker.sh        # wraps: docker compose up -d --build
```

Before the first run, edit `docker-compose.yml`: replace the
`change-me-in-production` secrets (`ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`) and
add `CRON_SECRET`. The SQLite DB persists in the named volume `graveklar-db`
(so it survives rebuilds), and the entrypoint runs `prisma db push` then
`next start`. You still need `client_max_body_size 20M` upstream in NPM (§5),
the cron jobs (§6), and backups (§6 — back up the *volume*, e.g.
`docker run --rm -v graveklar-db:/db -v "$PWD/backups":/out alpine sh -c 'apk add sqlite >/dev/null && sqlite3 /db/custom.db ".backup /out/graveklar-$(date +%F).db"'`).

---

## 5. Nginx Proxy Manager (reverse proxy + TLS)

Add a **Proxy Host**:

| Field | Value |
|---|---|
| Domain Names | `graveklar.no` (and `www.` if used) |
| Scheme | `http` |
| Forward Hostname/IP | the app host/container IP (e.g. LXC IP or `host.docker.internal`) |
| Forward Port | `3000` |
| Block Common Exploits | on |
| Websockets Support | off (not needed) |

**SSL tab:** request a Let's Encrypt cert, enable **Force SSL** + **HTTP/2**.
Leave **HSTS** *off* — the app already sends its own HSTS header.

**Advanced tab** — required, or large image uploads 413:
```nginx
client_max_body_size 20M;
```

### The two things that will silently break if misconfigured
1. **`client_max_body_size 20M`** — without it, machine photos > 1 MB fail (the
   upload route accepts up to 20 MB).
2. **`X-Forwarded-Proto`** — NPM forwards this by default; the app needs it to
   set the session cookie as `Secure`. **Test admin login immediately** after
   setup — if the cookie won't stick, this header is the cause.

### Lock down port 3000
Public traffic must only hit 443. Block 3000 from the internet:
```bash
sudo ufw allow 80,443/tcp
sudo ufw deny 3000/tcp        # or bind the app to the LAN/loopback NPM uses
sudo ufw enable
```

---

## 6. Scheduled jobs (do NOT skip)

Both endpoints require `Authorization: Bearer $CRON_SECRET`. `cleanup` also runs
lazily on traffic, but **reminders ONLY fire from here** — skip this and the
day-before reminder emails never send.

`/etc/cron.d/graveklar` (replace `<CRON_SECRET>`):

```cron
# Expire unpaid pending bookings — every 10 minutes
*/10 * * * * root curl -fsS -H "Authorization: Bearer <CRON_SECRET>" http://localhost:3000/api/cron/cleanup >/dev/null 2>&1

# Send day-before reminders — daily at 08:00
0 8 * * * root curl -fsS -H "Authorization: Bearer <CRON_SECRET>" http://localhost:3000/api/cron/reminders >/dev/null 2>&1
```

### On this host: systemd user timers

The production host runs everything as user units. Ready-made timers for the
cleanup sweep (wall-clock, every 10 min) and a nightly backup live in
`deploy/systemd/user/` with install commands in its README. Verify with
`systemctl --user list-timers --all | grep graveklar` — a timer showing no
`NEXT` time is not running.

### Database backups (systemd timer)

```ini
# /etc/systemd/system/graveklar-backup.service
[Unit]
Description=Graveklar SQLite backup
[Service]
Type=oneshot
WorkingDirectory=/opt/graveklar
Environment=DATABASE_URL=file:/var/lib/graveklar/custom.db
ExecStart=/bin/sh /opt/graveklar/scripts/backup-db.sh
```
```ini
# /etc/systemd/system/graveklar-backup.timer
[Unit]
Description=Daily Graveklar DB backup
[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
[Install]
WantedBy=timers.target
```
```bash
sudo systemctl daemon-reload && sudo systemctl enable --now graveklar-backup.timer
sudo systemctl start graveklar-backup.service   # test it once
ls -la /opt/graveklar/backups/                  # confirm a .db.gz appeared
```

`backup-db.sh` does an online `.backup` (safe while running), gzips, and prunes
older than `RETENTION_DAYS` (default 30). **Copy backups off the box too** (rsync
to another host / object storage) — a backup on the same disk doesn't survive a
disk failure.

---

## 7. Stripe (live)

1. Log into **Admin → Innstillinger → Stripe**, enter the **live** keys, enable
   Stripe (2FA-gated — set up 2FA first under Admin → 2FA).
2. In the Stripe Dashboard, add a webhook endpoint:
   `https://graveklar.no/api/payment/stripe/webhook`
   Events: `checkout.session.completed`, `checkout.session.expired`,
   `checkout.session.async_payment_failed`, `charge.refunded`,
   `charge.dispute.created`, `payment_intent.payment_failed`.
3. Copy the webhook **signing secret** (`whsec_…`) into Admin → Stripe.
4. Set **Admin → siteUrl** = `https://graveklar.no` (used for Stripe redirects
   and email links).

---

## 8. First-login + smoke test

1. Visit `https://graveklar.no` → loads over HTTPS, no cert warning.
2. `https://graveklar.no/admin` → log in with `ADMIN_PASSWORD`. **If the session
   doesn't stick, it's the `X-Forwarded-Proto` issue (§5).**
3. Change the admin password and enrol 2FA.
4. Upload a machine photo > 1 MB → succeeds (confirms `client_max_body_size`).
5. Make a real test booking through to Stripe checkout (use Stripe **test** mode
   first if possible); confirm the booking flips to *confirmed* and the
   confirmation email arrives.
6. `curl -H "Authorization: Bearer <CRON_SECRET>" https://graveklar.no/api/cron/cleanup`
   → `200`; without the header → `401`.

> The repo includes `scripts/test-stripe-flow.ts` and `scripts/test-concurrency.ts`
> for verifying a non-production/staging box end-to-end. Don't run them against a
> live DB — they create (and clean up) test bookings and send real emails.

---

## 9. Quick reference

| Task | Command |
|---|---|
| Restart app | `sudo systemctl restart graveklar` |
| Logs | `journalctl -u graveklar -f` |
| Update | `git pull && npm ci && npx prisma db push && npm run build && sudo systemctl restart graveklar` |
| Manual backup | `cd /opt/graveklar && DATABASE_URL=file:/var/lib/graveklar/custom.db sh scripts/backup-db.sh` |
| Restore | stop app → `gunzip -c backups/<file>.db.gz > /var/lib/graveklar/custom.db` → start app |
