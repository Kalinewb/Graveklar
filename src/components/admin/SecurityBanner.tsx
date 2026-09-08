'use client';

import { Shield, ShieldCheck, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Props {
  enrolled: boolean;
  onSetup: () => void;
  onReset: () => void;
}

export default function SecurityBanner({ enrolled, onSetup, onReset }: Props) {
  if (enrolled) {
    return (
      <div className="rounded-xl border border-green-200 dark:border-green-900 bg-green-50 dark:bg-green-950/30 p-3 flex items-center gap-3">
        <ShieldCheck className="w-5 h-5 text-green-700 dark:text-green-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-green-900 dark:text-green-200">2FA er aktivt</p>
          <p className="text-xs text-green-800/80 dark:text-green-300/80">
            Endringer i Stripe, e-post, priser, leveringsadresse, booking-regler og system krever 6-sifret kode.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={onReset} className="text-xs shrink-0">
          Slett oppsett
        </Button>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3 flex items-center gap-3">
      <ShieldAlert className="w-5 h-5 text-amber-700 dark:text-amber-400 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-amber-900 dark:text-amber-200">2FA er ikke satt opp</p>
        <p className="text-xs text-amber-800/80 dark:text-amber-300/80">
          Sett opp Bitwarden eller en annen authenticator for å beskytte prisendringer og betalingsoppsett mot uautoriserte endringer.
        </p>
      </div>
      <Button size="sm" onClick={onSetup} className="gap-1.5 shrink-0">
        <Shield className="w-3.5 h-3.5" />
        Sett opp 2FA
      </Button>
    </div>
  );
}
