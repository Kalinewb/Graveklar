import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { isAdminAuthenticated } from '@/lib/admin-auth';
import { QUOTE_STATUSES, type QuoteStatus } from '@/lib/quote-request';

export const dynamic = 'force-dynamic';

const ADMIN_SETTABLE_STATUSES = new Set<QuoteStatus>(['ny', 'tilbud_sendt', 'avslatt', 'utlopt', 'trukket']);

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  const body = await req.json();
  const action = String(body.action ?? '');

  const existing = await db.quoteRequest.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // ── Send or revise an offer (the "counteroffer" path) ──
  if (action === 'send_offer') {
    const offerAmount = Math.round(Number(body.offerAmount));
    if (!Number.isFinite(offerAmount) || offerAmount <= 0) {
      return NextResponse.json({ error: 'Ugyldig tilbudsbeløp' }, { status: 400 });
    }
    const offerMessage = typeof body.offerMessage === 'string' ? body.offerMessage.trim() || null : null;
    const paymentMode = body.paymentMode === 'invoice' ? 'invoice' : 'card';

    let offerValidUntil: Date;
    if (typeof body.offerValidUntil === 'string' && body.offerValidUntil) {
      const d = new Date(body.offerValidUntil);
      offerValidUntil = Number.isNaN(d.getTime()) ? defaultValidity() : d;
    } else {
      offerValidUntil = defaultValidity();
    }

    // Reuse the existing token across revisions so an already-sent link keeps
    // working; only mint one if none exists yet. Token outlives the offer
    // validity by a small buffer so the accept page can show a clean
    // "expired" message rather than 404.
    const acceptToken = existing.acceptToken ?? crypto.randomUUID();
    const acceptTokenExpiry = new Date(offerValidUntil.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Pin the deal terms (admin can confirm/correct the dates the customer
    // requested). These drive the calendar lock at acceptance time.
    const VALID_RENTAL = new Set(['day', 'weekend', 'week', 'custom']);
    const dealPatch: { startDate?: Date; rentalType?: string; customDays?: number | null } = {};
    if (typeof body.startDate === 'string' && body.startDate) {
      const d = new Date(body.startDate);
      if (!Number.isNaN(d.getTime())) dealPatch.startDate = d;
    }
    if (typeof body.rentalType === 'string' && VALID_RENTAL.has(body.rentalType)) {
      dealPatch.rentalType = body.rentalType;
      dealPatch.customDays =
        body.rentalType === 'custom' && body.customDays
          ? Math.min(Math.max(1, Math.floor(Number(body.customDays))), 365)
          : null;
    }

    const updated = await db.quoteRequest.update({
      where: { id },
      data: {
        offerAmount,
        offerMessage,
        offerValidUntil,
        paymentMode,
        acceptToken,
        acceptTokenExpiry,
        status: 'tilbud_sendt',
        ...dealPatch,
      },
      include: { machine: true },
    });

    import('@/lib/email')
      .then(({ sendQuoteOfferEmail }) => sendQuoteOfferEmail(updated))
      .catch((err) => console.error('quote offer email error:', err));

    return NextResponse.json({ success: true, request: updated });
  }

  // ── Update admin note ──
  if (action === 'note') {
    const updated = await db.quoteRequest.update({
      where: { id },
      data: { adminNote: typeof body.adminNote === 'string' ? body.adminNote : null },
      include: { machine: true },
    });
    return NextResponse.json({ success: true, request: updated });
  }

  // ── Set status (withdraw / decline / reopen) ──
  if (action === 'set_status') {
    const status = String(body.status ?? '') as QuoteStatus;
    if (!QUOTE_STATUSES.includes(status) || !ADMIN_SETTABLE_STATUSES.has(status)) {
      return NextResponse.json({ error: 'Ugyldig status' }, { status: 400 });
    }
    const updated = await db.quoteRequest.update({
      where: { id },
      data: { status },
      include: { machine: true },
    });
    return NextResponse.json({ success: true, request: updated });
  }

  return NextResponse.json({ error: 'Ukjent handling' }, { status: 400 });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  // Existence check first: without it Prisma's P2025 escapes the handler
  // unhandled (a bare 500) instead of the 404 every sibling admin-CRUD route
  // answers for an unknown id (finding F-10).
  const existing = await db.quoteRequest.findUnique({ where: { id }, select: { id: true } });
  if (!existing) {
    return NextResponse.json({ error: 'Forespørselen finnes ikke' }, { status: 404 });
  }
  await db.quoteRequest.delete({ where: { id } });
  return NextResponse.json({ success: true });
}

function defaultValidity(): Date {
  return new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
}
