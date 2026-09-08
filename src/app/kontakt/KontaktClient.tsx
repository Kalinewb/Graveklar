'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Mail, Phone, CheckCircle2, Loader2, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';

interface Props {
  businessName: string;
  contactEmail: string;
  contactPhone: string;
}

export function KontaktClient({ businessName, contactEmail, contactPhone }: Props) {
  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    message: '',
    website: '', // honeypot
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((p) => ({ ...p, [key]: value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/kontakt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Kunne ikke sende meldingen');
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Noe gikk galt');
    } finally {
      setSubmitting(false);
    }
  };

  if (sent) {
    return (
      <div className="text-center py-12">
        <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-5">
          <CheckCircle2 className="w-7 h-7 text-green-700" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight mb-2">Melding sendt</h1>
        <p className="text-muted-foreground max-w-md mx-auto">
          Takk for henvendelsen! Vi svarer deg på e-post så snart vi kan.
        </p>
        <div className="mt-8">
          <Button asChild variant="outline">
            <Link href="/">Tilbake til forsiden</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center gap-3 mb-2">
        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          <MessageSquare className="w-5 h-5 text-primary" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight">Kontakt {businessName}</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Send oss en melding, så svarer vi så raskt vi kan.
      </p>

      {(contactEmail || contactPhone) && (
        <div className="flex flex-wrap gap-4 mb-6 text-sm">
          {contactEmail && (
            <a href={`mailto:${contactEmail}`} className="inline-flex items-center gap-2 text-primary hover:underline underline-offset-2">
              <Mail className="w-4 h-4" />{contactEmail}
            </a>
          )}
          {contactPhone && (
            <a href={`tel:${contactPhone.replace(/\s/g, '')}`} className="inline-flex items-center gap-2 text-primary hover:underline underline-offset-2">
              <Phone className="w-4 h-4" />{contactPhone}
            </a>
          )}
        </div>
      )}

      <form onSubmit={submit} className="space-y-5">
        <input
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={form.website}
          onChange={(e) => set('website', e.target.value)}
          className="hidden"
          aria-hidden="true"
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <Label htmlFor="k-name">Navn *</Label>
            <Input id="k-name" className="mt-1.5" required value={form.name} onChange={(e) => set('name', e.target.value)} />
          </div>
          <div>
            <Label htmlFor="k-phone">Telefon</Label>
            <Input id="k-phone" type="tel" inputMode="tel" className="mt-1.5" value={form.phone} onChange={(e) => set('phone', e.target.value)} />
          </div>
        </div>

        <div>
          <Label htmlFor="k-email">E-post *</Label>
          <Input id="k-email" type="email" className="mt-1.5" required value={form.email} onChange={(e) => set('email', e.target.value)} />
        </div>

        <div>
          <Label htmlFor="k-message">Melding *</Label>
          <Textarea id="k-message" className="mt-1.5 min-h-[140px]" required value={form.message} onChange={(e) => set('message', e.target.value)} placeholder="Hva kan vi hjelpe deg med?" />
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 text-destructive text-sm px-3 py-2">
            {error}
          </div>
        )}

        <Button type="submit" className="w-full h-11" disabled={submitting}>
          {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
          {submitting ? 'Sender…' : 'Send melding'}
        </Button>
      </form>
    </>
  );
}
