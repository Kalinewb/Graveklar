import { db } from '@/lib/db';
import { DEFAULT_CONFIG, DEFAULT_CONFIGS, type ConfigItem } from '@/lib/config-defaults';
import type { ConfigValues } from '@/lib/pricing';

let cache: { values: ConfigValues; expiresAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

export function invalidateConfigCache(): void {
  cache = null;
}

export async function loadConfigValues(): Promise<ConfigValues> {
  if (cache && Date.now() < cache.expiresAt) return cache.values;

  let configs = await db.pricingConfig.findMany();
  const existingKeys = new Set(configs.map((c) => c.key));
  const validKeys = new Set(DEFAULT_CONFIGS.map((d) => d.key));
  const missing = DEFAULT_CONFIGS.filter((d) => !existingKeys.has(d.key));
  const stale = configs.filter((c) => !validKeys.has(c.key));

  if (missing.length > 0 || stale.length > 0) {
    await Promise.all([
      ...missing.map((d) =>
        db.pricingConfig.upsert({
          where: { key: d.key },
          create: { key: d.key, value: d.value, label: d.label, group: d.group },
          update: {},
        })
      ),
      ...stale.map((c) => db.pricingConfig.delete({ where: { key: c.key } })),
    ]);
    configs = await db.pricingConfig.findMany();
  }

  const values: ConfigValues = { ...DEFAULT_CONFIG };
  for (const c of configs) {
    values[c.key] = c.value;
  }

  cache = { values, expiresAt: Date.now() + CACHE_TTL_MS };
  return values;
}

export { DEFAULT_CONFIGS };
export type { ConfigItem };
