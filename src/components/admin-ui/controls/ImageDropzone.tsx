'use client';

import { useState, useRef } from 'react';
import { Camera, Plus, RefreshCw, X, Loader2, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useFieldIds } from '../layout/field-context';

// Wires to existing /api/admin/upload (POST multipart). On success, calls
// onChange(returnedUrl). Supports drag-drop + click-to-pick. Display-only
// when no onChange is supplied.

export function ImageDropzone({
  value, onChange, disabled, accept = 'image/*', uploadEndpoint = '/api/admin/upload',
}: {
  value: string | null;
  onChange?: (next: string | null) => void;
  disabled?: boolean;
  accept?: string;
  uploadEndpoint?: string;
}) {
  const interactive = !!onChange && !disabled;
  const ids = useFieldIds();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = async (file: File) => {
    if (!interactive) return;
    setError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(uploadEndpoint, { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) {
        setError(data.error || 'Opplasting feilet');
        return;
      }
      onChange!(data.url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const filename = value ? (value.split('/').pop() || value) : null;

  return (
    <div className="max-w-[420px]">
      <div
        onDragOver={(e) => { if (interactive) { e.preventDefault(); setDragging(true); } }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          if (!interactive) return;
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file) upload(file);
        }}
        className={cn(
          'rounded-lg border-2 border-dashed p-3 flex items-center gap-3 transition-colors',
          dragging ? 'border-primary bg-primary/5' : 'border-border bg-muted/20'
        )}
      >
        <div className="w-20 h-20 rounded-md bg-gradient-to-br from-muted to-muted/50 flex items-center justify-center shrink-0 overflow-hidden">
          {value ? (
             
            <img src={value} alt="Forhåndsvisning" className="w-full h-full object-cover" />
          ) : uploading ? (
            <Loader2 className="w-6 h-6 text-muted-foreground animate-spin" />
          ) : (
            <Plus className="w-6 h-6 text-muted-foreground" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          {value ? (
            <>
              <div className="text-sm font-medium truncate">{filename}</div>
              <div className="text-xs text-muted-foreground mt-0.5">Lastet opp</div>
              {interactive && (
                <div className="flex items-center gap-1 mt-2">
                  <button
                    id={ids?.controlId}
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-border hover:bg-muted disabled:opacity-50"
                  >
                    <RefreshCw className="w-3 h-3" /> Bytt
                  </button>
                  <button
                    type="button"
                    onClick={() => onChange!(null)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md text-muted-foreground hover:bg-muted"
                  >
                    <X className="w-3 h-3" /> Fjern
                  </button>
                </div>
              )}
            </>
          ) : (
            <button
              id={ids?.controlId}
              type="button"
              onClick={() => interactive && fileRef.current?.click()}
              disabled={!interactive || uploading}
              className="text-sm text-muted-foreground text-left flex items-center gap-2"
            >
              {uploading ? (
                <>Laster opp…</>
              ) : (
                <><Camera className="w-3.5 h-3.5" /> Dra bilde hit eller klikk for å laste opp</>
              )}
            </button>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload(file);
            e.target.value = '';
          }}
        />
      </div>
      {error && (
        <div className="mt-1.5 text-xs text-destructive flex items-center gap-1">
          <AlertCircle className="w-3 h-3" />{error}
        </div>
      )}
    </div>
  );
}
