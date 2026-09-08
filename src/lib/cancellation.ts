// Pure utilities for the cancellation cutoff (no DB or server-only imports).
// Safe to import from client components.

export function getCancelFreeHours(config: Record<string, string>): number {
  const weeks = Number(config['cancelFreeWeeks'] ?? '0') || 0;
  const days = Number(config['cancelFreeDays'] ?? '0') || 0;
  return weeks * 168 + days * 24;
}

/** The same window as whole calendar days — what the label actually promises. */
export function getCancelFreeDays(config: Record<string, string>): number {
  const weeks = Number(config['cancelFreeWeeks'] ?? '0') || 0;
  const days = Number(config['cancelFreeDays'] ?? '0') || 0;
  return weeks * 7 + days;
}

/**
 * The last instant at which cancelling is still free: local midnight of the
 * rental's start day, minus the configured window counted in **calendar**
 * days (`setDate`, so an Oslo day that is 23 or 25 hours long still counts as
 * one day).
 *
 * Measuring the window as a fixed number of elapsed hours instead made
 * "2 dager før" mean 47 real hours when the spring transition sat inside it —
 * the customer was charged the late fee at a wall-clock moment the policy
 * label said was free — and 49 hours across the autumn transition. Same
 * config, same lead time, free in June and 1 245 kr in March.
 */
export function getCancelFreeCutoff(startDateStr: string, config: Record<string, string>): Date {
  const cutoff = new Date(startDateStr + 'T00:00:00');
  cutoff.setDate(cutoff.getDate() - getCancelFreeDays(config));
  return cutoff;
}

export interface CancellationPolicy {
  /** 0 = free, otherwise the percentage of `basePrice` to charge. */
  feePercent: number;
  /** Last free instant (local). Cancelling exactly at it is still free. */
  cutoff: Date;
  /** Elapsed hours until the rental starts — presentation only. */
  hoursUntil: number;
}

/**
 * Single source of truth for "what does cancelling cost right now", shared by
 * `updateBookingStatus` (which writes the fee) and the `/api/booking/cancel`
 * preview (which promises it). Two copies of this rule is how a customer gets
 * quoted 0 kr and charged 1 245 kr.
 */
export function evaluateCancellationPolicy(
  startDateStr: string,
  config: Record<string, string>,
  now: Date = new Date(),
): CancellationPolicy {
  const latePercent = Number(config['cancelLatePercent'] || '50');
  const sameDayPercent = Number(config['cancelSameDayPercent'] || '100');

  const start = new Date(startDateStr + 'T00:00:00');
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const cutoff = getCancelFreeCutoff(startDateStr, config);

  let feePercent = 0;
  if (start <= todayMidnight) {
    feePercent = sameDayPercent;
  } else if (now.getTime() > cutoff.getTime()) {
    feePercent = latePercent;
  }

  return {
    feePercent,
    cutoff,
    hoursUntil: (start.getTime() - now.getTime()) / (1000 * 60 * 60),
  };
}

export function getCancelFreeLabel(config: Record<string, string>): string {
  const weeks = Number(config['cancelFreeWeeks'] ?? '0') || 0;
  const days = Number(config['cancelFreeDays'] ?? '0') || 0;
  const parts: string[] = [];
  if (weeks > 0) parts.push(`${weeks} uke${weeks > 1 ? 'r' : ''}`);
  if (days > 0) parts.push(`${days} dag${days > 1 ? 'er' : ''}`);
  if (parts.length === 0) return '0 timer';
  return parts.join(' og ');
}
