'use client';

import { Phone, Mail, MapPin } from 'lucide-react';
import { Separator } from '@/components/ui/separator';

interface FooterProps {
  appConfig: Record<string, string>;
}

export default function Footer({ appConfig }: FooterProps) {
  return (
    <footer className="bg-card border-t border-border py-12">
      <div className="max-w-6xl mx-auto px-4">
        <div className="flex flex-col md:flex-row md:justify-between gap-8">
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="font-bold text-lg tracking-tight">{appConfig['businessName'] || 'Graveklar'}</span>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {appConfig['businessTagline'] || `Utstyrsutleie${appConfig['serviceArea'] ? ` i ${appConfig['serviceArea']}` : ''}. Alt inkludert, levert til deg.`}
            </p>
          </div>

          <div>
            <h3 className="font-semibold text-sm mb-3">Kontakt</h3>
            <div className="space-y-2 text-sm text-muted-foreground">
              {appConfig['contactPhone'] ? (
                <a href={`tel:${appConfig['contactPhone'].replace(/\s/g, '')}`} className="flex items-center gap-2 hover:text-foreground transition-colors">
                  <Phone className="w-4 h-4 shrink-0" /> {appConfig['contactPhone']}
                </a>
              ) : null}
              {appConfig['contactEmail'] ? (
                <a href={`mailto:${appConfig['contactEmail']}`} className="flex items-center gap-2 hover:text-foreground transition-colors">
                  <Mail className="w-4 h-4 shrink-0" /> {appConfig['contactEmail']}
                </a>
              ) : null}
              {appConfig['businessAddress'] ? (
                <div className="flex items-center gap-2">
                  <MapPin className="w-4 h-4 shrink-0" /> {appConfig['businessAddress']}
                </div>
              ) : null}
            </div>
          </div>

        </div>
        <Separator className="my-6" />
        <div className="text-xs text-center text-muted-foreground space-y-2">
          {appConfig['orgNumber'] && (
            <div>
              <a href={`https://virksomhet.brreg.no/nb/oppslag/enheter/${appConfig['orgNumber']}`} target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">
                {appConfig['businessName'] || 'Graveklar'}
                {/* "Foretaksregistrert" only holds for the AS — show it once the
                    business is renamed to the AS, never as a false claim for the
                    enkeltpersonforetak. */}
                {(appConfig['businessName'] || '').includes('AS') && ' (Foretaksregistrert)'}
                {' · '}Org.nr {appConfig['orgNumber']}
                {appConfig['businessAddress'] && <> · {appConfig['businessAddress']}</>}
              </a>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
            <a href="/vilkar" className="underline underline-offset-2 hover:text-foreground transition-colors">Leievilkår og manualer</a>
            <span className="text-border">·</span>
            {appConfig['contactFormEnabled'] !== 'false' && (
              <>
                <a href="/kontakt" className="underline underline-offset-2 hover:text-foreground transition-colors">Kontakt</a>
                <span className="text-border">·</span>
              </>
            )}
            <a href="/personvern" className="underline underline-offset-2 hover:text-foreground transition-colors">Personvern</a>
            <span className="text-border">·</span>
            <a href="https://www.forbrukerradet.no" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">Forbrukerrådet</a>
            <span className="text-border">·</span>
            <a href="/admin" className="text-muted-foreground hover:text-foreground transition-colors">Admin</a>
          </div>
          <div className="text-muted-foreground/80">
            Er du uenig i en avgjørelse? Forbrukertvister kan bringes inn for Forbrukertilsynet og Forbrukerklageutvalget.
          </div>
        </div>
      </div>
    </footer>
  );
}
