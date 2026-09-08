'use client';

import { Calendar, CreditCard, FileSignature, FileText, CheckCircle2, X, Bell, Mail } from 'lucide-react';
import { contractSigningLabel, resolveContractSigning } from '@/lib/contract-signing';

export interface BookingTimelineInput {
  reference: string;
  status: string;
  createdAt?: string | null;
  termsAcceptedAt?: string | null;
  fullyPaidAt?: string | null;
  paymentMethod?: string | null;
  reminderSentAt?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  cancellationFee?: number | null;
  contractSigningMethod?: string | null;
  contractSigningStatus?: string | null;
  contractSentAt?: string | null;
  contractSignedAt?: string | null;
  digipostReference?: string | null;
  contractSigningNote?: string | null;
}

interface Event {
  at: string;
  title: string;
  Icon: React.ElementType;
  tone: 'blue' | 'emerald' | 'violet' | 'rose' | 'slate' | 'amber';
}

const TONE: Record<Event['tone'], string> = {
  blue:    'bg-blue-500/10 text-blue-600 ring-blue-500/20',
  emerald: 'bg-emerald-500/10 text-emerald-600 ring-emerald-500/20',
  violet:  'bg-violet-500/10 text-violet-600 ring-violet-500/20',
  rose:    'bg-rose-500/10 text-rose-600 ring-rose-500/20',
  slate:   'bg-slate-500/10 text-slate-600 ring-slate-500/20',
  amber:   'bg-amber-500/10 text-amber-600 ring-amber-500/20',
};

/**
 * What the payment event is called, from the method actually recorded.
 *
 * The event used to read "Betalt via Stripe" for every paid booking, which was
 * wrong for the drawer's own "Marker som betalt" (whose confirm text says it
 * skips Stripe and which records no method at all), for faktura on an accepted
 * B2B quote, for test bookings — and, with native Vipps now the primary
 * method, for most real payments (P-13).
 */
function paidLabel(method: string | null | undefined): string {
  switch ((method || '').toLowerCase()) {
    case 'vipps':   return 'Betalt via Vipps';
    case 'card':
    case 'stripe':  return 'Betalt via Stripe';
    case 'invoice': return 'Betalt mot faktura';
    case 'mock':    return 'Betalt (testbooking)';
    // No method recorded: the only path that gets here is the drawer's manual
    // mark-paid, so say that rather than naming a gateway that never ran.
    case '':        return 'Betalt — registrert manuelt';
    default:        return `Betalt via ${method}`;
  }
}

function fmt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleString('nb-NO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function BookingTimeline({ booking }: { booking: BookingTimelineInput }) {
  const events: Event[] = [];

  const created = fmt(booking.createdAt);
  if (created) events.push({ at: created, title: 'Booking opprettet av kunde', Icon: Calendar, tone: 'blue' });

  const terms = fmt(booking.termsAcceptedAt);
  if (terms) events.push({ at: terms, title: 'Vilkår godtatt + kontrakt frosset', Icon: FileText, tone: 'violet' });

  const paid = fmt(booking.fullyPaidAt);
  if (paid) events.push({ at: paid, title: paidLabel(booking.paymentMethod), Icon: CreditCard, tone: 'emerald' });

  const signing = resolveContractSigning({
    status: booking.status,
    contractSigningMethod: booking.contractSigningMethod,
    contractSigningStatus: booking.contractSigningStatus,
    contractSentAt: booking.contractSentAt ? new Date(booking.contractSentAt) : null,
    contractSignedAt: booking.contractSignedAt ? new Date(booking.contractSignedAt) : null,
    digipostReference: booking.digipostReference,
    contractSigningNote: booking.contractSigningNote,
    termsAcceptedAt: booking.termsAcceptedAt ? new Date(booking.termsAcceptedAt) : null,
    fullyPaidAt: booking.fullyPaidAt ? new Date(booking.fullyPaidAt) : null,
  });

  const sent = fmt(booking.contractSentAt);
  if (sent && signing.method === 'digipost') {
    events.push({
      at: sent,
      title: booking.digipostReference
        ? `Digipost sendt (${booking.digipostReference})`
        : 'Digipost sendt til kunde',
      Icon: Mail,
      tone: 'amber',
    });
  }

  const signedAt = fmt(booking.contractSignedAt);
  if (signedAt && (signing.status === 'signed' || signing.status === 'paper')) {
    events.push({
      at: signedAt,
      title: contractSigningLabel(signing),
      Icon: FileSignature,
      tone: 'emerald',
    });
  } else if (booking.status === 'confirmed' && signing.status === 'pending') {
    events.push({
      at: 'Venter',
      title: 'Kontrakt ikke sendt/signert',
      Icon: FileSignature,
      tone: 'rose',
    });
  } else if (booking.status === 'confirmed' && signing.status === 'sent') {
    events.push({
      at: sent ?? 'Sendt',
      title: 'Venter Digipost-signering',
      Icon: FileSignature,
      tone: 'amber',
    });
  }

  const reminded = fmt(booking.reminderSentAt);
  if (reminded) events.push({ at: reminded, title: 'Påminnelse sendt', Icon: Bell, tone: 'amber' });

  if (booking.status === 'completed') {
    const completedAt = booking.endDate ? fmt(booking.endDate + 'T12:00:00') : null;
    if (completedAt) events.push({ at: completedAt, title: 'Leieperiode fullført', Icon: CheckCircle2, tone: 'emerald' });
  }
  if (booking.status === 'cancelled') {
    events.push({
      at: 'Status: Avbestilt',
      title: booking.cancellationFee
        ? `Avbestilt — gebyr ${booking.cancellationFee.toLocaleString('nb-NO')} kr beholdt`
        : 'Avbestilt',
      Icon: X,
      tone: 'rose',
    });
  }

  if (events.length === 0) {
    return (
      <div className="text-xs text-muted-foreground italic">
        Ingen tidsstemplede hendelser ennå.
      </div>
    );
  }

  return (
    <ol className="relative space-y-3">
      <div className="absolute left-[15px] top-2 bottom-2 w-px bg-border" aria-hidden />
      {events.map((e, i) => (
        <li key={i} className="relative flex items-start gap-3 pl-1">
          <span className={`relative z-10 w-8 h-8 rounded-full flex items-center justify-center ring-4 ring-background ${TONE[e.tone]}`}>
            <e.Icon className="w-3.5 h-3.5" />
          </span>
          <div className="flex-1 min-w-0 pt-1">
            <div className="text-sm font-medium text-foreground">{e.title}</div>
            <div className="text-xs text-muted-foreground mt-0.5 tabular-nums">{e.at}</div>
          </div>
        </li>
      ))}
      <div className="pt-2 text-[10px] text-muted-foreground/70 font-mono pl-11">
        ref: {booking.reference}
      </div>
    </ol>
  );
}
