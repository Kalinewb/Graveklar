import { loadAppConfig } from '@/lib/app-config';
import { Package } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function NotFound() {
  const cfg = await loadAppConfig();
  const businessName = cfg['businessName'] || 'Graveklar';
  const contactEmail = cfg['contactEmail'];

  return (
    <main className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="max-w-md w-full text-center space-y-6">
        <div className="w-16 h-16 mx-auto rounded-2xl bg-primary/10 flex items-center justify-center">
          <Package className="w-8 h-8 text-primary" />
        </div>
        <div>
          <p className="text-6xl font-bold tracking-tight text-primary">404</p>
          <h1 className="text-2xl font-semibold mt-2">Siden finnes ikke</h1>
          <p className="text-muted-foreground mt-2">Lenken er gammel eller skrevet feil.</p>
        </div>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <a href="/" className="inline-flex items-center justify-center px-5 py-2.5 rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors">
            Tilbake til forsiden
          </a>
          {contactEmail && (
            <a href={`mailto:${contactEmail}`} className="inline-flex items-center justify-center px-5 py-2.5 rounded-lg border border-border font-medium hover:bg-muted transition-colors">
              Kontakt {businessName}
            </a>
          )}
        </div>
      </div>
    </main>
  );
}
