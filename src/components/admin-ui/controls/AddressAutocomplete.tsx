'use client';

import { useEffect, useRef, useState } from 'react';
import { MapPin, CheckCircle2, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useFieldIds } from '../layout/field-context';

interface Suggestion {
  display: string;
  lat?: number;
  lng?: number;
}

// Address input with debounced autocomplete against `/api/address-suggest`
// (existing endpoint). On select, the chosen display string is committed
// via onChange and the geocoded lat/lng is passed via onGeocode if provided.

export function AddressAutocomplete({
  value, onChange, onGeocode, geocoded, disabled, placeholder = 'F.eks. Storgata 12, 8006 Bodø',
}: {
  value: string;
  onChange?: (next: string) => void;
  onGeocode?: (coords: { lat: number; lng: number } | null) => void;
  /** Show the static geocoded ✓ indicator + lat/lng readout (display mode). */
  geocoded?: { lat: number; lng: number } | null;
  disabled?: boolean;
  placeholder?: string;
}) {
  const interactive = !!onChange && !disabled;
  const ids = useFieldIds();
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasResolved, setHasResolved] = useState(!!geocoded);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced fetch.
  useEffect(() => {
    if (!interactive) return;
    if (!value || value.length < 3) {
      setSuggestions([]);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        setLoading(true);
        const res = await fetch(`/api/address-suggest?q=${encodeURIComponent(value)}`);
        if (res.ok) {
          const d = await res.json();
          setSuggestions((d.suggestions || []).slice(0, 5));
          setOpen(true);
        }
      } catch { /* silent */ }
      finally { setLoading(false); }
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [value, interactive]);

  // Close on outside click.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, []);

  const pick = (s: Suggestion) => {
    if (!interactive) return;
    onChange!(s.display);
    if (onGeocode && s.lat !== undefined && s.lng !== undefined) {
      onGeocode({ lat: s.lat, lng: s.lng });
      setHasResolved(true);
    }
    setOpen(false);
  };

  return (
    <div ref={wrapperRef} className="space-y-2 max-w-[420px]">
      <div className="relative">
        <div className="inline-flex items-stretch rounded-md border border-border bg-background overflow-hidden w-full">
          <span className="pl-2.5 flex items-center text-muted-foreground"><MapPin className="w-4 h-4" /></span>
          <input
            id={ids?.controlId}
            type="text"
            value={value}
            onChange={(e) => {
              if (!interactive) return;
              onChange!(e.target.value);
              setHasResolved(false);
            }}
            onFocus={() => suggestions.length > 0 && setOpen(true)}
            disabled={!interactive}
            placeholder={placeholder}
            className={cn(
              'px-3 py-2 text-sm flex-1 min-w-0 bg-transparent outline-none focus:bg-primary/5',
              'placeholder:text-muted-foreground'
            )}
          />
          {loading && (
            <span className="px-2.5 flex items-center text-muted-foreground">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            </span>
          )}
          {hasResolved && !loading && (
            <span
              title="Geokodet"
              className="px-2.5 flex items-center text-emerald-600 border-l border-border bg-emerald-50 dark:bg-emerald-950/30"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
            </span>
          )}
        </div>
        {open && interactive && suggestions.length > 0 && (
          <div className="absolute left-0 right-0 mt-1 rounded-md border border-border bg-card shadow-lg z-20 max-h-64 overflow-y-auto">
            {suggestions.map((s, i) => (
              <button
                key={`${s.display}-${i}`}
                type="button"
                onClick={() => pick(s)}
                className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-muted"
              >
                <MapPin className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <span className="flex-1 truncate">{s.display}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {geocoded && (
        <div className="text-[11px] text-muted-foreground font-mono pl-1">
          {geocoded.lat.toFixed(4)}, {geocoded.lng.toFixed(4)} · lagret i SystemState
        </div>
      )}
    </div>
  );
}
