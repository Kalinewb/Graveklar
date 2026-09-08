import { cn } from '@/lib/utils';

export type MiniBarDatum = { label: string; value: number };

/**
 * Dependency-free vertical bar chart for small dashboard widgets.
 * Bars are sized relative to the largest value in the series; the last
 * bar is highlighted by default (it represents the current period).
 */
export function MiniBarChart({
  data,
  highlightLast = true,
  formatValue,
  className,
}: {
  data: MiniBarDatum[];
  highlightLast?: boolean;
  /** Formats the tiny number above each bar. Defaults to a "k" thousands view. */
  formatValue?: (value: number) => string;
  className?: string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const fmt =
    formatValue ??
    ((v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : v > 0 ? String(v) : ''));

  return (
    <div className={cn('w-full', className)}>
      <div className="flex items-end gap-1.5 h-32">
        {data.map((d, i) => {
          const heightPct = Math.round((d.value / max) * 100);
          const isLast = highlightLast && i === data.length - 1;
          return (
            <div
              key={i}
              className="flex-1 flex flex-col items-center justify-end h-full min-w-0"
              title={`${d.label}: ${d.value.toLocaleString('nb-NO')}`}
            >
              <div className="text-[9px] tabular-nums text-muted-foreground leading-none mb-1 h-3">
                {fmt(d.value)}
              </div>
              <div
                className={cn(
                  'w-full rounded-t-md transition-all',
                  isLast ? 'bg-primary' : 'bg-primary/25'
                )}
                style={{ height: `${d.value > 0 ? Math.max(4, heightPct) : 0}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex gap-1.5 mt-1.5">
        {data.map((d, i) => {
          const isLast = highlightLast && i === data.length - 1;
          return (
            <div
              key={i}
              className={cn(
                'flex-1 text-[10px] text-center leading-none truncate',
                isLast ? 'font-semibold text-foreground' : 'text-muted-foreground'
              )}
            >
              {d.label}
            </div>
          );
        })}
      </div>
    </div>
  );
}
