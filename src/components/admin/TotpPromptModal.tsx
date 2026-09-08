'use client';

import { useEffect, useState } from 'react';
import { Loader2, Shield, ShieldCheck, KeyRound, Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called with the verified 6-digit code so the caller can retry the save. */
  onVerified: (code: string) => void;
  /** Optional label for the action being protected ("Lagring av prisendringer", etc.). */
  context?: string;
}

interface SetupPayload {
  secret: string;
  otpauthUri: string;
  qrDataUrl: string;
}

export default function TotpPromptModal({ open, onClose, onVerified, context }: Props) {
  const [mode, setMode] = useState<'loading' | 'verify' | 'enroll'>('loading');
  const [setup, setSetup] = useState<SetupPayload | null>(null);
  const [code, setCode] = useState('');
  const [enrollPassword, setEnrollPassword] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [copied, setCopied] = useState(false);

  // Reset state every time the modal opens.
  useEffect(() => {
    if (!open) return;
    setCode('');
    setEnrollPassword('');
    setError('');
    setSetup(null);
    setMode('loading');
    (async () => {
      try {
        const res = await fetch('/api/admin/totp/status');
        const data = await res.json();
        if (data.enrolled) {
          setMode('verify');
        } else {
          const setupRes = await fetch('/api/admin/totp/setup');
          const setupData = await setupRes.json();
          if (!setupRes.ok) throw new Error(setupData.error || 'Setup feilet');
          setSetup(setupData);
          setMode('enroll');
        }
      } catch (err) {
        setError((err as Error).message || 'Kunne ikke laste 2FA-status');
        setMode('verify');
      }
    })();
  }, [open]);

  // Autofill drops all six digits in at once and then waits — which looked
  // like nothing happened. Confirm as soon as the code is complete, but only
  // in verify mode: enrolment also needs the admin password.
  const handleCodeChange = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, 6);
    setCode(digits);
    if (digits.length === 6 && mode === 'verify') {
      setError('');
      onVerified(digits);
    }
  };

  const handleSubmit = async () => {
    setError('');
    if (!/^\d{6}$/.test(code)) {
      setError('Skriv inn 6-sifret kode.');
      return;
    }
    if (mode === 'enroll' && !enrollPassword) {
      setError('Skriv inn admin-passordet for å aktivere 2FA.');
      return;
    }
    // 'verify' mode confirms a sensitive action (e.g. saving settings). The
    // protected request itself verifies the code — and TOTP codes are
    // single-use (replay guard), so verifying here too would consume the code
    // and make the real request fail as a replay, looping the prompt forever.
    // Hand the code straight to the caller; only enrollment needs the POST.
    if (mode !== 'enroll') {
      onVerified(code);
      return;
    }
    setWorking(true);
    try {
      const body: Record<string, string> = { code };
      if (mode === 'enroll' && setup) {
        body.secret = setup.secret;
        body.password = enrollPassword;
      }
      const res = await fetch('/api/admin/totp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Verifisering feilet');
        return;
      }
      onVerified(code);
    } catch (err) {
      setError((err as Error).message || 'Verifisering feilet');
    } finally {
      setWorking(false);
    }
  };

  const copySecret = async () => {
    if (!setup) return;
    await navigator.clipboard.writeText(setup.secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {mode === 'enroll'
              ? <><Shield className="w-5 h-5 text-amber-500" /> Sett opp 2FA</>
              : <><ShieldCheck className="w-5 h-5 text-primary" /> Bekreft med 2FA</>}
          </DialogTitle>
          <DialogDescription>
            {mode === 'enroll'
              ? 'Skann koden i Bitwarden (eller en annen authenticator) og skriv inn 6-sifret kode for å aktivere.'
              : context
                ? `${context} krever 2FA-kode fra Bitwarden eller authenticator.`
                : 'Skriv inn 6-sifret kode fra Bitwarden eller authenticator.'}
          </DialogDescription>
        </DialogHeader>

        {mode === 'loading' && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {mode === 'enroll' && setup && (
          <div className="space-y-3">
            <div className="flex justify-center">
              <img src={setup.qrDataUrl} alt="QR-kode" className="rounded-md border border-border bg-white p-2" />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Manuell oppføring</Label>
              <div className="flex items-center gap-2 mt-1">
                <code className="flex-1 px-2 py-1.5 rounded bg-muted font-mono text-xs break-all">{setup.secret}</code>
                <Button type="button" variant="outline" size="sm" onClick={copySecret} className="shrink-0">
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                </Button>
              </div>
            </div>
          </div>
        )}

        {(mode === 'verify' || mode === 'enroll') && (
          <form
            className="mt-2 space-y-3"
            onSubmit={(e) => { e.preventDefault(); handleSubmit(); }}
          >
            <div>
              <Label htmlFor="totp-code" className="text-sm flex items-center gap-1.5">
                <KeyRound className="w-3.5 h-3.5" />
                6-sifret kode
              </Label>
              {/* Bitwarden (and 1Password, and iOS) find a TOTP field by
                  autocomplete="one-time-code" first, then by `totp` in the
                  name/id. Without those the dialog was just an unlabelled text
                  box to them and the inline autofill menu never appeared —
                  type="number" would break it again, so keep it text. */}
              <Input
                id="totp-code"
                name="totp"
                type="text"
                autoFocus
                autoComplete="one-time-code"
                inputMode="numeric"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                maxLength={6}
                pattern="\d{6}"
                value={code}
                onChange={(e) => handleCodeChange(e.target.value)}
                className="mt-1.5 font-mono text-lg tracking-widest text-center"
                placeholder="000000"
              />
            </div>
            {mode === 'enroll' && (
              <div>
                <Label htmlFor="totp-password" className="text-sm">
                  Bekreft med admin-passord
                </Label>
                <Input
                  id="totp-password"
                  type="password"
                  value={enrollPassword}
                  onChange={(e) => setEnrollPassword(e.target.value)}
                  className="mt-1.5"
                  placeholder="Admin-passordet"
                  autoComplete="current-password"
                />
              </div>
            )}
            {error && <p className="text-xs text-destructive">{error}</p>}
            {/* Submits the form on Enter from any field without adding a
                second visible button next to the footer's "Bekreft". */}
            <button type="submit" className="hidden" tabIndex={-1} aria-hidden="true" />
          </form>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose} disabled={working}>
            Avbryt
          </Button>
          <Button onClick={handleSubmit} disabled={working || code.length !== 6}>
            {working
              ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Verifiserer…</>
              : mode === 'enroll' ? 'Aktiver 2FA' : 'Bekreft'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
