'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, MapPin, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface Suggestion {
  display_name: string;
  short_name: string;
  lat: string;
  lon: string;
}

interface Props {
  initial: string;
  edited: string | undefined;
  setEdited: (v: string) => void;
  onSave: () => void;
  isSaving: boolean;
  saved: boolean;
}

export default function AdminBaseAddressField({
  initial,
  edited,
  setEdited,
  onSave,
  isSaving,
  saved,
}: Props) {
  const value = edited ?? initial;
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const debounceRef = useRef<number | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Close dropdown on outside click.
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const fetchSuggestions = useCallback(async (query: string) => {
    if (query.trim().length < 3) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }
    setIsFetching(true);
    try {
      const res = await fetch('/api/address-suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const data = await res.json();
      const list = Array.isArray(data.results) ? data.results : [];
      setSuggestions(list);
      setShowSuggestions(list.length > 0);
    } catch {
      setSuggestions([]);
      setShowSuggestions(false);
    } finally {
      setIsFetching(false);
    }
  }, []);

  const onChange = (next: string) => {
    setEdited(next);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => fetchSuggestions(next), 300);
  };

  const pick = (s: Suggestion) => {
    setEdited(s.short_name || s.display_name);
    setSuggestions([]);
    setShowSuggestions(false);
  };

  return (
    <div ref={wrapperRef}>
      <Label className="text-sm font-medium">Utgangsadresse for levering</Label>
      <p className="text-xs text-muted-foreground mt-1 mb-2">
        Adressen som leveringsavstand måles fra. Velg fra forslagene for å bekrefte at den finnes — koordinatene lagres automatisk når du lagrer.
      </p>
      <div className="relative">
        <Input
          placeholder="f.eks. Industriveien 5, 8016 Bodø"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
        />
        {isFetching && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-muted-foreground" />
        )}
        {showSuggestions && suggestions.length > 0 && (
          <div className="absolute z-50 mt-1 w-full bg-background border border-border rounded-lg shadow-lg max-h-64 overflow-y-auto">
            {suggestions.map((s, i) => (
              <button
                key={`${s.lat}-${s.lon}-${i}`}
                type="button"
                onClick={() => pick(s)}
                className="w-full text-left px-3 py-2 hover:bg-muted flex items-start gap-2 border-b border-border last:border-b-0"
              >
                <MapPin className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{s.short_name || s.display_name}</div>
                  {s.short_name && (
                    <div className="text-xs text-muted-foreground truncate">{s.display_name}</div>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-3 pt-3 mt-3 border-t border-border">
        <Button size="sm" onClick={onSave} disabled={isSaving} className="gap-2">
          {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          Lagre adresse
        </Button>
        {saved && <span className="text-xs text-green-700">✓ Lagret og geokodet</span>}
      </div>
    </div>
  );
}
