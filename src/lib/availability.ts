import type { RentalType } from '@/lib/pricing';
import { addDays, toDateStr } from '@/lib/dates';

export function rentalDayCount(
  rentalType: RentalType,
  customDays?: number | null
): number {
  switch (rentalType) {
    case 'day':
      return 1;
    case 'weekend':
      return 3;
    case 'week':
      // Multi-week support: the booking form's week stepper (HomePage.tsx
      // ~line 1668) lets a customer pick 1..8 weeks and passes
      // `customDays = weekCount * 7`. Honor that here so the date-range +
      // slot locks span the full rental — otherwise the customer thinks
      // they reserved 2 weeks but only block 7 days. Defend against
      // garbage: require a positive multiple of 7, else default to 7.
      if (customDays && customDays > 0 && customDays % 7 === 0) return customDays;
      return 7;
    case 'custom':
      return customDays && customDays > 0 ? customDays : 2;
    default:
      return 1;
  }
}

/** Inclusive list of YYYY-MM-DD dates occupied by a booking. */
export function getRentalDateRange(
  startDateStr: string,
  rentalType: RentalType,
  customDays?: number | null
): string[] {
  const numDays = rentalDayCount(rentalType, customDays);
  const dates: string[] = [];
  for (let i = 0; i < numDays; i++) {
    dates.push(addDays(startDateStr, i));
  }
  return dates;
}

export function dateToDbMidnight(dateStr: string): Date {
  return new Date(dateStr + 'T00:00:00');
}

export function dbDateToStr(date: Date): string {
  return toDateStr(date);
}

