'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Star, Plus, RefreshCw, Trash2, Copy, Check, Mail, User as UserIcon,
  Calendar, CheckCircle2, XCircle, Hash, AlertCircle,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { Label } from '@/components/ui/label';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import { Toggle, Stepper, Slider, FieldRow } from '@/components/admin-ui';
import TotpPromptModal from '@/components/admin/TotpPromptModal';

interface RepeatRow {
  id: string;
  code: string;
  email: string;
  issuedFor: { id: string; reference: string; name: string } | null;
  redeemedBy: { id: string; reference: string; name: string } | null;
  expiresAt: string | null;
  createdAt: string;
  redeemedAt: string | null;
}
interface CampaignRow {
  id: string;
  code: string;
  percent: number;
  maxUses: number | null;
  usedCount: number;
  expiresAt: string | null;
  isActive: boolean;
  notes: string | null;
  createdAt: string;
  redemptions: {
    id: string;
    email: string;
    bookingRef: string | null;
    customerName: string | null;
    redeemedAt: string;
  }[];
}

interface DiscountSettings {
  enableFirstTimeDiscount: string;
  firstTimeDiscountPercent: string;
  enableRepeatDiscount: string;
  repeatDiscountPercent: string;
  discountHardCap: string;
}

export default function DiscountCodesPage() {
  const [tab, setTab] = useState<'settings' | 'unique' | 'campaigns'>('settings');
  const [settings, setSettings] = useState<DiscountSettings | null>(null);
  const [editedSettings, setEditedSettings] = useState<Partial<DiscountSettings>>({});
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  // These keys sit in a sensitive group, so the save is 2FA-gated. The prompt
  // is handled here rather than pointed at somewhere else: the old toast sent
  // the admin to "the admin panel", where these five keys are not rendered at
  // all (the `discounts` group is omitted from APP_CONFIG_GROUP_ORDER) and
  // where the same refusal would demand enrollment anyway (P-15).
  const [totpPromptOpen, setTotpPromptOpen] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [repeat, setRepeat] = useState<RepeatRow[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewForm, setShowNewForm] = useState(false);
  const [expandedCampaign, setExpandedCampaign] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // New campaign form
  const [newCode, setNewCode] = useState('');
  const [newPercent, setNewPercent] = useState(10);
  const [newMaxUses, setNewMaxUses] = useState<number | null>(null);
  const [newExpiresAt, setNewExpiresAt] = useState('');
  const [newNotes, setNewNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Discount-control AppConfig keys this page is responsible for. Reading
  // and writing flow through /api/admin/app-config (the single
  // AppConfig write path) — previously /api/admin/discount-settings was
  // a parallel writer that risked silent overwrites.
  const DISCOUNT_KEYS = [
    'enableFirstTimeDiscount',
    'firstTimeDiscountPercent',
    'enableRepeatDiscount',
    'repeatDiscountPercent',
    'discountHardCap',
  ] as const;

  const load = useCallback(async () => {
    setLoading(true);
    const [codesRes, configRes] = await Promise.all([
      fetch('/api/admin/discount-codes'),
      fetch('/api/admin/app-config'),
    ]);
    if (codesRes.ok) {
      const d = await codesRes.json();
      setRepeat(d.repeat);
      setCampaigns(d.campaigns);
    }
    if (configRes.ok) {
      const rows = await configRes.json() as { key: string; value: string }[];
      const map: Record<string, string> = {};
      for (const r of rows) {
        if ((DISCOUNT_KEYS as readonly string[]).includes(r.key)) map[r.key] = r.value;
      }
      setSettings(map as unknown as DiscountSettings);
      setEditedSettings({});
    }
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const saveSettings = async (totpCode?: string) => {
    setSettingsSaving(true);
    setSettingsSaved(false);
    setSettingsError('');
    // Build the {key, value}[] payload the unified app-config endpoint accepts.
    const updates = Object.entries(editedSettings)
      .filter(([k]) => (DISCOUNT_KEYS as readonly string[]).includes(k))
      .map(([key, value]) => ({ key, value: String(value) }));
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (totpCode) headers['X-Admin-TOTP'] = totpCode;
    const res = await fetch('/api/admin/app-config', {
      method: 'POST',
      headers,
      body: JSON.stringify(updates),
    });
    if (res.ok) {
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 2500);
      await load();
    } else {
      const d = await res.json().catch(() => ({}));
      if (d.requiresTotp) {
        // Ask for the code (or run enrollment) right here, then retry — the
        // save can finish where it was started instead of sending the admin
        // to a panel that cannot perform it.
        setTotpPromptOpen(true);
      } else {
        toast.error(d.error || 'Kunne ikke lagre.');
      }
    }
    setSettingsSaving(false);
  };
  const settingsDirty = Object.keys(editedSettings).length > 0;
  const get = (k: keyof DiscountSettings): string =>
    editedSettings[k] !== undefined ? String(editedSettings[k]) : (settings?.[k] ?? '');
  const setEdit = (k: keyof DiscountSettings, v: string) =>
    setEditedSettings((p) => ({ ...p, [k]: v }));

  const createCampaign = async () => {
    setCreateError(null);
    setSaving(true);
    const res = await fetch('/api/admin/discount-codes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: newCode,
        percent: newPercent,
        maxUses: newMaxUses,
        expiresAt: newExpiresAt || null,
        notes: newNotes || null,
      }),
    });
    if (res.ok) {
      setNewCode(''); setNewPercent(10); setNewMaxUses(null); setNewExpiresAt(''); setNewNotes('');
      setShowNewForm(false);
      await load();
    } else {
      const d = await res.json().catch(() => ({}));
      setCreateError(d.error || 'Ukjent feil');
    }
    setSaving(false);
  };

  const toggleCampaign = async (id: string, isActive: boolean) => {
    try {
      const res = await fetch(`/api/admin/discount-codes/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Kunne ikke oppdatere koden (HTTP ${res.status}).`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Kunne ikke oppdatere koden.');
    } finally {
      await load();
    }
  };

  const deleteCampaign = async (id: string, code: string) => {
    if (!confirm(`Slett kampanje-kode "${code}"? Dette sletter også loggen over bruk.`)) return;
    await fetch(`/api/admin/discount-codes/${id}`, { method: 'DELETE' });
    await load();
  };

  const copyCode = async (code: string) => {
    await navigator.clipboard.writeText(code).catch(() => {});
    setCopied(code);
    setTimeout(() => setCopied(null), 1500);
  };

  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString('nb-NO', { day: '2-digit', month: 'short', year: 'numeric' }) : '–';

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
              <Star className="w-5 h-5 text-primary" />
              <span className="font-bold text-lg">Rabattkoder</span>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} /> Oppdater
          </Button>
        </div>
      </nav>

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-4">
        {/* Tabs */}
        <div className="inline-flex rounded-lg border border-border bg-muted/40 p-1">
          {([
            { id: 'settings',  label: 'Innstillinger',                count: null as number | null },
            { id: 'unique',    label: 'Engangs (kunde)',              count: repeat.length },
            { id: 'campaigns', label: 'Kampanjer (gjenbrukbare)',     count: campaigns.length },
          ] as const).map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                tab === t.id ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t.label}{t.count !== null && <span className="ml-1.5 text-xs text-muted-foreground">{t.count}</span>}
            </button>
          ))}
        </div>

        {tab === 'settings' && (
          <div className="space-y-3">
            <Card className="bg-muted/30 border-dashed">
              <CardContent className="p-4 text-sm text-muted-foreground">
                <strong>Globale rabatt-innstillinger</strong> som styrer hvilke automatiske rabatter som er aktive, hvor mye de gir, og det totale taket. Endringer her krever 2FA og logges i revisjonsloggen.
              </CardContent>
            </Card>
            {!settings ? (
              <Card><CardContent className="p-12 text-center text-muted-foreground text-sm">Laster…</CardContent></Card>
            ) : (
              <Card>
                <CardContent className="p-5 space-y-5">
                  <FieldRow label="Aktiver førstegangskunde-rabatt" hint="Automatisk hvis e-post + telefon aldri har booket før">
                    <Toggle
                      value={get('enableFirstTimeDiscount') === 'true'}
                      onChange={(v) => setEdit('enableFirstTimeDiscount', v ? 'true' : 'false')}
                      labelOn="På" labelOff="Av"
                    />
                  </FieldRow>
                  <FieldRow label="Førstegangskunde-rabatt %">
                    <Slider
                      value={Number(get('firstTimeDiscountPercent')) || 0}
                      onChange={(n) => setEdit('firstTimeDiscountPercent', String(n))}
                      min={0} max={50} marks={[0, 25, 50]}
                    />
                  </FieldRow>
                  <FieldRow label="Aktiver returkunde-kode etter leie" hint="RETUR-XXXX sendes når booking fullføres">
                    <Toggle
                      value={get('enableRepeatDiscount') === 'true'}
                      onChange={(v) => setEdit('enableRepeatDiscount', v ? 'true' : 'false')}
                      labelOn="På" labelOff="Av"
                    />
                  </FieldRow>
                  <FieldRow label="Returkunde-rabatt %">
                    <Slider
                      value={Number(get('repeatDiscountPercent')) || 0}
                      onChange={(n) => setEdit('repeatDiscountPercent', String(n))}
                      min={0} max={50} marks={[0, 25, 50]}
                    />
                  </FieldRow>
                  <FieldRow label="Maksimal samlet rabatt %" hint="Hard cap mot stack-eksplosjon">
                    <Slider
                      value={Number(get('discountHardCap')) || 0}
                      onChange={(n) => setEdit('discountHardCap', String(n))}
                      min={0} max={100} marks={[0, 50, 100]}
                    />
                  </FieldRow>
                  {settingsError && (
                    <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-800 text-sm flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 shrink-0" />{settingsError}
                    </div>
                  )}
                  <div className="flex items-center justify-end gap-3 pt-3 border-t border-border">
                    {settingsSaved && (
                      <span className="text-sm text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1">
                        <CheckCircle2 className="w-4 h-4" /> Lagret
                      </span>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => { setEditedSettings({}); setSettingsError(''); }}
                      disabled={!settingsDirty || settingsSaving}
                    >
                      Avbryt
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => saveSettings()}
                      disabled={!settingsDirty || settingsSaving}
                    >
                      Lagre {settingsDirty && <span className="ml-1 text-xs opacity-80">({Object.keys(editedSettings).length})</span>}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {tab === 'unique' && (
          <div className="space-y-3">
            <Card className="bg-muted/30 border-dashed">
              <CardContent className="p-4 text-sm text-muted-foreground">
                <strong>Engangs-koder</strong> utstedes automatisk når en booking blir fullført eller kansellert (som goodwill). Hver kode er låst til kundens e-postadresse og kan kun brukes én gang.
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-0">
                {loading && repeat.length === 0 ? (
                  <div className="p-12 text-center text-muted-foreground text-sm">Laster…</div>
                ) : repeat.length === 0 ? (
                  <div className="p-12 text-center text-muted-foreground text-sm">Ingen engangs-koder utstedt ennå.</div>
                ) : (
                  <div className="divide-y divide-border">
                    {repeat.map((r) => (
                      <div key={r.id} className="px-5 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
                        <button
                          onClick={() => copyCode(r.code)}
                          title="Kopier kode"
                          className="font-mono text-sm bg-primary/5 border border-primary/20 rounded-md px-3 py-1.5 hover:bg-primary/10 flex items-center gap-1.5 shrink-0"
                        >
                          {r.code}
                          {copied === r.code ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3 text-muted-foreground" />}
                        </button>
                        <div className="flex-1 min-w-0 text-sm">
                          <div className="flex items-center gap-1.5">
                            <Mail className="w-3 h-3 text-muted-foreground shrink-0" />
                            <span className="truncate">{r.email}</span>
                          </div>
                          {r.issuedFor && (
                            <div className="text-xs text-muted-foreground mt-0.5">
                              Utstedt for <span className="font-mono">{r.issuedFor.reference}</span> · {r.issuedFor.name}
                            </div>
                          )}
                        </div>
                        <div className="text-xs flex items-center gap-3 shrink-0">
                          {r.redeemedBy ? (
                            <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              Brukt
                            </span>
                          ) : r.expiresAt && new Date(r.expiresAt) < new Date() ? (
                            <span className="inline-flex items-center gap-1 text-rose-600">
                              <XCircle className="w-3.5 h-3.5" /> Utløpt
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-blue-700 dark:text-blue-300">
                              <CheckCircle2 className="w-3.5 h-3.5" /> Aktiv
                            </span>
                          )}
                          <span className="text-muted-foreground">
                            Utstedt {fmt(r.createdAt)}
                          </span>
                          {r.expiresAt && !r.redeemedBy && (
                            <span className="text-muted-foreground">Utløper {fmt(r.expiresAt)}</span>
                          )}
                          {r.redeemedBy && (
                            <span className="text-muted-foreground">
                              Brukt på <span className="font-mono">{r.redeemedBy.reference}</span>
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {tab === 'campaigns' && (
          <div className="space-y-3">
            <Card className="bg-muted/30 border-dashed">
              <CardContent className="p-4 flex items-center justify-between gap-3">
                <div className="text-sm text-muted-foreground">
                  <strong>Kampanje-koder</strong> kan deles ut til hvem som helst og brukes flere ganger. Sett maks-antall-bruk for å begrense.
                </div>
                <Button size="sm" onClick={() => setShowNewForm(true)}>
                  <Plus className="w-4 h-4 mr-1" />Ny kampanje
                </Button>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-0">
                {loading && campaigns.length === 0 ? (
                  <div className="p-12 text-center text-muted-foreground text-sm">Laster…</div>
                ) : campaigns.length === 0 ? (
                  <div className="p-12 text-center text-muted-foreground text-sm">
                    Ingen kampanje-koder ennå. Lag den første for å starte en kampanje.
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {campaigns.map((c) => {
                      const expired = c.expiresAt && new Date(c.expiresAt) < new Date();
                      const exhausted = c.maxUses !== null && c.usedCount >= c.maxUses;
                      const dead = expired || exhausted || !c.isActive;
                      const expanded = expandedCampaign === c.id;
                      return (
                        <div key={c.id} className={`${dead ? 'opacity-70' : ''}`}>
                          <div className="px-5 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
                            <button
                              onClick={() => copyCode(c.code)}
                              title="Kopier kode"
                              className="font-mono text-sm bg-primary/5 border border-primary/20 rounded-md px-3 py-1.5 hover:bg-primary/10 flex items-center gap-1.5 shrink-0"
                            >
                              {c.code}
                              {copied === c.code ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3 text-muted-foreground" />}
                            </button>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 text-sm">
                                <span className="font-bold">{c.percent}% rabatt</span>
                                {c.notes && <span className="text-muted-foreground">· {c.notes}</span>}
                              </div>
                              <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-3 flex-wrap">
                                <span>{c.usedCount}{c.maxUses !== null ? `/${c.maxUses}` : ''} brukt</span>
                                {c.expiresAt && (
                                  <span className={expired ? 'text-rose-600' : ''}>
                                    {expired ? 'Utløpt' : 'Utløper'} {fmt(c.expiresAt)}
                                  </span>
                                )}
                                {!c.isActive && <Badge variant="outline" className="text-rose-600 border-rose-300 text-[10px]">Deaktivert</Badge>}
                                {exhausted && c.isActive && <Badge variant="outline" className="text-amber-600 border-amber-300 text-[10px]">Oppbrukt</Badge>}
                              </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <Toggle value={c.isActive} onChange={(v) => toggleCampaign(c.id, v)} labelOn="" labelOff="" />
                              <Button size="sm" variant="ghost" onClick={() => setExpandedCampaign(expanded ? null : c.id)}>
                                {c.redemptions.length} bruk{expanded ? ' ▾' : ' ▸'}
                              </Button>
                              <Button size="sm" variant="ghost" className="text-destructive hover:bg-destructive/10" onClick={() => deleteCampaign(c.id, c.code)}>
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </div>
                          </div>
                          {expanded && (
                            <div className="px-5 pb-4 -mt-1">
                              {c.redemptions.length === 0 ? (
                                <div className="text-xs text-muted-foreground italic">Ingen bruk registrert ennå.</div>
                              ) : (
                                <div className="rounded-lg border border-border bg-muted/20 divide-y divide-border">
                                  {c.redemptions.map((red) => (
                                    <div key={red.id} className="px-3 py-2 flex items-center gap-3 text-xs">
                                      <Calendar className="w-3 h-3 text-muted-foreground" />
                                      <span className="text-muted-foreground tabular-nums">{fmt(red.redeemedAt)}</span>
                                      <span className="font-mono">{red.bookingRef ?? '–'}</span>
                                      <span className="flex-1 truncate">
                                        {red.customerName && <span className="inline-flex items-center gap-1"><UserIcon className="w-3 h-3 text-muted-foreground" />{red.customerName}</span>}
                                      </span>
                                      <span className="inline-flex items-center gap-1 text-muted-foreground"><Mail className="w-3 h-3" />{red.email}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        <div className="text-xs text-muted-foreground text-center">
          Engangs-koder utstedes automatisk på fullført/kansellert booking. Kampanje-koder lager du her og deler manuelt (e-post, sosiale medier, plakat osv.).
        </div>
      </main>

      {/* New campaign drawer */}
      <Sheet open={showNewForm} onOpenChange={(o) => !o && setShowNewForm(false)}>
        <SheetContent side="right" className="sm:max-w-[480px] flex flex-col p-0">
          <SheetHeader className="shrink-0">
            <SheetTitle>Ny kampanje-kode</SheetTitle>
            <SheetDescription>Lag en gjenbrukbar rabattkode for kampanjer.</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            <div>
              <Label>Kode</Label>
              <Input
                className="mt-1.5 font-mono uppercase tracking-wider"
                placeholder="SOMMER2026"
                value={newCode}
                onChange={(e) => setNewCode(e.target.value.toUpperCase())}
                maxLength={32}
              />
              <p className="text-xs text-muted-foreground mt-1">A-Z, 0-9, bindestrek. 3-32 tegn.</p>
            </div>
            <FieldRow label="Rabatt-prosent">
              <Slider value={newPercent} onChange={setNewPercent} min={1} max={100} marks={[1, 50, 100]} />
            </FieldRow>
            <div>
              <Label>Maks antall bruk</Label>
              <div className="flex items-center gap-3 mt-1.5">
                <Stepper
                  value={newMaxUses ?? 0}
                  onChange={(n) => setNewMaxUses(n > 0 ? n : null)}
                  min={0}
                  max={10000}
                  unit="ganger"
                />
                <span className="text-xs text-muted-foreground">
                  {newMaxUses === null || newMaxUses === 0 ? 'Ubegrenset' : `${newMaxUses} bruk`}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">0 = ubegrenset bruk.</p>
            </div>
            <div>
              <Label>Utløpsdato (valgfritt)</Label>
              <Input
                type="date"
                className="mt-1.5"
                value={newExpiresAt}
                onChange={(e) => setNewExpiresAt(e.target.value)}
              />
            </div>
            <div>
              <Label>Beskrivelse (intern)</Label>
              <Input
                className="mt-1.5"
                placeholder="f.eks. Sommer-kampanje 2026"
                value={newNotes}
                onChange={(e) => setNewNotes(e.target.value)}
                maxLength={200}
              />
            </div>
            {createError && (
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="w-4 h-4" />{createError}
              </div>
            )}
          </div>
          <div className="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-border bg-muted/20">
            <Button variant="outline" onClick={() => setShowNewForm(false)}>Avbryt</Button>
            <Button onClick={createCampaign} disabled={saving || !newCode || newPercent < 1}>
              <Hash className="w-4 h-4 mr-1" />Opprett
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* Same prompt the admin panel uses, so a 2FA-gated save can be
          completed on the page that started it (P-15). Backing out says the
          change was not written, in the same words as the panel. */}
      <TotpPromptModal
        open={totpPromptOpen}
        context="Endring av rabattinnstillinger"
        onClose={() => {
          setTotpPromptOpen(false);
          setSettingsError('Ikke lagret — rabattinnstillinger krever 2FA. Endringene dine står fortsatt i skjemaet.');
        }}
        onVerified={(code) => {
          setTotpPromptOpen(false);
          void saveSettings(code);
        }}
      />
    </div>
  );
}
