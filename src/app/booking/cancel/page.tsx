'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { AlertCircle, CheckCircle2, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface BookingPreview {
  reference: string;
  name: string;
  rentalType: string;
  startDate: string;
  customDays?: number | null;
  deliveryAddress?: string | null;
  totalPrice: number;
  basePrice: number;
  status: string;
  cancellationFeePreview: number;
  feePercent: number;
  cancelFreeHours: number;
  hoursUntil: number;
}

function formatHours(h: number): string {
  const abs = Math.abs(h);
  if (abs >= 168 && abs % 168 === 0) return `${abs / 168} uke${abs / 168 > 1 ? 'r' : ''}`;
  if (abs >= 48 && abs % 24 === 0) return `${abs / 24} dager`;
  return `${abs} timer`;
}

function CancelPageInner() {
  const searchParams = useSearchParams();
  const tokenParam = searchParams.get('token');
  const refParam = searchParams.get('ref');
  const emailParam = searchParams.get('email');

  const [lookupRef, setLookupRef] = useState(refParam ?? '');
  const [lookupEmail, setLookupEmail] = useState(emailParam ?? '');

  const [preview, setPreview] = useState<BookingPreview | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  /** Second step of the cancel confirmation — see the action block below. */
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [error, setError] = useState('');
  const [cancelled, setCancelled] = useState(false);
  const [cancellationFee, setCancellationFee] = useState(0);
  const [refundAmount, setRefundAmount] = useState(0);
  const [cancelRef, setCancelRef] = useState('');

  // Auto-fetch when token is present in URL
  useEffect(() => {
    if (tokenParam) {
      fetchPreview({ token: tokenParam });
    } else if (refParam && emailParam) {
      fetchPreview({ ref: refParam, email: emailParam });
    }
     
  }, []);

  async function fetchPreview(params: { token?: string; ref?: string; email?: string }) {
    setIsLoading(true);
    setError('');
    setPreview(null);

    const qs = new URLSearchParams();
    if (params.token) qs.set('token', params.token);
    if (params.ref) qs.set('ref', params.ref);
    if (params.email) qs.set('email', params.email);

    try {
      const res = await fetch(`/api/booking/cancel?${qs}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Noe gikk galt.');
      } else {
        setPreview(data);
      }
    } catch {
      setError('Kunne ikke kontakte serveren. Prøv igjen.');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleCancel() {
    if (!preview) return;
    setIsCancelling(true);
    setError('');

    const body: Record<string, string> = {};
    if (tokenParam) {
      body.token = tokenParam;
    } else {
      body.reference = lookupRef;
      body.email = lookupEmail;
    }

    try {
      const res = await fetch('/api/booking/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Avbestilling feilet.');
      } else {
        setCancelled(true);
        setCancellationFee(data.cancellationFee ?? 0);
        setRefundAmount(data.refundAmount ?? 0);
        setCancelRef(data.reference ?? preview.reference);
      }
    } catch {
      setError('Kunne ikke kontakte serveren. Prøv igjen.');
    } finally {
      setIsCancelling(false);
    }
  }

  function handleLookupSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!lookupRef.trim() || !lookupEmail.trim()) return;
    fetchPreview({ ref: lookupRef.trim(), email: lookupEmail.trim() });
  }

  if (cancelled) {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-8 pb-8 text-center space-y-4">
            <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto" />
            <h1 className="text-2xl font-bold">Booking avbestilt</h1>
            <p className="text-muted-foreground">Referanse: <strong>{cancelRef}</strong></p>
            {cancellationFee > 0 && refundAmount > 0 ? (
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-4 text-sm text-amber-800 space-y-1">
                <p>Avbestillingsgebyr: <strong>{cancellationFee.toLocaleString('nb-NO')} kr</strong></p>
                <p>Refusjon: <strong>{refundAmount.toLocaleString('nb-NO')} kr</strong> tilbake til din betalingsmetode.</p>
                <p className="text-xs mt-1">Det kan ta 5–10 virkedager. Du mottar bekreftelse på e-post.</p>
              </div>
            ) : cancellationFee > 0 ? (
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-4 text-sm text-amber-800">
                Avbestillingsgebyr: <strong>{cancellationFee.toLocaleString('nb-NO')} kr</strong> — ingen refusjon.
              </div>
            ) : refundAmount > 0 ? (
              <div className="rounded-lg bg-green-50 border border-green-200 p-4 text-sm text-green-800">
                <p>Full refusjon: <strong>{refundAmount.toLocaleString('nb-NO')} kr</strong> tilbake til din betalingsmetode.</p>
                <p className="text-xs mt-1">Det kan ta 5–10 virkedager.</p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Ingen avbestillingsgebyr. Vi sender bekreftelse på e-post.
              </p>
            )}
            <Button variant="outline" asChild>
              <a href="/">Tilbake til forsiden</a>
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-lg space-y-6">
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight">Avbestill booking</h1>
          <p className="mt-2 text-muted-foreground">Finn din booking og avbestill den</p>
        </div>

        {/* Lookup form — shown when no token and no preview yet */}
        {!tokenParam && !preview && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Finn din booking</CardTitle>
              <CardDescription>Oppgi referanse og e-post fra bekreftelsesmailen</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleLookupSubmit} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="ref">Referansenummer</Label>
                  <Input
                    id="ref"
                    placeholder="f.eks. GK-ABC123"
                    value={lookupRef}
                    onChange={e => setLookupRef(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="email">E-postadresse</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="din@epost.no"
                    value={lookupEmail}
                    onChange={e => setLookupEmail(e.target.value)}
                    required
                  />
                </div>
                {error && (
                  <div className="flex items-start gap-2 text-sm text-destructive">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    {error}
                  </div>
                )}
                <Button type="submit" className="w-full" disabled={isLoading}>
                  {isLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  Finn booking
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        {/* Loading state for token mode */}
        {tokenParam && isLoading && (
          <div className="flex justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        )}

        {/* Error for token mode */}
        {tokenParam && error && !preview && (
          <Card className="border-destructive">
            <CardContent className="pt-6">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-destructive mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium text-destructive">Kunne ikke laste booking</p>
                  <p className="text-sm text-muted-foreground mt-1">{error}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Booking preview + confirm cancel */}
        {preview && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Bookingdetaljer</CardTitle>
              <CardDescription>Referanse: {preview.reference}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <span className="text-muted-foreground">Navn</span>
                <span className="font-medium">{preview.name}</span>
                <span className="text-muted-foreground">Leietype</span>
                <span className="font-medium">{preview.rentalType}</span>
                <span className="text-muted-foreground">Startdato</span>
                {/* Written out the way the rest of the site writes dates —
                    "2026-09-18" is not how a Norwegian customer reads one. */}
                <span className="font-medium">
                  {new Date(`${preview.startDate}T00:00:00`).toLocaleDateString('nb-NO', {
                    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
                  })}
                </span>
                {preview.customDays ? (
                  <>
                    <span className="text-muted-foreground">Antall dager</span>
                    <span className="font-medium">{preview.customDays}</span>
                  </>
                ) : null}
                {preview.deliveryAddress ? (
                  <>
                    <span className="text-muted-foreground">Leveringsadresse</span>
                    <span className="font-medium">{preview.deliveryAddress}</span>
                  </>
                ) : null}
                <span className="text-muted-foreground">Totalpris</span>
                <span className="font-medium">{preview.totalPrice.toLocaleString('nb-NO')} kr</span>
              </div>

              {/* Fee warning */}
              {preview.cancellationFeePreview > 0 ? (
                <div className="rounded-lg bg-amber-50 border border-amber-200 p-4 text-sm text-amber-800 space-y-1">
                  <div className="flex items-center gap-2 font-semibold">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    Avbestillingsgebyr gjelder
                  </div>
                  <p>
                    Siden det er {preview.hoursUntil < 0 ? 'etter' : 'kun'}{' '}
                    {formatHours(preview.hoursUntil)} til leiestart, vil du bli belastet{' '}
                    <strong>{preview.feePercent} %</strong> av leieprisen:{' '}
                    <strong>{preview.cancellationFeePreview.toLocaleString('nb-NO')} kr</strong>.
                  </p>
                </div>
              ) : (
                <div className="rounded-lg bg-green-50 border border-green-200 p-3 text-sm text-green-800 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  Gratis avbestilling – ingen gebyr.
                </div>
              )}

              {error && (
                <div className="flex items-start gap-2 text-sm text-destructive">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  {error}
                </div>
              )}

              {/* Two steps, because this is irreversible and reachable from a
                  forwardable e-mail link: one stray tap used to cancel the
                  booking and fire the refund with nothing in between. */}
              {!confirmingCancel ? (
                <div className="flex gap-3 pt-2">
                  <Button
                    variant="destructive"
                    className="flex-1"
                    onClick={() => { setConfirmingCancel(true); setError(''); }}
                  >
                    <X className="w-4 h-4 mr-2" />
                    {preview.cancellationFeePreview > 0
                      ? `Avbestill (gebyr ${preview.cancellationFeePreview.toLocaleString('nb-NO')} kr)`
                      : 'Avbestill booking'}
                  </Button>
                  {!tokenParam && (
                    <Button
                      variant="outline"
                      onClick={() => { setPreview(null); setError(''); }}
                    >
                      Tilbake
                    </Button>
                  )}
                </div>
              ) : (
                <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 space-y-3">
                  <div className="flex items-start gap-2 text-sm">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-destructive" />
                    <div>
                      <p className="font-semibold">Er du sikker?</p>
                      <p className="text-muted-foreground mt-1">
                        {preview.reference} for {preview.name} avbestilles, og datoen blir ledig for andre.
                        {preview.cancellationFeePreview > 0
                          ? ` Du får ${(preview.totalPrice - preview.cancellationFeePreview).toLocaleString('nb-NO')} kr refundert etter avbestillingsgebyr på ${preview.cancellationFeePreview.toLocaleString('nb-NO')} kr.`
                          : ` Hele beløpet på ${preview.totalPrice.toLocaleString('nb-NO')} kr refunderes.`}
                        {' '}Dette kan ikke angres.
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <Button
                      variant="destructive"
                      className="flex-1"
                      onClick={handleCancel}
                      disabled={isCancelling}
                    >
                      {isCancelling ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <X className="w-4 h-4 mr-2" />}
                      Ja, avbestill bookingen
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => setConfirmingCancel(false)}
                      disabled={isCancelling}
                    >
                      Behold bookingen
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <p className="text-center text-xs text-muted-foreground">
          Problemer? Ta kontakt direkte med utleier.
        </p>
      </div>
    </main>
  );
}

export default function CancelPage() {
  return (
    <Suspense fallback={
      <main className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </main>
    }>
      <CancelPageInner />
    </Suspense>
  );
}
