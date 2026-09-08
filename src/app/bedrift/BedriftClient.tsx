'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Building2, CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatMachineLabel } from '@/lib/machine-display';

interface MachineOption {
  id: string;
  name: string;
  model: string | null;
}

interface Props {
  businessName: string;
  machines: MachineOption[];
  enabledRentalTypes: string[];
}

const RENTAL_LABELS: Record<string, string> = {
  day: '1 dag',
  weekend: 'Helg',
  week: '1 uke',
  custom: 'Tilpasset',
};

// Radix Select items can't use an empty string as their value, so unset selections use this sentinel.
const UNSET = '__unset__';

export function BedriftClient({ businessName, machines, enabledRentalTypes }: Props) {
  const rentalTypes = [...enabledRentalTypes, 'custom'];

  const [form, setForm] = useState({
    company: '',
    orgNumber: '',
    contactName: '',
    email: '',
    phone: '',
    machineId: machines.length === 1 ? machines[0].id : '',
    rentalType: '',
    startDate: '',
    customDays: '',
    projectDescription: '',
    trainingConfirmed: false,
    website: '', // honeypot
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((p) => ({ ...p, [key]: value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/bedrift', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          customDays: form.rentalType === 'custom' && form.customDays ? Number(form.customDays) : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Kunne ikke sende forespørsel');
      setReference(data.reference);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Noe gikk galt');
    } finally {
      setSubmitting(false);
    }
  };

  if (reference) {
    return (
      <div className="text-center py-12">
        <div className="w-14 h-14 rounded-full bg-green-100 dark:bg-green-950/30 flex items-center justify-center mx-auto mb-5">
          <CheckCircle2 className="w-7 h-7 text-green-700 dark:text-green-300" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight mb-2">Forespørsel sendt</h1>
        <p className="text-muted-foreground max-w-md mx-auto">
          Takk! Vi har mottatt forespørselen din (referanse <strong>{reference}</strong>) og sender et tilbud så snart som mulig.
          Du får en bekreftelse på e-post.
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
          <Building2 className="w-5 h-5 text-primary" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight">Leie til bedrift</h1>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Be om et tilbud, så sender vi en pris tilbake. Vi blokkerer ikke datoer før du har akseptert tilbudet.{' '}
        <Link href="/vilkar?vis=bedrift" className="text-primary hover:underline underline-offset-2">
          Se bedriftsvilkår
        </Link>
        .
      </p>

      <form onSubmit={submit} className="space-y-5">
        <input
          type="text"
          name="website"
          value={form.website}
          onChange={(e) => set('website', e.target.value)}
          className="hidden"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
        />

        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <Label htmlFor="b-company">Firmanavn *</Label>
            <Input id="b-company" className="mt-1.5" value={form.company} onChange={(e) => set('company', e.target.value)} required />
          </div>
          <div>
            <Label htmlFor="b-org">Organisasjonsnummer *</Label>
            <Input
              id="b-org"
              className="mt-1.5"
              value={form.orgNumber}
              onChange={(e) => set('orgNumber', e.target.value)}
              inputMode="numeric"
              placeholder="9 siffer"
              required
            />
          </div>
          <div>
            <Label htmlFor="b-contact">Kontaktperson *</Label>
            <Input id="b-contact" className="mt-1.5" value={form.contactName} onChange={(e) => set('contactName', e.target.value)} required />
          </div>
          <div>
            <Label htmlFor="b-phone">Telefon *</Label>
            <Input id="b-phone" className="mt-1.5" type="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} required />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="b-email">E-post *</Label>
            <Input id="b-email" className="mt-1.5" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} required />
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          {machines.length > 0 && (
            <div>
              <Label htmlFor="b-machine">Maskin</Label>
              <Select
                value={form.machineId || UNSET}
                onValueChange={(value) => set('machineId', value === UNSET ? '' : value)}
              >
                <SelectTrigger id="b-machine" className="mt-1.5 w-full">
                  <SelectValue placeholder="Ikke bestemt / be om råd" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNSET}>Ikke bestemt / be om råd</SelectItem>
                  {machines.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {formatMachineLabel(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <Label htmlFor="b-rental">Leieperiode</Label>
            <Select
              value={form.rentalType || UNSET}
              onValueChange={(value) => set('rentalType', value === UNSET ? '' : value)}
            >
              <SelectTrigger id="b-rental" className="mt-1.5 w-full">
                <SelectValue placeholder="Ikke bestemt" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNSET}>Ikke bestemt</SelectItem>
                {rentalTypes.map((t) => (
                  <SelectItem key={t} value={t}>
                    {RENTAL_LABELS[t] ?? t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="b-start">Ønsket startdato</Label>
            <Input id="b-start" lang="nb-NO" className="mt-1.5" type="date" value={form.startDate} onChange={(e) => set('startDate', e.target.value)} />
          </div>
          {form.rentalType === 'custom' && (
            <div>
              <Label htmlFor="b-days">Antall dager</Label>
              <Input
                id="b-days"
                className="mt-1.5"
                type="number"
                min={1}
                max={365}
                value={form.customDays}
                onChange={(e) => set('customDays', e.target.value)}
              />
            </div>
          )}
        </div>

        <div>
          <Label htmlFor="b-desc">Beskrivelse av prosjektet</Label>
          <Textarea
            id="b-desc"
            className="mt-1.5"
            rows={4}
            value={form.projectDescription}
            onChange={(e) => set('projectDescription', e.target.value)}
            placeholder="Hva skal maskinen brukes til, hvor, og eventuelle spesielle behov?"
          />
        </div>

        <label className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-4 cursor-pointer">
          <input
            type="checkbox"
            checked={form.trainingConfirmed}
            onChange={(e) => set('trainingConfirmed', e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
            required
          />
          <span className="text-sm text-muted-foreground leading-relaxed">
            <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
              <ShieldCheck className="w-4 h-4 text-primary" /> M2-bekreftelse
            </span>
            <br />
            Jeg bekrefter at fører som skal betjene maskinen har gyldig og dokumentert sikkerhetsopplæring (M2 for
            masseforflyttingsmaskiner), og at bedriften er arbeidsgiver med ansvar for HMS ved bruk. *
          </span>
        </label>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Button type="submit" size="lg" className="w-full" disabled={submitting}>
          {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
          Send forespørsel
        </Button>
        <p className="text-xs text-muted-foreground text-center">
          Dette er en uforpliktende forespørsel – ingen betaling nå.
        </p>
      </form>
    </>
  );
}
