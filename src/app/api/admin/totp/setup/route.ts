import { NextRequest, NextResponse } from 'next/server';
import { startTotpEnrollment, isTotpEnrolled, requireTotp } from '@/lib/totp';
import { db } from '@/lib/db';
import { verifyHashedPassword, verifyAdminPassword } from '@/lib/admin-auth';
import { writeAuditLog } from '@/lib/audit-log';
import QRCode from 'qrcode';

export const dynamic = 'force-dynamic';

// Returns a fresh enrollment payload (secret + otpauth URI + a PNG data URL
// for the QR code). The caller stores the secret in their authenticator
// app, then POSTs a verifying code (+ admin password) to
// /api/admin/totp/verify to persist.
//
// Refuses if a secret is already enrolled — re-enrollment requires
// explicit removal via DELETE below.
export async function GET() {
  if (await isTotpEnrolled()) {
    return NextResponse.json(
      { error: '2FA er allerede satt opp. Slett eksisterende kode først.' },
      { status: 409 }
    );
  }
  const { secret, otpauthUri, accountLabel } = startTotpEnrollment();
  let qrDataUrl: string;
  try {
    qrDataUrl = await QRCode.toDataURL(otpauthUri, { width: 240, margin: 2 });
  } catch (err) {
    return NextResponse.json(
      { error: 'Kunne ikke generere QR-kode: ' + (err as Error).message },
      { status: 500 }
    );
  }
  return NextResponse.json({ secret, otpauthUri, qrDataUrl, accountLabel });
}

// Reset the TOTP enrollment. Requires BOTH the current TOTP code (so a
// stolen session can't disable 2FA without the authenticator) AND the
// admin password (so a malicious actor who somehow has the current code
// still has to know the password). Body: { password }.
export async function DELETE(request: NextRequest) {
  const guard = await requireTotp(request);
  if (!guard.ok && guard.reason !== 'not-enrolled') {
    return NextResponse.json(
      { error: guard.reason === 'missing' ? 'Kode mangler.' : 'Ugyldig kode.' },
      { status: 401 }
    );
  }
  // Always require password — even when no TOTP is enrolled, leaving the
  // door open without the password would let a stolen session blank-slate
  // the security setup.
  const { password } = (await request.json().catch(() => ({}))) as { password?: string };
  if (!password || typeof password !== 'string') {
    return NextResponse.json({ error: 'Passord påkrevd for å slette 2FA.' }, { status: 400 });
  }
  const hashRow = await db.appConfig.findUnique({ where: { key: 'adminPasswordHash' } });
  const passwordOk = hashRow?.value
    ? await verifyHashedPassword(password, hashRow.value)
    : await verifyAdminPassword(password);
  if (!passwordOk) {
    await writeAuditLog({
      action: 'admin.totp_remove_failed',
      changes: [{ key: 'reason', from: null, to: 'invalid_password' }],
      request,
    });
    return NextResponse.json({ error: 'Passord stemmer ikke.' }, { status: 401 });
  }

  await db.adminTotp.deleteMany();
  await writeAuditLog({
    action: 'admin.totp_remove',
    changes: [{ key: 'enrolled', from: true, to: false }],
    request,
  });
  return NextResponse.json({ success: true });
}
