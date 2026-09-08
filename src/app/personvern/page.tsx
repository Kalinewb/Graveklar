import Link from 'next/link';
import { ArrowLeft, Shield } from 'lucide-react';
import type { Metadata } from 'next';
import { loadAppConfig } from '@/lib/app-config';
import { buildSiteMetadata } from '@/lib/seo';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const cfg = await loadAppConfig();
  const name = cfg['businessName'] || 'Graveklar';
  return buildSiteMetadata(cfg, [], {
    path: '/personvern',
    title: `Personvernerklæring | ${name}`,
    description: `Hvordan ${name} behandler personopplysninger når du leier utstyr og booker online.`,
  });
}

// Privacy policy. Entity identity (name, org.nr, address, email) is read from
// appConfig so it updates automatically when the AS is incorporated and the
// admin flips businessName / orgNumber — no code change needed at that point.
export default async function PersonvernPage() {
  const cfg = await loadAppConfig();
  const name = cfg['businessName'] || 'Graveklar';
  const org = cfg['orgNumber'] || '';
  const address = cfg['businessAddress'] || '';
  const email = cfg['contactEmail'] || 'kontakt@graveklar.no';
  const site = cfg['siteUrl'] || 'https://graveklar.no';
  const host = site.replace(/^https?:\/\//, '');

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="max-w-3xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4" /><span className="text-sm">Tilbake til {name}</span>
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-10">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
            <Shield className="w-5 h-5 text-primary" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Personvernerklæring</h1>
        </div>
        <p className="text-sm text-muted-foreground mb-8">Sist oppdatert 2. juni 2026</p>

        <div className="space-y-7 text-sm leading-relaxed text-foreground/90">
          <p>
            {name} er behandlingsansvarlig for personopplysningene som samles inn når du bruker {host} og
            leier maskin av oss. Vi behandler personopplysninger i samsvar med personopplysningsloven og
            personvernforordningen (GDPR).
          </p>

          <Section title="Behandlingsansvarlig">
            <p>
              {name}
              {org && <><br />Organisasjonsnummer: {org}</>}
              {address && <><br />{address}</>}
              <br />E-post: <a href={`mailto:${email}`} className="text-primary underline underline-offset-2">{email}</a>
            </p>
          </Section>

          <Section title="Hvilke opplysninger vi samler inn">
            <ul className="list-disc pl-5 space-y-1.5">
              <li><strong>Kontakt- og bestillingsopplysninger:</strong> navn, adresse, telefonnummer, e-postadresse og opplysninger om bestillingen din.</li>
              <li><strong>Leveringsadresse:</strong> adressen du oppgir for levering, som brukes til å beregne leveringsavstand og leveringspris.</li>
              <li><strong>Betalingsopplysninger:</strong> betaling håndteres av Stripe. Vi lagrer ikke kortopplysninger selv.</li>
              <li><strong>Legitimasjonskontroll:</strong> ved utlevering kontrollerer vi at gyldig legitimasjon stemmer med bestillingen, og noterer type og nummer på leiekontrakten. Vi tar ikke bilde av legitimasjonen og lagrer ingen kopi.</li>
              <li><strong>Posisjonsdata for utstyret:</strong> maskinene kan være utstyrt med GPS-sporing av hensyn til tyverisikring og gjenfinning. Dette gjelder utstyret, ikke deg som person.</li>
            </ul>
          </Section>

          <Section title="Hvorfor vi behandler opplysningene (behandlingsgrunnlag)">
            <ul className="list-disc pl-5 space-y-1.5">
              <li>For å oppfylle leieavtalen med deg (GDPR artikkel 6 nr. 1 bokstav b): bestilling, levering, fakturering og oppfølging.</li>
              <li>For å oppfylle rettslige forpliktelser (artikkel 6 nr. 1 bokstav c): bokføring og regnskap.</li>
              <li>For å ivareta berettigede interesser (artikkel 6 nr. 1 bokstav f): skadeoppfølging, dokumentasjon ved tvist og sikring av maskinen mot tyveri.</li>
            </ul>
          </Section>

          <Section title="Hvem vi deler opplysninger med">
            <p>Vi bruker følgende databehandlere og samarbeidspartnere:</p>
            <ul className="list-disc pl-5 space-y-1.5 mt-2">
              <li><strong>Stripe</strong> – betalingsbehandling.</li>
              <li><strong>Tripletex</strong> – regnskap og fakturering.</li>
              <li><strong>If Skadeforsikring</strong> – kun ved skade som meldes til forsikringen.</li>
              <li><strong>E-postleverandør (SMTP på {host})</strong> – utsending av bestillingsbekreftelser og varsler.</li>
              <li><strong>Nominatim (OpenStreetMap)</strong> – geokoding av leveringsadressen du oppgir.</li>
              <li><strong>OSRM</strong> – beregning av kjøreavstand for å fastsette leveringspris.</li>
            </ul>
            <p className="mt-2">
              Vi selger aldri personopplysningene dine, og deler dem ikke med andre enn det som er nødvendig
              for å levere tjenesten eller oppfylle lovpålagte krav.
            </p>
          </Section>

          <Section title="Hvor lenge vi lagrer opplysningene">
            <ul className="list-disc pl-5 space-y-1.5">
              <li>Bestillings- og kontaktopplysninger lagres så lenge det er nødvendig for å administrere leieforholdet og eventuelle etterfølgende krav.</li>
              <li>Regnskaps- og faktureringsdata lagres i fem år i samsvar med bokføringsloven.</li>
              <li>Opplysninger som ikke lenger er nødvendige, slettes.</li>
            </ul>
          </Section>

          <Section title="Dine rettigheter">
            <p>Du har rett til å:</p>
            <ul className="list-disc pl-5 space-y-1.5 mt-2">
              <li>be om innsyn i hvilke opplysninger vi har om deg,</li>
              <li>be om retting av uriktige opplysninger,</li>
              <li>be om sletting av opplysninger,</li>
              <li>be om begrensning av behandlingen,</li>
              <li>protestere mot behandling basert på berettiget interesse,</li>
              <li>be om dataportabilitet.</li>
            </ul>
            <p className="mt-2">
              Ta kontakt på <a href={`mailto:${email}`} className="text-primary underline underline-offset-2">{email}</a> for
              å bruke rettighetene dine. Du har også rett til å klage til Datatilsynet dersom du mener vi
              behandler opplysningene dine i strid med regelverket.
            </p>
          </Section>

          <Section title="Informasjonskapsler (cookies)">
            <p>
              {host} bruker informasjonskapsler som er nødvendige for at nettsiden og betalingsløsningen skal
              fungere. Dersom vi tar i bruk analyse- eller markedsføringskapsler, ber vi om samtykke til dette først.
            </p>
          </Section>

          <Section title="Endringer">
            <p>
              Vi kan oppdatere denne personvernerklæringen. Gjeldende versjon er alltid tilgjengelig på {host}.
            </p>
          </Section>
        </div>
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-base font-semibold mb-2 text-foreground">{title}</h2>
      {children}
    </section>
  );
}
