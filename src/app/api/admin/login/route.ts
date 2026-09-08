import { NextRequest, NextResponse } from 'next/server';
import {
  createSessionToken,
  sessionCookieOptions,
  isSecureRequest,
  verifyAdminPassword,
  verifyHashedPassword,
  isDefaultPassword,
  hashPassword,
  needsRehash,
} from '@/lib/admin-auth';
import { isTotpEnrolled, verifyTotpCode } from '@/lib/totp';
import { createRateLimiter } from '@/lib/rate-limit';
import { clientIdentity } from '@/lib/client-ip';
import { writeAuditLog } from '@/lib/audit-log';
import { db } from '@/lib/db';

const checkLimit = createRateLimiter(10, 15 * 60 * 1000);

export async function POST(request: NextRequest) {
  try {
    if (checkLimit(clientIdentity(request))) {
      return NextResponse.json(
        { error: 'For mange forsøk. Prøv igjen om 15 minutter.' },
        { status: 429 }
      );
    }

    // Parsed outside the catch-all below: a body that is not JSON is a client
    // mistake (400), not a server failure. Mapping it to 500 made a malformed
    // request indistinguishable from a real outage in the logs.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Ugyldig forespørsel' }, { status: 400 });
    }
    const { password, code } = (body ?? {}) as { password?: unknown; code?: unknown };
    if (!password || typeof password !== 'string') {
      return NextResponse.json({ error: 'Passord påkrevd' }, { status: 400 });
    }

    let authenticated = false;

    const hashRow = await db.appConfig.findUnique({ where: { key: 'adminPasswordHash' } });
    if (hashRow?.value) {
      authenticated = await verifyHashedPassword(password, hashRow.value);
      if (authenticated && needsRehash(hashRow.value)) {
        // Transparent upgrade of a legacy fast hash to PBKDF2 on the first
        // successful login. Best-effort — must never block the login itself.
        hashPassword(password)
          .then((h) => db.appConfig.update({ where: { key: 'adminPasswordHash' }, data: { value: h } }))
          .catch((err) => console.error('[admin-auth] password hash upgrade failed:', err));
      }
    } else {
      authenticated = await verifyAdminPassword(password);
    }

    if (!authenticated) {
      await writeAuditLog({
        action: 'auth.login_failed',
        changes: [{ key: 'reason', from: null, to: 'invalid_password' }],
        request,
      });
      return NextResponse.json({ error: 'Feil passord' }, { status: 401 });
    }

    // Second factor: TOTP. Only enforced when a secret is enrolled — before
    // first enrollment the password is the sole gate. After enrollment, no
    // path can issue a session without a valid 6-digit code.
    if (await isTotpEnrolled()) {
      const codeStr = typeof code === 'string' ? code : '';
      if (!codeStr) {
        return NextResponse.json(
          { error: '2FA-kode påkrevd.', requiresTotp: true },
          { status: 401 },
        );
      }
      if (!(await verifyTotpCode(codeStr))) {
        await writeAuditLog({
          action: 'auth.login_failed',
          changes: [{ key: 'reason', from: null, to: 'invalid_totp' }],
          request,
        });
        return NextResponse.json(
          { error: 'Ugyldig 2FA-kode.', requiresTotp: true },
          { status: 401 },
        );
      }
    }

    await writeAuditLog({
      action: 'auth.login',
      changes: [{ key: 'success', from: null, to: true }],
      request,
    });

    const mustChangePassword = !hashRow?.value && isDefaultPassword();

    const token = await createSessionToken();
    // Only mark the cookie as Secure when the request really came in over
    // HTTPS. NODE_ENV alone is the wrong signal — it breaks plain-HTTP LAN
    // access.
    const opts = sessionCookieOptions(token, isSecureRequest(request));
    const res = NextResponse.json({ success: true, mustChangePassword });
    res.cookies.set(opts.name, opts.value, {
      httpOnly: opts.httpOnly,
      secure: opts.secure,
      sameSite: opts.sameSite,
      path: opts.path,
      maxAge: opts.maxAge,
    });
    return res;
  } catch (err) {
    console.error('admin/login error:', err);
    return NextResponse.json({ error: 'Innlogging feilet' }, { status: 500 });
  }
}
