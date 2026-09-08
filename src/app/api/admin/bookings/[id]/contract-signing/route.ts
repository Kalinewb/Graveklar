import { NextRequest, NextResponse } from 'next/server';
import { isAdminAuthenticated } from '@/lib/admin-auth';
import {
  applyContractSigningUpdate,
  CONTRACT_SIGNING_ACTIONS,
  type ContractSigningAction,
} from '@/lib/contract-signing-service';

export const dynamic = 'force-dynamic';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: 'Ikke autorisert.' }, { status: 401 });
  }

  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const action = String(body.action ?? '') as ContractSigningAction;

    if (!CONTRACT_SIGNING_ACTIONS.has(action)) {
      return NextResponse.json({ error: 'Ugyldig handling' }, { status: 400 });
    }

    const note = typeof body.note === 'string' ? body.note : null;
    const digipostReference = typeof body.digipostReference === 'string' ? body.digipostReference : null;

    const result = await applyContractSigningUpdate(id, action, { note, digipostReference });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json({ success: true, booking: result.booking });
  } catch (err) {
    console.error('contract-signing PATCH error:', err);
    const message = err instanceof Error ? err.message : 'Oppdatering feilet';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
