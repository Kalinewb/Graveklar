// admin-ui — Shared component library for admin + admin-preview.
//
// All controls follow the same contract:
//   value:       current value (required, controlled)
//   onChange?:   when provided → interactive
//                when omitted  → renders as a static display (preview mode)
//   disabled?:   force display mode
//
// New control? Add it here, then add the data-type mapping to the
// `feedback-fit-input-control` memory note so future sessions remember.

// Layout primitives
export { Pill, type PillTone } from './layout/Pill';
export { StatusBadge, type BookingStatus } from './layout/StatusBadge';
export { StatCard } from './layout/StatCard';
export { MiniBarChart, type MiniBarDatum } from './layout/MiniBarChart';
export { FieldRow } from './layout/FieldRow';
export { useFieldIds, type FieldIds } from './layout/field-context';

// Controls
export { Toggle } from './controls/Toggle';
export { Stepper } from './controls/Stepper';
export { Slider } from './controls/Slider';
export { ColorPicker } from './controls/ColorPicker';
export { TextInput } from './controls/TextInput';
export { TextArea } from './controls/TextArea';
export { PasswordField } from './controls/PasswordField';
export { PhoneInput } from './controls/PhoneInput';
export { TokenizedTextInput } from './controls/TokenizedTextInput';
export { WeekdayPicker } from './controls/WeekdayPicker';
export { ChipMultiSelect, type ChipOption } from './controls/ChipMultiSelect';
export { SegmentedControl, type SegmentOption } from './controls/SegmentedControl';
export { PortQuickSelect } from './controls/PortQuickSelect';
export { TagInput } from './controls/TagInput';
export { MachineDropdown, type MachineOption } from './controls/MachineDropdown';
export { AddressAutocomplete } from './controls/AddressAutocomplete';
export { ImageDropzone } from './controls/ImageDropzone';
