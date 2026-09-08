'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Filter, RefreshCw, ShieldCheck, AlertCircle, CheckCircle2,
  Hash, User, Globe, ChevronDown, Search, Activity,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

interface AuditChange {
  key?: string;
  from?: unknown;
  to?: unknown;
  [k: string]: unknown;
}
interface AuditRow {
  id: string;
  actor: string;
  action: string;
  changes: AuditChange[] | string | unknown;
  ip: string | null;
  createdAt: string;
}

export default function AuditLogPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [actionFilter, setActionFilter] = useState('');
  const [actorFilter, setActorFilter] = useState('');
  const [sinceFilter, setSinceFilter] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (actionFilter) qs.set('action', actionFilter);
    if (actorFilter) qs.set('actor', actorFilter);
    if (sinceFilter) qs.set('since', sinceFilter);
    qs.set('limit', '100');
    const res = await fetch(`/api/admin/audit-log?${qs.toString()}`);
    if (res.ok) {
      const d = await res.json();
      setRows(d.rows);
      setActions(d.actions);
      setTotal(d.total);
    }
    setLoading(false);
  }, [actionFilter, actorFilter, sinceFilter]);

  useEffect(() => { load(); }, [load]);

  const toggle = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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
              <Activity className="w-5 h-5 text-primary" />
              <span className="font-bold text-lg">Revisjonslogg</span>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} /> Oppdater
          </Button>
        </div>
      </nav>

      <main className="max-w-6xl mx-auto px-4 py-6">
        <Card className="mb-4">
          <CardContent className="p-4 flex items-end gap-3 flex-wrap">
            <div className="min-w-[180px]">
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Type handling</label>
              <div className="relative">
                <select
                  value={actionFilter}
                  onChange={(e) => setActionFilter(e.target.value)}
                  className="appearance-none w-full px-3 py-1.5 pr-8 rounded-md border border-border bg-background text-sm"
                >
                  <option value="">Alle</option>
                  {actions.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
                <ChevronDown className="w-3.5 h-3.5 absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              </div>
            </div>
            <div className="min-w-[180px]">
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Aktør</label>
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={actorFilter}
                  onChange={(e) => setActorFilter(e.target.value)}
                  placeholder="admin, system…"
                  className="pl-8 text-sm h-9"
                />
              </div>
            </div>
            <div className="min-w-[180px]">
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Siden</label>
              <Input
                type="datetime-local"
                lang="nb-NO"
                value={sinceFilter}
                onChange={(e) => setSinceFilter(e.target.value)}
                className="text-sm h-9"
              />
            </div>
            <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
              <Filter className="w-3.5 h-3.5" />
              <span className="tabular-nums">{rows.length} av {total} treff</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-0">
            {loading && rows.length === 0 ? (
              <div className="p-12 text-center text-muted-foreground text-sm">Laster…</div>
            ) : rows.length === 0 ? (
              <div className="p-12 text-center text-muted-foreground text-sm">Ingen oppføringer i loggen matcher.</div>
            ) : (
              <div className="divide-y divide-border">
                {rows.map(r => (
                  <AuditRowDisplay
                    key={r.id}
                    row={r}
                    expanded={expanded.has(r.id)}
                    onToggle={() => toggle(r.id)}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="mt-4 text-xs text-muted-foreground text-center">
          Loggen er append-only. Hver endring i en sensitiv innstilling, prisjustering eller adminhandling skrives her uten mulighet for redigering eller sletting.
        </div>
      </main>
    </div>
  );
}

function AuditRowDisplay({ row, expanded, onToggle }: { row: AuditRow; expanded: boolean; onToggle: () => void }) {
  const date = new Date(row.createdAt);
  const allChanges = Array.isArray(row.changes) ? row.changes : [];
  // Some rows carry identity fields (bookingId, reference) with from === to
  // purely so the per-booking timeline can filter the log. They are not
  // changes, and rendering them as "reference: GK-… → GK-…" buried the one
  // field that actually moved behind a "3 endringer" badge.
  const changes = allChanges.filter((c) => String(c?.from ?? '') !== String(c?.to ?? ''));
  const context = allChanges.filter((c) => String(c?.from ?? '') === String(c?.to ?? ''));
  const meta = actionMeta(row.action);
  return (
    <div className="px-5 py-3 hover:bg-muted/30 transition-colors">
      <button onClick={onToggle} className="w-full text-left flex items-start gap-3">
        <span className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${meta.bg} ${meta.fg}`}>
          <meta.Icon className="w-4 h-4" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-muted">{row.action}</span>
            {changes.length > 0 && (
              <Badge variant="secondary" className="text-[10px]">
                {changes.length} {changes.length === 1 ? 'endring' : 'endringer'}
              </Badge>
            )}
            <span className="text-[11px] text-muted-foreground ml-auto tabular-nums">
              {date.toLocaleString('nb-NO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
          <div className="text-xs text-muted-foreground mt-1 flex items-center gap-3 flex-wrap">
            <span className="inline-flex items-center gap-1"><User className="w-3 h-3" />{row.actor}</span>
            {row.ip && <span className="inline-flex items-center gap-1"><Globe className="w-3 h-3" />{row.ip}</span>}
            {changes.length > 0 && !expanded && (
              <span className="truncate text-foreground/70">
                {changes.slice(0, 2).map((c, i) => (
                  <span key={i} className="mr-2 font-mono">
                    {c.key ?? '?'}: <span className="text-muted-foreground">{shortVal(c.from)}</span> → <span className="text-foreground">{shortVal(c.to)}</span>
                  </span>
                ))}
                {changes.length > 2 && <span>… +{changes.length - 2}</span>}
              </span>
            )}
          </div>
          {expanded && (
            <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3 space-y-1.5">
              {context.length > 0 && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 pb-2 mb-1 border-b border-border/60">
                  {context.map((c, i) => (
                    <span key={`ctx-${i}`} className="font-mono text-[11px] text-muted-foreground">
                      {c.key ?? '?'}: <span className="text-foreground/80">{shortVal(c.to, 80)}</span>
                    </span>
                  ))}
                </div>
              )}
              {changes.length === 0 ? (
                <div className="text-xs text-muted-foreground italic">Ingen endringsdetaljer registrert.</div>
              ) : (
                changes.map((c, i) => (
                  <div key={i} className="grid grid-cols-[auto,1fr] gap-x-3 text-xs">
                    <span className="font-mono text-muted-foreground">{c.key ?? '?'}</span>
                    <span className="font-mono break-all">
                      <span className="text-rose-600 line-through">{shortVal(c.from, 80)}</span>
                      <span className="mx-1.5 text-muted-foreground">→</span>
                      <span className="text-emerald-700 dark:text-emerald-400">{shortVal(c.to, 80)}</span>
                    </span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </button>
    </div>
  );
}

function shortVal(v: unknown, max = 40): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function actionMeta(action: string) {
  const a = action.toLowerCase();
  if (a.includes('pricing'))   return { Icon: Hash,         bg: 'bg-amber-500/10',   fg: 'text-amber-600'   };
  if (a.includes('config'))    return { Icon: Hash,         bg: 'bg-blue-500/10',    fg: 'text-blue-600'    };
  if (a.includes('totp'))      return { Icon: ShieldCheck,  bg: 'bg-emerald-500/10', fg: 'text-emerald-600' };
  if (a.includes('login'))     return { Icon: ShieldCheck,  bg: 'bg-slate-500/10',   fg: 'text-slate-600'   };
  if (a.includes('delete'))    return { Icon: AlertCircle,  bg: 'bg-rose-500/10',    fg: 'text-rose-600'    };
  if (a.includes('terms'))     return { Icon: CheckCircle2, bg: 'bg-violet-500/10',  fg: 'text-violet-600'  };
  return { Icon: Activity, bg: 'bg-muted', fg: 'text-muted-foreground' };
}
