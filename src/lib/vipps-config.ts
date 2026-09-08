// Bridges the `vipps` AppConfig group (admin-editable, 2FA-gated) to the
// credential-agnostic client in lib/vipps.ts. Mirrors loadStripeConfig() in
// lib/stripe.ts — credentials live in the DB, never in env vars.

import { db } from '@/lib/db';
import type { VippsCredentials } from '@/lib/vipps';

const VIPPS_KEYS = [
  'vippsEnabled',
  'vippsEnvironment',
  'vippsClientId',
  'vippsClientSecret',
  'vippsSubscriptionKey',
  'vippsMsn',
  'vippsWebhookSecret',
] as const;

export interface VippsConfig {
  enabled: boolean;
  credentials: VippsCredentials;
  webhookSecret: string;
}

export async function loadVippsConfig(): Promise<VippsConfig> {
  const rows = await db.appConfig.findMany({ where: { key: { in: [...VIPPS_KEYS] } } });
  const cfg: Record<string, string> = {};
  for (const r of rows) cfg[r.key] = r.value;

  // Anything other than an explicit 'production' stays on the test endpoint —
  // a typo in this field must never route real money.
  const environment = cfg.vippsEnvironment === 'production' ? 'production' : 'test';

  return {
    enabled: cfg.vippsEnabled === 'true',
    webhookSecret: cfg.vippsWebhookSecret ?? '',
    credentials: {
      clientId: (cfg.vippsClientId ?? '').trim(),
      clientSecret: (cfg.vippsClientSecret ?? '').trim(),
      subscriptionKey: (cfg.vippsSubscriptionKey ?? '').trim(),
      msn: (cfg.vippsMsn ?? '').trim(),
      environment,
    },
  };
}

export function hasCompleteVippsCredentials(creds: VippsCredentials): boolean {
  return Boolean(creds.clientId && creds.clientSecret && creds.subscriptionKey && creds.msn);
}

/**
 * True only when Vipps is both switched on AND fully configured. Used to gate
 * booking creation and to decide which payment buttons the frontend shows —
 * a half-configured provider must look "off", not fail at redirect time.
 */
export async function isVippsEnabled(): Promise<boolean> {
  const cfg = await loadVippsConfig();
  return cfg.enabled && hasCompleteVippsCredentials(cfg.credentials);
}

/** Throws unless Vipps is usable. Returns credentials ready for the client. */
export async function requireVippsCredentials(): Promise<VippsCredentials> {
  const cfg = await loadVippsConfig();
  if (!cfg.enabled) throw new Error('Vipps er ikke aktivert');
  if (!hasCompleteVippsCredentials(cfg.credentials)) {
    throw new Error('Vipps mangler nødvendige nøkler');
  }
  return cfg.credentials;
}
