// End-to-end Stripe sandbox test. Drives the real customer HTTP path against
// the running server (localhost:3000), then exercises webhook confirmation,
// idempotency, and a real test-mode charge + refund. Cleans up after itself.
//
// Run:
//   DATABASE_URL="file:$(pwd)/prisma/prisma/db/custom.db" \
//   BASE_URL=http://localhost:3000 TEST_EMAIL=you@example.com \
//   npx tsx scripts/test-stripe-flow.ts
import Stripe from 'stripe';
import { db } from '@/lib/db';
import { refundBookingPayment } from '@/lib/stripe';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const TEST_EMAIL = process.env.TEST_EMAIL || 'stripe-test@example.com';

let pass = 0, fail = 0;
function check(label: string, cond: boolean, detail = '') {
  if (cond) { console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`); pass++; }
  else { console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); fail++; }
}

function nextFriday(daysAhead: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  while (d.getDay() !== 5) d.setDate(d.getDate() + 1); // 5 = Friday
  return d.toISOString().slice(0, 10);
}

async function main() {
  // --- Load Stripe config straight from the DB (same source the app uses) ---
  const rows = await db.appConfig.findMany({
    where: { key: { in: ['stripeSecretKey', 'stripeWebhookSecret'] } },
  });
  const cfg: Record<string, string> = {};
  for (const r of rows) cfg[r.key] = r.value;
  const secret = cfg.stripeSecretKey;
  const whsec = cfg.stripeWebhookSecret;

  console.log('\n[0] Preconditions');
  check('secret key is TEST mode', secret.startsWith('sk_test_'));
  check('webhook secret present', !!whsec);
  if (!secret.startsWith('sk_test_')) { console.log('ABORT: not test mode'); process.exit(1); }

  const stripe = new Stripe(secret);
  const machine = await db.machine.findFirst({ where: { isActive: true } });
  if (!machine) { console.log('ABORT: no active machine'); process.exit(1); }
  const startDate = nextFriday(63);

  // --- 1. Quote (real pricing authority) ---
  console.log('\n[1] POST /api/quote (weekend, self-pickup)');
  const qRes = await fetch(`${BASE}/api/quote`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    // Include email/phone so the quote reflects the first-time discount the
    // booking endpoint will also apply — otherwise the drift guard (correctly)
    // rejects the mismatch.
    body: JSON.stringify({ rentalType: 'weekend', startDate, machineId: machine.id, selfPickup: true, email: TEST_EMAIL, phone: '41234567' }),
  });
  const quote = await qRes.json();
  check('quote 200', qRes.status === 200, `total=${quote.totalPrice} kr`);

  // --- 2. Create booking (drift-checked against the quote) ---
  console.log('\n[2] POST /api/bookings');
  const bRes = await fetch(`${BASE}/api/bookings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Stripe Test', phone: '41234567', email: TEST_EMAIL,
      deliveryAddress: '', rentalType: 'weekend', startDate,
      selfPickup: true, deliveryDistance: 0, deliveryFee: 0,
      termsAccepted: true, machineId: machine.id, expectedTotalKr: quote.totalPrice,
    }),
  });
  const bJson = await bRes.json();
  check('booking 201', bRes.status === 201, bJson?.booking?.reference);
  const booking = bJson.booking;
  if (!booking) { console.log('ABORT:', JSON.stringify(bJson)); process.exit(1); }
  check('booking is pending', booking.status === 'pending');

  // --- 3. Create Stripe Checkout session (real Stripe API call) ---
  console.log('\n[3] POST /api/payment/stripe/create');
  const cRes = await fetch(`${BASE}/api/payment/stripe/create`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookingId: booking.id }),
  });
  const cJson = await cRes.json();
  check('create session 200', cRes.status === 200, cJson.sessionId);
  const sessionId = cJson.sessionId;

  // --- 4. Verify the session at Stripe matches the booking ---
  console.log('\n[4] Verify Checkout session at Stripe');
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  check('amount_total == total*100', session.amount_total === Math.round(booking.totalPrice * 100), `${session.amount_total} øre`);
  check('currency nok', session.currency === 'nok');
  check('status open', session.status === 'open');
  check('metadata.bookingId matches', session.metadata?.bookingId === booking.id);
  check('expires_at set', !!session.expires_at);

  // --- 5. Real test-mode charge (so the refund path has a real PI) ---
  console.log('\n[5] Create + confirm a real test PaymentIntent (pm_card_visa)');
  const pi = await stripe.paymentIntents.create({
    amount: Math.round(booking.totalPrice * 100), currency: 'nok',
    payment_method: 'pm_card_visa', confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
  });
  check('paymentIntent succeeded', pi.status === 'succeeded', pi.id);

  // --- 6. Fire a signed webhook: checkout.session.completed ---
  console.log('\n[6] POST signed checkout.session.completed → /api/payment/stripe/webhook');
  const evt = {
    id: 'evt_test_' + Date.now(), object: 'event', api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000), type: 'checkout.session.completed',
    data: { object: { id: sessionId, object: 'checkout.session', metadata: { bookingId: booking.id }, payment_intent: pi.id, status: 'complete', payment_status: 'paid' } },
  };
  const payload = JSON.stringify(evt);
  const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: whsec });
  const wRes = await fetch(`${BASE}/api/payment/stripe/webhook`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: payload,
  });
  check('webhook 200', wRes.status === 200, JSON.stringify(await wRes.json()));

  // --- 7. Booking confirmed + paid in DB ---
  console.log('\n[7] Booking confirmed in DB');
  await new Promise((r) => setTimeout(r, 500));
  const confirmed = await db.booking.findUnique({ where: { id: booking.id } });
  check('status confirmed', confirmed?.status === 'confirmed');
  check('fullyPaidAt set', !!confirmed?.fullyPaidAt);
  check('stripePaymentIntentId stored', confirmed?.stripePaymentIntentId === pi.id);

  // --- 8. Idempotency: replay the same event ---
  console.log('\n[8] Replay same webhook event (idempotency)');
  const wRes2 = await fetch(`${BASE}/api/payment/stripe/webhook`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: payload,
  });
  const w2 = await wRes2.json();
  check('replay 200 + duplicate', wRes2.status === 200 && w2.duplicate === true, JSON.stringify(w2));

  // --- 9. Bad signature is rejected ---
  console.log('\n[9] Tampered signature rejected');
  const wRes3 = await fetch(`${BASE}/api/payment/stripe/webhook`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' }, body: payload,
  });
  check('bad sig → 400', wRes3.status === 400);

  // --- 10. Real refund via our refundBookingPayment ---
  console.log('\n[10] Refund via refundBookingPayment');
  const fresh = await db.booking.findUnique({ where: { id: booking.id } });
  const refund = fresh ? await refundBookingPayment(fresh) : null;
  check('refund created', !!refund, refund ? `${refund.amountRefunded} kr (${refund.refundId})` : 'null');
  check('refund amount == total', refund?.amountRefunded === booking.totalPrice);

  // --- Cleanup: remove all test rows so prod data stays clean ---
  console.log('\n[cleanup]');
  await db.acceptedContract.deleteMany({ where: { bookingId: booking.id } }).catch(() => {});
  await db.bookingDateLock.deleteMany({ where: { bookingId: booking.id } });
  await db.webhookEvent.deleteMany({ where: { eventId: evt.id } });
  await db.booking.delete({ where: { id: booking.id } });
  console.log('  ✓ test booking + locks + contract + webhook event removed');

  console.log(`\n==== ${fail === 0 ? 'ALL PASS' : 'FAILURES PRESENT'}: ${pass} passed, ${fail} failed ====\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('test crashed:', err); process.exit(1); });
