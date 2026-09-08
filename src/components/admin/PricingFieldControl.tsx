'use client';

import { Stepper, Slider, Toggle, SegmentedControl } from '@/components/admin-ui';

// PricingConfig values are stored as numbers (vs AppConfig strings), so this
// uses a separate mapper from `ConfigFieldControl`. Per-key overrides are
// driven by suffix/prefix conventions established by the rest of the app.

export interface PricingField {
  key: string;
  value: number;
  label: string;
  group: string;
}

// Keys where the value is a 0/1 boolean stored as number.
const NUMERIC_BOOLEAN_KEYS = new Set<string>([
  'pricesIncludeMva',
]);

// Keys where a Slider is more useful than a Stepper.
const SLIDER_KEYS: Record<string, { min: number; max: number; marks: number[] }> = {
  mvaRate: { min: 0, max: 50, marks: [0, 25, 50] },
};

function unitFor(key: string): string {
  if (
    key.includes('Price') || key.includes('Fee') || key.includes('deposit') ||
    key.includes('Rate') || key.includes('PerKm') || key.includes('Hourly') ||
    key === 'overtimeRate' || key === 'preOrderHourRate'
  ) {
    return 'kr';
  }
  if (key.includes('Percent')) return '%';
  if (key.includes('Hours')) return 'timer';
  if (key.includes('Radius') || key === 'deliveryIncludedKm') return 'km';
  return '';
}

export function PricingFieldControl({
  field, current, onChange,
}: {
  field: PricingField;
  current: number;
  onChange: (next: number) => void;
}) {
  // Boolean-as-number → Toggle (presents the right control even though the
  // underlying storage is numeric).
  if (NUMERIC_BOOLEAN_KEYS.has(field.key)) {
    return (
      <Toggle
        value={current > 0}
        onChange={(v) => onChange(v ? 1 : 0)}
        labelOn="Inkl. MVA"
        labelOff="Eks. MVA"
      />
    );
  }

  // Sliders for bounded percents.
  const slider = SLIDER_KEYS[field.key];
  if (slider) {
    return (
      <Slider
        value={current}
        onChange={onChange}
        min={slider.min}
        max={slider.max}
        marks={slider.marks}
      />
    );
  }

  // Currency-class numbers: step by 50; integer counts: step by 1.
  const unit = unitFor(field.key);
  const step =
    field.key.includes('Radius') || field.key.includes('Hours') || field.key === 'deliveryIncludedKm'
      ? 1
      : 50;

  return (
    <Stepper
      value={current}
      onChange={onChange}
      min={0}
      step={step}
      unit={unit}
    />
  );
}
