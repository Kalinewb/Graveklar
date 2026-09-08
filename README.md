# Graveklar

A self-hosted booking and payment platform for equipment rental businesses. Customers browse machines, pick dates, pay online, and get confirmation — all automated. Operators manage availability, pricing, and bookings from a built-in admin panel.

Built to run on a single server with Docker. SQLite database, Stripe payments, SMTP email. No external services beyond what you configure.

---

## Features

**Customer-facing**
- Live availability calendar with blocked-date support
- Rental types: day (weekday), weekend, week, or custom duration
- Automatic delivery fee calculation based on address distance
- Stripe Checkout payment (card, Vipps, Klarna — whatever you enable)
- Discount, referral, and loyalty codes applied at checkout
- Booking confirmation emails with cancellation link
- Self-service cancellation page with fee calculation
- On-demand contract PDF generation from frozen terms

**Admin panel** (`/admin`)
- Booking overview with payment status (Betalt / Ikke betalt) and timeline
- Confirm or cancel bookings — cancellation requires a reason and auto-issues a goodwill code
- Generate Stripe payment links for manual sending
- Machine fleet management with specs, photos, and features
- All pricing configurable: rental rates, delivery fees, overtime, cancellation terms
- Discount, referral, and repeat-customer code management with redemption tracking
- Content management: FAQ, terms, insurance cards — all editable from the UI
- SMTP, Stripe, and business settings — no config files to edit
- Checklist system for delivery/return inspections
- Needs-survey responses captured and reviewed in-panel
- Optional TOTP two-factor auth and a full admin audit log
- First-time setup: forced password change on initial login

**Self-hosted**
- SQLite database — one file, trivial backups
- Docker image under 300 MB, single container
- Works behind any reverse proxy (Caddy, nginx, Traefik, Cloudflare)
- All config stored in the database — same image works for any operator

---

## Quick Start

### Option 1: Docker (recommended)

```bash
git clone https://github.com/Kalinewb/Equipment-rental-platform.git
cd Equipment-rental-platform
cp .env.example .env
docker compose up -d
```

Open `http://localhost:3000`. Admin at `/admin` — log in with `admin`, you'll be prompted to set a new password.

### Option 2: Local development

```bash
git clone https://github.com/Kalinewb/Equipment-rental-platform.git
cd Equipment-rental-platform
cp .env.example .env
npm install
npx prisma db push
npm run dev
```

---

## Configuration

Everything is configured from the admin panel after first login. No env vars needed beyond `ADMIN_PASSWORD`.

| Admin Section | What you configure |
|---|---|
| Virksomhet | Business name, address, phone, email, org number, GPS coordinates |
| Booking | Enabled rental types, advance booking limits, auto-confirm |
| Betaling | Bank account, payment instructions |
| E-post (SMTP) | Mail server for booking notifications |
| Stripe | API keys, webhook secret, enable/disable |
| Priser | Rental rates, delivery fees, overtime, cancellation terms |
| Innhold | Hero text, FAQ, terms, insurance cards |
| System | Maintenance mode, currency, map coordinates |

### Stripe Setup

1. Get API keys from [Stripe Dashboard](https://dashboard.stripe.com/apikeys)
2. In Admin → Stripe: paste secret key, publishable key, toggle on
3. Add webhook endpoint: `https://yourdomain.com/api/payment/stripe/webhook`
4. Listen for: `checkout.session.completed`
5. Paste webhook secret (`whsec_...`) in admin

Payment methods (card, Vipps, Klarna, etc.) are managed from the [Stripe Dashboard](https://dashboard.stripe.com/settings/payment_methods) — no code changes needed.

### SMTP Setup

Configure in Admin → E-post, or use env vars. Works with Gmail, Brevo, Postmark, Mailgun, SES, or any SMTP relay.

---

## Production Deployment

### Single server with Caddy

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh

# Clone and start
git clone https://github.com/Kalinewb/Equipment-rental-platform.git /opt/graveklar
cd /opt/graveklar
cp .env.example .env
nano .env  # set ADMIN_PASSWORD
docker compose up -d
```

Caddyfile:
```caddyfile
yourdomain.com {
    reverse_proxy localhost:3000
}
```

### Updates

```bash
cd /opt/graveklar
git pull
docker compose up -d --build
```

Schema migrations run automatically on container start.

### Backups

```bash
docker cp graveklar:/app/db/custom.db ./backup-$(date +%Y%m%d).db
```

---

## Architecture

```
Docker container
├── Next.js 16 (standalone)     :3000
│   ├── /                       Customer booking + payment
│   ├── /admin                  Operator panel
│   ├── /booking/cancel         Customer self-service cancellation
│   ├── /vilkar, /personvern    Terms & privacy pages
│   └── /api/*                  REST endpoints + Stripe webhooks
│
├── SQLite (Prisma)             /app/db/custom.db
│   ├── Booking, Machine, UnavailableDate, BookingDateLock
│   ├── PricingConfig, AppConfig, SystemState
│   ├── FaqItem, TermsSection, InsuranceCard, AcceptedContract
│   ├── CampaignDiscountCode, ReferralCode, RepeatDiscountCode (+ redemptions)
│   ├── AdminTotp, AdminAuditLog, WebhookEvent, SurveyResponse
│   └── ChecklistPhase, ChecklistItem
│
└── Middleware                  HMAC session auth on /admin/*
```

**Stack:** Next.js 16 App Router, TypeScript, Tailwind CSS, Prisma/SQLite, Stripe Checkout, Nodemailer

**Key decisions:**
- SQLite — no database server, one file to back up
- All config in DB — same Docker image for any operator
- Server-side rendering — no flash of default content
- Stripe dynamic payment methods — no hardcoded payment types
- HMAC-SHA256 sessions — Edge-compatible, no external auth service

---

## Project Structure

```
src/
├── app/
│   ├── page.tsx                  Server component (data fetching)
│   ├── HomePage.tsx              Client component (booking UI)
│   ├── layout.tsx                Root layout (dynamic metadata)
│   ├── admin/
│   │   ├── page.tsx              Admin panel
│   │   ├── login/page.tsx        Login + first-time password setup
│   │   ├── audit-log/            Admin action history
│   │   ├── checklist/            Delivery/return inspections
│   │   ├── discount-codes/       Campaign/referral/loyalty codes
│   │   ├── survey/               Needs-survey responses
│   │   └── bookings/[id]/contract/  Frozen contract view
│   ├── booking/cancel/page.tsx   Customer self-service cancellation
│   └── api/
│       ├── bookings/             Booking CRUD
│       ├── payment/stripe/       Checkout, callback, webhook, status
│       ├── availability/         Date availability lookup
│       ├── delivery/             Distance-based fee calculation
│       ├── faq/, terms/, insurance/  Public content endpoints
│       └── admin/                Protected admin endpoints
├── components/
│   ├── EquipmentShowcase.tsx     Machine carousel on the booking page
│   ├── Footer.tsx                Site footer
│   ├── TermsDialog.tsx           Terms & conditions dialog
│   ├── MaintenancePage.tsx       Maintenance-mode screen
│   ├── admin/                    Admin-specific widgets
│   ├── admin-ui/                 Reusable admin form controls
│   └── ui/                       shadcn/ui primitives
├── lib/
│   ├── booking-service.ts        Booking business logic + validation
│   ├── pricing.ts                Price calculation engine
│   ├── discount-engine.ts        Discount/referral/loyalty code logic
│   ├── stripe.ts                 Stripe Checkout integration
│   ├── email.ts                  Email templates (SMTP)
│   ├── freeze-contract.ts        Snapshots terms into a contract
│   ├── admin-auth.ts             HMAC session auth + password hashing
│   ├── totp.ts                   Two-factor auth
│   ├── app-config.ts             Cached config loader
│   └── db.ts                     Prisma client
└── proxy.ts                       Auth guard for /admin routes (Next.js 16 proxy, formerly middleware)
```

---

## Booking Flow

```
Customer fills form → "Bekreft og betal"
    │
    ├── Stripe enabled:
    │   POST /api/bookings → status: pending
    │   POST /api/payment/stripe/create → redirect to Stripe
    │   Customer pays → webhook confirms booking + sends email
    │
    └── Stripe disabled:
        POST /api/bookings → status: pending (or auto-confirmed)
        Email → admin notification
        Admin confirms → email → customer
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | SQLite path. Default: `file:./prisma/prisma/db/custom.db` |
| `ADMIN_PASSWORD` | Yes | Initial admin password. App forces change if set to `admin`. |
| `ADMIN_SESSION_SECRET` | Recommended | Session signing secret. Defaults to ADMIN_PASSWORD. |

All other settings (SMTP, Stripe, business info, pricing) are managed from the admin panel.

---

## Continuous Integration & Automation

GitHub Actions workflows live in `.github/workflows/`:

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | Push to `main`, every PR | Install, Prisma generate, typecheck, lint, unit tests, production build |
| `claude-code-review.yml` | PR opened / updated | Automated AI code review posting inline comments |
| `claude.yml` | `@claude` mention in an issue or PR | Interactive assistant — answers questions, implements fixes, pushes changes |

The two Claude workflows authenticate with a Claude Pro/Max subscription. To enable them, add a `CLAUDE_CODE_OAUTH_TOKEN` repository secret (generate it with `claude setup-token`). Until that secret is set they skip cleanly, so they never fail the build.

Run the same checks CI runs, locally:

```bash
npm run typecheck && npm run lint && npm test
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

[MIT](LICENSE)
