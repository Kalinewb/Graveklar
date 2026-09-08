import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { loadAppConfig } from '@/lib/app-config';
import { createRateLimiter } from '@/lib/rate-limit';
import { settleAuthorizedPayment } from '@/lib/vipps-payments';
import { clientIdentity, nullableClientIdentity } from '@/lib/client-ip';

export const dynamic = 'force-dynamic';

/**
 * Every other money-touching route is bounded per client — vipps/create is
 * 5/15 min, stripe/create 30/15 min, booking/cancel 10/15 min — and this one,
 * which reaches Vipps and can capture, had nothing (finding F-4). A returning
 * customer hits it once, twice if they refresh; ten is already generous.
 */
const checkLimit = createRateLimiter(10, 15 * 60 * 1000);

/**
 * Where Vipps sends the customer back to after they approve (or abandon) the
 * payment in the app.
 *
 * This is a convenience path, not the source of truth: the webhook is what
 * guarantees a payment gets settled even if the customer closes the browser on
 * the way back. Both call the same idempotent settle function, so whichever
 * arrives first wins and the other is a no-op.
 *
 * Deferred (R-8, docs/audit/phase1c-payments-cancellation.md): settling from a
 * GET is still the wrong shape — a GET must be safe, and this one can move
 * money. The intended design leaves settlement to the webhook and has the
 * return page ask for it over an explicit POST. That change cannot be
 * validated against a live Vipps in this audit, so for now the route is
 * bounded (above) and idempotent in effect (`settleAuthorizedPayment` captures
 * under a per-amount idempotency key and confirms through an atomic
 * compare-and-set, so repeats are no-ops).
 */
export async function GET(request: NextRequest) {
  const appConfig = await loadAppConfig();
  const origin = (appConfig['siteUrl'] || '').replace(/\/+$/, '') || request.nextUrl.origin;
  const reference = request.nextUrl.searchParams.get('ref');

  const redirect = (status: string, ref?: string) =>
    NextResponse.redirect(
      `${origin}/?vipps=${status}${ref ? `&ref=${encodeURIComponent(ref)}` : ''}`,
    );

  // Plain text rather than JSON: whoever is over the budget is a browser, and
  // the one thing worth telling them is to wait.
  if (checkLimit(clientIdentity(request))) {
    return new NextResponse('For mange forsøk på kort tid. Vent et par minutter og prøv igjen.', {
      status: 429,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '900' },
    });
  }

  if (!reference) return redirect('error');

  try {
    const ip =
      nullableClientIdentity(request);

    const outcome = await settleAuthorizedPayment(reference, { acceptedFromIp: ip });

    switch (outcome.status) {
      case 'confirmed':
      case 'already_handled':
        return redirect('success', outcome.booking.reference);

      case 'pending': {
        // The customer is back before Vipps finished processing. Send them to
        // a "we're checking" state rather than claiming failure — the webhook
        // will settle it within seconds.
        const booking = await db.booking.findUnique({ where: { vippsReference: reference } });
        return redirect('processing', booking?.reference);
      }

      case 'failed': {
        const booking = await db.booking.findUnique({ where: { vippsReference: reference } });
        return redirect('cancelled', booking?.reference);
      }

      case 'amount_mismatch':
        console.error(
          `[vipps] amount mismatch on ${reference}: authorized ${outcome.authorizedKr} kr, expected ${outcome.expectedKr} kr`,
        );
        return redirect('error');

      case 'unknown_reference':
      default:
        return redirect('error');
    }
  } catch (err) {
    console.error('Vipps return handler error:', err);
    return redirect('error');
  }
}
