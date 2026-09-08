// Concurrency proof for the double-booking guard. Fires N simultaneous
// createPendingBooking calls for the SAME machine + date and asserts exactly
// one wins — the rest must lose on the BookingDateLock unique constraint /
// slot exhaustion. This converts "race-safe by construction" into a
// demonstrated fact. Self-cleaning.
//
// Run:
//   DATABASE_URL="file:$(pwd)/prisma/prisma/db/custom.db" npx tsx scripts/test-concurrency.ts
import { db } from '@/lib/db';
import { buildQuote } from '@/lib/domain/quote';
import { createPendingBooking } from '@/lib/booking-service';
import { getRentalDateRange } from '@/lib/availability';

const N = 12; // simultaneous attempts for a single quantity-1 slot
let pass = 0, fail = 0;
function check(label: string, cond: boolean, detail = '') {
  if (cond) { console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`); pass++; }
  else { console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); fail++; }
}

function nextFriday(daysAhead: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function main() {
  // Ensure the same SQLite pragmas the server uses are active BEFORE the
  // burst (the app applies these via a fire-and-forget IIFE at module load;
  // a standalone script can race ahead of it).
  await db.$queryRawUnsafe('PRAGMA busy_timeout = 5000');
  await db.$queryRawUnsafe('PRAGMA journal_mode = WAL');

  const machine = await db.machine.findFirst({ where: { isActive: true } });
  if (!machine) { console.log('ABORT: no active machine'); process.exit(1); }
  const startDate = nextFriday(120); // far out, unlikely to collide with real data
  const email = `concurrency-test+${Date.now()}@example.com`;

  console.log(`\n[setup] ${N} parallel weekend bookings, machine=${machine.name} (qty=${machine.quantity}), date=${startDate}`);

  const quote = await buildQuote({
    rentalType: 'weekend', startDate, machineId: machine.id, selfPickup: true,
    deliveryDistance: 0, deliveryFee: 0, extraHours: 0, email, phone: '41234567', customDays: null, code: null,
  });

  const attempt = () => createPendingBooking({
    name: 'Concurrency Test', phone: '41234567', email,
    deliveryAddress: '', rentalType: 'weekend', startDate,
    selfPickup: true, deliveryDistance: 0, deliveryFee: 0,
    termsAccepted: true, machineId: machine.id, expectedTotalKr: quote.totalPrice,
  });

  console.log('\n[run] firing all attempts simultaneously…');
  const results = await Promise.allSettled(Array.from({ length: N }, attempt));

  const wins = results.filter((r) => r.status === 'fulfilled');
  const losses = results.filter((r) => r.status === 'rejected');
  check('exactly ONE booking succeeded', wins.length === 1, `${wins.length} won, ${losses.length} rejected`);

  // Diagnostic: show the distinct rejection reasons.
  const reasons = new Map<string, number>();
  for (const r of losses) {
    if (r.status === 'rejected') {
      const m = ((r.reason as Error)?.message ?? String(r.reason)).slice(0, 70);
      reasons.set(m, (reasons.get(m) ?? 0) + 1);
    }
  }
  for (const [m, n] of reasons) console.log(`     · ${n}× "${m}"`);

  // Losers must fail for the RIGHT reason (slot taken), not some unrelated error.
  const occupiedMsgs = losses.filter(
    (r) => r.status === 'rejected' && /opptatt|allerede brukt/i.test((r.reason as Error)?.message ?? '')
  ).length;
  check('all losers failed cleanly (occupied / busy)', occupiedMsgs === losses.length, `${occupiedMsgs}/${losses.length}`);

  // DB truth: exactly one booking + exactly one lock per rental day, no extras.
  const range = getRentalDateRange(startDate, 'weekend');
  const bookings = await db.booking.findMany({ where: { email } });
  const locks = await db.bookingDateLock.findMany({
    where: { machineId: machine.id, date: { in: range.map((d) => new Date(d + 'T00:00:00')) } },
  });
  check('DB has exactly 1 booking', bookings.length === 1, `${bookings.length}`);
  check('DB has 1 lock per rental day, no duplicates', locks.length === range.length, `${locks.length} locks for ${range.length} days`);

  // Cleanup
  console.log('\n[cleanup]');
  const ids = bookings.map((b) => b.id);
  await db.bookingDateLock.deleteMany({ where: { bookingId: { in: ids } } });
  await db.acceptedContract.deleteMany({ where: { bookingId: { in: ids } } }).catch(() => {});
  await db.booking.deleteMany({ where: { email } });
  console.log('  ✓ test bookings + locks removed');

  console.log(`\n==== ${fail === 0 ? 'ALL PASS' : 'FAILURES PRESENT'}: ${pass} passed, ${fail} failed ====\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('test crashed:', err); process.exit(1); });
