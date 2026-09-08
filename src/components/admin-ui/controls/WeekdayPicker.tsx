'use client';

import { cn } from '@/lib/utils';
import { useFieldIds } from '../layout/field-context';

// Norwegian weekday picker. ISO-style numbering: man=1, søn=7.
// `multi=false` reduces to single-selection (used for "helg startdag", etc.).

const DAYS: { num: number; short: string; full: string }[] = [
  { num: 1, short: 'M', full: 'Mandag' },
  { num: 2, short: 'T', full: 'Tirsdag' },
  { num: 3, short: 'O', full: 'Onsdag' },
  { num: 4, short: 'T', full: 'Torsdag' },
  { num: 5, short: 'F', full: 'Fredag' },
  { num: 6, short: 'L', full: 'Lørdag' },
  { num: 7, short: 'S', full: 'Søndag' },
];

export function WeekdayPicker({
  value, onChange, multi = true, disabled,
}: {
  value: number[];
  onChange?: (next: number[]) => void;
  multi?: boolean;
  disabled?: boolean;
}) {
  const interactive = !!onChange && !disabled;
  const ids = useFieldIds();
  const selected = new Set(value);

  const toggle = (n: number) => {
    if (!interactive) return;
    if (multi) {
      if (selected.has(n)) onChange!(value.filter((x) => x !== n));
      else onChange!([...value, n].sort((a, b) => a - b));
    } else {
      onChange!([n]);
    }
  };

  return (
    <div id={ids?.controlId} role="group" aria-labelledby={ids?.labelId} className="inline-flex items-center gap-1 rounded-md p-0.5">
      {DAYS.map((d) => {
        const on = selected.has(d.num);
        return (
          <button
            key={d.num}
            type="button"
            onClick={() => toggle(d.num)}
            disabled={!interactive}
            title={d.full}
            aria-label={d.full}
            aria-pressed={on}
            className={cn(
              'w-9 h-9 rounded-md flex items-center justify-center text-sm font-medium transition-colors',
              interactive ? 'cursor-pointer' : 'cursor-default',
              on
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            )}
          >
            {d.short}
          </button>
        );
      })}
      {!multi && <span className="ml-2 text-[10px] text-muted-foreground">velg én</span>}
    </div>
  );
}
