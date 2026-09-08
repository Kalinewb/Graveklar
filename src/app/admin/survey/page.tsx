'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { ArrowLeft, RefreshCw, ClipboardList, Mail, ChevronDown, Trash2, ListChecks, MessageSquare } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { SurveyQuestionBuilder } from '@/components/admin/SurveyQuestionBuilder';

interface SurveyRow {
  id: string;
  data: string;
  email: string | null;
  createdAt: string;
}

type SurveyData = Record<string, unknown>;

// Question metadata for labelling responses — fetched from the same builder
// table the customer wizard uses (single source of truth).
type QMeta = { key: string; label: string; type: string; unit?: string };

function fmt(n: number) { return n.toLocaleString('nb-NO'); }

function renderVal(meta: QMeta | undefined, val: unknown): string {
  if (val === undefined || val === null || val === '') return '—';
  if (typeof val === 'boolean') return val ? 'Ja' : 'Nei';
  if (Array.isArray(val)) return val.join(', ');
  if (meta?.type === 'range' && typeof val === 'number') {
    return `${fmt(val)}${meta.unit ? ` ${meta.unit}` : ''}`;
  }
  return String(val);
}

export default function SurveyPage() {
  const [tab, setTab] = useState<'svar' | 'sporsmal'>('svar');
  const [rows, setRows] = useState<SurveyRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [metas, setMetas] = useState<QMeta[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    const [resR, resQ] = await Promise.all([
      fetch('/api/admin/survey'),
      fetch('/api/admin/survey/questions'),
    ]);
    if (resR.ok) {
      const d = await resR.json();
      setRows(d.rows);
      setTotal(d.total);
    }
    if (resQ.ok) {
      const d = await resQ.json();
      setMetas(
        (d.questions as { key: string; label: string; type: string; config?: Record<string, unknown> }[]).map((q) => ({
          key: q.key,
          label: q.label,
          type: q.type,
          unit: typeof q.config?.unit === 'string' ? q.config.unit : undefined,
        }))
      );
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const deleteRow = async (id: string) => {
    await fetch(`/api/admin/survey/${id}`, { method: 'DELETE' });
    setRows(prev => prev.filter(r => r.id !== id));
    setTotal(prev => prev - 1);
  };

  const toggle = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const emails = rows.filter(r => r.email).map(r => r.email!);

  return (
    <div className="min-h-screen bg-background">
      <nav className="sticky top-0 z-50 bg-background/80 backdrop-blur-md border-b border-border">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/admin" className="flex items-center gap-2 text-muted-foreground hover:text-foreground">
              <ArrowLeft className="w-4 h-4" /><span className="text-sm">Tilbake til admin</span>
            </Link>
            <div className="h-6 w-px bg-border" />
            <div className="flex items-center gap-2">
              <ClipboardList className="w-5 h-5 text-primary" />
              <span className="font-bold text-lg">Behovsundersøkelse</span>
            </div>
          </div>
          {tab === 'svar' && (
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} /> Oppdater
            </Button>
          )}
        </div>
      </nav>

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-4">
        {/* Tabs */}
        <div className="inline-flex rounded-lg border border-border bg-card p-1">
          <button
            onClick={() => setTab('svar')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${tab === 'svar' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <MessageSquare className="w-4 h-4" /> Svar
          </button>
          <button
            onClick={() => setTab('sporsmal')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${tab === 'sporsmal' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <ListChecks className="w-4 h-4" /> Spørsmål
          </button>
        </div>

        {tab === 'sporsmal' ? (
          <SurveyQuestionBuilder />
        ) : (
          <>
            <div className="flex items-center gap-4 flex-wrap">
              <div className="text-sm text-muted-foreground">
                <span className="font-semibold text-foreground tabular-nums">{total}</span> svar totalt
              </div>
              {emails.length > 0 && (
                <div className="flex items-center gap-2 text-sm">
                  <Mail className="w-4 h-4 text-muted-foreground" />
                  <span className="text-muted-foreground">{emails.length} vil ha beskjed ved åpning:</span>
                  <span className="font-mono text-xs break-all">{emails.join(', ')}</span>
                </div>
              )}
            </div>

            <Card>
              <CardContent className="p-0">
                {loading && rows.length === 0 ? (
                  <div className="p-12 text-center text-muted-foreground text-sm">Laster…</div>
                ) : rows.length === 0 ? (
                  <div className="p-12 text-center text-muted-foreground text-sm">
                    Ingen svar ennå. Del lenken{' '}
                    <a href="/undersokelse" target="_blank" className="underline text-foreground">/undersokelse</a>
                    {' '}for å samle inn svar.
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {rows.map(r => (
                      <ResponseRow
                        key={r.id}
                        row={r}
                        metas={metas}
                        expanded={expanded.has(r.id)}
                        onToggle={() => toggle(r.id)}
                        onDelete={() => deleteRow(r.id)}
                      />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}

function ResponseRow({ row, metas, expanded, onToggle, onDelete }: { row: SurveyRow; metas: QMeta[]; expanded: boolean; onToggle: () => void; onDelete: () => void }) {
  const date = new Date(row.createdAt);
  let data: SurveyData = {};
  try { data = JSON.parse(row.data); } catch { /* ignore */ }

  const planlagt = data.planlagt as string | undefined;
  const planlagtColor =
    typeof planlagt === 'string' && planlagt.startsWith('Ja') ? 'bg-emerald-500/10 text-emerald-700 border-emerald-200' :
    typeof planlagt === 'string' && planlagt.startsWith('Kanskje') ? 'bg-amber-500/10 text-amber-700 border-amber-200' :
    'bg-muted text-muted-foreground border-border';

  const metaByKey = new Map(metas.map((m) => [m.key, m]));
  // Render known questions in their builder order, then any leftover answer
  // keys (e.g. consent, or answers to since-deleted questions).
  const known = metas.map((m) => m.key);
  const internal = new Set(['intro']);
  const extras = Object.keys(data).filter((k) => !metaByKey.has(k) && !internal.has(k));
  const orderedKeys = [...known.filter((k) => data[k] !== undefined), ...extras];

  return (
    <div className="px-5 py-3 hover:bg-muted/30 transition-colors">
      <div className="flex items-center gap-2">
        <button onClick={onToggle} className="flex-1 text-left">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs text-muted-foreground tabular-nums">
              {date.toLocaleString('nb-NO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
            </span>
            {row.email && (
              <span className="inline-flex items-center gap-1 text-xs font-mono text-foreground">
                <Mail className="w-3 h-3 text-muted-foreground" />{row.email}
              </span>
            )}
            {planlagt && (
              <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${planlagtColor}`}>
                {planlagt}
              </span>
            )}
            {data.postnr != null && <span className="text-xs text-muted-foreground">{String(data.postnr)}</span>}
            <ChevronDown className={`w-4 h-4 text-muted-foreground ml-auto transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </div>
        </button>
        <button
          onClick={onDelete}
          className="shrink-0 flex items-center justify-center w-8 h-8 rounded text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      {expanded && (
        <div className="mt-3 rounded-lg border border-border bg-muted/30 p-4 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2">
          {orderedKeys.map(key => {
            const meta = metaByKey.get(key);
            return (
              <div key={key} className="flex gap-2 text-xs">
                <span className="text-muted-foreground w-44 shrink-0">{meta?.label ?? key}</span>
                <span className="font-medium break-words">{renderVal(meta, data[key])}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
