'use client';

import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useFieldIds } from '../layout/field-context';

const DEFAULT_SWATCHES = ['#1a5fb4', '#d97706', '#059669', '#dc2626', '#7c3aed', '#0891b2', '#0f172a'];

const HEX_RE = /^#?[0-9a-fA-F]{6}$/;

function normalizeHex(s: string): string | null {
  const clean = s.trim();
  if (!HEX_RE.test(clean)) return null;
  return clean.startsWith('#') ? clean.toLowerCase() : `#${clean.toLowerCase()}`;
}

export function ColorPicker({
  value, onChange, swatches = DEFAULT_SWATCHES, disabled,
}: {
  value: string;
  onChange?: (next: string) => void;
  swatches?: string[];
  disabled?: boolean;
}) {
  const interactive = !!onChange && !disabled;
  const ids = useFieldIds();
  const safeValue = value || '#000000';
  const hex = normalizeHex(safeValue) || '#000000';

  return (
    <div className="flex flex-col gap-2">
      <div className="inline-flex items-center gap-2">
        <label className={cn(
          'relative w-10 h-10 rounded-md border border-border shadow-inner overflow-hidden',
          interactive && 'cursor-pointer'
        )}>
          <span className="absolute inset-0" style={{ backgroundColor: hex }} />
          {interactive && (
            <input
              type="color"
              value={hex}
              onChange={(e) => onChange!(e.target.value)}
              className="absolute inset-0 opacity-0 cursor-pointer"
              aria-label="Velg farge"
            />
          )}
        </label>
        <div className="inline-flex rounded-md border border-border bg-background overflow-hidden">
          <span className="px-2 py-1.5 text-xs text-muted-foreground border-r border-border bg-muted/40">HEX</span>
          <input
            id={ids?.controlId}
            type="text"
            value={value || ''}
            onChange={(e) => {
              if (!interactive) return;
              const v = e.target.value;
              // Allow free typing; only commit valid hexes upstream.
              const n = normalizeHex(v);
              onChange!(n ?? v);
            }}
            disabled={!interactive}
            placeholder="#1a5fb4"
            className={cn(
              'px-3 py-1.5 text-sm font-mono w-[110px] bg-transparent outline-none focus:bg-primary/5'
            )}
          />
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        {swatches.map((s) => {
          const matches = s.toLowerCase() === hex;
          return (
            <button
              key={s}
              type="button"
              title={s}
              disabled={!interactive}
              onClick={() => interactive && onChange!(s)}
              className={cn(
                'w-6 h-6 rounded-md border',
                matches ? 'border-foreground ring-2 ring-primary' : 'border-border',
                interactive ? 'cursor-pointer hover:scale-105 transition' : 'cursor-default'
              )}
              style={{ backgroundColor: s }}
            />
          );
        })}
        <span className="w-6 h-6 rounded-md border border-border bg-gradient-to-br from-rose-500 via-yellow-500 via-emerald-500 via-blue-500 to-violet-500 flex items-center justify-center cursor-default">
          <Plus className="w-3 h-3 text-white drop-shadow" />
        </span>
      </div>
    </div>
  );
}
