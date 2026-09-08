'use client';

import { cn } from '@/lib/utils';
import { useFieldIds } from '../layout/field-context';

export function Toggle({
  value, onChange, labelOn = 'På', labelOff = 'Av', disabled,
}: {
  value: boolean;
  onChange?: (next: boolean) => void;
  labelOn?: string;
  labelOff?: string;
  disabled?: boolean;
}) {
  const interactive = !!onChange && !disabled;
  const ids = useFieldIds();
  return (
    <button
      id={ids?.controlId}
      type="button"
      role="switch"
      aria-checked={value}
      disabled={!interactive}
      onClick={() => interactive && onChange!(!value)}
      className={cn(
        'inline-flex items-center gap-2.5',
        interactive ? 'cursor-pointer' : 'cursor-default'
      )}
    >
      <span
        className={cn(
          'relative inline-flex h-6 w-11 rounded-full transition-colors',
          value ? 'bg-primary' : 'bg-muted border border-border'
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all',
            value ? 'left-[22px]' : 'left-0.5'
          )}
        />
      </span>
      {(labelOn || labelOff) && (
        <span className={cn('text-sm', value ? 'font-medium text-foreground' : 'text-muted-foreground')}>
          {value ? labelOn : labelOff}
        </span>
      )}
    </button>
  );
}
