'use client';

import { CheckCircle2, HelpCircle, Hash, FileText, Camera, Wrench } from 'lucide-react';
import { useFieldIds } from '@/components/admin-ui/layout/field-context';

// Button-group picker for a checklist item's answer type ("Svartype").
// Intentionally bespoke (not a generic admin-ui control, same as the
// audience/appliesTo card pickers in ChecklistPhaseFormSheet) — but wired
// to the nearest FieldRow via useFieldIds() so the wrapping label is
// properly associated with this control group for screen readers.

const ANSWER_TYPE_OPTIONS: { value: string; label: string; Icon: React.ElementType }[] = [
  { value: 'checkbox',    label: 'Avkrysning', Icon: CheckCircle2 },
  { value: 'yesno',       label: 'Ja / Nei',   Icon: HelpCircle },
  { value: 'number',      label: 'Tall',       Icon: Hash },
  { value: 'text',        label: 'Tekst',      Icon: FileText },
  { value: 'photo',       label: 'Foto',       Icon: Camera },
  { value: 'measurement', label: 'Måling',     Icon: Wrench },
];

export function AnswerTypePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const ids = useFieldIds();
  return (
    <div
      id={ids?.controlId}
      role="group"
      aria-labelledby={ids?.labelId}
      className="flex flex-wrap gap-2"
    >
      {ANSWER_TYPE_OPTIONS.map(({ value: v, label, Icon }) => {
        const on = value === v;
        return (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            aria-pressed={on}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm border transition-colors ${
              on
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-background text-muted-foreground border-border hover:bg-muted'
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
            {on && <CheckCircle2 className="w-3.5 h-3.5" />}
          </button>
        );
      })}
    </div>
  );
}
