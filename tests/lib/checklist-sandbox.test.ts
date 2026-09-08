import { describe, expect, it } from 'vitest';
import {
  buildSandboxBooking,
  buildSandboxFlowSummary,
  buildSandboxRenterPhases,
  canLockOperatorPhase,
  sandboxDateRange,
  sandboxPresetLasteSelvhenting,
  sandboxSimulatedNow,
  sandboxSubmissionKey,
} from '@/lib/checklist-sandbox';
import { filterPhasesForBooking } from '@/lib/checklist';
import { toDateStr } from '@/lib/dates';
import { isRenterPhaseAvailable } from '@/lib/renter-checklist';

const phases = [
  {
    id: 'prep',
    name: 'Forberedelse',
    audience: 'operator',
    intervalMode: 'once',
    appliesTo: 'all',
    isActive: true,
    items: [],
  },
  {
    id: 'lever',
    name: 'Levering',
    audience: 'operator',
    intervalMode: 'once',
    appliesTo: 'delivery',
    isActive: true,
    items: [],
  },
  {
    id: 'selvhent',
    name: 'Selvhenting',
    audience: 'operator',
    intervalMode: 'once',
    appliesTo: 'selfPickup',
    isActive: true,
    items: [],
  },
  {
    id: 'laste',
    name: 'Laste og sikring',
    audience: 'split',
    intervalMode: 'return',
    appliesTo: 'all',
    isActive: true,
    items: [],
  },
  {
    id: 'daily',
    name: 'Daglig kontroll',
    audience: 'renter',
    intervalMode: 'daily',
    appliesTo: 'all',
    isActive: true,
    items: [],
  },
];

const lastePhase = phases[3]!;
const leveringPhase = phases[1]!;
const dailyPhase = phases[4]!;

describe('checklist-sandbox', () => {
  it('laste selvhenting preset unlocks on same day when handover is complete', () => {
    const { config, handoverComplete } = sandboxPresetLasteSelvhenting();
    expect(handoverComplete).toBe(true);

    const operatorData = { [`__phase_locked_${phases[2]!.id}`]: true };
    const booking = buildSandboxBooking(config, operatorData);
    const now = sandboxSimulatedNow(config);

    const availability = isRenterPhaseAvailable(lastePhase, booking, phases, now);
    expect(availability.available).toBe(true);
  });

  it('blocks renter phases before handover', () => {
    const config = sandboxPresetLasteSelvhenting().config;
    const booking = buildSandboxBooking(config, {});
    const views = buildSandboxRenterPhases(phases, booking, config, new Set());

    const daily = views.find((v) => v.id === dailyPhase.id);
    expect(daily?.available).toBe(false);
    expect(daily?.lockedReason).toContain('henting');
  });

  it('requires prior operator phases before lock', () => {
    const operatorPhases = filterPhasesForBooking(phases, { selfPickup: false }, { audience: 'operator' });
    expect(canLockOperatorPhase(leveringPhase.id, operatorPhases, {})).toBe(false);
    expect(
      canLockOperatorPhase(leveringPhase.id, operatorPhases, { [`__phase_locked_${phases[0]!.id}`]: true }),
    ).toBe(true);
  });

  it('tracks renter submissions per interval key', () => {
    const config = sandboxPresetLasteSelvhenting().config;
    const booking = buildSandboxBooking(config, { [`__phase_locked_${phases[2]!.id}`]: true });
    const viewsBefore = buildSandboxRenterPhases(phases, booking, config, new Set());
    const daily = viewsBefore.find((v) => v.id === dailyPhase.id);
    expect(daily).toBeDefined();
    const key = sandboxSubmissionKey(daily!.id, daily!.intervalKey);
    const viewsAfter = buildSandboxRenterPhases(phases, booking, config, new Set([key]));
    expect(viewsAfter.find((v) => v.id === dailyPhase.id)?.submitted).toBe(true);
  });

  it('multi_day range has three simulated days', () => {
    const range = sandboxDateRange({ rentalPreset: 'multi_day' });
    expect(range).toHaveLength(3);
    expect(toDateStr(sandboxSimulatedNow({ rentalPreset: 'multi_day', selfPickup: true, dayIndex: 2 }))).toBe(
      range[2],
    );
  });

  it('flow summary explains blocked renter QR', () => {
    const config = sandboxPresetLasteSelvhenting().config;
    const booking = buildSandboxBooking(config, {});
    const views = buildSandboxRenterPhases(phases, booking, config, new Set());
    const summary = buildSandboxFlowSummary(phases, booking, config, views);
    expect(summary.handoverComplete).toBe(false);
    expect(summary.hint).toContain('Selvhenting');
  });
});
