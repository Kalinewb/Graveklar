'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, ClipboardList, ExternalLink, Loader2 } from 'lucide-react';
import { Separator } from '@/components/ui/separator';
import {
  formatChecklistAnswerValue,
  isItemActive,
  isItemFilled,
  isOperatorChecklistComplete,
  parseChecklistData,
  photoUrls,
} from '@/lib/checklist';
import type { RenterSubmissionView } from '@/lib/renter-checklist';

interface Props {
  bookingId: string;
  checklistData?: string | null;
}

function SubmissionCard({ sub }: { sub: RenterSubmissionView }) {
  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-3 py-2.5 bg-muted/40 border-b border-border">
        <div className="text-sm font-medium flex items-center gap-1.5">
          <CheckCircle2 className="w-3.5 h-3.5 text-green-600 shrink-0" />
          {sub.phaseName}
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          {sub.intervalLabel}
          {' · '}
          {new Date(sub.submittedAt).toLocaleString('nb-NO', {
            day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
          })}
          {' · '}
          {sub.phone}
        </div>
      </div>
      <div className="divide-y divide-border">
        {sub.items.filter((i) => isItemActive(i, sub.data, sub.items)).map((item) => {
          const value = sub.data[item.id];
          return (
            <div key={item.id} className="px-3 py-2 flex items-start gap-3 text-sm">
              <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${isItemFilled(item, value) ? 'bg-green-500' : 'bg-muted-foreground/30'}`} />
              <div className="flex-1 min-w-0">
                <div className="font-medium">{item.label}</div>
                {item.answerType === 'photo' && photoUrls(value).length > 0 ? (
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {photoUrls(value).map((url) => (
                      <a key={url} href={url} target="_blank" rel="noopener noreferrer" className="inline-block">
                        <img src={url} alt={item.label} className="h-16 w-16 rounded-lg object-cover border border-border" />
                      </a>
                    ))}
                  </div>
                ) : (
                  <div className="text-muted-foreground text-xs mt-0.5">
                    {formatChecklistAnswerValue(item, value)}
                    {item.unit && item.answerType === 'measurement' ? ` ${item.unit}` : ''}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function CompletedChecklistsSummary({ bookingId, checklistData }: Props) {
  const [loading, setLoading] = useState(true);
  const [submissions, setSubmissions] = useState<RenterSubmissionView[]>([]);
  const [error, setError] = useState('');

  const operatorData = parseChecklistData(checklistData);
  const operatorComplete = isOperatorChecklistComplete(operatorData);
  const operatorLockedAt = typeof operatorData['__lockedAt'] === 'string'
    ? operatorData['__lockedAt']
    : null;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    fetch(`/api/admin/bookings/${bookingId}/checklist-submissions`, { credentials: 'include' })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Kunne ikke hente innsendinger');
        if (!cancelled) setSubmissions(data.submissions ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Feilet');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [bookingId]);

  if (!operatorComplete && !loading && submissions.length === 0 && !error) {
    return null;
  }

  return (
    <div className="space-y-3 pt-1">
      <Separator />
      <div className="flex items-center gap-2">
        <ClipboardList className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-semibold">Fullførte sjekklister</h3>
      </div>

      {operatorComplete && (
        <div className="rounded-lg border border-green-200 dark:border-green-900/40 bg-green-50/50 dark:bg-green-950/20 px-3 py-2.5 flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-green-600" />
              Operatør-sjekkliste
            </div>
            {operatorLockedAt && (
              <div className="text-xs text-muted-foreground mt-0.5">
                Fullført {new Date(operatorLockedAt).toLocaleString('nb-NO', {
                  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                })}
              </div>
            )}
          </div>
          <a
            href={`/admin/checklist/${bookingId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary hover:underline flex items-center gap-1 shrink-0"
          >
            Se PDF <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-1">
          <Loader2 className="w-4 h-4 animate-spin" />
          Laster leietaker-innsendinger…
        </div>
      )}

      {error && (
        <div className="text-sm text-destructive rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2">
          {error}
        </div>
      )}

      {submissions.map((sub) => (
        <SubmissionCard key={sub.id} sub={sub} />
      ))}
    </div>
  );
}
