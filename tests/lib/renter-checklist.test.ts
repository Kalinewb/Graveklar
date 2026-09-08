import { describe, it, expect } from 'vitest';
import {
  getBookingRentalBounds,
  isBookingActiveForRenterChecklist,
  rentalDayNumber,
  computeIntervalInfo,
  filterRenterPhases,
  formatStoredIntervalLabel,
  isSubmissionComplete,
  isRenterPhaseAvailable,
} from '@/lib/renter-checklist';
import { filterPhasesForBooking } from '@/lib/checklist';
import type { ChecklistPhaseLike } from '@/lib/checklist';

const baseBooking = {
  status: 'confirmed' as const,
  fullyPaidAt: new Date('2026-06-01'),
  startDate: new Date('2026-06-10'),
  rentalType: 'day',
  customDays: null,
  selfPickup: false,
};

describe('getBookingRentalBounds', () => {
  it('returns single day for day rental', () => {
    const b = getBookingRentalBounds(baseBooking);
    expect(b.startDate).toBe('2026-06-10');
    expect(b.endDate).toBe('2026-06-10');
    expect(b.totalDays).toBe(1);
  });
});

describe('isBookingActiveForRenterChecklist', () => {
  it('rejects unpaid bookings', () => {
    expect(isBookingActiveForRenterChecklist({
      ...baseBooking,
      fullyPaidAt: null,
    }, new Date('2026-06-10T12:00:00'))).toBe(false);
  });

  it('accepts confirmed paid booking on rental day', () => {
    expect(isBookingActiveForRenterChecklist(baseBooking, new Date('2026-06-10T12:00:00'))).toBe(true);
  });

  it('rejects after rental ends', () => {
    expect(isBookingActiveForRenterChecklist(baseBooking, new Date('2026-06-11T12:00:00'))).toBe(false);
  });
});

describe('computeIntervalInfo', () => {
  it('once mode uses fixed key', () => {
    const info = computeIntervalInfo({ intervalMode: 'once' }, baseBooking);
    expect(info.key).toBe('once');
  });

  it('daily mode uses date key', () => {
    const info = computeIntervalInfo({ intervalMode: 'daily' }, baseBooking, new Date('2026-06-10T15:00:00'));
    expect(info.key).toBe('day-2026-06-10');
    expect(info.label).toContain('Dag 1');
  });

  it('hours mode uses slot key', () => {
    const info = computeIntervalInfo({ intervalMode: 'hours', intervalHours: 8 }, baseBooking, new Date('2026-06-10T15:00:00'));
    expect(info.key).toMatch(/^h\d+$/);
  });

  it('return mode uses fixed return key', () => {
    const info = computeIntervalInfo({ intervalMode: 'return' }, baseBooking);
    expect(info.key).toBe('return');
    expect(info.label).toBe('Ved retur');
  });
});

describe('filterRenterPhases', () => {
  const phases: ChecklistPhaseLike[] = [
    { id: '1', name: 'Op', items: [], audience: 'operator' },
    { id: '2', name: 'Ren', items: [], audience: 'renter', appliesTo: 'all' },
    { id: '3', name: 'Del', items: [], audience: 'renter', appliesTo: 'delivery' },
    { id: '4', name: 'Laste', items: [], audience: 'split', appliesTo: 'all' },
  ];

  it('returns only renter phases matching booking type', () => {
    const r = filterRenterPhases(phases, { selfPickup: false });
    expect(r.map((p) => p.id)).toEqual(['2', '3']);
  });

  it('excludes delivery-only for self pickup', () => {
    const r = filterRenterPhases(phases, { selfPickup: true });
    expect(r.map((p) => p.id)).toEqual(['2', '4']);
  });
});

describe('filterPhasesForBooking operator default', () => {
  it('excludes renter phases for operator UI', () => {
    const phases: ChecklistPhaseLike[] = [
      { id: '1', name: 'Op', items: [], audience: 'operator' },
      { id: '2', name: 'Ren', items: [], audience: 'renter' },
    ];
    expect(filterPhasesForBooking(phases, { selfPickup: false }).map((p) => p.id)).toEqual(['1']);
  });

  it('includes split phases for delivery, excludes for self pickup', () => {
    const phases: ChecklistPhaseLike[] = [
      { id: '1', name: 'Laste', items: [], audience: 'split' },
    ];
    expect(filterPhasesForBooking(phases, { selfPickup: false }).map((p) => p.id)).toEqual(['1']);
    expect(filterPhasesForBooking(phases, { selfPickup: true }).map((p) => p.id)).toEqual([]);
  });
});

describe('isSubmissionComplete', () => {
  it('requires all active items filled', () => {
    const p: ChecklistPhaseLike = {
      id: '1', name: 'T', items: [
        { id: 'a', answerType: 'checkbox', isActive: true },
        { id: 'b', answerType: 'text', isActive: true },
      ],
    };
    expect(isSubmissionComplete(p, { a: true })).toBe(false);
    expect(isSubmissionComplete(p, { a: true, b: 'ok' })).toBe(true);
  });
});

describe('isRenterPhaseAvailable', () => {
  const returnPhase: ChecklistPhaseLike = {
    id: 'laste',
    name: 'Laste og sikring',
    items: [],
    audience: 'split',
    intervalMode: 'return',
  };

  const dailyPhase: ChecklistPhaseLike = {
    id: 'vedlikehold',
    name: 'Vedlikehold',
    items: [],
    audience: 'renter',
    intervalMode: 'daily',
  };

  const handoverPhase: ChecklistPhaseLike = {
    id: 'lever',
    name: 'Levering',
    items: [],
    audience: 'operator',
    intervalMode: 'once',
  };

  const allPhases = [handoverPhase, dailyPhase, returnPhase];

  it('blocks all renter phases until handover is complete', () => {
    const booking = {
      ...baseBooking,
      checklistData: JSON.stringify({}),
    };
    const r = isRenterPhaseAvailable(dailyPhase, booking, allPhases, new Date('2026-06-10T12:00:00'));
    expect(r.available).toBe(false);
    expect(r.reason).toContain('levering');
  });

  it('allows renter phases after handover is locked', () => {
    const booking = {
      ...baseBooking,
      checklistData: JSON.stringify({ [`__phase_locked_${handoverPhase.id}`]: true }),
    };
    const r = isRenterPhaseAvailable(dailyPhase, booking, allPhases, new Date('2026-06-10T12:00:00'));
    expect(r.available).toBe(true);
  });

  it('blocks return phase before end date', () => {
    const booking = {
      ...baseBooking,
      selfPickup: true,
      startDate: new Date('2026-06-10'),
      rentalType: 'week',
      customDays: null,
      checklistData: JSON.stringify({ [`__phase_locked_${handoverPhase.id}`]: true }),
    };
    const r = isRenterPhaseAvailable(returnPhase, booking, allPhases, new Date('2026-06-12T12:00:00'));
    expect(r.available).toBe(false);
    expect(r.reason).toContain('retur');
  });

  it('allows return phase on end date', () => {
    const booking = {
      ...baseBooking,
      selfPickup: true,
      startDate: new Date('2026-06-10'),
      rentalType: 'week',
      customDays: null,
      checklistData: JSON.stringify({ [`__phase_locked_${handoverPhase.id}`]: true }),
    };
    const r = isRenterPhaseAvailable(returnPhase, booking, allPhases, new Date('2026-06-16T12:00:00'));
    expect(r.available).toBe(true);
  });
});

describe('formatStoredIntervalLabel', () => {
  it('labels once, return and daily keys', () => {
    expect(formatStoredIntervalLabel({ intervalMode: 'once' }, 'once')).toBe('Engangskontroll');
    expect(formatStoredIntervalLabel({ intervalMode: 'return' }, 'return')).toBe('Ved retur');
    expect(formatStoredIntervalLabel({ intervalMode: 'daily' }, 'day-2026-06-10')).toContain('Dag');
  });
});

describe('rentalDayNumber', () => {
  it('returns 1 on first rental day', () => {
    expect(rentalDayNumber(baseBooking, new Date('2026-06-10T12:00:00'))).toBe(1);
  });
});
