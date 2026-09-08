/** Local calendar date as YYYY-MM-DD (avoids UTC shift from toISOString). */
export function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseDateStr(dateStr: string): Date {
  return new Date(dateStr + 'T12:00:00');
}

export function todayStr(): string {
  return toDateStr(new Date());
}

export function isFriday(dateStr: string): boolean {
  return parseDateStr(dateStr).getDay() === 5;
}

export function isWeekday(dateStr: string): boolean {
  const day = parseDateStr(dateStr).getDay();
  return day >= 1 && day <= 4;
}

export function addDays(dateStr: string, days: number): string {
  const d = parseDateStr(dateStr);
  d.setDate(d.getDate() + days);
  return toDateStr(d);
}
