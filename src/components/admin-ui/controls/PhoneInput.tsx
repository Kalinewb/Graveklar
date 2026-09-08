'use client';

import { cn } from '@/lib/utils';
import { useFieldIds } from '../layout/field-context';

// Lightweight Norwegian phone input. Displays "+47" as a fixed prefix and
// formats input as XXX XX XXX as the user types. Stores the value with
// spaces preserved (matches existing display patterns); callers can
// normalize on save via `normalizePhone()`.

function format(s: string): string {
  const digits = s.replace(/\D+/g, '').slice(0, 8);
  if (digits.length <= 3) return digits;
  if (digits.length <= 5) return `${digits.slice(0, 3)} ${digits.slice(3)}`;
  return `${digits.slice(0, 3)} ${digits.slice(3, 5)} ${digits.slice(5)}`;
}

export function PhoneInput({
  value, onChange, disabled,
}: {
  value: string;
  onChange?: (next: string) => void;
  disabled?: boolean;
}) {
  const interactive = !!onChange && !disabled;
  const ids = useFieldIds();
  return (
    <div className="inline-flex items-stretch rounded-md border border-border bg-background overflow-hidden">
      <span className="px-2.5 flex items-center text-xs text-muted-foreground bg-muted/40 border-r border-border">+47</span>
      <input
        id={ids?.controlId}
        type="tel"
        value={value}
        onChange={(e) => interactive && onChange!(format(e.target.value))}
        disabled={!interactive}
        placeholder="970 00 000"
        className={cn(
          'px-3 py-1.5 text-sm tabular-nums w-[150px] bg-transparent outline-none focus:bg-primary/5',
          'placeholder:text-muted-foreground'
        )}
      />
    </div>
  );
}
