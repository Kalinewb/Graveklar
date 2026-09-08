'use client';

import { cn } from '@/lib/utils';
import { useFieldIds } from '../layout/field-context';

export function TextInput({
  value, onChange, prefix, icon, placeholder, disabled, type = 'text', maxLength,
}: {
  value: string;
  onChange?: (next: string) => void;
  prefix?: string;
  icon?: React.ReactNode;
  placeholder?: string;
  disabled?: boolean;
  type?: 'text' | 'email' | 'url' | 'tel';
  maxLength?: number;
}) {
  const interactive = !!onChange && !disabled;
  const ids = useFieldIds();
  return (
    <div className="inline-flex items-stretch rounded-md border border-border bg-background overflow-hidden w-full max-w-[420px]">
      {icon && <span className="pl-2.5 flex items-center text-muted-foreground">{icon}</span>}
      {prefix && (
        <span className="px-2.5 flex items-center text-xs text-muted-foreground bg-muted/40 border-r border-border">
          {prefix}
        </span>
      )}
      <input
        id={ids?.controlId}
        type={type}
        value={value}
        onChange={(e) => interactive && onChange!(e.target.value)}
        placeholder={placeholder}
        disabled={!interactive}
        maxLength={maxLength}
        className={cn(
          'px-3 py-1.5 text-sm flex-1 min-w-0 bg-transparent outline-none focus:bg-primary/5 placeholder:text-muted-foreground'
        )}
      />
    </div>
  );
}
