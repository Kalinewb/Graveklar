import { Pill, type PillTone } from './Pill';

export type BookingStatus = 'pending' | 'confirmed' | 'active' | 'completed' | 'cancelled';

const LABEL: Record<BookingStatus, string> = {
  pending: 'Venter på betaling',
  confirmed: 'Bekreftet',
  active: 'Pågående',
  completed: 'Fullført',
  cancelled: 'Avbestilt',
};

const TONE: Record<BookingStatus, PillTone> = {
  pending: 'amber',
  confirmed: 'blue',
  active: 'emerald',
  completed: 'slate',
  cancelled: 'rose',
};

export function StatusBadge({ status }: { status: BookingStatus }) {
  return <Pill tone={TONE[status]}>{LABEL[status]}</Pill>;
}
