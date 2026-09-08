'use client';

import { useRef } from 'react';
import { cn } from '@/lib/utils';
import { useFieldIds } from '../layout/field-context';

// Text input that highlights `{token}` patterns inline and offers click-
// to-insert chips for the whitelisted token set. Underlying state is just
// a string — the chips are syntactic sugar over `value + "{token}"`.

const TOKEN_RE = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

export function TokenizedTextInput({
  value, onChange, tokens, disabled, placeholder, multiline = false, rows = 3,
}: {
  value: string;
  onChange?: (next: string) => void;
  tokens: string[];
  disabled?: boolean;
  placeholder?: string;
  multiline?: boolean;
  rows?: number;
}) {
  const interactive = !!onChange && !disabled;
  const ids = useFieldIds();
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  const insertToken = (token: string) => {
    if (!interactive) return;
    const el = inputRef.current;
    const insertion = `{${token}}`;
    if (!el) {
      onChange!(value + insertion);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = value.slice(0, start) + insertion + value.slice(end);
    onChange!(next);
    // Restore caret after the inserted token.
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + insertion.length;
      el.setSelectionRange(pos, pos);
    });
  };

  return (
    <div className="space-y-2">
      {multiline ? (
        <textarea
          id={ids?.controlId}
          ref={(r) => { inputRef.current = r; }}
          value={value}
          onChange={(e) => interactive && onChange!(e.target.value)}
          rows={rows}
          disabled={!interactive}
          placeholder={placeholder}
          className={cn(
            'w-full max-w-[420px] rounded-md border border-border bg-background px-3 py-2 text-sm',
            'outline-none focus:bg-primary/5 resize-y placeholder:text-muted-foreground'
          )}
        />
      ) : (
        <input
          id={ids?.controlId}
          ref={(r) => { inputRef.current = r; }}
          type="text"
          value={value}
          onChange={(e) => interactive && onChange!(e.target.value)}
          disabled={!interactive}
          placeholder={placeholder}
          className={cn(
            'w-full max-w-[420px] rounded-md border border-border bg-background px-3 py-1.5 text-sm',
            'outline-none focus:bg-primary/5 placeholder:text-muted-foreground'
          )}
        />
      )}
      {/* Tokenized preview line so the admin always sees what {…} resolves to visually. */}
      {TOKEN_RE.test(value) && (
        <div className="rounded-md bg-muted/30 px-2.5 py-1.5 text-xs max-w-[420px]">
          <span className="text-muted-foreground mr-1.5">Vises som:</span>
          <TokenizedPreview value={value} />
        </div>
      )}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[10px] text-muted-foreground">Sett inn:</span>
        {tokens.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => insertToken(t)}
            disabled={!interactive}
            className={cn(
              'inline-flex items-center px-1.5 py-0.5 rounded bg-muted text-xs font-mono',
              interactive ? 'cursor-pointer hover:bg-muted/80' : 'cursor-default'
            )}
          >
            {`{${t}}`}
          </button>
        ))}
      </div>
    </div>
  );
}

function TokenizedPreview({ value }: { value: string }) {
  // Reset regex state between renders.
  const re = new RegExp(TOKEN_RE.source, 'g');
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(value))) {
    if (m.index > last) parts.push(<span key={`t-${i++}`}>{value.slice(last, m.index)}</span>);
    parts.push(
      <span key={`tok-${i++}`} className="inline-flex items-center px-1.5 py-0.5 rounded bg-primary/10 text-primary font-mono text-[10px] mx-0.5">
        {m[0]}
      </span>
    );
    last = m.index + m[0].length;
  }
  if (last < value.length) parts.push(<span key={`t-${i++}`}>{value.slice(last)}</span>);
  return <span>{parts}</span>;
}
