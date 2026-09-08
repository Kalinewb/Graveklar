import { NextRequest, NextResponse } from 'next/server';
import { persistTotpSecret, isTotpEnrolled, verifyTotpCode, verifyTotpCodeAgainst } from '@/lib/totp';
import { createRateLimiter } from '@/lib/rate-limit';
import { writeAuditLog } from '@/lib/audit-log';
import { db } from '@/lib/db';
import { verifyHashedPassword, verifyAdminPassword } from '@/lib/admin-auth';
import { clientIdentity } from '@/lib/client-ip';

export const dynamic = 'force-dynamic';

// 10⁶ codes is brute-forceable from a single IP without a limiter.
const checkLimit = createRateLimiter(10, 5 * 60 * 1000);

// Two-mode endpoint:
//
//   1. Enrollment finalisation — body: { secret, code, password }
//      If no secret is enrolled yet, verifies the admin's password AND that
//      `code` matches `secret`, then persists `secret`. Password re-entry is
//      required so a stolen session can't silently enroll an attacker's TOTP
//      and lock out the real admin.
//
//   2. Verification — body: { code }
//      Used when a sensitive save needs to confirm the admin's identity.
//      Returns { ok: true } if `code` matches the stored secret.

export async function POST(request: NextRequest) {
  try {
    const ip = clientIdentity(request);
    if (checkLimit(ip)) {
      return NextResponse.json(
        { error: 'For mange forsøk. Prøv igjen om 5 minutter.' },
        { status: 429 }
      );
    }

    const { secret, code, password } = (await request.json()) as { secret?: string; code?: string; password?: string };
    if (typeof code !== 'string') {
      return NextResponse.json({ error: 'Kode mangler.' }, { status: 400 });
    }

    if (secret) {
      // Enrollment finalisation. Requires password re-entry.
      if (await isTotpEnrolled()) {
        return NextResponse.json({ error: '2FA er allerede satt opp.' }, { status: 409 });
      }
      if (!password || typeof password !== 'string') {
        return NextResponse.json({ error: 'Passord påkrevd for å aktivere 2FA.' }, { status: 400 });
      }
      const hashRow = await db.appConfig.findUnique({ where: { key: 'adminPasswordHash' } });
      const passwordOk = hashRow?.value
        ? await verifyHashedPassword(password, hashRow.value)
        : await verifyAdminPassword(password);
      if (!passwordOk) {
        await writeAuditLog({
          action: 'admin.totp_enroll_failed',
          changes: [{ key: 'reason', from: null, to: 'invalid_password' }],
          request,
        });
        return NextResponse.json({ error: 'Passord stemmer ikke.' }, { status: 401 });
      }
      if (!(await verifyTotpCodeAgainst(secret, code))) {
        return NextResponse.json({ error: 'Koden stemmer ikke. Sjekk at klokken er synkronisert.' }, { status: 400 });
      }
      await persistTotpSecret(secret);
      await writeAuditLog({
        action: 'admin.totp_enroll',
        changes: [{ key: 'enrolled', from: false, to: true }],
        request,
      });
      return NextResponse.json({ success: true, enrolled: true });
    }

    // Plain verification.
    const ok = await verifyTotpCode(code);
    if (!ok) {
      await writeAuditLog({
        action: 'admin.totp_verify_failed',
        changes: [{ key: 'reason', from: null, to: 'invalid_code' }],
        request,
      });
      return NextResponse.json({ error: 'Ugyldig kode.' }, { status: 400 });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[totp/verify] error', err);
    return NextResponse.json({ error: 'Verifisering feilet.' }, { status: 500 });
  }
}
