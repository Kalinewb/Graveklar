'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useFieldIds } from '../layout/field-context';

// Chip-style multi-value text input. Type, press Enter or comma to commit
// a new tag. Backspace on empty input removes the last tag.

export function TagInput({
  value, onChange, placeholder = '+ legg til…', disabled,
}: {
  value: string[];
  onChange?: (next: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const interactive = !!onChange && !disabled;
  const ids = useFieldIds();
  const [draft, setDraft] = useState('');

  const commit = () => {
    const t = draft.trim();
    if (!t || !interactive) return;
    if (value.includes(t)) { setDraft(''); return; }
    onChange!([...value, t]);
    setDraft('');
  };

  const remove = (i: number) => {
    if (!interactive) return;
    onChange!(value.filter((_, idx) => idx !== i));
  };

  return (
    <div className="rounded-md border border-border bg-background px-2 py-1.5 max-w-[420px] flex flex-wrap items-center gap-1.5">
      {value.map((t, i) => (
        <span
          key={`${t}-${i}`}
          className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-md bg-muted text-xs"
        >
          {t}
          <button
            type="button"
            onClick={() => remove(i)}
            disabled={!interactive}
            className={cn(
              'w-3.5 h-3.5 rounded-sm hover:bg-rose-500/20 flex items-center justify-center',
              interactive ? 'cursor-pointer' : 'cursor-default'
            )}
            aria-label={`Fjern ${t}`}
          >
            <X className="w-2.5 h-2.5" />
          </button>
        </span>
      ))}
      <input
        id={ids?.controlId}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (!interactive) return;
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
            remove(value.length - 1);
          }
        }}
        onBlur={commit}
        placeholder={value.length === 0 ? placeholder : ''}
        disabled={!interactive}
        className="text-xs px-1 py-0.5 flex-1 min-w-[80px] bg-transparent outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}
