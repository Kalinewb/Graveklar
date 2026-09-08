'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, FileSignature, Loader2, Mail, PenLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  contractSigningLabel,
  contractSigningTone,
  resolveContractSigning,
  type ContractSigningView,
} from '@/lib/contract-signing';

export interface ContractSigningBooking {
  id: string;
  status: string;
  email: string;
  contractSigningMethod?: string | null;
  contractSigningStatus?: string | null;
  contractSentAt?: string | null;
  contractSignedAt?: string | null;
  digipostReference?: string | null;
  contractSigningNote?: string | null;
  termsAcceptedAt?: string | null;
  fullyPaidAt?: string | null;
}

const TONE_CLASS: Record<ReturnType<typeof contractSigningTone>, string> = {
  emerald:
    'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200',
  amber:
    'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200',
  rose: 'border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200',
  slate: 'border-border bg-muted/30 text-foreground',
  violet: 'border-violet-200 bg-violet-50 text-violet-900',
};

function fmt(iso?: string | null) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('nb-NO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function serializeBooking(raw: Record<string, unknown>): ContractSigningBooking {
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null);
  return {
    id: String(raw.id),
    status: String(raw.status),
    email: String(raw.email ?? ''),
    contractSigningMethod: (raw.contractSigningMethod as string | null) ?? null,
    contractSigningStatus: (raw.contractSigningStatus as string | null) ?? null,
    contractSentAt: iso(raw.contractSentAt),
    contractSignedAt: iso(raw.contractSignedAt),
    digipostReference: (raw.digipostReference as string | null) ?? null,
    contractSigningNote: (raw.contractSigningNote as string | null) ?? null,
    termsAcceptedAt: iso(raw.termsAcceptedAt),
    fullyPaidAt: iso(raw.fullyPaidAt),
  };
}

export function ContractSigningPanel({
  booking,
  onUpdated,
}: {
  booking: ContractSigningBooking;
  onUpdated: (booking: ContractSigningBooking) => void | Promise<void>;
}) {
  const [local, setLocal] = useState(booking);
  const [digipostRef, setDigipostRef] = useState(booking.digipostReference ?? '');
  const [note, setNote] = useState(booking.contractSigningNote ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    setLocal(booking);
    setDigipostRef(booking.digipostReference ?? '');
    setNote(booking.contractSigningNote ?? '');
  }, [booking]);

  const view = resolveContractSigning({
    ...local,
    termsAcceptedAt: local.termsAcceptedAt ? new Date(local.termsAcceptedAt) : null,
    fullyPaidAt: local.fullyPaidAt ? new Date(local.fullyPaidAt) : null,
    contractSentAt: local.contractSentAt ? new Date(local.contractSentAt) : null,
    contractSignedAt: local.contractSignedAt ? new Date(local.contractSignedAt) : null,
  });

  if (local.status !== 'confirmed') return null;

  const patch = async (action: string, extra?: Record<string, unknown>) => {
    setBusy(action);
    setError(null);
    setFlash(null);
    try {
      const res = await fetch(`/api/admin/bookings/${local.id}/contract-signing`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action, digipostReference: digipostRef, note, ...extra }),
      });
      const text = await res.text();
      let data: Record<string, unknown> = {};
      try {
        data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        throw new Error(text.slice(0, 180) || `HTTP ${res.status}`);
      }
      if (!res.ok) {
        throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${res.status}`);
      }
      if (!data.booking || typeof data.booking !== 'object') {
        throw new Error('Manglende booking i svar');
      }
      const updated = serializeBooking(data.booking as Record<string, unknown>);
      setLocal(updated);
      setFlash('Lagret');
      await onUpdated(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Feil');
    } finally {
      setBusy(null);
    }
  };

  const showActions = view.status === 'pending' || view.status === 'sent';
  const showReset = view.status === 'signed' || view.status === 'paper';

  return (
    <div className={`rounded-lg border p-3 ${TONE_CLASS[contractSigningTone(view)]}`}>
      <div className="flex items-start gap-2 mb-2">
        <FileSignature className="w-4 h-4 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm">Kontraktsignering (Digipost/papir)</div>
          <div className="text-xs mt-0.5 opacity-90">{contractSigningLabel(view)}</div>
          {local.fullyPaidAt && view.status === 'pending' && (
            <div className="text-[11px] mt-1 opacity-80">
              Betalt online — send og marker signert leiekontrakt før utlevering.
            </div>
          )}
          <SigningMeta view={view} booking={local} />
        </div>
      </div>

      {error && <div className="text-xs text-rose-700 dark:text-rose-300 mb-2">{error}</div>}
      {flash && !error && <div className="text-xs text-emerald-700 dark:text-emerald-300 mb-2">{flash}</div>}

      {showActions && (
        <div className="space-y-2 mt-3 pt-3 border-t border-current/10">
          <div>
            <Label className="text-xs">Digipost-referanse (valgfritt)</Label>
            <Input
              className="mt-1 h-8 text-xs"
              value={digipostRef}
              onChange={(e) => setDigipostRef(e.target.value)}
              placeholder="Melding-ID / referanse"
            />
          </div>
          <div>
            <Label className="text-xs">Notat</Label>
            <Input
              className="mt-1 h-8 text-xs"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="F.eks. sendt 08:30, papir ønsket"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {view.status === 'pending' && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                disabled={!!busy}
                onClick={() => void patch('mark_sent')}
              >
                {busy === 'mark_sent' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
                ) : (
                  <Mail className="w-3.5 h-3.5 mr-1" />
                )}
                Marker sendt (Digipost)
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              disabled={!!busy}
              onClick={() => void patch('mark_signed')}
            >
              {busy === 'mark_signed' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
              ) : (
                <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
              )}
              Signert (Digipost)
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              disabled={!!busy}
              onClick={() => void patch('mark_paper')}
            >
              {busy === 'mark_paper' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
              ) : (
                <PenLine className="w-3.5 h-3.5 mr-1" />
              )}
              Signert på papir
            </Button>
          </div>
          <p className="text-[11px] opacity-80">
            Klargjøring og utlevering låses til kontrakt er signert.
          </p>
        </div>
      )}

      {showReset && (
        <div className="mt-2 flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            disabled={!!busy}
            onClick={() => {
              if (!confirm('Tilbakestill kontraktstatus? Klargjøring låses igjen.')) return;
              void patch('reset_pending');
            }}
          >
            Tilbakestill
          </Button>
        </div>
      )}
    </div>
  );
}

function SigningMeta({ view, booking }: { view: ContractSigningView; booking: ContractSigningBooking }) {
  const sent = fmt(booking.contractSentAt);
  const signed = fmt(booking.contractSignedAt);
  return (
    <div className="text-[11px] mt-1 space-y-0.5 opacity-80 font-mono tabular-nums">
      {view.method && <div>Metode: {view.method}</div>}
      {sent && <div>Sendt: {sent}</div>}
      {signed && <div>Signert: {signed}</div>}
      {view.digipostReference && <div>Digipost: {view.digipostReference}</div>}
      {view.note && <div>Notat: {view.note}</div>}
    </div>
  );
}
