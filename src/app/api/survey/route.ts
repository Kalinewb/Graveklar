import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { createRateLimiter } from '@/lib/rate-limit';
import { loadAppConfig } from '@/lib/app-config';
import { validateRepeatCode } from '@/lib/discount-engine';
import { sendSurveyDiscountEmail } from '@/lib/email';
import { clientIdentity } from '@/lib/client-ip';

// Public, unauthenticated endpoint — rate-limit per IP so it can't be used to
// flood the SurveyResponse table. Matches the posture of the other public
// write endpoints (bookings, quote, delivery).
const checkLimit = createRateLimiter(10, 15 * 60 * 1000);

/** Generous ceiling for a wizard whose real answer set is well under 2 KB. */
const MAX_BODY_BYTES = 64 * 1024;
/** Keys the wizard sends that are not question rows: the email + its consent flag. */
const RESERVED_KEYS = new Set(['epost', 'samtykke']);
/** Longest single free-text answer we keep — the rest is truncated away. */
const MAX_ANSWER_CHARS = 2000;

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/** What a wizard answer can be: a scalar, or the string list a checkbox group
 *  produces. Anything else (a nested object, a function-shaped payload) is a
 *  client that is not our form. */
function isAnswerValue(v: unknown): boolean {
  if (v === null) return true;
  const t = typeof v;
  if (t === 'string') return (v as string).length <= MAX_ANSWER_CHARS;
  if (t === 'number') return Number.isFinite(v as number);
  if (t === 'boolean') return true;
  if (Array.isArray(v)) {
    return v.every((x) => typeof x === 'string' && x.length <= MAX_ANSWER_CHARS);
  }
  return false;
}

export async function POST(req: NextRequest) {
  const ip = clientIdentity(req);
  if (checkLimit(ip)) {
    return NextResponse.json({ error: 'For mange forsøk. Prøv igjen om litt.' }, { status: 429 });
  }

  // Anonymous, rate-limited-only endpoint that persists whatever it is sent,
  // so the payload is bounded three ways before it reaches the table
  // (finding F-6): a size cap, a key whitelist, and a value-type check. The
  // wizard's whole answer set is a few hundred bytes.
  const raw = await req.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Svaret er for stort.' }, { status: 400 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return NextResponse.json({ error: 'Ugyldig svar.' }, { status: 400 });
  }
  const body = parsed as Record<string, unknown>;

  // Keys must be questions this survey actually asks (every question row, not
  // just the active ones, so an answer already in flight when a question is
  // retired still lands) plus the two reserved keys below.
  const questionKeys = new Set(
    (await db.surveyQuestion.findMany({ select: { key: true } })).map((q) => q.key)
  );
  for (const [key, value] of Object.entries(body)) {
    if (!RESERVED_KEYS.has(key) && !questionKeys.has(key)) {
      return NextResponse.json({ error: `Ukjent felt: ${key}` }, { status: 400 });
    }
    if (!isAnswerValue(value)) {
      return NextResponse.json({ error: `Ugyldig verdi for feltet ${key}.` }, { status: 400 });
    }
  }

  // `epost` is the reserved email key (mirrors the old form); `samtykke` is the
  // single consent flag set by the email question's checkbox.
  const email = typeof body.epost === 'string' && body.epost.trim() ? body.epost.trim() : null;
  const consent = body.samtykke === true;

  await db.surveyResponse.create({
    data: {
      data: JSON.stringify(body),
      email,
    },
  });

  // Lead incentive: if enabled and the respondent left an email + consented,
  // hand out the configured shared campaign code (created in /admin/discount-
  // codes). The code is redeemed at booking time by the existing engine — we
  // only surface + email it here.
  let discountCode: string | null = null;
  let discountPercent: number | undefined;
  try {
    const appCfg = await loadAppConfig();
    const enabled = appCfg['surveyLeadDiscountEnabled'] === 'true';
    const configured = (appCfg['surveyLeadDiscountCode'] || '').trim();
    if (enabled && consent && email && isValidEmail(email) && configured) {
      const v = await validateRepeatCode(configured, email);
      if (v.ok && v.kind === 'campaign') {
        discountCode = configured.toUpperCase();
        discountPercent = v.percent;
        // Best-effort — never block the thank-you response on email delivery.
        sendSurveyDiscountEmail(email, discountCode, v.percent).catch((e) =>
          console.error('[survey] discount email failed:', e)
        );
      } else {
        console.warn(
          '[survey] lead discount enabled but configured code is not a valid campaign code:',
          configured,
          v.ok ? v.kind : v.reason
        );
      }
    }
  } catch (err) {
    console.error('[survey] lead discount handling failed:', err);
  }

  return NextResponse.json({ ok: true, discountCode, discountPercent });
}
