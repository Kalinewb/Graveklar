'use client';

import { cn } from '@/lib/utils';
import { useFieldIds } from '../layout/field-context';

export function TextArea({
  value, onChange, rows = 3, placeholder, disabled, maxLength,
}: {
  value: string;
  onChange?: (next: string) => void;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  maxLength?: number;
}) {
  const interactive = !!onChange && !disabled;
  const ids = useFieldIds();
  return (
    <textarea
      id={ids?.controlId}
      value={value}
      onChange={(e) => interactive && onChange!(e.target.value)}
      rows={rows}
      placeholder={placeholder}
      disabled={!interactive}
      maxLength={maxLength}
      className={cn(
        'w-full max-w-full rounded-md border border-border bg-background px-3 py-2 text-sm',
        'outline-none focus:bg-primary/5 resize-y',
        'placeholder:text-muted-foreground'
      )}
    />
  );
}
