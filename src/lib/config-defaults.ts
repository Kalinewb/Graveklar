export interface ConfigItem {
  key: string;
  value: number;
  label: string;
  group: string;
}

export const DEFAULT_CONFIGS: ConfigItem[] = [
  // ── Priser (rental) ───────────────────────────────────
  // Prices are computed from three hourly rates × the included-hours for
  // each tier. `weekdayHourly` and `weekendHourly` are also used for the
  // "custom" tier (day-by-day calculation respects which weekday it is).
  { key: 'weekdayHourly', value: 249, label: 'Timepris hverdag (man–fre)', group: 'rental' },
  { key: 'weekendHourly', value: 329, label: 'Timepris helg (lør–søn)', group: 'rental' },
  { key: 'weeklyHourly',  value: 214, label: 'Timepris uke', group: 'rental' },
  { key: 'dayIncludedHours',     value: 10, label: 'Timer inkludert (1 dag)',  group: 'rental' },
  { key: 'weekendIncludedHours', value: 20, label: 'Timer inkludert (helg)',   group: 'rental' },
  { key: 'weekIncludedHours',    value: 56, label: 'Timer inkludert (1 uke)',  group: 'rental' },
  // customHoursPerDay removed — was always identical to dayIncludedHours,
  // and a custom-length rental should use the same per-day hour budget as
  // a 1-day rental. Single source of truth.

  // ── MVA ─────────────────────────────────────────────
  // mvaRate is the percentage (e.g. 25 for 25 %). pricesIncludeMva = 1
  // means the values entered in this tab are already mva-inclusive (the
  // historical default); 0 means they are ex mva and mva is added on top.
  { key: 'mvaRate',           value: 25, label: 'MVA-sats (%)',                                group: 'tax' },
  { key: 'pricesIncludeMva',  value: 1,  label: 'Lagrede priser inkluderer MVA (0 = ex mva)', group: 'tax' },
  // NOTE: `dayPrice`, `weekendPrice`, `weekPrice` are no longer stored —
  // they're computed from the hourly rate × the included-hours for the
  // corresponding tier. Per-machine overrides (Machine.dayPrice etc.)
  // still take precedence when set on an individual machine.
  // NOTE: `minBookingDaysAhead` moved to AppConfig group='booking'.

  // ── Timer ─────────────────────────────────────────────
  { key: 'overtimeRate', value: 199, label: 'Overtidspris (kr/time)', group: 'hours' },
  { key: 'preOrderHourRate', value: 179, label: 'Forbestilt timepris (kr/time)', group: 'hours' },

  // ── Levering ──────────────────────────────────────────
  { key: 'deliveryPerKm', value: 25, label: 'Pris per km (utover inkludert)', group: 'delivery' },
  { key: 'deliveryIncludedKm', value: 30, label: 'Inkludert avstand (km)', group: 'delivery' },
  { key: 'minDeliveryFee', value: 0, label: 'Minimumsgebyr (kr)', group: 'delivery' },
  { key: 'maxDeliveryRadius', value: 150, label: 'Maks leveringsavstand (km)', group: 'delivery' },
];

export const DEFAULT_CONFIG: Record<string, number> = Object.fromEntries(
  DEFAULT_CONFIGS.map((c) => [c.key, c.value])
);
