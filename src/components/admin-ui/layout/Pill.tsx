import { cn } from '@/lib/utils';

export type PillTone = 'slate' | 'amber' | 'blue' | 'emerald' | 'rose' | 'violet';

const TONE_CLASSES: Record<PillTone, string> = {
  slate:   'bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-500/20',
  amber:   'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20',
  blue:    'bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/20',
  emerald: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20',
  rose:    'bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/20',
  violet:  'bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/20',
};

export function Pill({
  children, tone = 'slate', className,
}: { children: React.ReactNode; tone?: PillTone; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium border',
        TONE_CLASSES[tone],
        className
      )}
    >
      {children}
    </span>
  );
}
