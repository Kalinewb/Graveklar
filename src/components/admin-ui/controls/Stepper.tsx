'use client';

import { cn } from '@/lib/utils';
import { useFieldIds } from '../layout/field-context';

export function Stepper({
  value, onChange, min = 0, max, step = 1, unit, disabled,
}: {
  value: number;
  onChange?: (next: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  disabled?: boolean;
}) {
  const interactive = !!onChange && !disabled;
  const ids = useFieldIds();
  const clamp = (n: number) => {
    if (max !== undefined && n > max) return max;
    if (n < min) return min;
    return n;
  };
  const dec = () => interactive && onChange!(clamp(value - step));
  const inc = () => interactive && onChange!(clamp(value + step));
  return (
    <div className={cn(
      'inline-flex items-stretch rounded-md border border-border bg-background overflow-hidden',
      !interactive && 'opacity-90'
    )}>
      <button
        type="button"
        onClick={dec}
        disabled={!interactive || value <= min}
        className="px-2.5 text-muted-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed flex items-center text-lg leading-none select-none"
        aria-label="Reduser"
      >
        −
      </button>
      <input
        id={ids?.controlId}
        type="number"
        value={value}
        onChange={(e) => {
          if (!interactive) return;
          const n = Number(e.target.value);
          if (!Number.isNaN(n)) onChange!(clamp(n));
        }}
        min={min}
        max={max}
        step={step}
        disabled={!interactive}
        className={cn(
          'w-[80px] text-center text-sm font-medium border-x border-border tabular-nums',
          'bg-transparent outline-none focus:bg-primary/5',
          // strip native spinners
          '[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none'
        )}
      />
      <button
        type="button"
        onClick={inc}
        disabled={!interactive || (max !== undefined && value >= max)}
        className="px-2.5 text-muted-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed flex items-center text-lg leading-none select-none"
        aria-label="Øk"
      >
        +
      </button>
      {unit && (
        <span className="px-2.5 flex items-center text-xs text-muted-foreground bg-muted/40 border-l border-border">
          {unit}
        </span>
      )}
    </div>
  );
}
