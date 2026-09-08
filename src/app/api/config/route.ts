import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { DEFAULT_CONFIG, DEFAULT_CONFIGS } from '@/lib/config-defaults';
import { loadConfigValues, invalidateConfigCache } from '@/lib/config-server';
import { requireTotp } from '@/lib/totp';
import { writeAuditLog, type AuditChange } from '@/lib/audit-log';

export async function GET() {
  try {
    const values = await loadConfigValues();
    const configs = await db.pricingConfig.findMany();
    return NextResponse.json({ configs, values });
  } catch (error) {
    console.error('Config GET error:', error);
    return NextResponse.json({ configs: DEFAULT_CONFIGS, values: DEFAULT_CONFIG });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { configs } = body as { configs: { key: string; value: number }[] };

    if (!configs || !Array.isArray(configs)) {
      return NextResponse.json({ error: 'configs array is required' }, { status: 400 });
    }

    // Pricing IS money. Changing a day-rate or delivery fee moves what every
    // customer is charged at Stripe, so it must clear the same second-factor
    // bar as the Stripe/SMTP settings in /api/admin/app-config. Without this
    // a stolen admin session could silently re-price the whole catalogue.
    // The proxy (src/proxy.ts) already enforces a valid admin session on POST here;
    // this adds the TOTP layer on top. The customer-facing /api/quote and
    // booking flow only READ pricing, so they're unaffected.
    const guard = await requireTotp(request);
    if (!guard.ok) {
      const errorMsg = guard.reason === 'not-enrolled'
        ? 'Aktivér 2FA før du endrer priser.'
        : guard.reason === 'missing'
          ? '2FA-kode mangler for prisendringer.'
          : 'Ugyldig 2FA-kode.';
      return NextResponse.json(
        {
          error: errorMsg,
          requiresTotp: true,
          requiresTotpEnrollment: guard.reason === 'not-enrolled',
        },
        { status: 401 },
      );
    }

    // Snapshot current values so the audit log captures from/to, same as the
    // app-config handler. Pricing changes are revenue-affecting and belong in
    // the audit trail.
    const existing = await db.pricingConfig.findMany({
      where: { key: { in: configs.map((c) => c.key) } },
    });
    const existingByKey = Object.fromEntries(existing.map((r) => [r.key, r.value]));

    for (const { key, value } of configs) {
      const defaultConfig = DEFAULT_CONFIGS.find((d) => d.key === key);
      await db.pricingConfig.upsert({
        where: { key },
        update: { value },
        create: {
          key,
          value,
          label: defaultConfig?.label ?? key,
          group: defaultConfig?.group ?? 'rental',
        },
      });
    }

    const changes: AuditChange[] = configs
      .filter((c) => existingByKey[c.key] !== c.value)
      .map((c) => ({
        key: c.key,
        from: existingByKey[c.key] != null ? String(existingByKey[c.key]) : null,
        to: String(c.value),
      }));
    if (changes.length > 0) {
      await writeAuditLog({ action: 'pricing.update', changes, request }).catch((err) =>
        console.error('pricing audit log failed:', err),
      );
    }

    invalidateConfigCache();
    const values = await loadConfigValues();
    const updatedConfigs = await db.pricingConfig.findMany();
    return NextResponse.json({ success: true, configs: updatedConfigs, values });
  } catch (error) {
    console.error('Config POST error:', error);
    return NextResponse.json({ error: 'Kunne ikke lagre innstillinger' }, { status: 500 });
  }
}
