'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Loader2, Shield, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Package } from 'lucide-react';

function AdminLoginForm() {
  const searchParams = useSearchParams();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [requiresTotp, setRequiresTotp] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  // Only relevant in the rare case where 2FA is already enrolled while the
  // default password is still in place: the change-password route then needs
  // its own fresh code.
  const [changeNeedsTotp, setChangeNeedsTotp] = useState(false);
  const [changeCode, setChangeCode] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password, code: requiresTotp ? code : undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        // First-step success but TOTP needed: reveal the code field instead
        // of throwing. Keeps the password in place so the second submit
        // delivers both factors in one request.
        if (data.requiresTotp) {
          setRequiresTotp(true);
          if (code) setError(data.error || 'Ugyldig 2FA-kode.');
        } else {
          throw new Error(data.error || 'Innlogging feilet');
        }
        return;
      }

      if (data.mustChangePassword) {
        setMustChangePassword(true);
      } else {
        const from = searchParams.get('from') || '/admin';
        window.location.href = from;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Innlogging feilet');
    } finally {
      setLoading(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (newPassword.length < 8) {
      setError('Passordet må være minst 8 tegn.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passordene stemmer ikke overens.');
      return;
    }

    setChangingPassword(true);
    try {
      const res = await fetch('/api/admin/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // A password change is credential-level, so the route asks for the
          // second factor whenever 2FA is enrolled. The code that unlocked the
          // login is single-use per 30 s step, hence a fresh field here.
          ...(changeCode ? { 'x-admin-totp': changeCode } : {}),
        },
        credentials: 'include',
        body: JSON.stringify({ currentPassword: password, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.requiresTotp) setChangeNeedsTotp(true);
        throw new Error(data.error || 'Kunne ikke endre passord');
      }

      const from = searchParams.get('from') || '/admin';
      window.location.href = from;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke endre passord');
    } finally {
      setChangingPassword(false);
    }
  };

  if (mustChangePassword) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <div className="mx-auto w-10 h-10 rounded-lg bg-amber-500 flex items-center justify-center mb-2">
              <Shield className="w-5 h-5 text-white" />
            </div>
            <CardTitle>Velg nytt passord</CardTitle>
            <CardDescription>Standardpassordet må endres før du kan fortsette.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleChangePassword} className="space-y-4">
              <div>
                <Label htmlFor="new-password">Nytt passord</Label>
                <Input
                  id="new-password"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="mt-1.5"
                  autoComplete="new-password"
                  placeholder="Minst 8 tegn"
                  required
                />
              </div>
              <div>
                <Label htmlFor="confirm-password">Bekreft passord</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="mt-1.5"
                  autoComplete="new-password"
                  required
                />
              </div>
              {changeNeedsTotp && (
                <div>
                  <Label htmlFor="change-code">2FA-kode</Label>
                  <Input
                    id="change-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={changeCode}
                    onChange={(e) => setChangeCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    className="mt-1.5 tracking-[0.4em] text-center"
                    placeholder="000000"
                    required
                  />
                </div>
              )}
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" className="w-full" disabled={changingPassword}>
                {changingPassword ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Lagrer...</>
                ) : (
                  <><Lock className="w-4 h-4 mr-2" />Sett nytt passord</>
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto w-10 h-10 rounded-lg bg-primary flex items-center justify-center mb-2">
            <Package className="w-5 h-5 text-primary-foreground" />
          </div>
          <CardTitle>Graveklar Admin</CardTitle>
          <CardDescription>Logg inn for å administrere bookinger</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4" suppressHydrationWarning>
            <div>
              <Label htmlFor="password">Passord</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1.5"
                autoComplete="current-password"
                required
                readOnly={requiresTotp}
              />
            </div>
            {requiresTotp && (
              <div>
                <Label htmlFor="totp-code">2FA-kode</Label>
                {/* `name="totp"` on top of autocomplete="one-time-code":
                    Bitwarden matches the name/id too, and this field only
                    appears after the password round-trip, so it has to be
                    unmistakable when the extension re-scans the form. */}
                <Input
                  id="totp-code"
                  name="totp"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  className="mt-1.5 tracking-widest text-center"
                  placeholder="000000"
                  autoFocus
                  required
                />
              </div>
            )}
            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Logger inn...</>
              ) : requiresTotp ? (
                'Verifiser kode'
              ) : (
                'Logg inn'
              )}
            </Button>
          </form>
          <p className="text-xs text-muted-foreground text-center mt-4">
            <a href="/" className="hover:underline">Tilbake til nettsiden</a>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export default function AdminLoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center">Laster...</div>}>
      <AdminLoginForm />
    </Suspense>
  );
}
