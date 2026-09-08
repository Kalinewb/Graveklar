'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Camera,
  CheckCircle2,
  Circle,
  FlaskConical,
  Loader2,
  Lock,
  Printer,
  RotateCcw,
  Smartphone,
  Wrench,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { SegmentedControl } from '@/components/admin-ui';
import {
  filterPhasesForBooking,
  isItemActive,
  isItemFilled,
  photoMin,
  photoUrls,
  resolvePhaseAudience,
  type ChecklistPhaseLike,
} from '@/lib/checklist';
import {
  applyHandoverComplete,
  buildSandboxBooking,
  buildSandboxFlowSummary,
  buildSandboxRenterPhases,
  canLockOperatorPhase,
  findHandoverPhase,
  findOperatorPhaseIndex,
  formatSandboxSimDay,
  sandboxDateRange,
  sandboxDayLabel,
  sandboxPresetDagligKontroll,
  sandboxPresetLasteLevering,
  sandboxPresetLasteSelvhenting,
  sandboxPresetUtlevering,
  sandboxSubmissionKey,
  type SandboxBookingConfig,
} from '@/lib/checklist-sandbox';
import { ChecklistSandboxPrint } from './ChecklistSandboxPrint';

interface ChecklistItem {
  id: string;
  label: string;
  answerType: string;
  unit?: string | null;
  conditionItemId?: string | null;
  conditionValue?: string | null;
  minPhotos?: number | null;
}

interface Phase extends ChecklistPhaseLike {
  items: ChecklistItem[];
}

interface MachineDocument {
  title: string;
  fileUrl: string;
}

interface Props {
  phases: Phase[];
  equipmentName: string;
  businessName: string;
  orgNumber: string;
  logoUrl?: string;
  machineDocuments: MachineDocument[];
}

type Answers = Record<string, string | boolean | string[]>;

interface RenterSubmission {
  phaseId: string;
  intervalKey: string;
  phaseName: string;
  intervalLabel: string;
  data: Answers;
  submittedAt: string;
}

function ChecklistItems({
  items,
  answers,
  onChange,
  disabled,
  uploadEndpoint = '/api/admin/upload',
}: {
  items: ChecklistItem[];
  answers: Answers;
  onChange: (id: string, value: string | boolean | string[]) => void;
  disabled?: boolean;
  uploadEndpoint?: string;
}) {
  const [uploading, setUploading] = useState<Set<string>>(() => new Set());
  const visible = items.filter((i) => isItemActive(i, answers, items));

  const addPhoto = (itemId: string, url: string) => {
    onChange(itemId, [...photoUrls(answers[itemId]), url]);
  };

  const removePhoto = (itemId: string, url: string) => {
    onChange(itemId, photoUrls(answers[itemId]).filter((u) => u !== url));
  };

  return (
    <div className="space-y-2">
      {visible.map((item) => {
        const value = answers[item.id];
        const filled = isItemFilled(item, value);

        if (item.answerType === 'yesno') {
          return (
            <div
              key={item.id}
              className={`p-3 rounded-xl border ${value === true || value === false ? 'border-green-500' : 'border-border'}`}
            >
              <div className="text-sm font-medium mb-2">{item.label}</div>
              <div className="flex gap-2">
                {([['Ja', true], ['Nei', false]] as const).map(([lbl, val]) => (
                  <button
                    key={lbl}
                    type="button"
                    disabled={disabled}
                    onClick={() => onChange(item.id, val)}
                    className={`flex-1 h-9 rounded-lg border text-sm font-medium ${
                      value === val ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
                    }`}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
            </div>
          );
        }

        if (item.answerType === 'checkbox') {
          const checked = value === true;
          return (
            <button
              key={item.id}
              type="button"
              disabled={disabled}
              onClick={() => onChange(item.id, !checked)}
              className={`w-full flex items-center gap-3 p-3 rounded-xl border text-left ${
                checked ? 'border-green-500 bg-green-50 dark:bg-green-950/20' : 'border-border'
              }`}
            >
              {checked ? (
                <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0" />
              ) : (
                <Circle className="w-5 h-5 text-muted-foreground shrink-0" />
              )}
              <span className="text-sm font-medium">{item.label}</span>
            </button>
          );
        }

        if (item.answerType === 'number' || item.answerType === 'measurement' || item.answerType === 'text') {
          return (
            <div key={item.id} className={`p-3 rounded-xl border ${filled ? 'border-green-500' : 'border-border'}`}>
              <label className="text-sm font-medium block mb-1.5">{item.label}</label>
              <input
                type={item.answerType === 'text' ? 'text' : 'number'}
                disabled={disabled}
                value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
                onChange={(e) => onChange(item.id, e.target.value)}
                className="w-full h-9 px-3 rounded-lg border bg-background text-sm"
                placeholder={item.unit ? `Enhet: ${item.unit}` : undefined}
              />
            </div>
          );
        }

        if (item.answerType === 'photo') {
          const urls = photoUrls(value);
          const min = photoMin(item);
          return (
            <div
              key={item.id}
              className={`p-3 rounded-xl border ${filled ? 'border-green-500' : 'border-border'}`}
            >
              <label className="text-sm font-medium block mb-1">{item.label}</label>
              <div className="text-xs text-muted-foreground mb-2">
                {urls.length}/{min} bilde{min > 1 ? 'r' : ''}
                {urls.length < min ? ` · minst ${min} påkrevd` : ' ✓'}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {urls.map((url) => (
                  <div key={url} className="relative shrink-0">
                    { }
                    <img src={url} alt="" className="h-20 w-20 rounded-lg object-cover border" />
                    {!disabled && (
                      <button
                        type="button"
                        onClick={() => removePhoto(item.id, url)}
                        className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-red-600 text-white flex items-center justify-center shadow"
                        title="Fjern bilde"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))}
                {!disabled && (
                  uploading.has(item.id) ? (
                    <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                  ) : (
                    <label className="cursor-pointer flex flex-col items-center justify-center gap-1 h-20 w-20 rounded-lg border border-dashed border-border hover:bg-muted transition-colors">
                      <Camera className="w-5 h-5 text-muted-foreground" />
                      <span className="text-[11px] text-muted-foreground">{urls.length ? 'Legg til' : 'Ta bilde'}</span>
                      <input
                        type="file"
                        accept="image/*,.heic,.heif"
                        capture="environment"
                        multiple
                        className="hidden"
                        onChange={async (e) => {
                          const files = Array.from(e.target.files ?? []);
                          if (files.length === 0) return;
                          setUploading((prev) => new Set(prev).add(item.id));
                          try {
                            for (const file of files) {
                              const fd = new FormData();
                              fd.append('file', file);
                              const res = await fetch(uploadEndpoint, {
                                method: 'POST',
                                credentials: 'include',
                                body: fd,
                              });
                              const d = await res.json();
                              if (d.url) addPhoto(item.id, d.url);
                              else if (d.error) break;
                            }
                          } finally {
                            setUploading((prev) => {
                              const next = new Set(prev);
                              next.delete(item.id);
                              return next;
                            });
                            e.target.value = '';
                          }
                        }}
                      />
                    </label>
                  )
                )}
              </div>
            </div>
          );
        }

        return null;
      })}
    </div>
  );
}

export default function ChecklistSandboxClient({
  phases,
  equipmentName,
  businessName,
  orgNumber,
  logoUrl,
  machineDocuments,
}: Props) {
  const [config, setConfig] = useState<SandboxBookingConfig>({
    selfPickup: true,
    rentalPreset: 'same_day',
    dayIndex: 0,
  });
  const [operatorData, setOperatorData] = useState<Answers>({});
  const [renterAnswers, setRenterAnswers] = useState<Answers>({});
  const [renterSubmissions, setRenterSubmissions] = useState<RenterSubmission[]>([]);
  const [operatorPhaseIdx, setOperatorPhaseIdx] = useState(0);
  const [activeRenterPhaseId, setActiveRenterPhaseId] = useState<string | null>(null);

  const renterSubmittedKeys = useMemo(
    () => new Set(renterSubmissions.map((s) => sandboxSubmissionKey(s.phaseId, s.intervalKey))),
    [renterSubmissions],
  );

  const booking = useMemo(
    () => buildSandboxBooking(config, operatorData),
    [config, operatorData],
  );

  const operatorPhases = useMemo(
    () => filterPhasesForBooking(phases, booking, { audience: 'operator' }),
    [phases, booking],
  );

  const renterPhaseViews = useMemo(
    () => buildSandboxRenterPhases(phases, booking, config, renterSubmittedKeys),
    [phases, booking, config, renterSubmittedKeys],
  );

  const flowSummary = useMemo(
    () => buildSandboxFlowSummary(phases, booking, config, renterPhaseViews),
    [phases, booking, config, renterPhaseViews],
  );

  const handoverComplete = useMemo(() => {
    const handover = findHandoverPhase(phases, booking);
    if (!handover) return true;
    return operatorData[`__phase_locked_${handover.id}`] === true;
  }, [phases, booking, operatorData]);

  const dateRange = sandboxDateRange(config);
  const simDay = formatSandboxSimDay(config);

  const operatorPhase = operatorPhases[operatorPhaseIdx];
  const operatorLocked = operatorPhase
    ? operatorData[`__phase_locked_${operatorPhase.id}`] === true
    : false;
  const operatorCanLock = operatorPhase
    ? canLockOperatorPhase(operatorPhase.id, operatorPhases, operatorData)
    : false;

  useEffect(() => {
    if (operatorPhases.length === 0) {
      setOperatorPhaseIdx(0);
      return;
    }
    if (operatorPhaseIdx >= operatorPhases.length) {
      setOperatorPhaseIdx(operatorPhases.length - 1);
    }
  }, [operatorPhases.length, operatorPhaseIdx]);

  function clearRenterState() {
    setRenterAnswers({});
    setRenterSubmissions([]);
    setActiveRenterPhaseId(null);
  }

  function updateConfig(patch: Partial<SandboxBookingConfig>) {
    setConfig((c) => ({ ...c, ...patch }));
    if (patch.selfPickup !== undefined || patch.rentalPreset !== undefined) {
      setOperatorData({});
      setOperatorPhaseIdx(0);
    }
    if (patch.selfPickup !== undefined || patch.rentalPreset !== undefined || patch.dayIndex !== undefined) {
      clearRenterState();
    }
  }

  const operatorItemsDone = operatorPhase
    ? operatorPhase.items
        .filter((i) => isItemActive(i, operatorData, operatorPhase.items))
        .every((i) => isItemFilled(i, operatorData[i.id]))
    : false;

  const activeRenterView =
    renterPhaseViews.find((p) => p.id === activeRenterPhaseId)
    ?? renterPhaseViews.find((p) => !p.submitted && p.available)
    ?? renterPhaseViews[0];

  const activeRenterPhase = phases.find((p) => p.id === activeRenterView?.id);
  const renterItemsDone = activeRenterPhase
    ? activeRenterPhase.items
        .filter((i) => isItemActive(i, renterAnswers, activeRenterPhase.items))
        .every((i) => isItemFilled(i, renterAnswers[i.id]))
    : false;

  function resetSandbox() {
    setOperatorData({});
    setRenterAnswers({});
    setRenterSubmissions([]);
    setOperatorPhaseIdx(0);
    setActiveRenterPhaseId(null);
  }

  function applyPreset(
    preset: 'laste-selvhenting' | 'laste-levering' | 'utlevering' | 'daglig-kontroll',
  ) {
    const presetDef =
      preset === 'laste-selvhenting' ? sandboxPresetLasteSelvhenting()
      : preset === 'laste-levering' ? sandboxPresetLasteLevering()
      : preset === 'daglig-kontroll' ? sandboxPresetDagligKontroll()
      : sandboxPresetUtlevering();

    const { config: c, handoverComplete: hc } = presetDef;
    const operatorDataInit = (hc
      ? applyHandoverComplete({}, phases, { selfPickup: c.selfPickup }, true)
      : {}) as Answers;

    let phaseIdx = 0;
    if (preset === 'laste-levering') {
      phaseIdx = findOperatorPhaseIndex(phases, { selfPickup: c.selfPickup }, /laste|sikring/i);
    } else if (preset === 'utlevering') {
      phaseIdx = findOperatorPhaseIndex(phases, { selfPickup: c.selfPickup }, /lever|selvhent/i);
    } else if (preset === 'daglig-kontroll') {
      phaseIdx = 0;
    }

    setConfig(c);
    setOperatorData(operatorDataInit);
    setRenterAnswers({});
    setRenterSubmissions([]);
    setActiveRenterPhaseId(null);
    setOperatorPhaseIdx(phaseIdx);
  }

  function setHandoverComplete(complete: boolean) {
    setOperatorData((prev) => applyHandoverComplete(prev, phases, booking, complete) as Answers);
    if (!complete) clearRenterState();
  }

  function lockOperatorPhase() {
    if (!operatorPhase || !operatorItemsDone || operatorLocked || !operatorCanLock) return;
    const updated: Answers = {
      ...operatorData,
      [`__phase_locked_${operatorPhase.id}`]: true,
      [`__phase_locked_at_${operatorPhase.id}`]: new Date().toISOString(),
    };
    const allLocked = operatorPhases.every(
      (p) => p.id === operatorPhase.id || updated[`__phase_locked_${p.id}`] === true,
    );
    if (allLocked) {
      updated.__locked = true;
      updated.__lockedAt = new Date().toISOString();
    }
    setOperatorData(updated);
    const firstOpen = operatorPhases.findIndex(
      (p, i) => i !== operatorPhaseIdx && updated[`__phase_locked_${p.id}`] !== true,
    );
    if (firstOpen >= 0) setOperatorPhaseIdx(firstOpen);
    else if (operatorPhaseIdx < operatorPhases.length - 1) setOperatorPhaseIdx(operatorPhaseIdx + 1);
  }

  function submitRenterPhase() {
    if (!activeRenterView || !activeRenterPhase || !renterItemsDone) return;
    if (!activeRenterView.available || activeRenterView.submitted) return;
    setRenterSubmissions((prev) => [
      ...prev,
      {
        phaseId: activeRenterView.id,
        intervalKey: activeRenterView.intervalKey,
        phaseName: activeRenterView.name,
        intervalLabel: activeRenterView.intervalLabel,
        data: { ...renterAnswers },
        submittedAt: new Date().toISOString(),
      },
    ]);
    setRenterAnswers({});
    const submittedAfter = new Set([
      ...renterSubmissions.map((s) => sandboxSubmissionKey(s.phaseId, s.intervalKey)),
      sandboxSubmissionKey(activeRenterView.id, activeRenterView.intervalKey),
    ]);
    const next = renterPhaseViews.find(
      (p) => !submittedAfter.has(sandboxSubmissionKey(p.id, p.intervalKey)) && p.available,
    );
    setActiveRenterPhaseId(next?.id ?? null);
  }

  const startDateLabel = new Date(`${simDay}T12:00:00`).toLocaleDateString('nb-NO', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
  });

  return (
    <div className="min-h-screen bg-background">
      <div className="sticky top-0 z-20 bg-primary text-primary-foreground px-4 py-3 border-b border-primary-foreground/10 print:hidden">
        <div className="max-w-6xl mx-auto flex items-center gap-3">
          <Link href="/admin" className="p-1 hover:opacity-80">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <FlaskConical className="w-5 h-5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-bold text-sm">Sjekkliste-sandbox</div>
            <div className="text-xs opacity-80 truncate">
              {equipmentName} · simulert {simDay} · ingen ekte booking
            </div>
          </div>
          <Button variant="secondary" size="sm" onClick={() => window.print()} className="gap-1.5 text-xs">
            <Printer className="w-3.5 h-3.5" />
            PDF
          </Button>
          <Button variant="secondary" size="sm" onClick={resetSandbox} className="gap-1.5 text-xs">
            <RotateCcw className="w-3.5 h-3.5" />
            Nullstill
          </Button>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-6 space-y-6 print:hidden">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Scenario</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => applyPreset('utlevering')}>
                Utlevering (operatør)
              </Button>
              <Button size="sm" variant="outline" onClick={() => applyPreset('laste-selvhenting')}>
                Laste og sikring · QR
              </Button>
              <Button size="sm" variant="outline" onClick={() => applyPreset('laste-levering')}>
                Laste og sikring · operatør
              </Button>
              <Button size="sm" variant="outline" onClick={() => applyPreset('daglig-kontroll')}>
                Daglig kontroll · dag 2
              </Button>
            </div>

            <div className="rounded-lg border bg-muted/40 px-3 py-2 text-sm">
              <span className={flowSummary.handoverComplete ? 'text-green-600' : 'text-amber-600'}>
                {flowSummary.handoverComplete ? '✓' : '○'} {flowSummary.handoverLabel}
              </span>
              <span className="text-muted-foreground"> · {flowSummary.simDayLabel}</span>
              <p className="text-xs text-muted-foreground mt-1">{flowSummary.hint}</p>
            </div>

            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Hentemåte</p>
                <SegmentedControl
                  value={config.selfPickup ? 'selfPickup' : 'delivery'}
                  onChange={(v) => updateConfig({ selfPickup: v === 'selfPickup' })}
                  options={[
                    { value: 'selfPickup', label: 'Selvhenting' },
                    { value: 'delivery', label: 'Levering' },
                  ]}
                />
              </div>

              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Leieperiode</p>
                <SegmentedControl
                  value={config.rentalPreset}
                  onChange={(v) =>
                    updateConfig({
                      rentalPreset: v as SandboxBookingConfig['rentalPreset'],
                      dayIndex: v === 'same_day' ? 0 : Math.min(config.dayIndex, 2),
                    })
                  }
                  options={[
                    { value: 'same_day', label: 'Døgn i dag' },
                    { value: 'multi_day', label: '3 dager' },
                  ]}
                />
              </div>

              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Simulert dag</p>
                <SegmentedControl
                  value={String(config.dayIndex)}
                  onChange={(v) => updateConfig({ dayIndex: Number(v) })}
                  options={dateRange.map((d, i) => ({
                    value: String(i),
                    label: sandboxDayLabel(d, config),
                  }))}
                />
              </div>

              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Utlevering fullført</p>
                <label className="flex items-center gap-2 h-9 px-3 rounded-lg border cursor-pointer text-sm">
                  <input
                    type="checkbox"
                    checked={handoverComplete}
                    onChange={(e) => setHandoverComplete(e.target.checked)}
                    className="rounded"
                  />
                  Operatør har levert ut
                </label>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              Operatør-faser må fullføres i rekkefølge. Kunde-QR åpnes først etter utlevering/levering.
              Bilder og PDF fungerer som i produksjon — ingenting lagres på booking.
            </p>
          </CardContent>
        </Card>

        <div className="grid lg:grid-cols-2 gap-6">
          {/* Operator panel */}
          <Card className="overflow-hidden">
            <CardHeader className="pb-2 bg-muted/30">
              <CardTitle className="text-sm flex items-center gap-2">
                <Wrench className="w-4 h-4" />
                Operatør
                <Badge variant="outline" className="text-[10px] font-normal ml-auto">
                  {operatorPhases.length} faser
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {operatorPhases.length === 0 ? (
                <p className="text-sm text-muted-foreground p-4">Ingen operatør-faser for dette scenariet.</p>
              ) : (
                <>
                  <div className="flex overflow-x-auto border-b">
                    {operatorPhases.map((p, i) => {
                      const locked = operatorData[`__phase_locked_${p.id}`] === true;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => setOperatorPhaseIdx(i)}
                          className={`shrink-0 px-3 py-2 text-xs font-medium border-b-2 ${
                            i === operatorPhaseIdx ? 'border-primary text-primary' : 'border-transparent text-muted-foreground'
                          }`}
                        >
                          {locked && <Lock className="w-3 h-3 inline mr-1" />}
                          {p.name}
                        </button>
                      );
                    })}
                  </div>
                  <div className="p-4 space-y-3">
                    {operatorPhase && (
                      <>
                        <div className="text-xs text-muted-foreground">
                          {resolvePhaseAudience(operatorPhase, booking) === 'operator' ? 'Operatør' : 'Delt fase'}
                          {operatorLocked && ' · Låst'}
                        </div>
                        <ChecklistItems
                          items={operatorPhase.items}
                          answers={operatorData}
                          onChange={(id, val) => setOperatorData((prev) => ({ ...prev, [id]: val }))}
                          disabled={operatorLocked}
                        />
                        {!operatorLocked && (
                          <>
                            {!operatorCanLock && (
                              <p className="text-xs text-amber-600">
                                Fullfør tidligere operatør-faser først.
                              </p>
                            )}
                            <Button
                              size="sm"
                              className="w-full"
                              disabled={!operatorItemsDone || !operatorCanLock}
                              onClick={lockOperatorPhase}
                            >
                              Fullfør og lås fase
                            </Button>
                          </>
                        )}
                      </>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Renter panel */}
          <Card className="overflow-hidden">
            <CardHeader className="pb-2 bg-muted/30">
              <CardTitle className="text-sm flex items-center gap-2">
                <Smartphone className="w-4 h-4" />
                Kunde QR
                <span className="text-xs font-normal text-muted-foreground ml-1">({businessName})</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {machineDocuments.length > 0 && (
                <div className="px-4 py-2 border-b flex flex-wrap gap-2">
                  {machineDocuments.map((doc) => (
                    <a
                      key={doc.fileUrl}
                      href={doc.fileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs underline text-muted-foreground"
                    >
                      {doc.title || 'PDF'}
                    </a>
                  ))}
                </div>
              )}

              {renterPhaseViews.length === 0 ? (
                <p className="text-sm text-muted-foreground p-4">Ingen kunde-faser for dette scenariet.</p>
              ) : !handoverComplete ? (
                <div className="p-4">
                  <div className="rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-950/20 p-4 flex gap-3 text-sm">
                    <Lock className="w-5 h-5 shrink-0 text-amber-700" />
                    <div>
                      <div className="font-medium">Kunde-QR er låst</div>
                      <p className="mt-1 text-amber-900 dark:text-amber-200 opacity-90">
                        {config.selfPickup
                          ? 'Fullfør henting/utlevering i operatør-panelet først, eller huk av «Operatør har levert ut».'
                          : 'Fullfør levering i operatør-panelet først, eller huk av «Operatør har levert ut».'}
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex overflow-x-auto border-b gap-1 p-2">
                    {renterPhaseViews.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          setActiveRenterPhaseId(p.id);
                          setRenterAnswers({});
                        }}
                        className={`shrink-0 px-2.5 py-1.5 rounded-lg text-xs border ${
                          p.id === (activeRenterPhaseId ?? activeRenterView?.id)
                            ? 'border-primary bg-primary/10'
                            : 'border-border'
                        } ${!p.available ? 'opacity-60' : ''}`}
                      >
                        {p.name}
                        {p.submitted && ' ✓'}
                        {!p.available && !p.submitted && ' 🔒'}
                      </button>
                    ))}
                  </div>

                  <div className="p-4 space-y-3">
                    {activeRenterView?.submitted ? (
                      <div className="text-center py-8 space-y-2">
                        <CheckCircle2 className="w-10 h-10 text-green-500 mx-auto" />
                        <p className="text-sm font-medium">{activeRenterView.name} — levert</p>
                      </div>
                    ) : activeRenterView && !activeRenterView.available ? (
                      <div className="rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-950/20 p-4 flex gap-3 text-sm">
                        <Lock className="w-5 h-5 shrink-0 text-amber-700" />
                        <div>
                          <div className="font-medium">{activeRenterView.name}</div>
                          <p className="mt-1 text-amber-900 dark:text-amber-200 opacity-90">
                            {activeRenterView.lockedReason ?? 'Ikke tilgjengelig ennå.'}
                          </p>
                        </div>
                      </div>
                    ) : activeRenterPhase ? (
                      <>
                        <div className="text-xs text-muted-foreground">{activeRenterView.intervalLabel}</div>
                        <ChecklistItems
                          items={activeRenterPhase.items}
                          answers={renterAnswers}
                          onChange={(id, val) => setRenterAnswers((prev) => ({ ...prev, [id]: val }))}
                        />
                        <Button
                          size="sm"
                          className="w-full"
                          disabled={!renterItemsDone}
                          onClick={submitRenterPhase}
                        >
                          Lever inn
                        </Button>
                      </>
                    ) : null}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <ChecklistSandboxPrint
        businessName={businessName}
        orgNumber={orgNumber}
        logoUrl={logoUrl}
        reference="SANDBOX"
        customerName={booking.name}
        customerPhone={booking.phone}
        equipmentName={equipmentName}
        startDateLabel={startDateLabel}
        selfPickup={config.selfPickup}
        operatorPhases={operatorPhases}
        allPhases={phases}
        operatorData={operatorData}
        renterSubmissions={renterSubmissions}
      />
    </div>
  );
}
