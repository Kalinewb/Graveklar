import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { loadAppConfig, invalidateAppConfigCache, maskPasswords, PASSWORD_MASK } from '@/lib/app-config';
import { APP_CONFIG_DEFAULTS, SENSITIVE_GROUPS } from '@/lib/app-config-defaults';
import { geocodeAddress, normalizeAddress } from '@/lib/geocode';
import { getDeliveryOrigin, setDeliveryOrigin } from '@/lib/system-state';
import { requireTotp } from '@/lib/totp';
import { writeAuditLog, type AuditChange } from '@/lib/audit-log';

export const dynamic = 'force-dynamic';

/**
 * Is this update the UI echoing a masked secret straight back?
 *
 * Only `password` and `hidden` keys are masked by `maskPasswords()`, so only
 * those may treat the sentinel as "no change". Any other field's value is its
 * own — including the (admittedly odd) case of a text field whose content is
 * literally the mask string.
 */
function isMaskedEcho(def: { type: string } | undefined, value: unknown): boolean {
  return value === PASSWORD_MASK && (def?.type === 'password' || def?.type === 'hidden');
}

// Field metadata (label / control type / group / order) is owned by the code
// defaults; a DB row only owns its value. Merging here means a renamed label
// or a richer control type shows up in the admin without every row having
// to be re-saved first. Rows for keys no longer in the defaults keep what
// the DB has.
type AppConfigRow = Awaited<ReturnType<typeof db.appConfig.findMany>>[number];
function withCodeMeta(rows: AppConfigRow[]): AppConfigRow[] {
  const meta = new Map(APP_CONFIG_DEFAULTS.map((d) => [d.key, d]));
  return rows
    .map((r) => {
      const d = meta.get(r.key);
      return d
        ? { ...r, label: d.label, group: d.group, type: d.type, isPublic: d.isPublic, sortOrder: d.sortOrder }
        : r;
    })
    .sort((a, b) => a.group.localeCompare(b.group) || a.sortOrder - b.sortOrder);
}

export async function GET() {
  await loadAppConfig();
  const rows = await db.appConfig.findMany({ orderBy: [{ group: 'asc' }, { sortOrder: 'asc' }] });
  return NextResponse.json(maskPasswords(withCodeMeta(rows)));
}

export async function POST(request: NextRequest) {
  // Parsed outside the catch-all below: a body that is not JSON is a client
  // mistake, and answering it 500 "Lagring feilet" made "your browser sent
  // nonsense" indistinguishable from "the database is down" (I-3).
  let updates: { key: string; value: string | boolean }[];
  try {
    updates = await request.json() as { key: string; value: string | boolean }[];
  } catch {
    return NextResponse.json({ error: 'Ugyldig format' }, { status: 400 });
  }
  if (!Array.isArray(updates)) return NextResponse.json({ error: 'Ugyldig format' }, { status: 400 });

  try {
    const defaultsByKey = Object.fromEntries(APP_CONFIG_DEFAULTS.map((d) => [d.key, d]));

    // Sensitive-save guard. If ANY key in this batch belongs to a sensitive
    // group, the admin must have 2FA enrolled AND present a valid code.
    // Previously "not-enrolled" was allowed through so a fresh install could
    // be configured; that left a window where an attacker with a stolen
    // session could change Stripe/SMTP credentials with no second factor.
    // Now: enroll TOTP first via /admin → 2FA, THEN configure sensitive
    // settings. (TOTP enrollment itself doesn't need SMTP/Stripe to be set.)
    // Only keys whose stored value would actually change count — a full-form
    // save that merely echoes the current Stripe/SMTP values back is not a
    // sensitive change. Masked password echoes never are.
    const currentRows = await db.appConfig.findMany({
      where: { key: { in: updates.map((u) => u.key) } },
      select: { key: true, value: true },
    });
    const currentByKey = Object.fromEntries(currentRows.map((r) => [r.key, r.value]));
    const normalizeFor = (def: { type: string } | undefined, value: unknown): string =>
      def?.type === 'boolean' ? (value === true || value === 'true' ? 'true' : 'false') : String(value);
    const sensitiveKeys = updates.filter((u) => {
      const def = defaultsByKey[u.key];
      if (!def || !SENSITIVE_GROUPS.has(def.group)) return false;
      if (isMaskedEcho(def, u.value)) return false;
      return normalizeFor(def, u.value) !== (currentByKey[u.key] ?? def.value);
    });
    let totpEnforced = false;
    if (sensitiveKeys.length > 0) {
      const guard = await requireTotp(request);
      if (!guard.ok) {
        const errorMsg = guard.reason === 'not-enrolled'
          ? 'Aktivér 2FA før du endrer sensitive innstillinger.'
          : guard.reason === 'missing'
            ? '2FA-kode mangler for sensitive innstillinger.'
            : 'Ugyldig 2FA-kode.';
        return NextResponse.json(
          {
            error: errorMsg,
            sensitiveKeys: sensitiveKeys.map((k) => k.key),
            requiresTotp: true,
            requiresTotpEnrollment: guard.reason === 'not-enrolled',
          },
          { status: 401 }
        );
      }
      totpEnforced = true;
    }

    // Snapshot current values so the audit log captures from/to.
    const existing = await db.appConfig.findMany({
      where: { key: { in: updates.map((u) => u.key) } },
    });
    const existingByKey = Object.fromEntries(existing.map((r) => [r.key, r.value]));

    for (const { key, value } of updates) {
      const def = defaultsByKey[key];
      // Don't overwrite a secret with its own mask. The sentinel is only
      // special for the field types that are actually masked on the way out —
      // skipping it for every type silently discarded a text field whose
      // content happened to be the mask string, while still answering 200 (I-2).
      if (isMaskedEcho(def, value)) continue;
      // Normalize boolean fields to literal 'true'/'false' strings at the write
      // boundary so read-paths can rely on string comparison (fixes a class of
      // boolean-vs-string mismatches, e.g. maintenanceMode).
      const normalized: string = def?.type === 'boolean'
        ? (value === true || value === 'true' ? 'true' : 'false')
        : String(value);
      await db.appConfig.upsert({
        where: { key },
        update: { value: normalized },
        create: {
          key,
          value: normalized,
          label: def?.label ?? key,
          group: def?.group ?? 'system',
          type: def?.type ?? 'text',
          isPublic: def?.isPublic ?? false,
          sortOrder: def?.sortOrder ?? 99,
        },
      });
    }

    invalidateAppConfigCache();

    // If baseAddress was in this batch and the normalized value actually
    // changed, geocode it and write the derived lat/lng to SystemState.
    // AppConfig holds intent ("Industriveien 5"); SystemState holds the
    // resolved coordinates. Never the other way around.
    const baseAddressUpdate = updates.find((u) => u.key === 'baseAddress');
    let originResolved: { displayName: string; lat: number; lng: number } | null = null;
    let originGeocodeFailed = false;
    if (baseAddressUpdate) {
      const normalized = normalizeAddress(String(baseAddressUpdate.value));
      const currentOrigin = await getDeliveryOrigin();
      if (normalized && normalized !== currentOrigin?.address) {
        const geo = await geocodeAddress(normalized);
        if (geo) {
          await setDeliveryOrigin({
            address: geo.address,
            displayName: geo.displayName,
            lat: geo.lat,
            lng: geo.lng,
            resolvedAt: geo.resolvedAt,
          });
          originResolved = { displayName: geo.displayName, lat: geo.lat, lng: geo.lng };
        } else {
          originGeocodeFailed = true;
        }
      }
    }

    // Audit log: only sensitive keys are persisted (don't pollute the log
    // with hero-copy changes). For credential-type keys (Stripe/SMTP secrets)
    // we record *that* the value changed but redact the actual secret — the
    // audit log is read back via GET /api/admin/audit-log, and storing the
    // cleartext there would defeat the masking applied everywhere else.
    if (sensitiveKeys.length > 0) {
      const changes: AuditChange[] = sensitiveKeys
        .filter((u) => !isMaskedEcho(defaultsByKey[u.key], u.value))
        .map((u) => {
          const isSecret = defaultsByKey[u.key]?.type === 'password';
          const rawTo = typeof u.value === 'string' ? u.value : String(u.value);
          const rawFrom = existingByKey[u.key] ?? null;
          return {
            key: u.key,
            from: isSecret ? (rawFrom ? PASSWORD_MASK : null) : rawFrom,
            to: isSecret ? PASSWORD_MASK : rawTo,
          };
        });
      await writeAuditLog({ action: 'config.update', changes, request });
    }

    const rows = await db.appConfig.findMany({ orderBy: [{ group: 'asc' }, { sortOrder: 'asc' }] });
    return NextResponse.json({
      success: true,
      configs: maskPasswords(withCodeMeta(rows)),
      totpEnforced,
      ...(originResolved ? { deliveryOrigin: originResolved } : {}),
      ...(originGeocodeFailed ? { warning: 'Adressen kunne ikke geokodes — sjekk skrivemåten.' } : {}),
    });
  } catch (err) {
    console.error('admin/app-config error:', err);
    return NextResponse.json({ error: 'Lagring feilet' }, { status: 500 });
  }
}
