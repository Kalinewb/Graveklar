import { createSessionToken } from '../src/lib/admin-auth';
import { db } from '../src/lib/db';

async function main() {
  const token = await createSessionToken();
  const b = await db.booking.findFirst({ where: { status: 'confirmed' } });
  if (!b) {
    console.log('no booking');
    return;
  }

  const res = await fetch(`http://localhost:3000/api/admin/bookings/${b.id}/contract-signing`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `graveklar_admin_session=${token}`,
    },
    body: JSON.stringify({ action: 'mark_signed', note: 'test', digipostReference: 'DP-123' }),
  });

  const text = await res.text();
  console.log('status', res.status);
  console.log('body', text.slice(0, 500));
}

main().finally(() => db.$disconnect());
