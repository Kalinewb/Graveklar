'use client';

import { useState } from 'react';
import { Eye, EyeOff, Copy, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { copyToClipboard } from '@/lib/clipboard';
import { useFieldIds } from '../layout/field-context';

export function PasswordField({
  value, onChange, placeholder, disabled,
}: {
  value: string;
  onChange?: (next: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const interactive = !!onChange && !disabled;
  const ids = useFieldIds();
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!(await copyToClipboard(value))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="inline-flex items-stretch rounded-md border border-border bg-background overflow-hidden w-full max-w-[420px]">
      <input
        id={ids?.controlId}
        type={revealed ? 'text' : 'password'}
        value={value}
        onChange={(e) => interactive && onChange!(e.target.value)}
        placeholder={placeholder}
        disabled={!interactive}
        className={cn(
          'px-3 py-1.5 text-sm font-mono flex-1 min-w-0 bg-transparent outline-none focus:bg-primary/5',
          'placeholder:text-muted-foreground'
        )}
      />
      <button
        type="button"
        onClick={() => setRevealed((v) => !v)}
        title={revealed ? 'Skjul' : 'Vis'}
        className="px-2.5 flex items-center text-muted-foreground hover:bg-muted hover:text-foreground border-l border-border"
      >
        {revealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
      </button>
      <button
        type="button"
        onClick={copy}
        disabled={!value}
        title="Kopier"
        className="px-2.5 flex items-center text-muted-foreground hover:bg-muted hover:text-foreground border-l border-border disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}
