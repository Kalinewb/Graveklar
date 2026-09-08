import { db } from '@/lib/db';
import { APP_CONFIG_DEFAULTS } from '@/lib/app-config-defaults';

let cache: { values: Record<string, string>; expiresAt: number } | null = null;
// Short TTL so settings changes propagate fast. The admin POST handler also
// calls invalidateAppConfigCache(), but cross-process state changes (e.g.
// dev server vs. prod server hitting the same DB) only rely on this expiry.
const CACHE_TTL_MS = 2 * 1000;
const PASSWORD_MASK = '●●●●●●';

// Process-local flag: once migrations have been applied (or confirmed as
// no-op) for this process lifetime, skip the migration scan on subsequent
// cache misses. The migrations themselves are idempotent; this just avoids
// the cost of re-checking and the extra findMany.
let migrationsApplied = false;

export function invalidateAppConfigCache() { cache = null; }

const DEFAULTS_MAP: Record<string, string> = Object.fromEntries(
  APP_CONFIG_DEFAULTS.map((d) => [d.key, d.value])
);

// One-time data migrations applied before the stale-cleanup deletes old keys.
// Each migration must be idempotent — it may run before old keys exist or
// after they've already been removed.
async function applyOneTimeMigrations(
  rows: { key: string; value: string }[]
): Promise<void> {
  const current = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  // cancelFreeHours (single int) → cancelFreeWeeks + cancelFreeDays
  if (current.cancelFreeHours != null) {
    const hours = Number(current.cancelFreeHours) || 0;
    const weeks = Math.floor(hours / 168);
    const days = Math.floor((hours % 168) / 24);
    if (current.cancelFreeWeeks == null) {
      await db.appConfig.upsert({
        where: { key: 'cancelFreeWeeks' },
        create: {
          key: 'cancelFreeWeeks', value: String(weeks),
          label: 'Gratis avbestilling (uker før start)',
          group: 'terms', type: 'number', isPublic: true, sortOrder: 0,
        },
        update: { value: String(weeks) },
      });
    }
    if (current.cancelFreeDays == null) {
      await db.appConfig.upsert({
        where: { key: 'cancelFreeDays' },
        create: {
          key: 'cancelFreeDays', value: String(days),
          label: 'Gratis avbestilling (dager før start)',
          group: 'terms', type: 'number', isPublic: true, sortOrder: 1,
        },
        update: { value: String(days) },
      });
    }
  }
}

/**
 * Every caller gets its own copy of the map (finding I-5).
 *
 * Handing out the cached object itself meant a caller that wrote into the
 * returned map rewrote the cache for every other reader in the process until
 * the 2-second TTL expired — intermittently, which is the worst kind of bug.
 */
export async function loadAppConfig(): Promise<Record<string, string>> {
  if (cache && Date.now() < cache.expiresAt) return { ...cache.values };

  if (!db.appConfig) return { ...DEFAULTS_MAP };

  let rows = await db.appConfig.findMany();

  // Apply one-time data migrations BEFORE stale-cleanup removes old keys.
  // Skip after the first successful pass per process — the migrations are
  // idempotent but re-scanning the rows on every cache miss is wasteful.
  if (!migrationsApplied) {
    await applyOneTimeMigrations(rows);
    migrationsApplied = true;
    // Re-read after migrations may have inserted new rows.
    rows = await db.appConfig.findMany();
  }

  const existing = new Set(rows.map((r) => r.key));
  const validKeys = new Set(APP_CONFIG_DEFAULTS.map((d) => d.key));
  const missing = APP_CONFIG_DEFAULTS.filter((d) => !existing.has(d.key));
  const stale = rows.filter((r) => !validKeys.has(r.key) && r.key !== 'adminPasswordHash');

  if (missing.length > 0 || stale.length > 0) {
    // Use deleteMany so concurrent requests don't race on individual
    // delete()s (which throw P2025 if the row vanished between the read
    // and the delete).
    await Promise.all([
      // `hint` is presentation-only metadata on AppConfigItem — there is no
      // such column, and passing the default object wholesale makes Prisma
      // reject the create with "Unknown argument `hint`". Strip it here so a
      // hinted key can still seed itself on a fresh database.
      ...missing.map(({ hint: _hint, ...row }) =>
        db.appConfig.upsert({ where: { key: row.key }, create: row, update: {} })
      ),
      stale.length > 0
        ? db.appConfig.deleteMany({ where: { key: { in: stale.map((r) => r.key) } } })
        : Promise.resolve(),
    ]);
    rows = await db.appConfig.findMany();
  }

  const values: Record<string, string> = {};
  for (const row of rows) values[row.key] = row.value;

  cache = { values, expiresAt: Date.now() + CACHE_TTL_MS };
  return { ...values };
}

export function appCfg(config: Record<string, string>, key: string, fallback = ''): string {
  return config[key] ?? fallback;
}

// Keys safe to expose to the browser. Everything else returned by
// loadAppConfig() — Stripe/SMTP credentials, webhook secret,
// adminPasswordHash — must never cross to a client component.
const PUBLIC_APP_CONFIG_KEYS = new Set(
  APP_CONFIG_DEFAULTS.filter((d) => d.isPublic).map((d) => d.key)
);

/**
 * Filter a full appConfig map down to only `isPublic` keys. MUST be applied
 * before handing appConfig to ANY client component — `loadAppConfig()` returns
 * every key, including secrets. Fail-closed: keys absent from the defaults are
 * dropped (an unknown key is treated as non-public).
 */
export function publicAppConfig(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PUBLIC_APP_CONFIG_KEYS) {
    if (values[key] !== undefined) out[key] = values[key];
  }
  return out;
}

// Re-export pure helpers so server code keeps a single import path.
export { getCancelFreeHours, getCancelFreeLabel } from '@/lib/cancellation';

export function maskPasswords(
  rows: { key: string; value: string; type: string }[]
): typeof rows {
  // Mask both `password`-type secrets (Stripe/SMTP) and `hidden`-type
  // internal values (e.g. adminPasswordHash). Even over the authenticated
  // admin API there's no reason to ship a credential hash to the browser.
  return rows.map((r) =>
    (r.type === 'password' || r.type === 'hidden') && r.value
      ? { ...r, value: PASSWORD_MASK }
      : r
  );
}

export { PASSWORD_MASK };
