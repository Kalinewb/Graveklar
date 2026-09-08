'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Circle, Camera, ArrowLeft, Printer, Lock, Fuel, X, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { isItemFilled, findPrepPhaseIndex, formatChecklistAnswerValue, isItemActive, computeChecklistStats, formatStatNumber, photoUrls, photoMin } from '@/lib/checklist';
import { computeFuelNeeds } from '@/lib/fuel';
import type { RenterSubmissionView } from '@/lib/renter-checklist';

interface ChecklistItem {
  id: string;
  label: string;
  answerType: string;
  unit?: string | null;
  conditionItemId?: string | null;
  conditionValue?: string | null;
  statKey?: string | null;
  minPhotos?: number | null;
}

interface ChecklistPhase {
  id: string;
  name: string;
  items: ChecklistItem[];
}

interface MachineDocument {
  title: string;
  fileUrl: string;
}

interface Props {
  bookingId: string;
  reference: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  equipmentName: string;
  startDate: string;
  rentalType: string;
  totalHours: number;
  totalPrice: number;
  basePrice: number;
  deliveryFee: number;
  deliveryAddress: string;
  selfPickup: boolean;
  status: string;
  handoverAllowed?: boolean;
  machineDocuments?: MachineDocument[];
  businessName: string;
  orgNumber: string;
  logoUrl?: string;
  fuelTankLiters: number | null;
  fuelConsumptionPerHour: number | null;
  phases: ChecklistPhase[];
  initialData: ChecklistData;
  renterSubmissions: RenterSubmissionView[];
}

const RENTAL_LABELS: Record<string, string> = {
  day: 'Døgn', weekend: 'Helg', week: 'Uke', custom: 'Tilpasset',
};

const FUEL_KEY = '__fuel-cans';

// Photo items hold a string[]; everything else string | boolean.
type ChecklistValue = string | boolean | string[];
type ChecklistData = Record<string, ChecklistValue>;

export default function ChecklistClient({
  bookingId, reference, customerName, customerPhone, customerEmail,
  equipmentName, startDate, rentalType, totalHours, totalPrice, basePrice,
  deliveryFee, deliveryAddress, selfPickup, status, handoverAllowed = true,
  machineDocuments = [],
  businessName, orgNumber, logoUrl, fuelTankLiters, fuelConsumptionPerHour,
  phases, initialData, renterSubmissions,
}: Props) {
  const [data, setData] = useState<ChecklistData>(initialData);
  const [activePhase, setActivePhase] = useState(() => {
    const first = phases.findIndex(p => initialData[`__phase_locked_${p.id}`] !== true);
    return first >= 0 ? first : phases.length - 1;
  });
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState<Set<string>>(new Set());
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fuelNeeds = computeFuelNeeds({
    totalHours,
    tankLiters: fuelTankLiters,
    consumptionPerHour: fuelConsumptionPerHour,
  });
  const fuelPhaseIdx = findPrepPhaseIndex(phases);
  const includeFuelForPhase = (phaseIdx: number) =>
    phaseIdx === fuelPhaseIdx && fuelNeeds.computable && fuelNeeds.cansNeeded > 0;
  const isFuelDone = data[FUEL_KEY] === true;

  const allLocked = data['__locked'] === true;
  const phaseLocked = (phaseId: string) => data[`__phase_locked_${phaseId}`] === true;

  // 24-hour timestamp for the print/PDF view.
  const fmtDateTime = (iso?: string | null) =>
    iso
      ? new Date(iso).toLocaleString('nb-NO', {
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        })
      : '';
  // Items whose conditional trigger is currently satisfied (or unconditional).
  // Hidden items don't render, aren't counted, and don't block completion.
  const visibleItems = (items: ChecklistItem[]) =>
    items.filter((i) => isItemActive(i, data, items));

  // Cross-phase numeric stats (e.g. hour meter Levering → Retur = hours used).
  const stats = computeChecklistStats(phases, data);
  const statRow = (s: ReturnType<typeof computeChecklistStats>[number]) =>
    `${formatStatNumber(s.startValue)} → ${formatStatNumber(s.endValue)}${s.unit ? ` ${s.unit}` : ''}`;

  const persistChecklist = useCallback(async (updated: ChecklistData) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/bookings/${bookingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'checklist', checklistData: JSON.stringify(updated) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(typeof body.error === 'string' ? body.error : 'Lagring feilet');
        return null;
      }
      return body as { autoCompleted?: boolean };
    } catch {
      toast.error('Lagring feilet');
      return null;
    } finally {
      setSaving(false);
    }
  }, [bookingId]);

  const saveImmediate = useCallback((updated: ChecklistData) => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    void persistChecklist(updated);
  }, [persistChecklist]);

  const saveDebounced = useCallback((updated: ChecklistData) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void persistChecklist(updated);
    }, 400);
  }, [persistChecklist]);

  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
  }, []);

  const allLockedOrPhaseLocked =
    allLocked
    || !handoverAllowed
    || (phases[activePhase] ? phaseLocked(phases[activePhase].id) : false);

  // Why the controls are inert, in one sentence. `isHandoverAllowed` refuses
  // every status but `confirmed`, and refuses that one until the contract is
  // signed — the old banner only covered the last of those cases, so a
  // checklist opened on a pending or completed booking was dead with no
  // explanation at all (P-10).
  const gateReason = handoverAllowed
    ? null
    : status === 'confirmed'
      ? 'Kontrakt må signeres (Digipost/papir) før klargjøring og utlevering. Marker signering i booking-detaljer.'
      : status === 'completed'
        ? 'Leieforholdet er fullført. Sjekklisten er kun lesbar.'
        : status === 'cancelled'
          ? 'Bookingen er avbestilt. Sjekklisten er kun lesbar.'
          : 'Bookingen er ikke bekreftet ennå. Sjekklisten låses opp når bookingen er bekreftet og kontrakten er signert.';

  const setValue = (itemId: string, value: ChecklistValue, immediate = false) => {
    if (allLockedOrPhaseLocked) return;
    const updated = { ...data, [itemId]: value };
    setData(updated);
    if (immediate) saveImmediate(updated);
    else saveDebounced(updated);
  };

  const addPhoto = (itemId: string, url: string) =>
    setValue(itemId, [...photoUrls(data[itemId]), url], true);
  const removePhoto = (itemId: string, url: string) =>
    setValue(itemId, photoUrls(data[itemId]).filter((u) => u !== url), true);

  const totalItems = phases.reduce(
    (sum, p, idx) => sum + visibleItems(p.items).length + (includeFuelForPhase(idx) ? 1 : 0),
    0,
  );
  const doneItems = phases.reduce((sum, p, idx) => {
    const itemsDone = visibleItems(p.items).filter(i => isItemFilled(i, data[i.id])).length;
    const fuelExtra = includeFuelForPhase(idx) && isFuelDone ? 1 : 0;
    return sum + itemsDone + fuelExtra;
  }, 0);

  const phase = phases[activePhase];
  const phaseIsLocked = allLocked || (phase ? phaseLocked(phase.id) : false);
  // The controls follow exactly the rule `setValue` follows — contract gate
  // included. They used to disable on `phaseIsLocked` alone, so a checklist
  // behind an unsigned contract rendered at full opacity with a default
  // cursor and silently swallowed every tap (P-10).
  const locked = allLockedOrPhaseLocked;
  const phaseAllDone = phase
    ? visibleItems(phase.items).every(i => isItemFilled(i, data[i.id]))
      && (!includeFuelForPhase(activePhase) || isFuelDone)
    : false;

  const handleSubmitPhase = async () => {
    if (!phase || !phaseAllDone || locked) return;
    if (!confirm(`Fullfør og lås "${phase.name}"? Dette kan ikke angres.`)) return;
    setSubmitting(true);
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const updated = {
      ...data,
      [`__phase_locked_${phase.id}`]: true,
      [`__phase_locked_at_${phase.id}`]: new Date().toISOString(),
    };
    const allPhasesLocked = phases.every(p => p.id === phase.id || phaseLocked(p.id));
    if (allPhasesLocked) {
      updated['__locked'] = true;
      updated['__lockedAt'] = new Date().toISOString();
    }
    setData(updated);
    const result = await persistChecklist(updated);
    if (result === null) {
      setSubmitting(false);
      return;
    }
    if (result.autoCompleted) {
      toast.success('Retur-fasen er fullført — bookingen er automatisk markert som fullført.');
    }
    window.location.href = '/admin';
  };

  const showFuelItem = includeFuelForPhase(activePhase);

  const renterSubmissionBlock = renterSubmissions.length > 0 ? (
    <div className="space-y-4">
      {renterSubmissions.map((sub) => (
        <div key={sub.id}>
          <h3 className="text-sm font-bold mb-1">{sub.phaseName}</h3>
          <p className="text-xs text-muted-foreground mb-2">
            {sub.intervalLabel} · {new Date(sub.submittedAt).toLocaleString('nb-NO', {
              day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
            })} · {sub.phone}
          </p>
          <div className="space-y-1.5">
            {sub.items.filter((i) => isItemActive(i, sub.data, sub.items)).map((item) => {
              const value = sub.data[item.id];
              return (
                <div key={item.id} className="text-sm">
                  <div className="flex items-start gap-2">
                    <span className="w-5 h-5 border border-border rounded flex items-center justify-center shrink-0 mt-0.5 text-xs print:border-gray-400">
                      {isItemFilled(item, value) ? '✓' : ''}
                    </span>
                    <span className="flex-1">{item.label}</span>
                    {(item.answerType === 'yesno' || item.answerType === 'number' || item.answerType === 'measurement' || item.answerType === 'text')
                      && value != null && value !== '' && (
                      <span className="font-medium">
                        {formatChecklistAnswerValue(item, value)}
                        {item.unit && item.answerType === 'measurement' ? ` ${item.unit}` : ''}
                      </span>
                    )}
                  </div>
                  {item.answerType === 'photo' && photoUrls(value).length > 0 && (
                    <div className="ml-7 mt-1 flex flex-wrap gap-2">
                      {photoUrls(value).map((url) => (
                        <img key={url} src={url} alt={item.label} className="max-w-[200px] max-h-[150px] rounded border border-border object-cover print:border-gray-300" />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  ) : null;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="sticky top-0 z-50 bg-background/80 backdrop-blur-md border-b border-border print:hidden">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center gap-3">
          <a href="/admin" className="p-1 text-muted-foreground hover:text-foreground transition-colors"><ArrowLeft className="w-5 h-5" /></a>
          <div className="flex-1 min-w-0">
            <div className="font-bold text-sm truncate flex items-center gap-1.5 text-foreground">
              {locked && <Lock className="w-3.5 h-3.5" />}
              {reference}
            </div>
            <div className="text-xs text-muted-foreground truncate">{customerName} · {equipmentName}</div>
          </div>
          <Button variant="outline" size="sm" onClick={() => window.print()} className="gap-1.5 text-xs">
            <Printer className="w-3.5 h-3.5" />PDF
          </Button>
          <div className="text-right text-xs">
            <div className="font-semibold text-foreground">{doneItems}/{totalItems}</div>
            <div className="text-muted-foreground">{locked ? 'Låst' : saving ? 'Lagrer...' : 'Lagret'}</div>
          </div>
        </div>
        <div className="max-w-6xl mx-auto px-4 pb-2">
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${totalItems > 0 ? (doneItems / totalItems) * 100 : 0}%` }} />
          </div>
        </div>
      </div>

      {/* Print header */}
      <div className="hidden print:block px-8 pt-8 pb-4 border-b-2 border-black">
        <div className="flex justify-between items-start">
          <div className="flex items-center gap-3">
            {logoUrl && (

              <img src={logoUrl} alt={businessName} className="h-12 w-auto object-contain" />
            )}
            <div>
              <div className="text-2xl font-bold">{businessName}</div>
              {orgNumber && <div className="text-sm text-gray-600">Org.nr {orgNumber}</div>}
            </div>
          </div>
          <div className="text-right">
            <div className="text-lg font-bold">Sjekkliste</div>
            <div className="text-sm">{reference}</div>
            <div className="text-sm text-gray-600">
              {data['__lockedAt']
                ? `Fullført ${fmtDateTime(data['__lockedAt'] as string)}`
                : `Utskrift ${fmtDateTime(new Date().toISOString())}`}
            </div>
          </div>
        </div>
      </div>

      {/* Booking summary */}
      <div className="px-4 py-4 border-b bg-card print:px-8 print:py-4">
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm max-w-lg">
          <div><span className="text-muted-foreground text-xs">Kunde</span><div className="font-medium">{customerName}</div></div>
          <div><span className="text-muted-foreground text-xs">Telefon</span><div className="font-medium">{customerPhone}</div></div>
          <div><span className="text-muted-foreground text-xs">Utstyr</span><div className="font-medium">{equipmentName}</div></div>
          <div><span className="text-muted-foreground text-xs">Type</span><div className="font-medium">{RENTAL_LABELS[rentalType] || rentalType} · {totalHours}t</div></div>
          <div><span className="text-muted-foreground text-xs">Startdato</span><div className="font-medium">{new Date(startDate + 'T00:00:00').toLocaleDateString('nb-NO', { weekday: 'short', day: 'numeric', month: 'long' })}</div></div>
          <div><span className="text-muted-foreground text-xs">Levering</span><div className="font-medium truncate">{selfPickup ? 'Selvhenting' : deliveryAddress}</div></div>
          <div><span className="text-muted-foreground text-xs">Totalpris</span><div className="font-bold text-primary print:text-black">{totalPrice.toLocaleString('nb-NO')} kr</div></div>
        </div>
      </div>

      {machineDocuments.length > 0 && (
        <div className="px-4 py-3 border-b bg-muted/20 print:px-8">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            Maskindokumentasjon
          </div>
          <div className="flex flex-wrap gap-2">
            {machineDocuments.map((doc) => (
              <a
                key={doc.fileUrl}
                href={doc.fileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-xs hover:bg-muted transition-colors"
              >
                <FileText className="w-3.5 h-3.5 shrink-0" />
                {doc.title || 'Dokument'}
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Locked banner. The gate applies to every status the handover rule
          refuses, not just an unsigned contract on a confirmed booking — so
          the sentence has to cover them all, because the disabled controls
          now say nothing on their own (P-10). */}
      {gateReason && (
        <div className="px-4 py-3 bg-rose-50 dark:bg-rose-950/30 border-b border-rose-200 text-sm text-rose-800 dark:text-rose-300 flex items-center gap-2 print:hidden">
          <Lock className="w-4 h-4 shrink-0" />
          {gateReason}
        </div>
      )}
      {phaseIsLocked && (
        <div className="px-4 py-3 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 text-sm text-amber-800 dark:text-amber-300 flex items-center gap-2 print:hidden">
          <Lock className="w-4 h-4 shrink-0" />
          Denne sjekklisten er fullført og låst. Kun lesbar.
        </div>
      )}

      {/* Stats — computed cross-phase deltas (screen) */}
      {stats.length > 0 && (
        <div className="px-4 py-4 border-b bg-card print:hidden">
          <div className="text-sm font-semibold mb-2">Statistikk</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {stats.map((s) => (
              <div key={s.key} className="rounded-lg border border-border p-3">
                <div className="text-xs text-muted-foreground">{s.label}</div>
                <div className="text-sm font-mono tabular-nums mt-0.5">{statRow(s)}</div>
                <div className="text-base font-bold tabular-nums">
                  = {formatStatNumber(s.delta)}{s.unit ? ` ${s.unit}` : ''}
                  <span className="text-xs font-normal text-muted-foreground ml-1">({s.startPhase} → {s.endPhase})</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Phase tabs */}
      <div className="flex overflow-x-auto border-b bg-card print:hidden">
        {phases.map((p, i) => {
          const vis = visibleItems(p.items);
          const itemsDone = vis.filter(item => isItemFilled(item, data[item.id])).length;
          const fuelExtra = includeFuelForPhase(i) && isFuelDone ? 1 : 0;
          const done = itemsDone + fuelExtra;
          const total = vis.length + (includeFuelForPhase(i) ? 1 : 0);
          const isLocked = phaseLocked(p.id);
          return (
            <button key={p.id} onClick={() => setActivePhase(i)}
              className={`flex-shrink-0 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                i === activePhase ? 'border-primary text-primary'
                : isLocked ? 'border-transparent text-green-600'
                : 'border-transparent text-muted-foreground'
              }`}>
              <div className="flex items-center gap-1.5">
                {isLocked ? <Lock className="w-3.5 h-3.5 text-green-600" /> : null}
                {p.name}
              </div>
              <div className="text-xs mt-0.5 opacity-60">{isLocked ? '✓ Låst' : `${done}/${total}`}</div>
            </button>
          );
        })}
      </div>

      {/* Items — screen */}
      <div className="print:hidden">
        {phase && (
          <div className="px-4 py-4 space-y-3">
            {showFuelItem && fuelNeeds.computable && (
              <button
                type="button"
                onClick={() => setValue(FUEL_KEY, !isFuelDone, true)}
                disabled={locked}
                className={`w-full flex items-start gap-3 p-4 rounded-xl border-2 text-left transition-all active:scale-[0.98] ${
                  isFuelDone
                    ? 'border-green-500 bg-green-50 dark:bg-green-950/20'
                    : 'border-amber-300 bg-amber-50/50 dark:bg-amber-950/20'
                } ${locked ? 'opacity-70 pointer-events-none' : ''}`}
              >
                {isFuelDone
                  ? <CheckCircle2 className="w-6 h-6 text-green-600 shrink-0 mt-0.5" />
                  : <Circle className="w-6 h-6 text-amber-400 shrink-0 mt-0.5" />
                }
                <div className="flex-1 min-w-0">
                  <div className={`text-sm font-medium ${isFuelDone ? 'line-through text-muted-foreground' : ''}`}>
                    <Fuel className="w-4 h-4 inline mr-1.5 -mt-0.5" />
                    Hent {fuelNeeds.cansNeeded} × 20 L drivstoffkanner
                  </div>
                  <div className="text-xs text-muted-foreground mt-2 font-mono tabular-nums space-y-0.5">
                    <div className="flex justify-between"><span>Estimert forbruk</span><span>{Math.round(fuelNeeds.estimatedUsage)} L</span></div>
                    <div className="flex justify-between"><span>+ sikkerhetsmargin</span><span>{fuelNeeds.margin} L</span></div>
                    <div className="flex justify-between border-t border-current/20 pt-0.5"><span>= Behov totalt</span><span>{Math.round(fuelNeeds.plannedTotal)} L</span></div>
                    <div className="flex justify-between"><span>− full tank</span><span>{fuelNeeds.tank} L</span></div>
                    <div className="flex justify-between border-t border-current/20 pt-0.5 font-bold text-foreground"><span>= I kanner</span><span>{Math.round(fuelNeeds.beyondTank)} L → {fuelNeeds.cansNeeded} kanner</span></div>
                  </div>
                </div>
              </button>
            )}

            {visibleItems(phase.items).map((item) => {
              const value = data[item.id];
              const filled = isItemFilled(item, value);

              if (item.answerType === 'checkbox') {
                const checked = value === true;
                return (
                  <button key={item.id} type="button" onClick={() => setValue(item.id, !checked, true)} disabled={locked}
                    className={`w-full flex items-center gap-3 p-4 rounded-xl border-2 text-left transition-all active:scale-[0.98] ${
                      checked ? 'border-green-500 bg-green-50 dark:bg-green-950/20' : 'border-red-200 bg-red-50/50 dark:bg-red-950/10'
                    } ${locked ? 'opacity-70 pointer-events-none' : ''}`}>
                    {checked
                      ? <CheckCircle2 className="w-6 h-6 text-green-600 shrink-0" />
                      : <Circle className="w-6 h-6 text-red-300 shrink-0" />
                    }
                    <span className={`text-sm font-medium ${checked ? 'line-through text-muted-foreground' : ''}`}>{item.label}</span>
                  </button>
                );
              }

              if (item.answerType === 'yesno') {
                const answered = value === true || value === false;
                return (
                  <div key={item.id} className={`p-4 rounded-xl border-2 ${
                    answered ? 'border-green-500 bg-green-50/50 dark:bg-green-950/10' : 'border-red-200 bg-red-50/50 dark:bg-red-950/10'
                  } ${locked ? 'opacity-70' : ''}`}>
                    <div className="text-sm font-medium mb-2">{item.label} <span className="text-red-500">*</span></div>
                    <div className="flex gap-2">
                      {([['Ja', true], ['Nei', false]] as const).map(([lbl, val]) => {
                        const on = value === val;
                        return (
                          <button key={lbl} type="button" disabled={locked}
                            onClick={() => setValue(item.id, val, true)}
                            className={`flex-1 h-11 rounded-lg border-2 text-sm font-medium transition-colors ${
                              on ? 'border-primary bg-primary text-primary-foreground'
                                 : 'border-border bg-background text-muted-foreground hover:bg-muted'
                            } ${locked ? 'pointer-events-none' : ''}`}>
                            {lbl}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              }

              if (item.answerType === 'number') {
                return (
                  <div key={item.id} className={`p-4 rounded-xl border-2 ${filled ? 'border-green-500 bg-green-50/50 dark:bg-green-950/10' : 'border-red-200 bg-red-50/50 dark:bg-red-950/10'}`}>
                    <label className="text-sm font-medium block mb-2">{item.label} <span className="text-red-500">*</span></label>
                    <div className="flex items-center gap-2">
                      <Input type="number" className="h-12 text-lg" placeholder="Påkrevd" disabled={locked}
                        value={typeof value === 'string' ? value : String(value ?? '')}
                        onChange={(e) => setValue(item.id, e.target.value)} />
                      {item.unit && <span className="text-sm text-muted-foreground shrink-0">{item.unit}</span>}
                    </div>
                  </div>
                );
              }

              if (item.answerType === 'measurement') {
                return (
                  <div key={item.id} className={`p-4 rounded-xl border-2 ${filled ? 'border-green-500 bg-green-50/50 dark:bg-green-950/10' : 'border-red-200 bg-red-50/50 dark:bg-red-950/10'}`}>
                    <label className="text-sm font-medium block mb-2">
                      {item.label}
                      {item.unit && <span className="ml-1.5 text-xs text-muted-foreground font-normal">({item.unit})</span>}
                      <span className="text-red-500"> *</span>
                    </label>
                    <div className="flex items-center gap-2">
                      <Input type="number" step="any" className="h-12 text-lg max-w-[160px]" placeholder="0" disabled={locked}
                        value={typeof value === 'string' ? value : String(value ?? '')}
                        onChange={(e) => setValue(item.id, e.target.value)} />
                      {item.unit && <span className="text-sm text-muted-foreground shrink-0">{item.unit}</span>}
                    </div>
                  </div>
                );
              }

              if (item.answerType === 'photo') {
                const urls = photoUrls(value);
                const min = photoMin(item);
                return (
                  <div key={item.id} className={`p-4 rounded-xl border-2 ${filled ? 'border-green-500 bg-green-50/50 dark:bg-green-950/10' : 'border-red-200 bg-red-50/50 dark:bg-red-950/10'}`}>
                    <label className="text-sm font-medium block mb-1">
                      {item.label} <span className="text-red-500">*</span>
                    </label>
                    <div className="text-xs text-muted-foreground mb-2">
                      {urls.length}/{min} bilde{min > 1 ? 'r' : ''}{urls.length < min ? ` · minst ${min} påkrevd` : ' ✓'}
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      {urls.map((url) => (
                        <div key={url} className="relative shrink-0">
                          <img src={url} alt="" className="h-20 w-20 rounded-lg object-cover border" />
                          {!locked && (
                            <button type="button" onClick={() => removePhoto(item.id, url)}
                              className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-red-600 text-white flex items-center justify-center shadow"
                              title="Fjern bilde">
                              <X className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      ))}
                      {!locked && (
                        uploading.has(item.id) ? (
                          <div className="flex items-center gap-2 px-4 py-3 rounded-lg border border-dashed border-primary bg-primary/5">
                            <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                            <span className="text-sm text-primary font-medium">Laster opp...</span>
                          </div>
                        ) : (
                        <label className="cursor-pointer flex flex-col items-center justify-center gap-1 h-20 w-20 rounded-lg border border-dashed border-border hover:bg-muted transition-colors">
                          <Camera className="w-5 h-5 text-muted-foreground" />
                          <span className="text-[11px] text-muted-foreground">{urls.length ? 'Legg til' : 'Ta bilde'}</span>
                          <input type="file" accept="image/*,.heic,.heif" capture="environment" multiple className="hidden"
                            onChange={async (e) => {
                              const files = Array.from(e.target.files ?? []);
                              if (files.length === 0) return;
                              setUploading(prev => new Set(prev).add(item.id));
                              try {
                                for (const file of files) {
                                  const fd = new FormData();
                                  fd.append('file', file);
                                  const res = await fetch('/api/admin/upload', { method: 'POST', credentials: 'include', body: fd });
                                  const d = await res.json();
                                  if (d.url) addPhoto(item.id, d.url);
                                  else if (d.error) { toast.error(d.error); break; }
                                }
                              } catch { toast.error('Opplasting feilet'); }
                              finally { setUploading(prev => { const next = new Set(prev); next.delete(item.id); return next; }); }
                            }} />
                        </label>
                        )
                      )}
                    </div>
                  </div>
                );
              }

              return (
                <div key={item.id} className={`p-4 rounded-xl border-2 ${filled ? 'border-green-500 bg-green-50/50 dark:bg-green-950/10' : 'border-red-200 bg-red-50/50 dark:bg-red-950/10'}`}>
                  <label className="text-sm font-medium block mb-2">{item.label} <span className="text-red-500">*</span></label>
                  <Input type="text" className="h-12" placeholder="Påkrevd" disabled={locked}
                    value={typeof value === 'string' ? value : ''}
                    onChange={(e) => setValue(item.id, e.target.value)} />
                </div>
              );
            })}

            {/* Submit current phase */}
            {!locked && phaseAllDone && (
              <Button className="w-full h-12 text-base mt-4 bg-green-600 hover:bg-green-700" onClick={handleSubmitPhase} disabled={submitting}>
                {submitting ? 'Fullfører...' : `✓ Fullfør ${phase.name}`}
              </Button>
            )}
            {!locked && !phaseAllDone && (
              <p className="text-center text-sm text-red-500 mt-4">
                Fyll ut alle punkter for å fullføre {phase.name.toLowerCase()}
              </p>
            )}
          </div>
        )}
      </div>

      {renterSubmissions.length > 0 && (
        <div className="px-4 py-4 border-t bg-muted/20 print:hidden">
          <h2 className="text-sm font-semibold mb-3">Leietaker / vedlikehold</h2>
          {renterSubmissionBlock}
        </div>
      )}

      {/* Print view */}
      <div className="hidden print:block px-8 py-4">
        {phases.map((p, phaseIdx) => (
          <div key={p.id} className="mb-6">
            <div className="flex items-baseline justify-between border-b border-gray-300 pb-1 mb-3">
              <h2 className="text-lg font-bold">{p.name}</h2>
              {typeof data[`__phase_locked_at_${p.id}`] === 'string' && (
                <span className="text-xs text-gray-600">Fullført {fmtDateTime(data[`__phase_locked_at_${p.id}`] as string)}</span>
              )}
            </div>
            <div className="space-y-1.5">
              {includeFuelForPhase(phaseIdx) && fuelNeeds.computable && (
                <div className="text-sm mb-2">
                  <div className="flex items-start gap-2">
                    <span className="w-5 h-5 border border-gray-400 rounded flex items-center justify-center shrink-0 mt-0.5 text-xs">
                      {isFuelDone ? '✓' : ''}
                    </span>
                    <span className="flex-1">Hent {fuelNeeds.cansNeeded} × 20 L drivstoffkanner</span>
                  </div>
                </div>
              )}
              {visibleItems(p.items).map((item) => {
                const value = data[item.id];
                const checked = value === true;
                return (
                  <div key={item.id} className="text-sm mb-2">
                    <div className="flex items-start gap-2">
                      <span className="w-5 h-5 border border-gray-400 rounded flex items-center justify-center shrink-0 mt-0.5 text-xs">
                        {item.answerType === 'checkbox' ? (checked ? '✓' : '') : ''}
                      </span>
                      <span className="flex-1">
                        {item.label}
                        {item.conditionItemId && <span className="text-gray-500"> (betinget)</span>}
                      </span>
                      {item.answerType === 'yesno' && (value === true || value === false) && (
                        <span className="font-medium">{value === true ? 'Ja' : 'Nei'}</span>
                      )}
                      {(item.answerType === 'number' || item.answerType === 'measurement') && typeof value === 'string' && value && (
                        <span className="font-medium">{value} {item.unit || ''}</span>
                      )}
                      {item.answerType === 'text' && typeof value === 'string' && value && (
                        <span className="font-medium italic">{value}</span>
                      )}
                    </div>
                    {item.answerType === 'photo' && photoUrls(value).length > 0 && (
                      <div className="ml-7 mt-1 flex flex-wrap gap-2">
                        {photoUrls(value).map((url) => (
                          <img key={url} src={url} alt={item.label} className="max-w-[200px] max-h-[150px] rounded border border-gray-300 object-cover" />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {renterSubmissions.length > 0 && (
          <div className="mb-6">
            <h2 className="text-lg font-bold border-b border-gray-300 pb-1 mb-3">Leietaker / vedlikehold</h2>
            {renterSubmissionBlock}
          </div>
        )}
        {stats.length > 0 && (
          <div className="mb-6">
            <h2 className="text-lg font-bold border-b border-gray-300 pb-1 mb-3">Statistikk</h2>
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-left text-gray-600 border-b border-gray-300">
                  <th className="py-1 pr-3 font-medium">Måling</th>
                  <th className="py-1 px-3 font-medium">Start</th>
                  <th className="py-1 px-3 font-medium">Slutt</th>
                  <th className="py-1 pl-3 font-medium text-right">Differanse</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((s) => (
                  <tr key={s.key} className="border-b border-gray-200">
                    <td className="py-1.5 pr-3">
                      {s.label}
                      <span className="text-gray-500"> ({s.startPhase} → {s.endPhase})</span>
                    </td>
                    <td className="py-1.5 px-3 tabular-nums">{formatStatNumber(s.startValue)}{s.unit ? ` ${s.unit}` : ''}</td>
                    <td className="py-1.5 px-3 tabular-nums">{formatStatNumber(s.endValue)}{s.unit ? ` ${s.unit}` : ''}</td>
                    <td className="py-1.5 pl-3 tabular-nums text-right font-bold">{formatStatNumber(s.delta)}{s.unit ? ` ${s.unit}` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-8 pt-4 border-t border-gray-300 text-xs text-center text-gray-600">
          {businessName}{orgNumber ? ` · Org.nr ${orgNumber}` : ''} · {reference} · {data['__lockedAt'] ? `Fullført ${fmtDateTime(data['__lockedAt'] as string)}` : 'Ikke fullført'}
        </div>
      </div>
    </div>
  );
}
