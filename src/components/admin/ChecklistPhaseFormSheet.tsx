'use client';

import { useState } from 'react';
import {
  ChevronDown,
  ClipboardList,
  Loader2,
  Save,
  Smartphone,
  Shuffle,
  UserCog,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { FieldRow, Stepper, TextInput, Toggle } from '@/components/admin-ui';

export interface ChecklistPhaseFormData {
  name?: string;
  sortOrder?: number;
  isActive?: boolean;
  appliesTo?: string;
  audience?: string;
  intervalMode?: string;
  // null (not just absent) is a meaningful value here: it's what the form
  // writes when intervalMode leaves 'hours', and it's how the row is stored.
  intervalHours?: number | null;
  isCompletionTrigger?: boolean;
}

type AudienceMode = 'operator' | 'renter' | 'split';

const AUDIENCE_OPTIONS: {
  value: AudienceMode;
  label: string;
  description: string;
  Icon: typeof UserCog;
}[] = [
  {
    value: 'operator',
    label: 'Operatør',
    description: 'Du fyller ut i admin-sjekklisten på utleveringsdagen.',
    Icon: UserCog,
  },
  {
    value: 'renter',
    label: 'Kunde (QR)',
    description: 'Kunden scanner QR og fyller på /sjekkliste.',
    Icon: Smartphone,
  },
  {
    value: 'split',
    label: 'Varierer etter henting',
    description: 'Operatør ved levering · kunde ved selvhenting.',
    Icon: Shuffle,
  },
];

const WHEN_OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: 'once', label: 'Én gang', hint: 'Under leieperioden, når som helst' },
  { value: 'return', label: 'Ved retur', hint: 'Først på returdagen (f.eks. lasting hjem)' },
  { value: 'daily', label: 'Hver dag', hint: 'Ny innsending hver kalenderdag' },
  { value: 'hours', label: 'Intervall', hint: 'Gjentas hver X. time' },
];

function describePhase(form: Partial<ChecklistPhaseFormData>) {
  const aud = (form.audience ?? 'operator') as AudienceMode;
  const applies = form.appliesTo ?? 'all';
  const interval = form.intervalMode ?? 'once';

  const whenLabel = () => {
    if (interval === 'return') return 'ved retur';
    if (interval === 'daily') return 'daglig';
    if (interval === 'hours') return `hver ${form.intervalHours ?? 24}. t`;
    return 'én gang';
  };

  const operator = 'Admin-sjekkliste';
  const renter = `QR-kode · ${whenLabel()}`;

  if (aud === 'operator') {
    if (applies === 'delivery') return { delivery: operator, selfPickup: '—' };
    if (applies === 'selfPickup') return { delivery: '—', selfPickup: operator };
    return { delivery: operator, selfPickup: operator };
  }
  if (aud === 'renter') {
    if (applies === 'delivery') return { delivery: renter, selfPickup: '—' };
    if (applies === 'selfPickup') return { delivery: '—', selfPickup: renter };
    return { delivery: renter, selfPickup: renter };
  }
  return { delivery: operator, selfPickup: renter };
}

/** Single-line label for the phase list in admin (avoids duplicate badges). */
export function getPhaseListBadge(phase: {
  audience?: string | null;
  appliesTo?: string | null;
  intervalMode?: string | null;
  intervalHours?: number | null;
}): string | null {
  const aud = phase.audience ?? 'operator';
  const applies = phase.appliesTo ?? 'all';
  const interval = phase.intervalMode ?? 'once';

  const timing = () => {
    if (interval === 'return') return 'ved retur';
    if (interval === 'daily') return 'daglig';
    if (interval === 'hours') return `hver ${phase.intervalHours ?? 24}t`;
    return null;
  };

  if (aud === 'split') {
    const t = timing();
    return t ? `Operatør (levering) · QR (selvhenting, ${t})` : 'Operatør (levering) · QR (selvhenting)';
  }
  if (aud === 'renter') {
    const parts = ['QR'];
    if (applies === 'delivery') parts.push('levering');
    if (applies === 'selfPickup') parts.push('selvhenting');
    const t = timing();
    if (t) parts.push(t);
    return parts.join(' · ');
  }
  if (aud === 'operator') {
    if (applies === 'delivery') return 'Operatør · levering';
    if (applies === 'selfPickup') return 'Operatør · selvhenting';
    return 'Operatør';
  }
  return null;
}

export function buildChecklistPhasePayload(form: Partial<ChecklistPhaseFormData>) {
  const audience = form.audience ?? 'operator';
  const intervalMode = form.intervalMode ?? 'once';
  return {
    name: form.name?.trim() || '',
    sortOrder: form.sortOrder ?? 0,
    isActive: form.isActive ?? true,
    appliesTo: form.appliesTo ?? 'all',
    audience,
    intervalMode,
    intervalHours: intervalMode === 'hours' ? (form.intervalHours ?? 24) : null,
    isCompletionTrigger:
      audience === 'renter' || audience === 'split' ? false : Boolean(form.isCompletionTrigger),
  };
}

function OptionCard({
  selected,
  onClick,
  label,
  description,
  Icon,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
  description: string;
  Icon: typeof UserCog;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left rounded-xl border-2 p-3 transition-colors ${
        selected
          ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
          : 'border-border hover:border-primary/40 hover:bg-muted/40'
      }`}
    >
      <div className="flex gap-3">
        <div
          className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
            selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
          }`}
        >
          <Icon className="w-4 h-4" />
        </div>
        <div className="min-w-0">
          <div className="font-semibold text-sm">{label}</div>
          <div className="text-xs text-muted-foreground mt-0.5 leading-snug">{description}</div>
        </div>
      </div>
    </button>
  );
}

export function ChecklistPhaseFormSheet({
  open,
  onOpenChange,
  form,
  onChange,
  onSave,
  saving,
  error,
  editing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  form: Partial<ChecklistPhaseFormData>;
  onChange: (patch: Partial<ChecklistPhaseFormData>) => void;
  onSave: () => void;
  saving: boolean;
  error: string;
  editing: boolean;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const audience = (form.audience ?? 'operator') as AudienceMode;
  const summary = describePhase(form);
  const showRenterTiming = audience === 'renter' || audience === 'split';
  const showBookingFilter = audience !== 'split';
  const showCompletion = audience === 'operator';

  const setAudience = (value: AudienceMode) => {
    onChange({
      audience: value,
      isCompletionTrigger: value === 'renter' || value === 'split' ? false : form.isCompletionTrigger,
      ...(value === 'split' && (form.intervalMode ?? 'once') === 'once'
        ? { intervalMode: 'return' }
        : {}),
    });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-[520px] flex flex-col p-0">
        <SheetHeader className="shrink-0">
          <SheetTitle>{editing ? 'Rediger fase' : 'Ny sjekklistefase'}</SheetTitle>
          <SheetDescription>
            En fase er et steg i utleieflyten — f.eks. klargjøring, levering eller retur.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {error && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 text-destructive text-sm px-3 py-2">
              {error}
            </div>
          )}

          <FieldRow label="Navn på fasen">
            <TextInput
              placeholder="F.eks. Klargjøring, Laste og sikring, Retur"
              value={form.name ?? ''}
              onChange={(v) => onChange({ name: v })}
            />
          </FieldRow>

          <div className="rounded-xl border bg-muted/20 p-3 space-y-2">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <ClipboardList className="w-4 h-4 text-primary" />
              Forhåndsvisning
            </div>
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
              <span className="text-muted-foreground">Levering</span>
              <span className="font-medium">{summary.delivery}</span>
              <span className="text-muted-foreground">Selvhenting</span>
              <span className="font-medium">{summary.selfPickup}</span>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Hvem fyller ut?</Label>
            <div className="space-y-2">
              {AUDIENCE_OPTIONS.map((opt) => (
                <OptionCard
                  key={opt.value}
                  selected={audience === opt.value}
                  onClick={() => setAudience(opt.value)}
                  label={opt.label}
                  description={opt.description}
                  Icon={opt.Icon}
                />
              ))}
            </div>
          </div>

          {showBookingFilter && (
            <div className="space-y-2">
              <Label>Gjelder for hvilke bookinger?</Label>
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    { value: 'all', label: 'Alle' },
                    { value: 'delivery', label: 'Kun levering' },
                    { value: 'selfPickup', label: 'Kun selvhenting' },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => onChange({ appliesTo: opt.value })}
                    className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                      (form.appliesTo ?? 'all') === opt.value
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border hover:bg-muted/50'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {showRenterTiming && (
            <div className="space-y-2">
              <Label>
                {audience === 'split' ? 'Når fyller kunden ut? (selvhenting)' : 'Når skal kunden fylle ut?'}
              </Label>
              <div className="space-y-1.5">
                {WHEN_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => onChange({ intervalMode: opt.value })}
                    className={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors ${
                      (form.intervalMode ?? 'once') === opt.value
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:bg-muted/40'
                    }`}
                  >
                    <div className="text-sm font-medium">{opt.label}</div>
                    <div className="text-xs text-muted-foreground">{opt.hint}</div>
                  </button>
                ))}
              </div>
              {(form.intervalMode ?? 'once') === 'hours' && (
                <FieldRow label="Timer mellom hver innsending" className="pt-2">
                  <Stepper
                    value={form.intervalHours ?? 24}
                    onChange={(n) => onChange({ intervalHours: n })}
                    min={1}
                    max={168}
                    step={1}
                  />
                </FieldRow>
              )}
            </div>
          )}

          {showCompletion && (
            <FieldRow
              label="Fullfører booking automatisk"
              hint="Bruk på retur-fase. Setter booking til fullført når alle punkter er utfylt."
              className="rounded-xl border px-3 py-3"
              full
            >
              <Toggle
                value={form.isCompletionTrigger ?? false}
                onChange={(v) => onChange({ isCompletionTrigger: v })}
                labelOn="Aktivert"
                labelOff="Deaktivert"
              />
            </FieldRow>
          )}

          <div>
            <button
              type="button"
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setShowAdvanced((v) => !v)}
            >
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
              Avansert
            </button>
            {showAdvanced && (
              <div className="mt-3 space-y-2">
                <FieldRow
                  label="Rekkefølge i sjekklisten"
                  hint="Lavere tall = tidligere. F.eks. 0 klargjøring, 3 retur."
                >
                  <Stepper
                    value={form.sortOrder ?? 0}
                    onChange={(n) => onChange({ sortOrder: n })}
                    min={0}
                    max={20}
                  />
                </FieldRow>
              </div>
            )}
          </div>
        </div>

        <div className="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-border bg-muted/20">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Avbryt
          </Button>
          <Button type="button" onClick={onSave} disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
            {editing ? 'Lagre' : 'Opprett fase'}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
