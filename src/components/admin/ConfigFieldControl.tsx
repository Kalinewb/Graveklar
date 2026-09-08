'use client';

import {
  Toggle, Stepper, Slider, ColorPicker, PasswordField,
  TextInput, TextArea, PhoneInput, AddressAutocomplete,
  ImageDropzone, MachineDropdown, ChipMultiSelect, WeekdayPicker,
  PortQuickSelect, SegmentedControl, TagInput, TokenizedTextInput,
  type ChipOption,
} from '@/components/admin-ui';

// Maps an AppConfig field → the appropriate control from admin-ui.
// Per-key overrides take precedence over cfg.type when a richer control
// fits better than the type would suggest (e.g. `imgVignette` is `number`
// in schema, but renders as a Slider in the UI).
//
// Contract: every code path must support the dual mode of admin-ui — when
// onChange is omitted, the rendered control is read-only.

export interface AppConfigField {
  key: string;
  value: string;
  label: string;
  group: string;
  type: string;
}

export interface MachineForDropdown {
  id: string;
  name: string;
  model?: string | null;
  imageUrl?: string | null;
  isActive?: boolean;
}

const RENTAL_TYPE_OPTIONS: ChipOption[] = [
  { value: 'day',     label: '1 dag' },
  { value: 'weekend', label: 'Helg' },
  { value: 'week',    label: '1 uke' },
  { value: 'custom',  label: 'Tilpasset' },
];

type Override =
  | 'slider'           // 0-100 percent or similar bounded number
  | 'phone'
  | 'siteurl'
  | 'tags'
  | 'address'
  | 'port'
  | 'tokenized'        // single-line tokenized text
  | 'tokenized-multi'  // multi-line tokenized text
  | 'weekday'          // single ISO weekday (1=man … 7=søn)
  | 'theme'            // light/dark/system selector
  | 'vipps-env';       // Vipps test/production environment

// Only keys this component is actually asked to render belong here. Six
// entries used to sit in this map that no call site could ever reach (P-12):
//
//   • `mvaRate` is a PricingConfig key, not an AppConfig one, and the Priser
//     tab renders it through `PricingFieldControl` instead.
//   • `baseAddress` is rendered by `AdminBaseAddressField` inside the Priser
//     tab, which has its own autocomplete.
//   • `firstTimeDiscountPercent`, `repeatDiscountPercent` and
//     `discountHardCap` live in the `discounts` group, which
//     `APP_CONFIG_GROUP_ORDER` deliberately omits — they are edited on
//     /admin/discount-codes, which builds its own controls.
//
//   • `imgVignette` was removed from the settings as a niche knob; the stale
//     read in `src/lib/equipment-bg.tsx` went with it.
const KEY_OVERRIDES: Record<string, Override> = {
  cancelLatePercent:        'slider',
  cancelSameDayPercent:     'slider',
  contactPhone:             'phone',
  siteUrl:                  'siteurl',
  seoKeywords:              'tags',
  // businessAddress is a physical address like baseAddress — same control.
  businessAddress:          'address',
  smtpPort:                 'port',
  heroHeading:              'tokenized',
  heroTagline:              'tokenized',
  heroSubtext:              'tokenized-multi',
  // Start-day settings are stored as '1'..'7'; a picker beats typing a digit.
  weekendStartDay:          'weekday',
  weekStartDay:             'weekday',
  defaultTheme:             'theme',
  // Two fixed environments — a typo in a free-text field here would decide
  // whether real money moves, so never leave this as a text input.
  vippsEnvironment:         'vipps-env',
};

const TOKENS_HERO = ['kategori', 'pris', 'deliveryIncludedKm'];

export function ConfigFieldControl({
  cfg, current, onChange, machines,
}: {
  cfg: AppConfigField;
  current: string;
  onChange: (next: string) => void;
  machines: MachineForDropdown[];
}) {
  const override = KEY_OVERRIDES[cfg.key];

  // ── Per-key overrides (richer control than cfg.type would suggest) ──
  if (override === 'slider') {
    return (
      <Slider
        value={Number(current) || 0}
        onChange={(n) => onChange(String(n))}
        min={0}
        max={100}
        marks={[0, 50, 100]}
      />
    );
  }
  if (override === 'phone') {
    return <PhoneInput value={current} onChange={onChange} />;
  }
  if (override === 'siteurl') {
    // Strip leading "https://" if present so the prefix doesn't double up
    // when re-typing. Persist without the prefix; consumers add scheme.
    const visible = current.replace(/^https?:\/\//i, '');
    return (
      <TextInput
        value={visible}
        onChange={(v) => onChange(v.replace(/^https?:\/\//i, ''))}
        prefix="https://"
        placeholder="dittdomene.no"
      />
    );
  }
  if (override === 'tags') {
    const tags = current.split(',').map((s) => s.trim()).filter(Boolean);
    return (
      <TagInput
        value={tags}
        onChange={(next) => onChange(next.join(', '))}
      />
    );
  }
  if (override === 'address') {
    return <AddressAutocomplete value={current} onChange={onChange} />;
  }
  if (override === 'port') {
    return (
      <PortQuickSelect
        value={Number(current) || 587}
        onChange={(n) => onChange(String(n))}
      />
    );
  }
  if (override === 'tokenized') {
    return <TokenizedTextInput value={current} onChange={onChange} tokens={TOKENS_HERO} />;
  }
  if (override === 'weekday') {
    const day = parseInt(current, 10);
    return (
      <WeekdayPicker
        multi={false}
        value={Number.isNaN(day) ? [] : [day]}
        onChange={(next) => onChange(String(next[0] ?? ''))}
      />
    );
  }
  if (override === 'tokenized-multi') {
    return (
      <TokenizedTextInput
        value={current}
        onChange={onChange}
        tokens={TOKENS_HERO}
        multiline
        rows={3}
      />
    );
  }
  if (override === 'theme') {
    return (
      <SegmentedControl
        options={[
          { value: 'light',  label: 'Lys' },
          { value: 'dark',   label: 'Mørk' },
          { value: 'system', label: 'System' },
        ]}
        value={current || 'light'}
        onChange={onChange}
      />
    );
  }
  if (override === 'vipps-env') {
    return (
      <SegmentedControl
        options={[
          { value: 'test',       label: 'Test' },
          { value: 'production', label: 'Produksjon' },
        ]}
        value={current === 'production' ? 'production' : 'test'}
        onChange={onChange}
      />
    );
  }

  // ── cfg.type-driven mapping ────────────────────────────────────────
  switch (cfg.type) {
    case 'boolean':
      return (
        <Toggle
          value={current === 'true'}
          onChange={(v) => onChange(v ? 'true' : 'false')}
          labelOn="Aktivert"
          labelOff="Deaktivert"
        />
      );
    case 'number':
      return (
        <Stepper
          value={Number(current) || 0}
          onChange={(n) => onChange(String(n))}
        />
      );
    case 'textarea':
      return <TextArea value={current} onChange={onChange} rows={3} />;
    case 'password':
      return <PasswordField value={current} onChange={onChange} />;
    case 'color':
      return <ColorPicker value={current || '#3d5a3e'} onChange={onChange} />;
    case 'image':
      return (
        <ImageDropzone
          value={current || null}
          onChange={(v) => onChange(v || '')}
        />
      );
    case 'email':
      return <TextInput value={current} onChange={onChange} type="email" />;
    case 'url':
      return <TextInput value={current} onChange={onChange} type="url" />;
    case 'machine-select':
      return (
        <MachineDropdown
          value={current || null}
          onChange={(v) => onChange(v ?? '')}
          machines={machines
            .filter((m) => m.isActive !== false)
            .map((m) => ({ id: m.id, name: m.name, model: m.model, imageUrl: m.imageUrl }))}
          allowNone
        />
      );
    case 'rental-type-toggles': {
      const selected = current.split(',').map((s) => s.trim()).filter(Boolean);
      return (
        <ChipMultiSelect
          options={RENTAL_TYPE_OPTIONS}
          value={selected}
          onChange={(next) => onChange(next.join(','))}
        />
      );
    }
    case 'day-toggles': {
      const days = current
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n));
      return (
        <WeekdayPicker
          value={days}
          onChange={(next) => onChange(next.join(','))}
        />
      );
    }
    case 'select-unit':
      return (
        <SegmentedControl
          options={[
            { value: 'hours', label: 'Timer' },
            { value: 'days',  label: 'Dager' },
            { value: 'weeks', label: 'Uker' },
          ]}
          value={current || 'hours'}
          onChange={onChange}
        />
      );
    case 'text':
    default:
      return <TextInput value={current} onChange={onChange} />;
  }
}
