'use client';

import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Tractor, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useFieldIds } from '../layout/field-context';

export interface MachineOption {
  id: string;
  name: string;
  model?: string | null;
  imageUrl?: string | null;
}

export function MachineDropdown({
  value, onChange, machines, placeholder = 'Velg utstyr…', disabled, allowNone = false,
}: {
  value: string | null;
  onChange?: (next: string | null) => void;
  machines: MachineOption[];
  placeholder?: string;
  disabled?: boolean;
  /** If true, includes an "Ingen" option that sets value to null. */
  allowNone?: boolean;
}) {
  const interactive = !!onChange && !disabled;
  const ids = useFieldIds();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = machines.find((m) => m.id === value);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onClickOut = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClickOut);
    return () => window.removeEventListener('mousedown', onClickOut);
  }, [open]);

  return (
    <div ref={ref} className="relative w-full max-w-[420px]">
      <button
        id={ids?.controlId}
        type="button"
        onClick={() => interactive && setOpen((o) => !o)}
        disabled={!interactive}
        className={cn(
          'w-full inline-flex items-stretch rounded-md border border-border bg-background overflow-hidden',
          interactive && 'hover:bg-muted/40'
        )}
      >
        <span className="w-10 h-10 bg-gradient-to-br from-muted to-muted/50 flex items-center justify-center border-r border-border shrink-0">
          {selected?.imageUrl ? (
             
            <img src={selected.imageUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            <Tractor className="w-4 h-4 text-muted-foreground" />
          )}
        </span>
        <span className="px-3 py-2 flex-1 text-sm text-left flex items-center">
          {selected ? (
            <>{selected.name}{selected.model ? <> <span className="text-muted-foreground ml-1">{selected.model}</span></> : null}</>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
        </span>
        <span className="px-2.5 flex items-center text-muted-foreground border-l border-border">
          <ChevronDown className={cn('w-4 h-4 transition-transform', open && 'rotate-180')} />
        </span>
      </button>

      {open && interactive && (
        <div className="absolute left-0 right-0 mt-1 rounded-md border border-border bg-card shadow-lg z-20 max-h-72 overflow-y-auto">
          {allowNone && (
            <button
              type="button"
              onClick={() => { onChange!(null); setOpen(false); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted border-b border-border"
            >
              <span className="w-6 h-6 rounded bg-muted flex items-center justify-center text-muted-foreground text-xs">∅</span>
              <span className="flex-1 text-left text-muted-foreground">Ingen</span>
              {value === null && <CheckCircle2 className="w-3.5 h-3.5 text-primary" />}
            </button>
          )}
          {machines.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => { onChange!(m.id); setOpen(false); }}
              className={cn(
                'w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted',
                value === m.id && 'bg-primary/5'
              )}
            >
              <span className="w-6 h-6 rounded bg-gradient-to-br from-muted to-muted/50 flex items-center justify-center overflow-hidden shrink-0">
                {m.imageUrl ? (
                   
                  <img src={m.imageUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <Tractor className="w-3 h-3 text-muted-foreground" />
                )}
              </span>
              <span className="flex-1 text-left truncate">
                {m.name}{m.model ? <span className="text-muted-foreground ml-1">{m.model}</span> : null}
              </span>
              {value === m.id && <CheckCircle2 className="w-3.5 h-3.5 text-primary" />}
            </button>
          ))}
          {machines.length === 0 && (
            <div className="px-3 py-3 text-xs text-muted-foreground">Ingen utstyr registrert.</div>
          )}
        </div>
      )}
    </div>
  );
}
