import Link from 'next/link';
import { ArrowLeft, CheckCircle2 } from 'lucide-react';
import { loadAppConfig } from '@/lib/app-config';
import { getReviewByToken } from '@/lib/review';
import { OmtaleClient } from './OmtaleClient';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Gi en vurdering',
  robots: { index: false, follow: false },
};

// Declared at module scope, not inside the page: a component created during
// render is a fresh type on every pass, which remounts its subtree.
function Shell({ businessName, children }: { businessName: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="max-w-xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4" /><span className="text-sm">Tilbake til {businessName}</span>
          </Link>
        </div>
      </header>
      <main className="max-w-xl mx-auto px-4 py-12">{children}</main>
    </div>
  );
}

export default async function OmtalePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const cfg = await loadAppConfig();
  const name = cfg['businessName'] || 'Graveklar';
  const review = await getReviewByToken(token);

  if (!review) {
    return (
      <Shell businessName={name}>
        <h1 className="text-2xl font-bold tracking-tight mb-2">Ugyldig lenke</h1>
        <p className="text-muted-foreground">Denne vurderingslenken finnes ikke eller har utløpt.</p>
      </Shell>
    );
  }

  if (review.status !== 'pending') {
    return (
      <Shell businessName={name}>
        <div className="text-center py-8">
          <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-5">
            <CheckCircle2 className="w-7 h-7 text-green-700" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight mb-2">Takk!</h1>
          <p className="text-muted-foreground">Vi har allerede registrert vurderingen din. Takk for tilbakemeldingen!</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell businessName={name}>
      <OmtaleClient
        token={token}
        businessName={name}
        defaultName={(review.booking.name || '').trim().split(/\s+/)[0] || ''}
      />
    </Shell>
  );
}
