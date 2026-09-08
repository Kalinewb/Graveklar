import { cn } from '@/lib/utils';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

type Tone = 'amber' | 'blue' | 'emerald' | 'violet' | 'rose' | 'slate' | 'primary';

const TONE_CLASSES: Record<Tone, string> = {
  amber:   'bg-amber-500/10 text-amber-600',
  blue:    'bg-blue-500/10 text-blue-600',
  emerald: 'bg-emerald-500/10 text-emerald-600',
  violet:  'bg-violet-500/10 text-violet-600',
  rose:    'bg-rose-500/10 text-rose-600',
  slate:   'bg-slate-500/10 text-slate-600',
  primary: 'bg-primary/10 text-primary',
};

export function StatCard({
  Icon, tone, value, label, sub, trend, delta, className, onClick, size = 'md',
}: {
  Icon: React.ElementType;
  tone: Tone;
  value: string;
  label: string;
  sub?: string;
  trend?: 'up' | 'down' | null;
  /** Optional short delta shown next to the trend arrow, e.g. "+12 %". */
  delta?: string;
  className?: string;
  /** When supplied the card behaves as a button + shows a subtle hover state. */
  onClick?: () => void;
  size?: 'sm' | 'md';
}) {
  const sm = size === 'sm';
  const inner = (
    <CardContent className={sm ? 'p-3' : 'p-4'}>
      <div className="flex items-center justify-between gap-2">
        <div className={cn(
          'rounded-xl flex items-center justify-center shrink-0',
          sm ? 'w-8 h-8' : 'w-10 h-10',
          TONE_CLASSES[tone]
        )}>
          <Icon className={sm ? 'w-4 h-4' : 'w-5 h-5'} />
        </div>
        {trend && (
          <div className={cn(
            'flex items-center gap-0.5 font-semibold tabular-nums shrink-0',
            sm ? 'text-[11px]' : 'text-xs',
            trend === 'up' ? 'text-emerald-600' : 'text-rose-600'
          )}>
            {trend === 'up'
              ? <TrendingUp className={sm ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
              : <TrendingDown className={sm ? 'w-3.5 h-3.5' : 'w-4 h-4'} />}
            {delta && <span>{delta}</span>}
          </div>
        )}
      </div>
      <div className={sm ? 'mt-2' : 'mt-3'}>
        <div className={cn('font-bold leading-none tabular-nums', sm ? 'text-xl' : 'text-2xl')}>{value}</div>
        <div className={cn('text-muted-foreground mt-1 leading-tight', sm ? 'text-[11px]' : 'text-xs')}>{label}</div>
        {sub && (
          <div className={cn(
            'text-muted-foreground/80 border-t border-border/50',
            sm ? 'text-[10px] mt-1 pt-1' : 'text-[11px] mt-1.5 pt-1.5'
          )}>{sub}</div>
        )}
      </div>
    </CardContent>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'text-left rounded-xl border border-border bg-card text-card-foreground shadow-sm',
          'hover:border-primary/40 hover:shadow-md transition-all cursor-pointer',
          'focus:outline-none focus:ring-2 focus:ring-primary/30',
          className
        )}
      >
        {inner}
      </button>
    );
  }
  return <Card className={className}>{inner}</Card>;
}
