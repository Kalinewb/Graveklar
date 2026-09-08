import { NextRequest, NextResponse } from 'next/server';
import { submitReview, ReviewError } from '@/lib/review';
import { createRateLimiter } from '@/lib/rate-limit';
import { clientIdentity } from '@/lib/client-ip';

export const dynamic = 'force-dynamic';

const checkLimit = createRateLimiter(10, 15 * 60 * 1000);

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  const ip = clientIdentity(request);
  if (checkLimit(ip)) {
    return NextResponse.json({ error: 'For mange forsøk. Prøv igjen om litt.' }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldig forespørsel' }, { status: 400 });
  }

  if (body.website) {
    return NextResponse.json({ error: 'Ugyldig forespørsel' }, { status: 400 });
  }

  try {
    await submitReview({
      token,
      rating: Number(body.rating),
      comment: String(body.comment ?? ''),
      reviewerName: typeof body.reviewerName === 'string' ? body.reviewerName : undefined,
    });
    return NextResponse.json({ success: true });
  } catch (err) {
    const isClient = err instanceof ReviewError;
    if (!isClient) console.error('Review submit error:', err);
    const message = err instanceof Error ? err.message : 'Kunne ikke sende vurderingen';
    return NextResponse.json({ error: message }, { status: isClient ? 400 : 500 });
  }
}
