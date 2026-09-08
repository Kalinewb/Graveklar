import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Vitest config for the whole test pyramid.
//
// `tests/setup.ts` runs in every worker before any test module is imported.
// It repoints DATABASE_URL at a per-worker scratch SQLite file outside the
// repository and refuses to start if the resolved path could be the live
// database — that guard is what makes DB-touching tests safe to run here.
//
// Environment stays `node`. A component test can opt in per file with
// `// @vitest-environment jsdom` once jsdom is installed (it is not, today).
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      // Route handlers and the proxy are exercised in-process by tests/api;
      // without them here their coverage never showed up in the report.
      include: ['src/lib/**/*.ts', 'src/app/api/**/route.ts', 'src/proxy.ts'],
      // db.ts is the PrismaClient construction site — nothing to cover but a
      // constructor and pragmas. Everything else, email included, is in scope.
      exclude: ['src/lib/db.ts'],
      // json-summary is what the gate review reads; the thresholds below are Gate B.
      reporter: ['text', 'json-summary', 'html'],
      // Gate B (audit, 2026-09-07) is a ratchet, not a target: every number is
      // the floor of what the suite measured on the day the audit closed, so a
      // change that removes tests or adds untested branches fails CI, while
      // the targets stay written down in docs/test-audit-2026-09.md (P0 set
      // >= 90 % branches, everything else >= 80 %). Raise a floor whenever a
      // measured value passes it; never lower one without a note in the audit
      // report. The P0 set is the money and security code: booking state,
      // payments, discounts, auth, uploads, rate-limit identity, pricing.
      thresholds: {
        branches: 78,
        lines: 87,
        functions: 86,
        statements: 87,
        'src/{lib/{booking-service,stripe,vipps-payments,discount-engine,admin-auth,upload-store,client-ip,rate-limit,pricing,mva,cancellation,audit-log,totp}.ts,lib/domain/quote.ts,proxy.ts,app/api/{payment/**,bookings,booking/cancel,uploads/[filename],admin/login,admin/totp/**,cron/**}/route.ts}': {
          branches: 83,
          lines: 92,
        },
      },
    },
  },
});
