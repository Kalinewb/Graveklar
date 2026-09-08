'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Star, CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';

interface Props {
  token: string;
  businessName: string;
  defaultName: string;
}

export function OmtaleClient({ token, businessName, defaultName }: Props) {
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState('');
  const [name, setName] = useState(defaultName);
  const [website, setWebsite] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (rating < 1) {
      setError('Velg en vurdering mellom 1 og 5 stjerner.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/omtale/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating, comment, reviewerName: name, website }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Kunne ikke sende vurderingen');
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Noe gikk galt');
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div className="text-center py-8">
        <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-5">
          <CheckCircle2 className="w-7 h-7 text-green-700" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight mb-2">Tusen takk!</h1>
        <p className="text-muted-foreground max-w-md mx-auto">
          Vurderingen din er sendt inn og publiseres etter en kjapp gjennomgang.
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
      <h1 className="text-2xl font-bold tracking-tight mb-1">Hvordan var leien?</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Del din opplevelse med {businessName}. Det tar bare et øyeblikk.
      </p>

      <form onSubmit={submit} className="space-y-6">
        <input
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          className="hidden"
          aria-hidden="true"
        />

        <div>
          <Label className="mb-2 block">Din vurdering *</Label>
          <div className="flex gap-1" onMouseLeave={() => setHover(0)}>
            {[1, 2, 3, 4, 5].map((n) => {
              const active = (hover || rating) >= n;
              return (
                <button
                  key={n}
                  type="button"
                  onClick={() => setRating(n)}
                  onMouseEnter={() => setHover(n)}
                  aria-label={`${n} av 5 stjerner`}
                  className="p-1 transition-transform hover:scale-110"
                >
                  <Star className={`w-9 h-9 ${active ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/30'}`} />
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <Label htmlFor="o-comment">Kommentar</Label>
          <Textarea
            id="o-comment"
            className="mt-1.5 min-h-[120px]"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Hva likte du? Noe vi kan bli bedre på?"
            maxLength={2000}
          />
        </div>

        <div>
          <Label htmlFor="o-name">Fornavn (vises offentlig)</Label>
          <Input id="o-name" className="mt-1.5" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 text-destructive text-sm px-3 py-2">
            {error}
          </div>
        )}

        <Button type="submit" className="w-full h-11" disabled={submitting}>
          {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
          {submitting ? 'Sender…' : 'Send vurdering'}
        </Button>
      </form>
    </>
  );
}
