import { describe, it, expect } from 'vitest';
import {
  parseChecklistData,
  isMetaKey,
  filterPhasesForBooking,
  isItemFilled,
  countChecklistProgress,
  findCompletionTriggerPhase,
  isCompletionPhaseDone,
  findPrepPhaseIndex,
  type ChecklistPhaseLike,
} from '@/lib/checklist';

const item = (id: string, answerType = 'checkbox', isActive = true) => ({
  id,
  answerType,
  isActive,
});

const phase = (
  id: string,
  name: string,
  items: ReturnType<typeof item>[],
  opts: Partial<ChecklistPhaseLike> = {},
): ChecklistPhaseLike => ({
  id,
  name,
  items,
  isActive: true,
  appliesTo: 'all',
  ...opts,
});

describe('parseChecklistData', () => {
  it('returns {} for null/undefined/empty', () => {
    expect(parseChecklistData(null)).toEqual({});
    expect(parseChecklistData(undefined)).toEqual({});
    expect(parseChecklistData('')).toEqual({});
  });

  it('parses valid JSON object', () => {
    expect(parseChecklistData('{"a":1,"b":true}')).toEqual({ a: 1, b: true });
  });

  it('returns {} for invalid JSON', () => {
    expect(parseChecklistData('not-json')).toEqual({});
  });

  it('returns {} for non-object JSON', () => {
    expect(parseChecklistData('"hello"')).toEqual({});
    expect(parseChecklistData('[1,2]')).toEqual({});
  });
});

describe('isMetaKey', () => {
  it('detects keys starting with __', () => {
    expect(isMetaKey('__fuel-cans')).toBe(true);
    expect(isMetaKey('__anything')).toBe(true);
  });

  it('rejects normal item ids', () => {
    expect(isMetaKey('item-1')).toBe(false);
    expect(isMetaKey('_single')).toBe(false);
  });
});

describe('filterPhasesForBooking', () => {
  const phases = [
    phase('p1', 'All', [item('i1')], { appliesTo: 'all' }),
    phase('p2', 'Delivery', [item('i2')], { appliesTo: 'delivery' }),
    phase('p3', 'Self pickup', [item('i3')], { appliesTo: 'selfPickup' }),
    phase('p4', 'Inactive', [item('i4')], { isActive: false }),
  ];

  it('filters inactive phases', () => {
    const result = filterPhasesForBooking(phases, { selfPickup: false });
    expect(result.map((p) => p.id)).not.toContain('p4');
  });

  it('shows delivery-only phases for delivery bookings', () => {
    const result = filterPhasesForBooking(phases, { selfPickup: false });
    expect(result.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('shows selfPickup-only phases for self-pickup bookings', () => {
    const result = filterPhasesForBooking(phases, { selfPickup: true });
    expect(result.map((p) => p.id)).toEqual(['p1', 'p3']);
  });

  it('defaults appliesTo to all', () => {
    const noApplies = [phase('x', 'X', [item('i')], { appliesTo: undefined })];
    expect(filterPhasesForBooking(noApplies, { selfPickup: true })).toHaveLength(1);
  });
});

describe('isItemFilled', () => {
  it('checkbox requires true', () => {
    expect(isItemFilled({ answerType: 'checkbox' }, true)).toBe(true);
    expect(isItemFilled({ answerType: 'checkbox' }, false)).toBe(false);
    expect(isItemFilled({ answerType: 'checkbox' }, undefined)).toBe(false);
  });

  it('photo requires non-empty string', () => {
    expect(isItemFilled({ answerType: 'photo' }, '/uploads/x.jpg')).toBe(true);
    expect(isItemFilled({ answerType: 'photo' }, '')).toBe(false);
    expect(isItemFilled({ answerType: 'photo' }, true)).toBe(false);
  });

  it('other types require non-empty value', () => {
    expect(isItemFilled({ answerType: 'text' }, 'hello')).toBe(true);
    expect(isItemFilled({ answerType: 'number' }, 42)).toBe(true);
    expect(isItemFilled({ answerType: 'text' }, '')).toBe(false);
    expect(isItemFilled({ answerType: 'text' }, undefined)).toBe(false);
    expect(isItemFilled({ answerType: 'text' }, false)).toBe(false);
  });
});

describe('countChecklistProgress', () => {
  const phases = [
    phase('prep', 'Klargjør', [
      item('a', 'checkbox'),
      item('b', 'text'),
      item('inactive', 'checkbox', false),
    ]),
  ];

  it('counts filled items across applicable phases', () => {
    const data = { a: true, b: 'ok' };
    expect(countChecklistProgress(phases, data, { selfPickup: false })).toEqual({
      done: 2,
      total: 2,
    });
  });

  it('optionally includes fuel synthetic item', () => {
    const data = { a: true, b: '' };
    expect(
      countChecklistProgress(phases, data, { selfPickup: false }, { includeFuel: true, fuelDone: true }),
    ).toEqual({ done: 2, total: 3 });
    expect(
      countChecklistProgress(phases, data, { selfPickup: false }, { includeFuel: true, fuelDone: false }),
    ).toEqual({ done: 1, total: 3 });
  });
});

describe('findCompletionTriggerPhase', () => {
  const phases = [
    phase('prep', 'Klargjør', [item('i1')]),
    phase('retur', 'Retur', [item('i2')], { isCompletionTrigger: false }),
    phase('pickup', 'Henting', [item('i3')], { appliesTo: 'selfPickup' }),
  ];

  it('prefers explicit isCompletionTrigger flag', () => {
    const withFlag = [
      ...phases,
      phase('custom', 'Whatever', [item('i4')], { isCompletionTrigger: true }),
    ];
    expect(findCompletionTriggerPhase(withFlag, { selfPickup: false })?.id).toBe('custom');
  });

  it('falls back to legacy name regex', () => {
    expect(findCompletionTriggerPhase(phases, { selfPickup: false })?.id).toBe('retur');
  });

  it('respects booking variant filtering', () => {
    const deliveryOnly = [
      phase('d', 'Retur levering', [item('i')], { appliesTo: 'delivery' }),
      phase('s', 'Retur henting', [item('j')], { appliesTo: 'selfPickup' }),
    ];
    expect(findCompletionTriggerPhase(deliveryOnly, { selfPickup: true })?.id).toBe('s');
    expect(findCompletionTriggerPhase(deliveryOnly, { selfPickup: false })?.id).toBe('d');
  });

  it('returns null when no match', () => {
    const none = [phase('x', 'Klargjør', [item('i')])];
    expect(findCompletionTriggerPhase(none, { selfPickup: false })).toBeNull();
  });
});

describe('isCompletionPhaseDone', () => {
  const retur = phase('r', 'Retur', [
    item('cb', 'checkbox'),
    item('tx', 'text'),
    item('off', 'checkbox', false),
  ]);

  it('returns false when any active item is unfilled', () => {
    expect(isCompletionPhaseDone(retur, { cb: true, tx: '' })).toBe(false);
  });

  it('returns true when all active items are filled', () => {
    expect(isCompletionPhaseDone(retur, { cb: true, tx: 'done' })).toBe(true);
  });

  it('returns false when phase has no active items', () => {
    const empty = phase('e', 'Empty', [item('x', 'checkbox', false)]);
    expect(isCompletionPhaseDone(empty, {})).toBe(false);
  });
});

describe('findPrepPhaseIndex', () => {
  it('finds klargjør/forbered/prep phase among active phases', () => {
    const phases = [
      phase('a', 'Start', [item('i1')], { isActive: false }),
      phase('b', 'Levering', [item('i2')]),
      phase('c', 'Klargjøring', [item('i3')]),
    ];
    expect(findPrepPhaseIndex(phases)).toBe(1);
  });

  it('returns 0 when no prep name match', () => {
    const phases = [
      phase('a', 'Levering', [item('i1')]),
      phase('b', 'Retur', [item('i2')]),
    ];
    expect(findPrepPhaseIndex(phases)).toBe(0);
  });

  it('matches prep keyword case-insensitively', () => {
    const phases = [phase('a', 'PREP', [item('i')])];
    expect(findPrepPhaseIndex(phases)).toBe(0);
  });
});
