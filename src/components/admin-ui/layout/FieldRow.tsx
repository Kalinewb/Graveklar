'use client';

import { useId } from 'react';
import { Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FieldContext } from './field-context';

// Standard wrapper for one labeled control in a settings panel. Renders the
// label + optional hint + lock icon (for 2FA-gated fields). Children is
// whatever control you pass — Toggle, Stepper, Slider, etc. The label is
// associated with the control through FieldContext (see field-context.ts).

export function FieldRow({
  label, hint, locked, children, full, className,
}: {
  label: string;
  hint?: string;
  locked?: boolean;
  children: React.ReactNode;
  /** If true, the control fills the available width instead of capping at ~420px. */
  full?: boolean;
  className?: string;
}) {
  const base = useId();
  const controlId = `${base}-control`;
  const labelId = `${base}-label`;
  return (
    <div className={className}>
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-2">
          <label id={labelId} htmlFor={controlId} className="text-sm font-medium text-foreground">{label}</label>
          {locked && <Lock className="w-3 h-3 text-amber-600" role="img" aria-label="Krever 2FA" />}
        </div>
        {hint && <span className="text-[11px] text-muted-foreground/80">{hint}</span>}
      </div>
      <FieldContext.Provider value={{ controlId, labelId }}>
        <div className={cn(full ? '' : 'max-w-[420px]')}>{children}</div>
      </FieldContext.Provider>
    </div>
  );
}
