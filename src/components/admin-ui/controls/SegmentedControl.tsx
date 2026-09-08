'use client';

import { cn } from '@/lib/utils';
import { useFieldIds } from '../layout/field-context';

export interface SegmentOption {
  value: string;
  label: string;
}

export function SegmentedControl({
  options, value, onChange, disabled,
}: {
  options: SegmentOption[] | string[];
  value: string;
  onChange?: (next: string) => void;
  disabled?: boolean;
}) {
  const interactive = !!onChange && !disabled;
  const ids = useFieldIds();
  const normalized: SegmentOption[] = options.map((o) =>
    typeof o === 'string' ? { value: o, label: o } : o
  );
  return (
    <div id={ids?.controlId} role="group" aria-labelledby={ids?.labelId} className="inline-flex rounded-md border border-border bg-muted/40 p-0.5">
      {normalized.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => interactive && onChange!(o.value)}
            disabled={!interactive}
            className={cn(
              'px-3 py-1 rounded text-sm transition-colors',
              interactive ? 'cursor-pointer' : 'cursor-default',
              active ? 'bg-background shadow-sm font-medium text-foreground' : 'text-muted-foreground hover:bg-background/60'
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
