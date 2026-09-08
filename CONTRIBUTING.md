# Contributing to Graveklar

Thanks for your interest in contributing! This guide will help you get started.

## Development Setup

```bash
git clone https://github.com/your-org/graveklar.git
cd graveklar
cp .env.example .env
npm install
npx prisma db push
npm run dev
```

The app runs at `http://localhost:3000`. Admin panel at `/admin` (default password: `admin`).

## Branch Naming

- `feature/short-description` for new features
- `fix/short-description` for bug fixes
- `docs/short-description` for documentation

## Pull Requests

1. Fork the repo and create your branch from `main`
2. Make your changes
3. Run `npx tsc --noEmit` to verify TypeScript compiles
4. Test your changes manually in the browser
5. Open a PR with a clear description of what changed and why

## Code Style

- TypeScript strict mode
- Tailwind CSS for styling
- shadcn/ui components in `src/components/ui/`
- Business logic in `src/lib/`
- API routes in `src/app/api/`
- Norwegian UI text (customer-facing), English code/comments

## Architecture Rules

- All config lives in the database (AppConfig / PricingConfig), not in env vars or config files
- No new npm dependencies without justification
- No client-side Stripe SDK — server-side only
- SQLite only — no Postgres/MySQL abstractions
- Keep components simple — prefer props over context/state management libraries

## Database Changes

Edit `prisma/schema.prisma`, then:

```bash
npx prisma db push
npx prisma generate
```

New AppConfig keys go in `src/lib/app-config-defaults.ts`. They appear in the admin UI automatically.

## Reporting Issues

- Check existing issues first
- Include steps to reproduce
- Include browser/OS if it's a UI issue
- Screenshots help

## Good First Issues

Look for issues labeled `good first issue` — these are scoped, well-described tasks suitable for newcomers.
