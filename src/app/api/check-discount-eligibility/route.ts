import { NextRequest, NextResponse } from 'next/server';
import { isFirstTimeEligible, validateRepeatCode } from '@/lib/discount-engine';
import { loadAppConfig } from '@/lib/app-config';
import { createRateLimiter } from '@/lib/rate-limit';
import { clientIdentity } from '@/lib/client-ip';

export const dynamic = 'force-dynamic';

// Tightened from 40 → 15 per minute. A real booking session makes only a
// handful of debounced calls; the lower ceiling slows bulk email enumeration
// (probing whether an address has rented before) without hurting UX.
const checkLimit = createRateLimiter(15, 60_000);

// Customer-facing eligibility check. Called from the booking form on email/
// phone blur (debounced) so the breakdown can preview the discount line
// before the customer submits. The real authority is the create-Stripe-
// session endpoint, which re-runs the same logic at the boundary.
//
// Gate semantics MUST match `computeDiscount` in lib/discount-engine.ts —
// any divergence here means the previewed discount won't match what's
// actually billed.

export async function GET(request: NextRequest) {
  const ip = clientIdentity(request);
  if (checkLimit(ip)) {
    return NextResponse.json({ firstTimeEligible: false, code: null }, { status: 429 });
  }

  const { searchParams } = new URL(request.url);
  const email = searchParams.get('email') || '';
  const phone = searchParams.get('phone') || '';
  const code  = searchParams.get('code')  || '';

  const appCfg = await loadAppConfig();
  const enableFirst = appCfg['enableFirstTimeDiscount'] === 'true';
  const enableRepeat = appCfg['enableRepeatDiscount'] === 'true';
  const firstPct = Number(appCfg['firstTimeDiscountPercent'] || '0') || 0;
  const repeatPct = Number(appCfg['repeatDiscountPercent'] || '0') || 0;

  const firstTimeEligible =
    enableFirst && firstPct > 0 && (await isFirstTimeEligible(email, phone));

  let codeResult: {
    valid: boolean;
    reason?: string;
    percent?: number;
    kind?: 'repeat' | 'campaign';
  } = { valid: false };

  if (code) {
    const v = await validateRepeatCode(code, email);
    if (v.ok) {
      // Campaigns are independent of the enableRepeat flag — separate
      // marketing channel. Only the goodwill RETUR codes are gated.
      if (v.kind === 'campaign') {
        codeResult = { valid: true, kind: 'campaign', percent: v.percent };
      } else if (enableRepeat && repeatPct > 0) {
        codeResult = { valid: true, kind: 'repeat', percent: repeatPct };
      } else {
        codeResult = { valid: false, reason: 'inactive' };
      }
    } else {
      codeResult = { valid: false, reason: v.reason };
    }
  }

  // `computeDiscount` treats first-time and repeat as mutually exclusive — you
  // cannot be both new and returning — and keeps first-time, which needs the
  // stricter evidence. Reporting the two gates independently told a first-time
  // customer holding a RETUR code that both applied while only one was ever
  // charged. Campaign codes are a separate channel and DO stack, so they are
  // untouched.
  if (firstTimeEligible && codeResult.valid && codeResult.kind === 'repeat') {
    codeResult = { valid: false, reason: 'superseded' };
  }

  return NextResponse.json({
    firstTimeEligible,
    firstTimePercent: firstPct,
    code: codeResult,
  });
}
