// Register / inspect / remove the Vipps ePayment webhook.
//
//   npx tsx scripts/vipps-webhook.ts list
//   npx tsx scripts/vipps-webhook.ts register
//   npx tsx scripts/vipps-webhook.ts delete <id>
//
// `register` stores the returned secret straight into AppConfig
// (vippsWebhookSecret) rather than printing it — Vipps only reveals it once,
// and it should not end up in terminal scrollback or shell history.
//
// Vipps must be able to reach the URL, so this only works against a public
// hostname (siteUrl). On localhost the return-URL path still settles payments;
// the webhook is what covers customers who close the browser.

import { db } from '@/lib/db';
import { loadAppConfig, invalidateAppConfigCache } from '@/lib/app-config';
import { loadVippsConfig, hasCompleteVippsCredentials } from '@/lib/vipps-config';
import {
  deleteWebhook,
  listWebhooks,
  registerWebhook,
  VIPPS_WEBHOOK_EVENTS,
  vippsBaseUrl,
} from '@/lib/vipps';

async function main() {
  const [command, arg] = process.argv.slice(2);

  const cfg = await loadVippsConfig();
  if (!hasCompleteVippsCredentials(cfg.credentials)) {
    throw new Error(
      'Vipps-nøkler mangler. Fyll ut Client ID, Client Secret, Subscription Key og MSN under Admin → Innstillinger → Vipps MobilePay.',
    );
  }
  console.log(`Miljø: ${cfg.credentials.environment} (${vippsBaseUrl(cfg.credentials)})`);
  console.log(`MSN:   ${cfg.credentials.msn}`);

  if (command === 'list') {
    const { webhooks } = await listWebhooks(cfg.credentials);
    if (!webhooks?.length) {
      console.log('Ingen webhooks registrert.');
      return;
    }
    for (const w of webhooks) {
      console.log(`- ${w.id}\n  url:    ${w.url}\n  events: ${w.events.join(', ')}`);
    }
    return;
  }

  if (command === 'delete') {
    if (!arg) throw new Error('Mangler webhook-id. Bruk: npx tsx scripts/vipps-webhook.ts delete <id>');
    await deleteWebhook(cfg.credentials, arg);
    console.log(`Slettet webhook ${arg}`);
    return;
  }

  if (command === 'register') {
    const appConfig = await loadAppConfig();
    const siteUrl = (appConfig['siteUrl'] || '').replace(/\/+$/, '');
    if (!siteUrl) throw new Error('siteUrl er ikke satt i Innstillinger.');
    if (!/^https:\/\//i.test(siteUrl)) {
      throw new Error(`siteUrl må være https for at Vipps skal kunne kalle den (fikk: ${siteUrl})`);
    }

    const url = `${siteUrl}/api/payment/vipps/webhook`;

    // Registering the same URL twice leaves two live webhooks that both fire;
    // the handler dedupes, but it doubles the traffic. Clean up first.
    const { webhooks } = await listWebhooks(cfg.credentials);
    for (const existing of webhooks ?? []) {
      if (existing.url === url) {
        await deleteWebhook(cfg.credentials, existing.id);
        console.log(`Fjernet eksisterende webhook ${existing.id} for samme URL`);
      }
    }

    const result = await registerWebhook(cfg.credentials, url, VIPPS_WEBHOOK_EVENTS);

    await db.appConfig.upsert({
      where: { key: 'vippsWebhookSecret' },
      update: { value: result.secret },
      create: {
        key: 'vippsWebhookSecret',
        value: result.secret,
        label: 'Webhook Secret',
        group: 'vipps',
        type: 'password',
        isPublic: false,
        sortOrder: 6,
      },
    });
    invalidateAppConfigCache();

    console.log(`\nRegistrert webhook ${result.id}`);
    console.log(`URL:    ${url}`);
    console.log(`Events: ${VIPPS_WEBHOOK_EVENTS.length} stk`);
    console.log('Secret lagret i AppConfig (vippsWebhookSecret) — ikke skrevet til terminalen.');
    return;
  }

  console.log('Bruk: npx tsx scripts/vipps-webhook.ts <list|register|delete <id>>');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
