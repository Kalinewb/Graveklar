'use client';

import { cn } from '@/lib/utils';
import { Stepper } from './Stepper';

// Combo: a number Stepper paired with common-port quick-select chips.
// Selecting a chip writes that port via onChange; the stepper still works
// for unusual numbers.

export function PortQuickSelect({
  value, onChange, presets = [25, 465, 587, 2525], disabled,
}: {
  value: number;
  onChange?: (next: number) => void;
  presets?: number[];
  disabled?: boolean;
}) {
  const interactive = !!onChange && !disabled;
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Stepper value={value} onChange={onChange} min={1} max={65535} unit="port" disabled={disabled} />
      <div className="inline-flex rounded-md border border-border bg-background overflow-hidden">
        {presets.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => interactive && onChange!(p)}
            disabled={!interactive}
            className={cn(
              'px-2 py-1 text-xs border-r border-border last:border-0',
              interactive ? 'cursor-pointer' : 'cursor-default',
              p === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
            )}
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}
