export type ContractSigningMethod = 'online' | 'digipost' | 'paper';
export type ContractSigningStatus = 'pending' | 'sent' | 'signed' | 'paper' | 'not_required';

export interface ContractSigningView {
  status: ContractSigningStatus;
  method: ContractSigningMethod | null;
  sentAt: Date | null;
  signedAt: Date | null;
  digipostReference: string | null;
  note: string | null;
}

type BookingSigningFields = {
  status: string;
  contractSigningMethod?: string | null;
  contractSigningStatus?: string | null;
  contractSentAt?: Date | null;
  contractSignedAt?: Date | null;
  digipostReference?: string | null;
  contractSigningNote?: string | null;
  termsAcceptedAt?: Date | null;
  fullyPaidAt?: Date | null;
};

const VALID_STATUS = new Set<ContractSigningStatus>(['pending', 'sent', 'signed', 'paper', 'not_required']);
const VALID_METHOD = new Set<ContractSigningMethod>(['online', 'digipost', 'paper']);

/** Resolve effective signing state, including legacy bookings that predate
 *  the explicit columns (online checkout = terms + payment). */
export function resolveContractSigning(booking: BookingSigningFields): ContractSigningView {
  const rawStatus = booking.contractSigningStatus as ContractSigningStatus | null | undefined;
  if (rawStatus && VALID_STATUS.has(rawStatus)) {
    const method = booking.contractSigningMethod as ContractSigningMethod | null | undefined;
    return {
      status: rawStatus,
      method: method && VALID_METHOD.has(method) ? method : null,
      sentAt: booking.contractSentAt ?? null,
      signedAt: booking.contractSignedAt ?? null,
      digipostReference: booking.digipostReference ?? null,
      note: booking.contractSigningNote ?? null,
    };
  }

  // Confirmed bookings without explicit signing status need Digipost/papir
  // before handover — online betaling/vilkår er ikke det samme.
  if (booking.status === 'confirmed') {
    return {
      status: 'pending',
      method: null,
      sentAt: null,
      signedAt: null,
      digipostReference: null,
      note: null,
    };
  }

  return {
    status: 'not_required',
    method: null,
    sentAt: null,
    signedAt: null,
    digipostReference: null,
    note: null,
  };
}

export function isHandoverAllowed(booking: BookingSigningFields): boolean {
  if (booking.status !== 'confirmed') return false;
  const { status } = resolveContractSigning(booking);
  return status === 'signed' || status === 'paper';
}

export function contractSigningLabel(view: ContractSigningView): string {
  switch (view.status) {
    case 'signed':
      return view.method === 'online' ? 'Kontrakt signert (online)' : 'Kontrakt signert';
    case 'paper':
      return 'Kontrakt signert (papir)';
    case 'sent':
      return 'Digipost sendt – venter signatur';
    case 'pending':
      return 'Kontrakt ikke sendt/signert';
    case 'not_required':
      return 'Kontrakt ikke relevant';
    default:
      return 'Ukjent';
  }
}

export function contractSigningTone(
  view: ContractSigningView,
): 'emerald' | 'amber' | 'rose' | 'slate' | 'violet' {
  switch (view.status) {
    case 'signed':
    case 'paper':
      return 'emerald';
    case 'sent':
      return 'amber';
    case 'pending':
      return 'rose';
    default:
      return 'slate';
  }
}
