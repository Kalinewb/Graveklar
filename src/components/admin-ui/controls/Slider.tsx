'use client';

import { cn } from '@/lib/utils';
import { useFieldIds } from '../layout/field-context';

export function Slider({
  value, onChange, min = 0, max = 100, step = 1, unit = '%', marks, disabled,
}: {
  value: number;
  onChange?: (next: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  marks?: number[];
  disabled?: boolean;
}) {
  const interactive = !!onChange && !disabled;
  const ids = useFieldIds();
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="w-full max-w-[420px]">
      <div className="flex items-center gap-3">
        <div className="relative flex-1 h-6 flex items-center">
          <div className="absolute inset-x-0 h-2 rounded-full bg-muted" />
          <div
            className="absolute h-2 rounded-full bg-primary"
            style={{ left: 0, width: `${pct}%` }}
          />
          <div
            className="absolute w-4 h-4 rounded-full bg-primary border-2 border-white shadow"
            style={{ left: `calc(${pct}% - 8px)` }}
          />
          {interactive && (
            <input
              id={ids?.controlId}
              type="range"
              min={min}
              max={max}
              step={step}
              value={value}
              onChange={(e) => onChange!(Number(e.target.value))}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              // Inside a FieldRow the row label names the slider; only fall back
              // to a generic name when used standalone.
              aria-label={ids ? undefined : 'Skyver'}
            />
          )}
        </div>
        <div className={cn(
          'px-2 py-1 rounded-md border border-border bg-background text-sm font-medium tabular-nums min-w-[56px] text-center'
        )}>
          {value}{unit}
        </div>
      </div>
      {marks && marks.length > 0 && (
        <div className="flex justify-between mt-1 px-1 text-[10px] text-muted-foreground tabular-nums">
          {marks.map((m) => <span key={m}>{m}{unit}</span>)}
        </div>
      )}
    </div>
  );
}
