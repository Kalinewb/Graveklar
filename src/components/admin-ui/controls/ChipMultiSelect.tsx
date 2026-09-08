'use client';

import { CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useFieldIds } from '../layout/field-context';

export interface ChipOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
}

export function ChipMultiSelect({
  options, value, onChange, disabled,
}: {
  options: ChipOption[];
  value: string[];
  onChange?: (next: string[]) => void;
  disabled?: boolean;
}) {
  const interactive = !!onChange && !disabled;
  const ids = useFieldIds();
  const selected = new Set(value);

  const toggle = (v: string) => {
    if (!interactive) return;
    if (selected.has(v)) onChange!(value.filter((x) => x !== v));
    else onChange!([...value, v]);
  };

  return (
    <div id={ids?.controlId} role="group" aria-labelledby={ids?.labelId} className="flex items-center gap-1.5 flex-wrap">
      {options.map((o) => {
        const on = selected.has(o.value);
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => toggle(o.value)}
            aria-pressed={on}
            disabled={!interactive}
            className={cn(
              'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm border transition-colors',
              interactive ? 'cursor-pointer' : 'cursor-default',
              on
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-background text-muted-foreground border-border hover:bg-muted'
            )}
          >
            {o.icon}
            {o.label}
            {on && <CheckCircle2 className="w-3.5 h-3.5" />}
          </button>
        );
      })}
    </div>
  );
}
