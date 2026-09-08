'use client';

import { CheckCircle2, Hash, FileText, Camera, Wrench, HelpCircle } from 'lucide-react';
import { Pill, type PillTone } from '@/components/admin-ui';

// Visual pill for a checklist item's answer type. Mirrors the preview's
// ANSWER_TYPE_META mapping. Renders inline next to each item so the
// admin can scan a phase and immediately see what each row collects.

type AnswerType = 'checkbox' | 'yesno' | 'number' | 'text' | 'photo' | 'measurement';

const META: Record<AnswerType, { Icon: React.ElementType; label: string; tone: PillTone }> = {
  checkbox:    { Icon: CheckCircle2, label: 'Avkrysning', tone: 'slate'   },
  yesno:       { Icon: HelpCircle,   label: 'Ja/Nei',     tone: 'blue'    },
  number:      { Icon: Hash,         label: 'Tall',       tone: 'blue'    },
  text:        { Icon: FileText,     label: 'Tekst',      tone: 'violet'  },
  photo:       { Icon: Camera,       label: 'Bilde',      tone: 'emerald' },
  measurement: { Icon: Wrench,       label: 'Måling',     tone: 'amber'   },
};

export function AnswerTypePill({
  type, unit,
}: {
  type: string | null | undefined;
  unit?: string | null;
}) {
  const t = (type ?? 'checkbox') as AnswerType;
  const meta = META[t] ?? META.checkbox;
  return (
    <Pill tone={meta.tone}>
      <meta.Icon className="w-3 h-3" />
      {meta.label}
      {unit ? ` · ${unit}` : ''}
    </Pill>
  );
}
