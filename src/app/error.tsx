'use client';

import { useEffect } from 'react';
import { AlertCircle } from 'lucide-react';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('App error:', error);
  }, [error]);

  return (
    <main className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="max-w-md w-full text-center space-y-6">
        <div className="w-16 h-16 mx-auto rounded-2xl bg-red-100 dark:bg-red-950/30 flex items-center justify-center">
          <AlertCircle className="w-8 h-8 text-red-600 dark:text-red-400" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold">Noe gikk galt</h1>
          <p className="text-muted-foreground mt-2">
            Vi beklager – en uventet feil oppstod. Prøv igjen, eller ta kontakt om problemet vedvarer.
          </p>
          {error.digest && (
            <p className="text-xs text-muted-foreground mt-2 font-mono">Feilkode: {error.digest}</p>
          )}
        </div>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <button
            onClick={reset}
            className="inline-flex items-center justify-center px-5 py-2.5 rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors"
          >
            Prøv igjen
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center px-5 py-2.5 rounded-lg border border-border font-medium hover:bg-muted transition-colors"
          >
            Tilbake til forsiden
          </a>
        </div>
      </div>
    </main>
  );
}
