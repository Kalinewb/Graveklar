'use client';

import { useEffect, useState } from 'react';
import { FlaskConical, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SegmentedControl, Stepper } from '@/components/admin-ui';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import type { RentalType } from '@/lib/pricing';
import { formatMachineLabel } from '@/lib/machine-display';

interface MachineOption {
  id: string;
  name: string;
  model?: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  startDate: string;
  machines: MachineOption[];
  onCreated?: (result: { reference: string; phone: string }) => void;
}

export function MockBookingSheet({
  open, onOpenChange, startDate, machines, onCreated,
}: Props) {
  const [date, setDate] = useState(startDate);
  const [rentalType, setRentalType] = useState<RentalType>('day');
  const [customDays, setCustomDays] = useState(2);
  const [phone, setPhone] = useState('99011223');
  const [name, setName] = useState('');
  const [machineId, setMachineId] = useState('');
  const [selfPickup, setSelfPickup] = useState(false);
  const [status, setStatus] = useState<'confirmed' | 'pending'>('confirmed');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setDate(startDate);
      setError('');
      if (machines.length === 1) setMachineId(machines[0].id);
    }
  }, [open, startDate, machines]);

  const handleCreate = async () => {
    if (!date) {
      setError('Velg startdato.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/mock-booking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          startDate: date,
          rentalType,
          customDays: rentalType === 'custom' ? customDays : rentalType === 'week' ? customDays : undefined,
          phone: phone.trim() || undefined,
          name: name.trim() || undefined,
          machineId: machineId || undefined,
          selfPickup,
          status,
          force: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Feilet');
      onCreated?.({ reference: data.booking.reference, phone: data.booking.phone });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Feilet');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-[480px] flex flex-col p-0">
        <SheetHeader className="shrink-0">
          <SheetTitle className="flex items-center gap-2">
            <FlaskConical className="w-4 h-4 text-amber-600" />
            Opprett testbooking
          </SheetTitle>
          <SheetDescription>
            Plasseres på valgt kalenderdato. Fjerner testbooking-låser og manuelle blokkeringer på leieperioden.
            Markert med <code className="text-[10px]">[TESTBOOKING]</code>.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {error && (
            <div className="text-sm text-destructive rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2">
              {error}
            </div>
          )}

          <div>
            <Label>Startdato</Label>
            <Input type="date" className="mt-1.5" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>

          <div>
            <Label className="mb-1.5 block">Leietype</Label>
            <SegmentedControl
              options={[
                { value: 'day', label: 'Døgn' },
                { value: 'weekend', label: 'Helg' },
                { value: 'week', label: 'Uke' },
                { value: 'custom', label: 'Tilpasset' },
              ]}
              value={rentalType}
              onChange={(v) => setRentalType(v as RentalType)}
            />
          </div>

          {(rentalType === 'custom' || rentalType === 'week') && (
            <div>
              <Label>{rentalType === 'week' ? 'Antall dager (7, 14, …)' : 'Antall dager'}</Label>
              <div className="mt-1.5">
                <Stepper
                  value={customDays}
                  onChange={setCustomDays}
                  min={rentalType === 'week' ? 7 : 2}
                  max={rentalType === 'week' ? 56 : 30}
                  step={rentalType === 'week' ? 7 : 1}
                />
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>Telefon</Label>
              <Input className="mt-1.5" placeholder="99011223" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div>
              <Label>Navn</Label>
              <Input className="mt-1.5" placeholder="Test Leietaker" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          </div>

          {machines.length > 0 && (
            <div>
              <Label>Utstyr</Label>
              {machines.length === 1 ? (
                <div className="mt-1.5 text-sm font-medium">
                  {formatMachineLabel(machines[0])}
                </div>
              ) : (
                <select
                  className="mt-1.5 w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                  value={machineId}
                  onChange={(e) => setMachineId(e.target.value)}
                >
                  <option value="">Første tilgjengelige</option>
                  {machines.map((m) => (
                    <option key={m.id} value={m.id}>{formatMachineLabel(m)}</option>
                  ))}
                </select>
              )}
            </div>
          )}

          <div>
            <Label className="mb-1.5 block">Levering</Label>
            <SegmentedControl
              options={[
                { value: 'delivery', label: 'Levering' },
                { value: 'pickup', label: 'Selvhenting' },
              ]}
              value={selfPickup ? 'pickup' : 'delivery'}
              onChange={(v) => setSelfPickup(v === 'pickup')}
            />
          </div>

          <div>
            <Label className="mb-1.5 block">Status</Label>
            <SegmentedControl
              options={[
                { value: 'confirmed', label: 'Betalt / bekreftet' },
                { value: 'pending', label: 'Venter betaling' },
              ]}
              value={status}
              onChange={(v) => setStatus(v as 'confirmed' | 'pending')}
            />
          </div>
        </div>

        <div className="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-border bg-muted/20">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Avbryt</Button>
          <Button type="button" onClick={handleCreate} disabled={loading || machines.length === 0}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
            Opprett
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
