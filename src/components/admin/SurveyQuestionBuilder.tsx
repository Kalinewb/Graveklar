'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, ChevronUp, ChevronDown, Pencil, Trash2, GripVertical, Save, X } from 'lucide-react';
import { Toggle, TextInput, TextArea, Stepper } from '@/components/admin-ui';

type QType = 'intro' | 'radio' | 'check' | 'likert' | 'range' | 'text' | 'email' | 'price-callout';

type Question = {
  id: string;
  key: string;
  type: QType;
  section: string;
  label: string;
  hint: string | null;
  options: string[];
  config: Record<string, unknown>;
  required: boolean;
  isActive: boolean;
  sortOrder: number;
};

type Draft = {
  id?: string;
  key: string;
  type: QType;
  section: string;
  label: string;
  hint: string;
  optionsText: string;
  required: boolean;
  config: Record<string, unknown>;
};

const TYPE_LABELS: Record<QType, string> = {
  intro: 'Intro', radio: 'Enkeltvalg', check: 'Flervalg', likert: 'Skala',
  range: 'Glidebryter', text: 'Fritekst', email: 'E-post', 'price-callout': 'Prisboks',
};
const TYPE_ORDER: QType[] = ['intro', 'radio', 'check', 'likert', 'range', 'text', 'email', 'price-callout'];
const HAS_OPTIONS = new Set<QType>(['radio', 'check', 'likert']);

function num(v: unknown, d: number) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : d;
}

function emptyDraft(): Draft {
  return { key: '', type: 'radio', section: '', label: '', hint: '', optionsText: '', required: true, config: {} };
}
function toDraft(q: Question): Draft {
  return {
    id: q.id, key: q.key, type: q.type, section: q.section, label: q.label,
    hint: q.hint ?? '', optionsText: q.options.join('\n'), required: q.required, config: { ...q.config },
  };
}

export function SurveyQuestionBuilder() {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch('/api/admin/survey/questions');
    if (res.ok) setQuestions((await res.json()).questions);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const patch = (d: Partial<Draft>) => setDraft((prev) => (prev ? { ...prev, ...d } : prev));
  const patchConfig = (c: Record<string, unknown>) =>
    setDraft((prev) => (prev ? { ...prev, config: { ...prev.config, ...c } } : prev));

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    const options = HAS_OPTIONS.has(draft.type)
      ? draft.optionsText.split('\n').map((s) => s.trim()).filter(Boolean)
      : [];
    const payload = {
      key: draft.key,
      type: draft.type,
      section: draft.section,
      label: draft.label,
      hint: draft.hint || null,
      options,
      config: draft.config,
      required: draft.required,
    };
    const res = draft.id
      ? await fetch(`/api/admin/survey/questions/${draft.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        })
      : await fetch('/api/admin/survey/questions', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
    setSaving(false);
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error || 'Kunne ikke lagre.');
      return;
    }
    setDraft(null);
    load();
  }

  async function toggleActive(q: Question) {
    await fetch(`/api/admin/survey/questions/${q.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isActive: !q.isActive }),
    });
    load();
  }

  async function remove(q: Question) {
    if (!confirm(`Slette spørsmålet «${q.label || q.key}»?`)) return;
    await fetch(`/api/admin/survey/questions/${q.id}`, { method: 'DELETE' });
    load();
  }

  async function move(idx: number, dir: -1 | 1) {
    const next = [...questions];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    setQuestions(next); // optimistic
    await fetch('/api/admin/survey/questions', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: next.map((q) => q.id) }),
    });
  }

  if (loading) return <div className="p-12 text-center text-sm text-muted-foreground">Laster spørsmål …</div>;

  // Group by section for display headers.
  const rows: React.ReactNode[] = [];
  let lastSection = '';
  questions.forEach((q, idx) => {
    if (q.section !== lastSection) {
      lastSection = q.section;
      rows.push(
        <div key={`s-${idx}`} className="px-4 pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wider text-primary">
          {q.section}
        </div>
      );
    }
    rows.push(
      <div key={q.id} className={`flex items-center gap-3 px-4 py-2.5 ${q.isActive ? '' : 'opacity-50'}`}>
        <div className="flex flex-col">
          <button onClick={() => move(idx, -1)} disabled={idx === 0} className="text-muted-foreground hover:text-foreground disabled:opacity-30"><ChevronUp className="h-4 w-4" /></button>
          <button onClick={() => move(idx, 1)} disabled={idx === questions.length - 1} className="text-muted-foreground hover:text-foreground disabled:opacity-30"><ChevronDown className="h-4 w-4" /></button>
        </div>
        <GripVertical className="h-4 w-4 text-muted-foreground/40 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{q.label || <span className="text-muted-foreground italic">(uten tekst)</span>}</div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="rounded bg-muted px-1.5 py-0.5 font-medium">{TYPE_LABELS[q.type]}</span>
            <span className="font-mono">{q.key}</span>
            {q.required && <span>· påkrevd</span>}
          </div>
        </div>
        <Toggle value={q.isActive} onChange={() => toggleActive(q)} labelOn="" labelOff="" />
        <button onClick={() => { setError(null); setDraft(toDraft(q)); }} className="text-muted-foreground hover:text-foreground"><Pencil className="h-4 w-4" /></button>
        <button onClick={() => remove(q)} className="text-rose-500 hover:text-rose-600"><Trash2 className="h-4 w-4" /></button>
      </div>
    );
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          <span className="font-semibold text-foreground tabular-nums">{questions.length}</span> spørsmål ·{' '}
          {questions.filter((q) => q.isActive).length} aktive
        </div>
        <button
          onClick={() => { setError(null); setDraft(emptyDraft()); }}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" /> Legg til spørsmål
        </button>
      </div>

      {draft && (
        <DraftEditor
          draft={draft}
          isNew={!draft.id}
          saving={saving}
          error={error}
          onPatch={patch}
          onPatchConfig={patchConfig}
          onCancel={() => setDraft(null)}
          onSave={save}
        />
      )}

      <div className="overflow-hidden rounded-xl border border-border bg-card divide-y divide-border">
        {questions.length === 0 ? (
          <div className="p-12 text-center text-sm text-muted-foreground">Ingen spørsmål ennå.</div>
        ) : rows}
      </div>
    </div>
  );
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-semibold text-foreground">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function DraftEditor({
  draft, isNew, saving, error, onPatch, onPatchConfig, onCancel, onSave,
}: {
  draft: Draft;
  isNew: boolean;
  saving: boolean;
  error: string | null;
  onPatch: (d: Partial<Draft>) => void;
  onPatchConfig: (c: Record<string, unknown>) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const cfg = draft.config;

  return (
    <div className="rounded-xl border-2 border-primary/30 bg-card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-bold">{isNew ? 'Nytt spørsmål' : `Rediger «${draft.key}»`}</div>
        <button onClick={onCancel} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type">
          <select
            value={draft.type}
            onChange={(e) => onPatch({ type: e.target.value as QType })}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          >
            {TYPE_ORDER.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
          </select>
        </Field>
        <Field label="Nøkkel (stabil ID)" hint={isNew ? 'a–z, 0–9, _ — kan ikke endres senere' : 'Kan ikke endres'}>
          {isNew ? (
            <TextInput value={draft.key} onChange={(v) => onPatch({ key: v.toLowerCase() })} placeholder="f.eks. planlagt" />
          ) : (
            <div className="rounded-md border border-border bg-muted px-3 py-2 font-mono text-sm text-muted-foreground">{draft.key}</div>
          )}
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Seksjon (steg)"><TextInput value={draft.section} onChange={(v) => onPatch({ section: v })} placeholder="f.eks. Behov" /></Field>
        <Field label="Påkrevd"><Toggle value={draft.required} onChange={(v) => onPatch({ required: v })} labelOn="Ja" labelOff="Nei" /></Field>
      </div>

      <Field label="Spørsmålstekst"><TextInput value={draft.label} onChange={(v) => onPatch({ label: v })} placeholder="Selve spørsmålet" /></Field>
      <Field label="Hjelpetekst (valgfri)"><TextArea value={draft.hint} onChange={(v) => onPatch({ hint: v })} rows={2} placeholder="Kort utdyping under spørsmålet" /></Field>

      {HAS_OPTIONS.has(draft.type) && (
        <Field label="Svaralternativer" hint="Ett alternativ per linje">
          <TextArea value={draft.optionsText} onChange={(v) => onPatch({ optionsText: v })} rows={5} placeholder={'Alternativ 1\nAlternativ 2'} />
        </Field>
      )}

      {draft.type === 'check' && (
        <Field label="Maks antall valg (0 = ubegrenset)">
          <Stepper value={num(cfg.max, 0)} onChange={(v) => onPatchConfig({ max: v || undefined })} min={0} max={20} />
        </Field>
      )}

      {draft.type === 'range' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Min"><Stepper value={num(cfg.min, 0)} onChange={(v) => onPatchConfig({ min: v })} min={0} max={1000000} step={250} /></Field>
          <Field label="Maks"><Stepper value={num(cfg.max, 10000)} onChange={(v) => onPatchConfig({ max: v })} min={0} max={1000000} step={250} /></Field>
          <Field label="Steg"><Stepper value={num(cfg.step, 250)} onChange={(v) => onPatchConfig({ step: v })} min={1} max={10000} step={50} /></Field>
          <Field label="Enhet"><TextInput value={typeof cfg.unit === 'string' ? cfg.unit : ''} onChange={(v) => onPatchConfig({ unit: v })} placeholder="kr" /></Field>
        </div>
      )}

      {draft.type === 'text' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Plassholder"><TextInput value={typeof cfg.placeholder === 'string' ? cfg.placeholder : ''} onChange={(v) => onPatchConfig({ placeholder: v })} /></Field>
          <Field label="Maks tegn (0 = ingen)"><Stepper value={num(cfg.maxLength, 0)} onChange={(v) => onPatchConfig({ maxLength: v || undefined })} min={0} max={2000} step={10} /></Field>
        </div>
      )}

      {draft.type === 'email' && (
        <>
          <Field label="Krev samtykke"><Toggle value={cfg.consentRequired === true} onChange={(v) => onPatchConfig({ consentRequired: v })} labelOn="Ja" labelOff="Nei" /></Field>
          <Field label="Samtykketekst"><TextArea value={typeof cfg.consentLabel === 'string' ? cfg.consentLabel : ''} onChange={(v) => onPatchConfig({ consentLabel: v })} rows={2} /></Field>
        </>
      )}

      {error && <div className="text-sm font-medium text-destructive">{error}</div>}

      <div className="flex gap-2">
        <button onClick={onSave} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
          <Save className="h-4 w-4" /> {saving ? 'Lagrer …' : 'Lagre'}
        </button>
        <button onClick={onCancel} className="rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-muted">Avbryt</button>
      </div>
    </div>
  );
}
