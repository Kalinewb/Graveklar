import { Wrench, Mail, Phone, ShieldCheck } from 'lucide-react';

interface Props {
  businessName: string;
  message: string;
  contactEmail?: string;
  contactPhone?: string;
}

export default function MaintenancePage({ businessName, message, contactEmail, contactPhone }: Props) {
  return (
    <main className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="max-w-md w-full text-center space-y-6">
        <div className="w-16 h-16 mx-auto rounded-2xl bg-primary/10 flex items-center justify-center">
          <Wrench className="w-8 h-8 text-primary" />
        </div>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{businessName}</h1>
          <p className="text-sm text-muted-foreground uppercase tracking-wider mt-1">Vedlikehold pågår</p>
        </div>
        <p className="text-base text-foreground leading-relaxed">{message}</p>
        {(contactEmail || contactPhone) && (
          <div className="flex flex-col gap-2 pt-4 border-t border-border">
            <p className="text-sm text-muted-foreground">Ta kontakt om noe haster:</p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center items-center text-sm">
              {contactPhone && (
                <a href={`tel:${contactPhone.replace(/\s/g, '')}`} className="inline-flex items-center gap-1.5 text-primary hover:underline">
                  <Phone className="w-4 h-4" /> {contactPhone}
                </a>
              )}
              {contactEmail && (
                <a href={`mailto:${contactEmail}`} className="inline-flex items-center gap-1.5 text-primary hover:underline">
                  <Mail className="w-4 h-4" /> {contactEmail}
                </a>
              )}
            </div>
          </div>
        )}
        <div className="pt-6 border-t border-border/50">
          <a
            href="/admin"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground/70 hover:text-primary transition-colors"
          >
            <ShieldCheck className="w-3.5 h-3.5" />
            Admin
          </a>
        </div>
      </div>
    </main>
  );
}
