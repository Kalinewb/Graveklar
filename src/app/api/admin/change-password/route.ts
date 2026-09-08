import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { hashPassword, verifyAdminPassword, verifyHashedPassword } from '@/lib/admin-auth';
import { createRateLimiter } from '@/lib/rate-limit';
import { writeAuditLog } from '@/lib/audit-log';
import { clientIdentity } from '@/lib/client-ip';
import { requireTotp } from '@/lib/totp';

export const dynamic = 'force-dynamic';

// Brute-forcing the *current* password via this endpoint is just as
// damaging as via the login route; rate-limit on the same scale.
const checkLimit = createRateLimiter(10, 15 * 60 * 1000);

export async function POST(request: NextRequest) {
  try {
    const ip = clientIdentity(request);
    if (checkLimit(ip)) {
      return NextResponse.json(
        { error: 'For mange forsøk. Prøv igjen om 15 minutter.' },
        { status: 429 }
      );
    }

    // Second factor, on the same terms as DELETE /api/admin/totp/setup: a new
    // password is a credential-level change, so a stolen session must not be
    // able to make one on its own and lock the real admin out. `not-enrolled`
    // stays open — before the first enrollment the password is the sole gate,
    // which is what the forced-change flow at first login relies on.
    const guard = await requireTotp(request);
    if (!guard.ok && guard.reason !== 'not-enrolled') {
      return NextResponse.json(
        {
          error: guard.reason === 'missing' ? 'Kode mangler.' : 'Ugyldig kode.',
          requiresTotp: true,
        },
        { status: 401 }
      );
    }

    const { currentPassword, newPassword } = await request.json();

    if (!currentPassword || !newPassword) {
      return NextResponse.json({ error: 'Begge passord er påkrevd.' }, { status: 400 });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return NextResponse.json({ error: 'Nytt passord må være minst 8 tegn.' }, { status: 400 });
    }

    const hashRow = await db.appConfig.findUnique({ where: { key: 'adminPasswordHash' } });
    let currentValid = false;
    if (hashRow?.value) {
      currentValid = await verifyHashedPassword(currentPassword, hashRow.value);
    } else {
      currentValid = await verifyAdminPassword(currentPassword);
    }

    if (!currentValid) {
      await writeAuditLog({
        action: 'admin.password_change_failed',
        changes: [{ key: 'reason', from: null, to: 'invalid_current_password' }],
        request,
      });
      return NextResponse.json({ error: 'Nåværende passord er feil.' }, { status: 401 });
    }

    const hashed = await hashPassword(newPassword);
    await db.appConfig.upsert({
      where: { key: 'adminPasswordHash' },
      create: { key: 'adminPasswordHash', value: hashed, label: 'Admin-passord (hash)', group: 'system', type: 'hidden', isPublic: false, sortOrder: 99 },
      update: { value: hashed },
    });

    await writeAuditLog({
      action: 'admin.password_change',
      changes: [{ key: 'adminPasswordHash', from: '***', to: '***' }],
      request,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('admin/change-password error:', err);
    return NextResponse.json({ error: 'Kunne ikke endre passord.' }, { status: 500 });
  }
}
