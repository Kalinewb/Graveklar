import { isHandoverAllowed, resolveContractSigning, type ContractSigningView } from '@/lib/contract-signing';
import { isCompletionPhaseDone, parseChecklistData, type ChecklistPhaseLike } from '@/lib/checklist';

export type RentalFlowStep =
  | 'await_payment'
  | 'send_contract'
  | 'await_signature'
  | 'prep'
  | 'handover'
  | 'in_rental'
  | 'return'
  | 'completed';

export interface RentalFlowContext {
  todayStr: string;
  startDate: string;
  endDate: string;
  selfPickup: boolean;
  prepDone: boolean;
  handoverDone: boolean;
  returnDone: boolean;
  signing: ContractSigningView;
  handoverAllowed: boolean;
}

export interface RentalFlowState {
  step: RentalFlowStep;
  label: string;
  tone: 'amber' | 'emerald' | 'slate' | 'rose';
  blockedReason?: string;
}

export function computeRentalFlow(ctx: RentalFlowContext): RentalFlowState {
  const handoverLabel = ctx.selfPickup ? 'Selvhenting' : 'Levering';

  if (ctx.returnDone) {
    return { step: 'completed', label: 'Retur fullført', tone: 'emerald' };
  }

  if (!ctx.handoverAllowed) {
    if (ctx.signing.status === 'sent') {
      return {
        step: 'await_signature',
        label: 'Venter Digipost-signering',
        tone: 'amber',
        blockedReason: 'Kontrakt må signeres før klargjøring/utlevering',
      };
    }
    return {
      step: 'send_contract',
      label: 'Send kontrakt (Digipost/papir)',
      tone: 'rose',
      blockedReason: 'Kontrakt må signeres før klargjøring/utlevering',
    };
  }

  if (ctx.todayStr < ctx.startDate) {
    if (!ctx.prepDone) {
      return { step: 'prep', label: 'Klargjøring', tone: 'amber' };
    }
    return {
      step: 'handover',
      label: `${handoverLabel} (${ctx.startDate})`,
      tone: 'slate',
      blockedReason: 'Tilgjengelig på startdato',
    };
  }

  if (ctx.todayStr === ctx.startDate && !ctx.handoverDone) {
    return { step: 'handover', label: `${handoverLabel} i dag`, tone: 'amber' };
  }

  if (!ctx.handoverDone) {
    return { step: 'handover', label: `${handoverLabel} – ikke fullført`, tone: 'amber' };
  }

  if (ctx.todayStr === ctx.endDate) {
    return { step: 'return', label: 'Retur i dag', tone: 'amber' };
  }

  if (ctx.todayStr > ctx.endDate) {
    return { step: 'return', label: 'Retur forfalt', tone: 'rose' };
  }

  return { step: 'in_rental', label: 'Pågående leie', tone: 'slate' };
}

export function buildRentalFlowContext(input: {
  booking: {
    status: string;
    startDate: string;
    selfPickup: boolean;
    checklistData?: string | null;
    contractSigningMethod?: string | null;
    contractSigningStatus?: string | null;
    contractSentAt?: Date | null;
    contractSignedAt?: Date | null;
    digipostReference?: string | null;
    contractSigningNote?: string | null;
    termsAcceptedAt?: Date | null;
    fullyPaidAt?: Date | null;
  };
  phases: ChecklistPhaseLike[];
  todayStr: string;
  endDate: string;
}): RentalFlowContext {
  const checklistData = parseChecklistData(input.booking.checklistData);
  const activePhases = input.phases.filter((p) => p.isActive !== false && (p.audience ?? 'operator') === 'operator');

  const phaseByKeyword = (re: RegExp, fallbackIdx: number) =>
    activePhases.find((p) => re.test(p.name)) ?? activePhases[fallbackIdx] ?? null;

  const prepPhase = phaseByKeyword(/klargjør|forbered|prep/i, 0);
  const handoverPhase = phaseByKeyword(/lever|utlever|delivery|hent/i, Math.min(1, activePhases.length - 1));
  const returnPhase =
    activePhases.find((p) => p.isCompletionTrigger) ??
    phaseByKeyword(/retur|hent|return|pickup/i, activePhases.length - 1);

  const isDone = (phase: ChecklistPhaseLike | null) =>
    phase ? isCompletionPhaseDone(phase, checklistData) : false;

  const signing = resolveContractSigning(input.booking);

  return {
    todayStr: input.todayStr,
    startDate: input.booking.startDate,
    endDate: input.endDate,
    selfPickup: input.booking.selfPickup,
    prepDone: isDone(prepPhase),
    handoverDone: isDone(handoverPhase),
    returnDone: isDone(returnPhase),
    signing,
    handoverAllowed: isHandoverAllowed(input.booking),
  };
}
