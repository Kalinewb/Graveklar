'use client';

import { useState, useCallback, useEffect } from 'react';
import { CheckCircle2, Circle, Camera, Loader2, Phone, QrCode, ChevronRight, X, FileText, Lock, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { isItemFilled, isItemActive, photoUrls, photoMin, countChecklistProgress } from '@/lib/checklist';

const RENTER_SESSION_TOKEN_KEY = 'sjekkliste:sessionToken';

function answersStorageKey(bookingId: string, phaseId: string): string {
  return `checklist:${bookingId}:${phaseId}`;
}

// All localStorage/sessionStorage access is wrapped in try/catch: private
// browsing / storage-disabled contexts must degrade to in-memory-only
// behavior, never throw.
function loadStoredAnswers(bookingId: string, phaseId: string): Record<string, string | boolean | string[]> {
  try {
    const raw = localStorage.getItem(answersStorageKey(bookingId, phaseId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, string | boolean | string[]>)
      : {};
  } catch {
    return {};
  }
}

function saveStoredAnswers(bookingId: string, phaseId: string, answers: Record<string, string | boolean | string[]>): void {
  try {
    localStorage.setItem(answersStorageKey(bookingId, phaseId), JSON.stringify(answers));
  } catch {
    // storage unavailable — fall back silently to in-memory state only
  }
}

function clearStoredAnswers(bookingId: string, phaseId: string): void {
  try {
    localStorage.removeItem(answersStorageKey(bookingId, phaseId));
  } catch {
    // ignore
  }
}

function readStoredSessionToken(): string {
  try {
    return sessionStorage.getItem(RENTER_SESSION_TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveStoredSessionToken(token: string): void {
  try {
    sessionStorage.setItem(RENTER_SESSION_TOKEN_KEY, token);
  } catch {
    // ignore
  }
}

function clearStoredSessionToken(): void {
  try {
    sessionStorage.removeItem(RENTER_SESSION_TOKEN_KEY);
  } catch {
    // ignore
  }
}

interface BookingOption {
  id: string;
  reference: string;
  name: string;
  equipmentName: string;
  startDate: string;
  endDate: string;
  rentalDay: number;
  totalDays: number;
}

interface ChecklistItem {
  id: string;
  label: string;
  answerType: string;
  unit?: string | null;
  conditionItemId?: string | null;
  conditionValue?: string | null;
  minPhotos?: number | null;
}

interface PhaseState {
  id: string;
  name: string;
  interval: { key: string; label: string };
  submitted: boolean;
  complete: boolean;
  available?: boolean;
  lockedReason?: string | null;
  submittedAt: string | null;
  data: Record<string, unknown>;
  items: ChecklistItem[];
}

interface SessionData {
  booking: {
    id: string;
    reference: string;
    name: string;
    equipmentName: string;
    startDate: string;
    selfPickup: boolean;
  };
  businessName: string;
  machineDocuments?: { title: string; fileUrl: string }[];
  phases: PhaseState[];
  duePhaseId: string | null;
}

type Step = 'phone' | 'pick' | 'checklist' | 'done';

export default function SjekklisteClient() {
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [sessionToken, setSessionToken] = useState('');
  const [bookings, setBookings] = useState<BookingOption[]>([]);
  const [session, setSession] = useState<SessionData | null>(null);
  const [activePhaseId, setActivePhaseId] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string | boolean | string[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState<Set<string>>(new Set());
  // Uploaded checklist photos are private: /api/uploads only serves a
  // `renter-<bookingId>-…` file to an admin session or to this renter's bearer
  // token, and a plain <img> cannot send a bearer token. So the thumbnail
  // shows the file the browser already has (an object URL from the file
  // input), keyed by the stored URL that goes into the answers.
  const [photoPreviews, setPhotoPreviews] = useState<Record<string, string>>({});
  const [restoring, setRestoring] = useState(true);
  const [lastSubmission, setLastSubmission] = useState<{
    reference: string;
    phaseName: string;
    intervalLabel: string;
    photos: string[];
  } | null>(null);

  const loadSession = useCallback(async (token: string) => {
    const res = await fetch('/api/checklist/session', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Kunne ikke laste sjekkliste');
    setSession(data);
    const due = data.phases.find((p: PhaseState) => p.id === data.duePhaseId && p.available !== false)
      ?? data.phases.find((p: PhaseState) => !p.submitted && p.available !== false)
      ?? data.phases.find((p: PhaseState) => !p.submitted);
    if (due && !due.submitted) {
      setActivePhaseId(due.id);
      setAnswers(loadStoredAnswers(data.booking.id, due.id));
    } else {
      const fallbackId = data.phases[0]?.id ?? null;
      setActivePhaseId(fallbackId);
      setAnswers(fallbackId ? loadStoredAnswers(data.booking.id, fallbackId) : {});
    }
    setStep('checklist');
  }, []);

  // Restore the renter's phone-verification session across reloads. The
  // token itself is only ever trusted after it's re-validated against the
  // session-check API (loadSession), never blindly.
  useEffect(() => {
    const stored = readStoredSessionToken();
    if (!stored) {
      setRestoring(false);
      return;
    }
    setSessionToken(stored);
    loadSession(stored)
      .catch(() => {
        setSessionToken('');
        clearStoredSessionToken();
      })
      .finally(() => setRestoring(false));
  }, [loadSession]);

  const handleLookup = async (bookingId?: string) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/checklist/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, bookingId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Oppslag feilet');

      if (data.needsSelection) {
        setBookings(data.bookings);
        setStep('pick');
        return;
      }

      setSessionToken(data.sessionToken);
      saveStoredSessionToken(data.sessionToken);
      await loadSession(data.sessionToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Noe gikk galt');
    } finally {
      setLoading(false);
    }
  };

  const handlePick = async (bookingId: string) => {
    await handleLookup(bookingId);
  };

  const activePhase = session?.phases.find((p) => p.id === activePhaseId) ?? null;

  const switchToPhase = (phaseId: string) => {
    setActivePhaseId(phaseId);
    setAnswers(session ? loadStoredAnswers(session.booking.id, phaseId) : {});
  };

  const setValue = (itemId: string, value: string | boolean | string[]) => {
    setAnswers((prev) => {
      const next = { ...prev, [itemId]: value };
      if (session && activePhaseId) saveStoredAnswers(session.booking.id, activePhaseId, next);
      return next;
    });
  };

  const handleSubmit = async () => {
    if (!session || !activePhase || activePhase.submitted) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/checklist/submit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({ phaseId: activePhase.id, data: answers }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Innsending feilet');

      clearStoredAnswers(session.booking.id, activePhase.id);
      const submittedPhotos = activePhase.items
        .filter((i) => i.answerType === 'photo')
        .flatMap((i) => photoUrls(answers[i.id]));
      setLastSubmission({
        reference: session.booking.reference,
        phaseName: activePhase.name,
        intervalLabel: activePhase.interval.label,
        photos: submittedPhotos,
      });

      const refreshed = await fetch('/api/checklist/session', {
        headers: { Authorization: `Bearer ${sessionToken}` },
      }).then((r) => r.json());
      setSession(refreshed);
      const stillDue = refreshed.phases?.some((p: PhaseState) => !p.submitted);
      if (!stillDue) setStep('done');
      else {
        const next = refreshed.phases.find((p: PhaseState) => !p.submitted);
        if (next) { setActivePhaseId(next.id); setAnswers(loadStoredAnswers(refreshed.booking.id, next.id)); }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Innsending feilet');
    } finally {
      setLoading(false);
    }
  };

  const overallProgress = session
    ? countChecklistProgress(
        session.phases,
        session.phases.reduce((acc, p) => {
          Object.assign(acc, p.id === activePhaseId ? answers : p.data);
          return acc;
        }, {} as Record<string, unknown>),
        { selfPickup: session.booking.selfPickup },
      )
    : { done: 0, total: 0 };

  const visiblePhaseItems = activePhase
    ? activePhase.items.filter((i) => isItemActive(i, answers, activePhase.items))
    : [];
  const phaseAllDone = activePhase
    ? visiblePhaseItems.every((i) => isItemFilled(i, answers[i.id]))
    : false;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <div className="sticky top-0 z-50 bg-background/80 backdrop-blur-md border-b border-border">
        <div className="max-w-lg mx-auto px-4 h-16 flex items-center gap-3">
          <a href="/" className="p-1 -ml-1 text-muted-foreground hover:text-foreground transition-colors shrink-0" aria-label="Tilbake til forsiden">
            <ArrowLeft className="w-5 h-5" />
          </a>
          <QrCode className="w-6 h-6 shrink-0 text-primary" />
          <div className="min-w-0">
            <div className="font-bold text-sm truncate">{session?.businessName ?? 'Utstyrsjekk'}</div>
            <div className="text-xs text-muted-foreground truncate">Skann & fyll ut sjekkliste</div>
          </div>
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center px-4 py-6">
      <div className="w-full max-w-lg space-y-4">
        {error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 text-destructive text-sm px-4 py-3">
            {error}
          </div>
        )}

        {restoring && (
          <div className="flex justify-center py-16">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        )}

        {!restoring && step === 'phone' && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Skriv inn telefonnummeret du brukte ved booking. Du må ha en aktiv, betalt leie for å fylle ut sjekklisten.
            </p>
            <div>
              <label className="text-sm font-medium flex items-center gap-2 mb-2">
                <Phone className="w-4 h-4" /> Telefonnummer
              </label>
              <Input
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="f.eks. 990 11 223"
                className="h-12 text-lg"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleLookup()}
              />
            </div>
            <Button className="w-full h-12" onClick={() => handleLookup()} disabled={loading || !phone.trim()}>
              {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Finn min booking'}
            </Button>
          </div>
        )}

        {!restoring && step === 'pick' && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Vi fant flere aktive bookinger på dette nummeret. Velg riktig leie:
            </p>
            {bookings.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => handlePick(b.id)}
                disabled={loading}
                className="w-full text-left rounded-xl border-2 border-border p-4 hover:border-primary transition-colors flex items-center gap-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="font-semibold">{b.reference}</div>
                  <div className="text-sm text-muted-foreground">{b.equipmentName}</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {new Date(b.startDate + 'T00:00:00').toLocaleDateString('nb-NO')} – {new Date(b.endDate + 'T00:00:00').toLocaleDateString('nb-NO')}
                    {' · '}Dag {b.rentalDay}/{b.totalDays}
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-muted-foreground shrink-0" />
              </button>
            ))}
          </div>
        )}

        {!restoring && step === 'checklist' && session && (
          <div className="space-y-4">
            <div className="rounded-xl border bg-card p-4 text-sm">
              <div className="font-semibold">{session.booking.reference}</div>
              <div className="text-muted-foreground">{session.booking.name} · {session.booking.equipmentName}</div>
            </div>

            {(session.machineDocuments?.length ?? 0) > 0 && (
              <div className="rounded-xl border bg-card p-4">
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                  Maskindokumentasjon
                </div>
                <div className="flex flex-wrap gap-2">
                  {session.machineDocuments!.map((doc) => (
                    <a
                      key={doc.fileUrl}
                      href={doc.fileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs hover:bg-muted"
                    >
                      <FileText className="w-3.5 h-3.5" />
                      {doc.title || 'PDF'}
                    </a>
                  ))}
                </div>
              </div>
            )}

            {overallProgress.total > 0 && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Fremdrift</span>
                  <span>{overallProgress.done}/{overallProgress.total} punkter fullført</span>
                </div>
                <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-green-500 transition-all"
                    style={{ width: `${Math.round((overallProgress.done / overallProgress.total) * 100)}%` }}
                  />
                </div>
              </div>
            )}

            {session.phases.length > 1 && (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {session.phases.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => switchToPhase(p.id)}
                    className={`shrink-0 px-3 py-2 rounded-lg text-xs font-medium border ${
                      p.id === activePhaseId ? 'border-primary bg-primary/10 text-primary' : 'border-border'
                    }`}
                  >
                    {p.name}
                    {p.submitted && ' ✓'}
                  </button>
                ))}
              </div>
            )}

            {activePhase?.submitted ? (
              <div className="text-center py-10 space-y-2">
                <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto" />
                <p className="font-medium">{activePhase.name} — {activePhase.interval.label}</p>
                <p className="text-sm text-muted-foreground">Allerede levert</p>
              </div>
            ) : activePhase && activePhase.available === false ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-950/20 p-4 flex gap-3 text-sm text-amber-900 dark:text-amber-200">
                <Lock className="w-5 h-5 shrink-0 mt-0.5" />
                <div>
                  <div className="font-medium">{activePhase.name}</div>
                  <p className="mt-1 opacity-90">{activePhase.lockedReason ?? 'Ikke tilgjengelig ennå.'}</p>
                </div>
              </div>
            ) : activePhase && (
              <div className="space-y-3">
                <div className="text-sm font-medium text-muted-foreground">{activePhase.interval.label}</div>
                {visiblePhaseItems.map((item) => {
                  const value = answers[item.id];
                  const filled = isItemFilled(item, value);

                  if (item.answerType === 'yesno') {
                    return (
                      <div key={item.id} className={`p-4 rounded-xl border-2 ${(value === true || value === false) ? 'border-green-500' : 'border-border'}`}>
                        <div className="text-sm font-medium mb-2">{item.label}</div>
                        <div className="flex gap-2">
                          {([['Ja', true], ['Nei', false]] as const).map(([lbl, val]) => (
                            <button key={lbl} type="button" onClick={() => setValue(item.id, val)}
                              className={`flex-1 h-11 rounded-lg border-2 text-sm font-medium ${
                                value === val ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
                              }`}>
                              {lbl}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  }

                  if (item.answerType === 'checkbox') {
                    const checked = value === true;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setValue(item.id, !checked)}
                        className={`w-full flex items-center gap-3 p-4 rounded-xl border-2 text-left ${
                          checked ? 'border-green-500 bg-green-50 dark:bg-green-950/20' : 'border-border'
                        }`}
                      >
                        {checked
                          ? <CheckCircle2 className="w-6 h-6 text-green-600" />
                          : <Circle className="w-6 h-6 text-muted-foreground" />}
                        <span className="text-sm font-medium">{item.label}</span>
                      </button>
                    );
                  }

                  if (item.answerType === 'photo') {
                    const urls = photoUrls(value);
                    const min = photoMin(item);
                    return (
                      <div key={item.id} className={`p-4 rounded-xl border-2 ${filled ? 'border-green-500' : 'border-border'}`}>
                        <label className="text-sm font-medium block mb-1">{item.label}</label>
                        <div className="text-xs text-muted-foreground mb-2">
                          {urls.length}/{min} bilde{min > 1 ? 'r' : ''}{urls.length < min ? ` · minst ${min} påkrevd` : ' ✓'}
                        </div>
                        <div className="flex flex-wrap items-center gap-3">
                          {urls.map((url) => (
                            <div key={url} className="relative shrink-0">
                              {photoPreviews[url] ? (
                                <img src={photoPreviews[url]} alt="" className="h-20 w-20 rounded-lg object-cover border" />
                              ) : (
                                // Restored from a previous session: the bytes
                                // are safely stored, but this browser cannot
                                // fetch them back without the bearer token.
                                <div className="h-20 w-20 rounded-lg border flex flex-col items-center justify-center gap-1 bg-muted text-muted-foreground">
                                  <Camera className="w-5 h-5" />
                                  <span className="text-[10px]">Lastet opp</span>
                                </div>
                              )}
                              <button type="button" onClick={() => {
                                const preview = photoPreviews[url];
                                if (preview) {
                                  URL.revokeObjectURL(preview);
                                  setPhotoPreviews((prev) => { const next = { ...prev }; delete next[url]; return next; });
                                }
                                setValue(item.id, urls.filter((u) => u !== url));
                              }}
                                className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-red-600 text-white flex items-center justify-center shadow"
                                title="Fjern bilde">
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))}
                          {uploading.has(item.id) ? (
                            <Loader2 className="w-5 h-5 animate-spin" />
                          ) : (
                            <label className="cursor-pointer flex flex-col items-center justify-center gap-1 h-20 w-20 rounded-lg border border-dashed">
                              <Camera className="w-5 h-5" />
                              <span className="text-[11px]">{urls.length ? 'Legg til' : 'Ta bilde'}</span>
                              <input
                                type="file"
                                accept="image/*,.heic,.heif"
                                capture="environment"
                                multiple
                                className="hidden"
                                onChange={async (e) => {
                                  const files = Array.from(e.target.files ?? []);
                                  if (files.length === 0) return;
                                  setUploading((prev) => new Set(prev).add(item.id));
                                  try {
                                    let current = photoUrls(answers[item.id]);
                                    for (const file of files) {
                                      const fd = new FormData();
                                      fd.append('file', file);
                                      const res = await fetch('/api/checklist/upload', {
                                        method: 'POST',
                                        headers: { Authorization: `Bearer ${sessionToken}` },
                                        body: fd,
                                      });
                                      const d = await res.json();
                                      if (d.url) {
                                        current = [...current, d.url];
                                        setValue(item.id, current);
                                        try {
                                          const objectUrl = URL.createObjectURL(file);
                                          setPhotoPreviews((prev) => ({ ...prev, [d.url]: objectUrl }));
                                        } catch { /* no object URL support — the tile falls back to a placeholder */ }
                                      }
                                      else if (d.error) { setError(d.error); break; }
                                    }
                                  } catch { setError('Opplasting feilet'); }
                                  finally {
                                    setUploading((prev) => { const n = new Set(prev); n.delete(item.id); return n; });
                                  }
                                }}
                              />
                            </label>
                          )}
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div key={item.id} className={`p-4 rounded-xl border-2 ${filled ? 'border-green-500' : 'border-border'}`}>
                      <label className="text-sm font-medium block mb-2">{item.label}</label>
                      <Input
                        type={item.answerType === 'number' || item.answerType === 'measurement' ? 'number' : 'text'}
                        className="h-11"
                        value={typeof value === 'string' ? value : ''}
                        onChange={(e) => setValue(item.id, e.target.value)}
                      />
                    </div>
                  );
                })}

                <Button
                  className="w-full h-12 bg-green-600 hover:bg-green-700"
                  disabled={!phaseAllDone || loading}
                  onClick={handleSubmit}
                >
                  {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Send inn sjekkliste'}
                </Button>
              </div>
            )}
          </div>
        )}

        {!restoring && step === 'done' && (
          <div className="text-center py-12 space-y-4">
            <CheckCircle2 className="w-16 h-16 text-green-500 mx-auto" />
            <h2 className="text-xl font-bold">Takk!</h2>
            <p className="text-sm text-muted-foreground">Sjekklisten er registrert.</p>
            {lastSubmission && (
              <div className="mx-auto max-w-xs rounded-xl border bg-card p-4 text-left space-y-3">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Booking</div>
                  <div className="font-semibold">{lastSubmission.reference}</div>
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Innsendt</div>
                  <div className="text-sm">{lastSubmission.phaseName} — {lastSubmission.intervalLabel}</div>
                </div>
                {lastSubmission.photos.length > 0 && (
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Bilder</div>
                    <div className="flex flex-wrap gap-2">
                      {lastSubmission.photos.map((url) => (
                        photoPreviews[url] ? (
                          <img key={url} src={photoPreviews[url]} alt="" className="h-16 w-16 rounded-lg object-cover border" />
                        ) : (
                          <div key={url} className="h-16 w-16 rounded-lg border flex items-center justify-center bg-muted text-muted-foreground">
                            <Camera className="w-4 h-4" />
                          </div>
                        )
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
