/**
 * L1 — branch coverage for src/lib/checklist.ts and the `computeIntervalInfo`
 * hours-mode math in src/lib/renter-checklist.ts that tests/lib/checklist.test.ts
 * and tests/lib/renter-checklist.test.ts don't reach: yesno vs checkbox
 * filledness, conditional items whose controlling item is inactive or gone,
 * split-audience flipping, the hours interval anchor before 07:00 and across
 * midnight, additional legacy-regex completion-phase names, and the
 * statistics/numeric-parsing helpers.
 */
import { describe, it, expect } from 'vitest';
import {
  isItemFilled,
  isConditionMet,
  isItemActive,
  isOperatorChecklistComplete,
  resolvePhaseAudience,
  findCompletionTriggerPhase,
  computeChecklistStats,
  parseNumericAnswer,
  formatChecklistAnswerValue,
  formatStatNumber,
  type ChecklistItemLike,
} from '@/lib/checklist';
import { computeIntervalInfo, filterRenterPhases, hoursUntilNextInterval } from '@/lib/renter-checklist';

const baseBooking = {
  startDate: new Date('2026-06-10'),
  rentalType: 'day' as const,
  customDays: null as number | null,
};

describe('isItemFilled — yesno vs checkbox', () => {
  it('yesno counts both true and false as filled', () => {
    expect(isItemFilled({ answerType: 'yesno' }, true)).toBe(true);
    expect(isItemFilled({ answerType: 'yesno' }, false)).toBe(true);
  });

  it('yesno with no answer yet is not filled', () => {
    expect(isItemFilled({ answerType: 'yesno' }, undefined)).toBe(false);
    expect(isItemFilled({ answerType: 'yesno' }, null)).toBe(false);
    expect(isItemFilled({ answerType: 'yesno' }, '')).toBe(false);
  });

  it('checkbox false is NOT filled (unlike yesno false)', () => {
    expect(isItemFilled({ answerType: 'checkbox' }, false)).toBe(false);
    expect(isItemFilled({ answerType: 'checkbox' }, true)).toBe(true);
  });
});

describe('isItemFilled — photo with minPhotos', () => {
  it('requires at least minPhotos urls', () => {
    const item = { answerType: 'photo', minPhotos: 3 };
    expect(isItemFilled(item, ['a.jpg', 'b.jpg'])).toBe(false);
    expect(isItemFilled(item, ['a.jpg', 'b.jpg', 'c.jpg'])).toBe(true);
    expect(isItemFilled(item, ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'])).toBe(true);
  });

  it('defaults minPhotos to 1 when unset or zero', () => {
    expect(isItemFilled({ answerType: 'photo', minPhotos: 0 }, ['a.jpg'])).toBe(true);
    expect(isItemFilled({ answerType: 'photo' }, [])).toBe(false);
    expect(isItemFilled({ answerType: 'photo' }, 'legacy-single-url.jpg')).toBe(true);
  });
});

describe('isConditionMet / isItemActive — parent inactive or deleted', () => {
  const parent: ChecklistItemLike = { id: 'skader', answerType: 'yesno' };
  const child: ChecklistItemLike = { id: 'foto', answerType: 'photo', conditionItemId: 'skader', conditionValue: 'ja' };

  it('condition holds only when the parent answer matches', () => {
    expect(isConditionMet(child, { skader: true }, [parent, child])).toBe(true);
    expect(isConditionMet(child, { skader: false }, [parent, child])).toBe(false);
    expect(isConditionMet(child, {}, [parent, child])).toBe(false);
  });

  it('a deleted/missing controlling item does not trap the user — condition defaults to met', () => {
    // `pool` no longer contains the parent (e.g. an admin deleted it).
    expect(isConditionMet(child, { skader: false }, [child])).toBe(true);
    expect(isItemActive(child, { skader: false }, [child])).toBe(true);
  });

  it('an inactive-but-present parent item still gates the child by its stored value', () => {
    const inactiveParent: ChecklistItemLike = { ...parent, isActive: false };
    // isConditionMet only reads the parent's answerType + the data value, not
    // its own isActive flag — the child's visibility follows the parent's
    // last known answer even after the parent itself is deactivated.
    expect(isConditionMet(child, { skader: true }, [inactiveParent, child])).toBe(true);
    expect(isConditionMet(child, { skader: false }, [inactiveParent, child])).toBe(false);
  });

  it('isItemActive is false when the item itself is inactive, condition notwithstanding', () => {
    const inactiveChild: ChecklistItemLike = { ...child, isActive: false };
    expect(isItemActive(inactiveChild, { skader: true }, [parent, inactiveChild])).toBe(false);
  });

  it('non-checkbox/yesno parents compare the raw value case-insensitively, trimmed', () => {
    const textParent: ChecklistItemLike = { id: 'type', answerType: 'text' };
    const textChild: ChecklistItemLike = { id: 'detail', answerType: 'text', conditionItemId: 'type', conditionValue: 'Olje' };
    expect(isConditionMet(textChild, { type: '  olje  ' }, [textParent, textChild])).toBe(true);
    expect(isConditionMet(textChild, { type: 'diesel' }, [textParent, textChild])).toBe(false);
  });
});

describe('isOperatorChecklistComplete', () => {
  it('is true only when __locked is exactly true', () => {
    expect(isOperatorChecklistComplete({ __locked: true })).toBe(true);
    expect(isOperatorChecklistComplete({ __locked: 'true' })).toBe(false);
    expect(isOperatorChecklistComplete({})).toBe(false);
  });
});

describe('resolvePhaseAudience — split flips with selfPickup', () => {
  it('split → operator on delivery, renter on self-pickup', () => {
    expect(resolvePhaseAudience({ audience: 'split' }, { selfPickup: false })).toBe('operator');
    expect(resolvePhaseAudience({ audience: 'split' }, { selfPickup: true })).toBe('renter');
  });

  it('operator and renter audiences are unaffected by selfPickup', () => {
    expect(resolvePhaseAudience({ audience: 'operator' }, { selfPickup: true })).toBe('operator');
    expect(resolvePhaseAudience({ audience: 'renter' }, { selfPickup: false })).toBe('renter');
  });

  it('defaults to operator when audience is unset', () => {
    expect(resolvePhaseAudience({}, { selfPickup: true })).toBe('operator');
  });
});

describe('findCompletionTriggerPhase — legacy regex fallback, more names', () => {
  const item = (id: string) => ({ id, answerType: 'checkbox' });

  it('matches "Henting" (selvhenting return) by the hent/pickup regex', () => {
    const phases = [
      { id: 'p1', name: 'Klargjøring', items: [item('a')] },
      { id: 'p2', name: 'Henting', items: [item('b')] },
    ];
    expect(findCompletionTriggerPhase(phases, { selfPickup: true })?.id).toBe('p2');
  });

  it('matches an English "Return" name', () => {
    const phases = [
      { id: 'p1', name: 'Prep', items: [item('a')] },
      { id: 'p2', name: 'Return check', items: [item('b')] },
    ];
    expect(findCompletionTriggerPhase(phases, { selfPickup: false })?.id).toBe('p2');
  });

  it('an explicit isCompletionTrigger:false does not disable the name-regex fallback for a DIFFERENT phase', () => {
    const phases = [
      { id: 'p1', name: 'Retur', items: [item('a')], isCompletionTrigger: false },
      { id: 'p2', name: 'Ekstra', items: [item('b')] },
    ];
    expect(findCompletionTriggerPhase(phases, { selfPickup: false })?.id).toBe('p1');
  });
});

describe('computeIntervalInfo — hours mode edge cases', () => {
  it('before 07:00 on the start date, elapsed is clamped to 0 → slot 0', () => {
    const info = computeIntervalInfo(
      { intervalMode: 'hours', intervalHours: 8 },
      baseBooking,
      new Date('2026-06-10T05:30:00'),
    );
    expect(info.key).toBe('h0');
  });

  it('right at 07:00 is slot 0', () => {
    const info = computeIntervalInfo(
      { intervalMode: 'hours', intervalHours: 8 },
      baseBooking,
      new Date('2026-06-10T07:00:00'),
    );
    expect(info.key).toBe('h0');
  });

  it('carries the count across midnight without resetting', () => {
    // Start 2026-06-10T07:00; 20h later is 2026-06-11T03:00 → slot floor(20/8) = 2.
    const info = computeIntervalInfo(
      { intervalMode: 'hours', intervalHours: 8 },
      baseBooking,
      new Date('2026-06-11T03:00:00'),
    );
    expect(info.key).toBe('h2');
  });

  it('defaults to 24h slots when intervalHours is missing or non-positive', () => {
    const missing = computeIntervalInfo({ intervalMode: 'hours' }, baseBooking, new Date('2026-06-11T10:00:00'));
    expect(missing.key).toBe('h1'); // 27h elapsed / 24h slots = 1
    const zero = computeIntervalInfo({ intervalMode: 'hours', intervalHours: 0 }, baseBooking, new Date('2026-06-11T10:00:00'));
    expect(zero.key).toBe('h1');
  });
});

describe('parseNumericAnswer', () => {
  it('parses plain numbers and finite floats untouched', () => {
    expect(parseNumericAnswer(42)).toBe(42);
    expect(parseNumericAnswer(9.5)).toBe(9.5);
    expect(parseNumericAnswer(NaN)).toBeNull();
    expect(parseNumericAnswer(Infinity)).toBeNull();
  });

  it('tolerates Norwegian decimal commas and stray spaces', () => {
    expect(parseNumericAnswer('9,2')).toBe(9.2);
    expect(parseNumericAnswer(' 1 234,5 ')).toBe(1234.5);
  });

  it('returns null for empty or non-numeric strings', () => {
    expect(parseNumericAnswer('')).toBeNull();
    expect(parseNumericAnswer('   ')).toBeNull();
    expect(parseNumericAnswer('abc')).toBeNull();
  });

  it('returns null for non-string, non-number values', () => {
    expect(parseNumericAnswer(null)).toBeNull();
    expect(parseNumericAnswer(undefined)).toBeNull();
    expect(parseNumericAnswer(true)).toBeNull();
    expect(parseNumericAnswer(['9'])).toBeNull();
  });
});

describe('computeChecklistStats', () => {
  const phases = [
    { name: 'Levering', items: [
      { id: 'a', label: 'Timeteller', answerType: 'measurement', unit: 't', statKey: 'timeteller' },
      { id: 'b', label: 'Drivstoff', answerType: 'number', unit: 'L' },
    ] },
    { name: 'Retur', items: [
      { id: 'c', label: 'Timeteller', answerType: 'measurement', unit: 't', statKey: 'timeteller' },
      { id: 'd', label: 'Drivstoff', answerType: 'number', unit: 'L' },
    ] },
  ];

  it('pairs readings across phases by statKey and computes the delta', () => {
    const data = { a: '10,5', c: '14,2' };
    const stats = computeChecklistStats(phases, data);
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      key: 'timeteller', label: 'Timeteller', unit: 't',
      startValue: 10.5, endValue: 14.2, points: 2,
    });
    expect(stats[0].delta).toBeCloseTo(3.7, 5);
  });

  it('falls back to the normalized label when statKey is unset, grouping same-label items', () => {
    const data = { b: 20, d: 12 };
    const stats = computeChecklistStats(phases, data);
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ key: 'drivstoff', startValue: 20, endValue: 12, delta: -8 });
  });

  it('does not produce a row when only one phase supplied a value', () => {
    const stats = computeChecklistStats(phases, { a: '10' });
    expect(stats).toHaveLength(0);
  });

  it('ignores non-numeric answer types entirely', () => {
    const withText = [
      { name: 'Levering', items: [{ id: 'x', label: 'Kommentar', answerType: 'text' }] },
      { name: 'Retur', items: [{ id: 'y', label: 'Kommentar', answerType: 'text' }] },
    ];
    expect(computeChecklistStats(withText, { x: 'ok', y: 'ok' })).toHaveLength(0);
  });

  it('skips unparseable numeric answers rather than counting them as a point', () => {
    const stats = computeChecklistStats(phases, { a: 'not-a-number', c: '5' });
    expect(stats).toHaveLength(0);
  });
});

describe('filterRenterPhases — remaining branches', () => {
  it('excludes an inactive phase even if it is otherwise a matching renter phase', () => {
    const phases = [
      { id: '1', name: 'Ren', items: [], audience: 'renter' as const, isActive: false },
    ];
    expect(filterRenterPhases(phases, { selfPickup: true })).toEqual([]);
  });

  it('a selfPickup-only renter phase is excluded for a delivery booking', () => {
    const phases = [
      { id: '1', name: 'Ren', items: [], audience: 'renter' as const, appliesTo: 'selfPickup' },
    ];
    expect(filterRenterPhases(phases, { selfPickup: false })).toEqual([]);
    expect(filterRenterPhases(phases, { selfPickup: true }).map((p) => p.id)).toEqual(['1']);
  });
});

describe('hoursUntilNextInterval', () => {
  const hourly = { intervalMode: 'hours', intervalHours: 8 };

  it('is 0 for any mode other than "hours"', () => {
    expect(hoursUntilNextInterval({ intervalMode: 'once' }, baseBooking, new Date('2026-06-10T12:00:00'))).toBe(0);
    expect(hoursUntilNextInterval({ intervalMode: 'daily' }, baseBooking, new Date('2026-06-10T12:00:00'))).toBe(0);
  });

  it('is 0 in the first minute of a slot (due now)', () => {
    // Slot boundary is 07:00 + 8h = 15:00.
    expect(hoursUntilNextInterval(hourly, baseBooking, new Date('2026-06-10T15:00:30'))).toBe(0);
  });

  it('counts up the remaining whole hours until the next slot boundary', () => {
    // 07:00 + 2h = 09:00; next boundary at 15:00 → 6h remain.
    expect(hoursUntilNextInterval(hourly, baseBooking, new Date('2026-06-10T09:00:00'))).toBe(6);
  });
});

describe('formatChecklistAnswerValue', () => {
  it('renders checkbox/yesno as Ja/Nei', () => {
    expect(formatChecklistAnswerValue({ answerType: 'checkbox' }, true)).toBe('Ja');
    expect(formatChecklistAnswerValue({ answerType: 'checkbox' }, false)).toBe('Nei');
    expect(formatChecklistAnswerValue({ answerType: 'yesno' }, true)).toBe('Ja');
    expect(formatChecklistAnswerValue({ answerType: 'yesno' }, false)).toBe('Nei');
  });

  it('renders an unanswered yesno as an em dash, unlike checkbox', () => {
    expect(formatChecklistAnswerValue({ answerType: 'yesno' }, undefined)).toBe('—');
    // checkbox has no "unanswered" state distinct from false in this formatter.
    expect(formatChecklistAnswerValue({ answerType: 'checkbox' }, undefined)).toBe('Nei');
  });

  it('renders an empty/missing value for other types as an em dash', () => {
    expect(formatChecklistAnswerValue({ answerType: 'text' }, undefined)).toBe('—');
    expect(formatChecklistAnswerValue({ answerType: 'text' }, null)).toBe('—');
    expect(formatChecklistAnswerValue({ answerType: 'text' }, '')).toBe('—');
  });

  it('stringifies any other value as-is', () => {
    expect(formatChecklistAnswerValue({ answerType: 'number' }, 42)).toBe('42');
    expect(formatChecklistAnswerValue({ answerType: 'text' }, 'ok')).toBe('ok');
  });
});

describe('formatStatNumber', () => {
  it('formats with Norwegian comma decimals, max 2 fraction digits', () => {
    expect(formatStatNumber(10.5)).toBe('10,5');
    expect(formatStatNumber(1234)).toBe('1\u00a0234');
    expect(formatStatNumber(3.14159)).toBe('3,14');
  });
});
