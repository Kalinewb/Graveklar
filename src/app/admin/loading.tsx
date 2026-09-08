import { Loader2 } from 'lucide-react';

/**
 * Route-transition spinner for the admin panel only. There is deliberately no
 * root `loading.tsx`: a root Suspense boundary flushes a 200 shell before a
 * page can call `notFound()`, which made switched-off public pages answer 200
 * (finding Q-6). The admin surface never gates with `notFound()`, and its
 * initial load is slow enough that the spinner is worth keeping here.
 */
export default function Loading() {
  return (
    <div role="status" aria-live="polite" className="min-h-screen flex items-center justify-center bg-background">
      <Loader2 aria-hidden="true" className="w-8 h-8 animate-spin text-primary" />
      <span className="sr-only">Laster…</span>
    </div>
  );
}
