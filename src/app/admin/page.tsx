'use client';

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { addDays, toDateStr } from '@/lib/dates';
import { rentalDayCount } from '@/lib/availability';
import type { RentalType } from '@/lib/pricing';
import {
  Activity,
  TrendingUp,
  TrendingDown,
  Layers,
  Calendar,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  X,
  Loader2,
  ArrowLeft,
  Wrench,
  CheckCircle2,
  AlertCircle,
  Trash2,
  Info,
  Settings,
  Save,
  LogOut,
  Clock,
  XCircle,
  Copy,
  Check,
  Plus,
  Tractor,
  Mail,
  FlaskConical,
  MoreHorizontal,
  FileText,
  Upload,
  Printer,
  Hash,
  Camera,
  ShieldCheck,
  HelpCircle,
  GitBranch,
  Building2,
  CreditCard,
  Lock,
  Eye,
  Palette,
  Star,
  Percent,
  ListChecks,
  Globe,
  Shield,
  Fuel,
  Package,
  GripVertical,
  ArrowUpRight,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import AdminBaseAddressField from '@/components/AdminBaseAddressField';
import TotpPromptModal from '@/components/admin/TotpPromptModal';
import { toast } from 'sonner';
import SecurityBanner from '@/components/admin/SecurityBanner';
import SaveBar from '@/components/admin/SaveBar';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { APP_CONFIG_GROUP_LABELS, APP_CONFIG_GROUP_ORDER, SENSITIVE_GROUPS } from '@/lib/app-config-defaults';
import { FieldRow, StatCard, MiniBarChart, Toggle, Stepper, Slider, ImageDropzone, TextInput, TextArea as AdminTextArea, SegmentedControl } from '@/components/admin-ui';
import { GraveklarMark } from '@/components/GraveklarMark';
import { AdminThemeMenu } from '@/components/ThemeToggle';
import { ConfigFieldControl } from '@/components/admin/ConfigFieldControl';
import { PricingFieldControl } from '@/components/admin/PricingFieldControl';
import { AnswerTypePicker } from '@/components/admin/AnswerTypePicker';
import { BookingTimeline } from '@/components/admin/BookingTimeline';
import { ContractSigningPanel } from '@/components/admin/ContractSigningPanel';
import { contractSigningLabel, contractSigningTone, resolveContractSigning } from '@/lib/contract-signing';
import { buildRentalFlowContext, computeRentalFlow } from '@/lib/rental-flow';
import { AnswerTypePill } from '@/components/admin/AnswerTypePill';
import { ChecklistPhasesList } from '@/components/admin/ChecklistPhasesList';
import { ChecklistPhaseFormSheet, buildChecklistPhasePayload } from '@/components/admin/ChecklistPhaseFormSheet';
import { SeoPreview } from '@/components/admin/SeoPreview';
import { ChecklistQrPanel } from '@/components/admin/ChecklistQrPanel';
import { TestChecklistPanel } from '@/components/admin/TestChecklistPanel';
import { MockBookingSheet } from '@/components/admin/MockBookingSheet';
import { CompletedChecklistsSummary } from '@/components/admin/CompletedChecklistsSummary';
import { computeFuelNeeds, fuelCansLabel } from '@/lib/fuel';
import { formatMachineLabel } from '@/lib/machine-display';
import {
  parseChecklistData,
  filterPhasesForBooking,
  isItemFilled,
  countChecklistProgress,
  findCompletionTriggerPhase,
  isCompletionPhaseDone,
  findPrepPhaseIndex,
} from '@/lib/checklist';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';

// Keys that benefit from spanning the full content panel width even though
// their declared type is not textarea/image (e.g. tokenized hero copy).
const KEY_FULL_WIDTH = new Set<string>([
  'heroHeading', 'heroTagline', 'heroSubtext', 'seoTitle', 'seoDescription', 'seoKeywords', 'baseAddress',
]);
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/* ─── constants ─── */
const NORWEGIAN_DAY_NAMES = ['man', 'tir', 'ons', 'tor', 'fre', 'lør', 'søn'];
const NORWEGIAN_MONTH_NAMES = [
  'januar', 'februar', 'mars', 'april', 'mai', 'juni',
  'juli', 'august', 'september', 'oktober', 'november', 'desember',
];

const RENTAL_TYPE_LABELS: Record<string, string> = {
  day: '1 dag',
  weekend: 'Helg',
  week: '1 uke',
  custom: 'Tilpasset',
};

// Actual rental length in days (honors multi-week `customDays`), e.g. a 2-week
// 'week' booking → "14 dager" instead of the misleading "1 uke".
function rentalDaysLabel(rentalType: string, customDays?: number | null): string {
  const d = rentalDayCount(rentalType as RentalType, customDays);
  return d === 1 ? '1 dag' : `${d} dager`;
}

type SelectionMode = 'day' | 'week' | 'month';
type AdminTab = 'calendar' | 'pricing' | 'machines' | 'settings' | 'content' | 'checklists' | 'forespørsler' | 'omtaler';

interface ReviewData {
  id: string;
  rating: number | null;
  comment: string | null;
  reviewerName: string | null;
  status: string;
  submittedAt: string | null;
  booking: { reference: string; name: string };
}

/* ─── helpers ─── */
function getWeekDates(dateStr: string): string[] {
  const d = new Date(dateStr + 'T00:00:00');
  const dayOfWeek = d.getDay();
  const monday = new Date(d);
  const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  monday.setDate(monday.getDate() - diff);

  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const current = new Date(monday);
    current.setDate(current.getDate() + i);
    dates.push(toDateStr(current));
  }
  return dates;
}

function getMonthDates(year: number, month: number): string[] {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const dates: string[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    dates.push(toDateStr(new Date(year, month, d)));
  }
  return dates;
}

interface BookingInfo {
  id: string;
  reference: string;
  name: string;
  phone: string;
  email: string;
  deliveryAddress: string;
  rentalType: string;
  customDays?: number;
  startDate: string;
  preferredTime?: string;
  basePrice: number;
  deliveryFee: number;
  deliveryDistance: number;
  totalPrice: number;
  extraHours: number;
  extraHoursCost: number;
  includedHours: number;
  totalHours: number;
  notes?: string;
  selfPickup: boolean;
  checklistData?: string;
  status: string;
  fullyPaidAt?: string | null;
  paymentMethod?: string | null;
  termsAcceptedAt?: string | null;
  contractSigningMethod?: string | null;
  contractSigningStatus?: string | null;
  contractSentAt?: string | null;
  contractSignedAt?: string | null;
  digipostReference?: string | null;
  contractSigningNote?: string | null;
  createdAt: string;
  machineId?: string | null;
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'Venter',
  confirmed: 'Bekreftet',
  cancelled: 'Avbestilt',
  completed: 'Fullført',
};

interface UnavailableDateInfo {
  id: string;
  date: string;
  reason?: string;
}

interface MachineInfo {
  id: string;
  name: string;
  category?: string | null;
  model: string;
  year?: string;
  description?: string;
  imageUrl?: string;
  isActive: boolean;
  specs?: string;
  features?: string;
  included?: string;
  sortOrder: number;
  quantity: number;
  dayPrice?: number | null;
  weekendPrice?: number | null;
  weekPrice?: number | null;
  dayIncludedHours?: number | null;
  weekendIncludedHours?: number | null;
  weekIncludedHours?: number | null;
  overtimeRate?: number | null;
  preOrderHourRate?: number | null;
  fuelTankLiters?: number | null;
  fuelConsumptionPerHour?: number | null;
  photoScale?: number | null;
  documents?: MachineDocumentData[];
}

interface MachineDocumentData { id?: string; title: string; fileUrl: string; sortOrder?: number; }

interface FaqItemData { id: string; question: string; answer: string; sortOrder: number; isActive: boolean; }
interface TermsSectionData { id: string; title: string; content: string; sortOrder: number; isActive: boolean; audience: 'consumer' | 'business'; }
interface QuoteRequestData {
  id: string;
  reference: string;
  company: string;
  orgNumber: string;
  contactName: string;
  email: string;
  phone: string;
  machineId: string | null;
  machine: { id: string; name: string; model: string | null } | null;
  startDate: string | null;
  rentalType: string | null;
  customDays: number | null;
  projectDescription: string | null;
  trainingConfirmed: boolean;
  status: string;
  offerAmount: number | null;
  offerMessage: string | null;
  offerValidUntil: string | null;
  paymentMode: string | null;
  acceptToken: string | null;
  convertedBookingId: string | null;
  adminNote: string | null;
  createdAt: string;
}
interface InsuranceCardData { id: string; label: string; value: string; detail: string; sortOrder: number; isActive: boolean; }
interface ChecklistItemData { id: string; phaseId: string; label: string; answerType: string; unit?: string; sortOrder: number; isActive: boolean; conditionItemId?: string | null; conditionValue?: string | null; statKey?: string | null; minPhotos?: number | null; }
interface ChecklistPhaseData {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  appliesTo?: string;
  isCompletionTrigger?: boolean;
  audience?: string;
  intervalMode?: string;
  intervalHours?: number | null;
  items: ChecklistItemData[];
}

interface PricingConfigItem {
  id: string;
  key: string;
  value: number;
  label: string;
  group: string;
}

const GROUP_LABELS: Record<string, string> = {
  rental: 'Leiepriser',
  hours: 'Timepriser',
  delivery: 'Levering',
  tax: 'MVA',
};

// 'cancellation' and 'services' intentionally excluded — no keys in
// config-defaults.ts belong to those groups (only rental/hours/delivery/tax
// exist there), so they always rendered nothing. Avbestilling lives in
// Innstillinger → Booking instead — see the quick-jump button below.
const GROUP_ORDER = ['rental', 'hours', 'delivery', 'tax'];

// Canonical sort order inside each Priser group. Each rate is followed by
// its companion includedHours field so admins read them as pairs:
//
//   Timepris hverdag (man–fre)
//   Timer inkludert (1 dag)
//
//   Timepris helg (lør–søn)
//   Timer inkludert (helg)
//   ...etc.
//
// Keys not listed sort after the listed ones, preserving insertion order.
const PRICING_KEY_ORDER: Record<string, string[]> = {
  rental: [
    'weekdayHourly',
    'dayIncludedHours',
    'weekendHourly',
    'weekendIncludedHours',
    'weeklyHourly',
    'weekIncludedHours',
  ],
  hours: ['overtimeRate', 'preOrderHourRate'],
  delivery: ['deliveryPerKm', 'deliveryIncludedKm', 'minDeliveryFee', 'maxDeliveryRadius'],
  tax: ['mvaRate', 'pricesIncludeMva'],
};

function sortPricingKeys<T extends { key: string }>(group: string, items: T[]): T[] {
  const order = PRICING_KEY_ORDER[group];
  if (!order) return items;
  const indexOf = (key: string) => {
    const i = order.indexOf(key);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...items].sort((a, b) => indexOf(a.key) - indexOf(b.key));
}

const SETTINGS_GROUP_ICONS: Record<string, React.ElementType> = {
  business:       Building2,
  'rental-types': Clock,
  booking:        Calendar,
  discounts:      Star,
  stripe:         CreditCard,
  smtp:           Mail,
  content:        FileText,
  ui:             Eye,
  theme:          Palette,
  system:         Globe,
};

const PRICING_GROUP_ICONS: Record<string, React.ElementType> = {
  rental:       Tractor,
  hours:        Clock,
  delivery:     Wrench,
  services:     Settings,
  tax:          Percent,
};

/* ═══════════════════════════════════════════════════
   ADMIN PAGE
   ═══════════════════════════════════════════════════ */
export default function AdminPage() {
  const [mounted, setMounted] = useState(false);
  const today = mounted ? new Date() : null;
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });

  // ─── Mount effect: set client-side date values ───
  useEffect(() => {
    const now = new Date();
    setCalendarMonth({ year: now.getFullYear(), month: now.getMonth() });
    setMounted(true);
  }, []);

  // Tab
  const [activeTab, setActiveTab] = useState<AdminTab>('calendar');

  // Data
  const [bookings, setBookings] = useState<BookingInfo[]>([]);
  const [unavailableDates, setUnavailableDates] = useState<UnavailableDateInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const adminAutoAdvanced = useRef(false);
  // Set the moment the admin uses the month chevrons. The auto-advance below
  // fires when the first bookings land, which can be *after* a fast admin has
  // already stepped to another month — jumping the calendar out from under
  // them and starting yet another fetch. Their choice wins (P-16/P-17).
  const monthPickedByAdmin = useRef(false);
  useEffect(() => {
    if (adminAutoAdvanced.current || monthPickedByAdmin.current || bookings.length === 0) return;
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const hasActivity = bookings.some(b =>
      ['confirmed', 'pending'].includes(b.status) &&
      b.startDate.startsWith(thisMonth)
    );
    if (!hasActivity) {
      const nextBooking = bookings
        .filter(b => ['confirmed', 'pending'].includes(b.status) && b.startDate > thisMonth)
        .sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
      if (nextBooking) {
        const d = new Date(nextBooking.startDate + 'T00:00:00');
        setCalendarMonth({ year: d.getFullYear(), month: d.getMonth() });
      }
    }
    adminAutoAdvanced.current = true;
  }, [bookings]);

  // Selection
  const [selectionMode, setSelectionMode] = useState<SelectionMode>('day');
  const [selectedDates, setSelectedDates] = useState<Set<string>>(new Set());
  const [hoverDates, setHoverDates] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');

  // Dialogs
  const [showConfirmBlock, setShowConfirmBlock] = useState(false);
  const [showMockBookingSheet, setShowMockBookingSheet] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [showBookingDetail, setShowBookingDetail] = useState(false);
  const [selectedBooking, setSelectedBooking] = useState<BookingInfo | null>(null);

  // Drill-down drawer triggered by clicking a stat card in the Kalender tab.
  // One state covers all 5 drawers since only one can be open at a time.
  const [statDrawer, setStatDrawer] = useState<'pending' | 'confirmed' | 'stats' | null>(null);
  const [isSaving, setIsSaving] = useState(false);



  // Pricing config
  const [pricingConfigs, setPricingConfigs] = useState<PricingConfigItem[]>([]);
  // Strings while mid-edit so the user can clear and retype freely.
  // Converted to numbers at save time. Avoids the NaN-guard trap that
  // froze the input on full delete.
  const [editedValues, setEditedValues] = useState<Record<string, string>>({});

  // TOTP prompt state — set when a sensitive save was rejected with 401.
  // The modal fires onVerified(code) which retries the corresponding save.
  const [pendingTotpSave, setPendingTotpSave] =
    useState<{ kind: 'app-config' | 'pricing' | 'machine'; context: string; group?: string } | null>(null);
  // TOTP enrollment status + manual-trigger flag for the security banner.
  const [totpEnrolled, setTotpEnrolled] = useState<boolean>(false);
  const [showTotpSetup, setShowTotpSetup] = useState(false);

  // Probe enrollment status on mount so the security banner renders correctly.
  useEffect(() => {
    fetch('/api/admin/totp/status')
      .then((r) => r.json())
      .then((d) => setTotpEnrolled(!!d.enrolled))
      .catch(() => {});
  }, []);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [configSaved, setConfigSaved] = useState(false);
  const [configError, setConfigError] = useState('');

  // App config (settings)
  const [appConfigs, setAppConfigs] = useState<{ key: string; value: string; label: string; group: string; type: string; hint?: string }[]>([]);
  const [editedAppValues, setEditedAppValues] = useState<Record<string, string>>({});
  const [isSavingApp, setIsSavingApp] = useState(false);
  const [appConfigSaved, setAppConfigSaved] = useState(false);
  const [appConfigError, setAppConfigError] = useState('');
  const [isSendingTestEmail, setIsSendingTestEmail] = useState(false);
  const [testEmailResult, setTestEmailResult] = useState('');

  // ─── Unsaved-change tracking ──────────────────────────────────────────
  // One source of truth for "does the form differ from the server", used by
  // the sidebar dots, the save bars and the leave-page guard. Each of those
  // used to answer the question its own way (or not at all), which is how the
  // Lagre button ended up always enabled: nothing knew what was saved.
  //
  // Pricing compares NUMERICALLY on purpose — editedValues holds text drafts,
  // so "299.50" and 299.5 are the same saved value and must not read as an
  // edit. Blank drafts are skipped, matching what handleSaveConfig submits.
  const dirtyPricingKeys = useMemo(() => {
    const original = new Map(pricingConfigs.map((c) => [c.key, c.value]));
    return Object.keys(editedValues).filter((key) => {
      const draft = editedValues[key];
      if (draft === '' || draft === undefined) return false;
      if (!original.has(key)) return false;
      const n = Number(draft);
      return Number.isFinite(n) && n !== original.get(key);
    });
  }, [pricingConfigs, editedValues]);

  const pricingGroupByKey = useMemo(
    () => new Map(pricingConfigs.map((c) => [c.key, c.group])),
    [pricingConfigs],
  );

  // App config saves are scoped to one group, so the dirty count must be too.
  // Same predicate handleSaveAppConfig uses to build its payload.
  const dirtyAppKeysByGroup = useMemo(() => {
    const original = new Map(appConfigs.map((c) => [c.key, c.value]));
    const groupByKey = new Map(appConfigs.map((c) => [c.key, c.group]));
    const byGroup = new Map<string, number>();
    for (const [key, value] of Object.entries(editedAppValues)) {
      const group = groupByKey.get(key);
      if (!group) continue;
      if (original.get(key) === value) continue;
      byGroup.set(group, (byGroup.get(group) ?? 0) + 1);
    }
    return byGroup;
  }, [appConfigs, editedAppValues]);

  const hasUnsavedSettings = dirtyPricingKeys.length > 0 || dirtyAppKeysByGroup.size > 0;

  // Closing the tab mid-edit silently threw the changes away. The browser's
  // own prompt is the only reliable guard, and it only fires when there is
  // genuinely something to lose.
  useEffect(() => {
    if (!hasUnsavedSettings) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasUnsavedSettings]);

  // Machines
  const [machines, setMachines] = useState<MachineInfo[]>([]);
  const [editingMachine, setEditingMachine] = useState<MachineInfo | null>(null);
  const [showMachineForm, setShowMachineForm] = useState(false);
  const [machineForm, setMachineForm] = useState<Partial<MachineInfo>>({});
  const [isSavingMachine, setIsSavingMachine] = useState(false);
  // Same role as configError / appConfigError, for the machine drawer: a save
  // that was refused and then abandoned has to say so where the edited value
  // is still on screen (P-11).
  const [machineFormError, setMachineFormError] = useState('');
  const [isReorderingMachines, setIsReorderingMachines] = useState(false);
  const [machineSpecs, setMachineSpecs] = useState<{ label: string; value: string }[]>([]);
  const [machineFeatures, setMachineFeatures] = useState<{ title: string; desc: string }[]>([]);
  const [machineIncluded, setMachineIncluded] = useState<string[]>([]);
  const [machineDocuments, setMachineDocuments] = useState<MachineDocumentData[]>([]);
  const [uploadingDoc, setUploadingDoc] = useState(false);

  // Copy feedback
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // Booking search
  const [bookingSearch, setBookingSearch] = useState('');
  // Cancelled rows are off by default and switched on from the list header.
  // See `listedBookings` for why they have to be reachable at all (P-1).
  const [showCancelled, setShowCancelled] = useState(false);


  // Content CRUD state
  const [faqItems, setFaqItems] = useState<FaqItemData[]>([]);
  const [editingFaq, setEditingFaq] = useState<FaqItemData | null>(null);
  const [showFaqForm, setShowFaqForm] = useState(false);
  const [faqForm, setFaqForm] = useState<Partial<FaqItemData>>({});
  const [isSavingFaq, setIsSavingFaq] = useState(false);

  const [termsSections, setTermsSections] = useState<TermsSectionData[]>([]);
  const [editingTerms, setEditingTerms] = useState<TermsSectionData | null>(null);
  const [showTermsForm, setShowTermsForm] = useState(false);
  const [termsForm, setTermsForm] = useState<Partial<TermsSectionData>>({});
  const [isSavingTerms, setIsSavingTerms] = useState(false);

  // B2B quote requests
  const [quoteRequests, setQuoteRequests] = useState<QuoteRequestData[]>([]);
  const [offerQuote, setOfferQuote] = useState<QuoteRequestData | null>(null);
  const [showOfferForm, setShowOfferForm] = useState(false);
  const [offerForm, setOfferForm] = useState<{ offerAmount: string; offerMessage: string; offerValidUntil: string; paymentMode: 'card' | 'invoice'; startDate: string; rentalType: string; customDays: string }>({ offerAmount: '', offerMessage: '', offerValidUntil: '', paymentMode: 'card', startDate: '', rentalType: 'day', customDays: '' });
  const [isSendingOffer, setIsSendingOffer] = useState(false);

  // Customer reviews (moderation)
  const [reviews, setReviews] = useState<ReviewData[]>([]);

  const [insuranceCards, setInsuranceCards] = useState<InsuranceCardData[]>([]);
  const [editingInsurance, setEditingInsurance] = useState<InsuranceCardData | null>(null);
  const [showInsuranceForm, setShowInsuranceForm] = useState(false);
  const [insuranceForm, setInsuranceForm] = useState<Partial<InsuranceCardData>>({});
  const [isSavingInsurance, setIsSavingInsurance] = useState(false);

  // Checklist template
  const [checklistPhases, setChecklistPhases] = useState<ChecklistPhaseData[]>([]);
  const [editingPhase, setEditingPhase] = useState<ChecklistPhaseData | null>(null);
  const [showPhaseForm, setShowPhaseForm] = useState(false);
  const [phaseForm, setPhaseForm] = useState<Partial<ChecklistPhaseData>>({});
  const [phaseFormError, setPhaseFormError] = useState('');
  const [isSavingPhase, setIsSavingPhase] = useState(false);
  const [editingItem, setEditingItem] = useState<ChecklistItemData | null>(null);
  const [showItemForm, setShowItemForm] = useState(false);
  const [itemForm, setItemForm] = useState<Partial<ChecklistItemData> & { phaseId?: string }>({});
  const [itemFormError, setItemFormError] = useState('');
  const [isSavingItem, setIsSavingItem] = useState(false);

  // Sidebar active groups
  const [activeSettingsGroup, setActiveSettingsGroup] = useState('business');
  const [activePricingGroup, setActivePricingGroup] = useState('rental');

  // Derived: business name from loaded app config
  const adminBusinessName = editedAppValues['businessName'] || appConfigs.find(c => c.key === 'businessName')?.value || 'Graveklar';
  const adminLogoUrl = editedAppValues['logoUrl'] ?? appConfigs.find(c => c.key === 'logoUrl')?.value ?? '';
  const adminLogoInHeader = (editedAppValues['logoInHeader'] ?? appConfigs.find(c => c.key === 'logoInHeader')?.value ?? 'true') !== 'false';
  const showMockBookingPanel = (editedAppValues['showMockBookingPanel'] ?? appConfigs.find(c => c.key === 'showMockBookingPanel')?.value ?? 'true') !== 'false';

  // Filtered bookings for search
  const filteredBookings = bookingSearch.trim()
    ? bookings.filter(b => {
        const q = bookingSearch.toLowerCase();
        return (
          b.name.toLowerCase().includes(q) ||
          b.reference.toLowerCase().includes(q) ||
          b.phone.includes(q) ||
          b.email.toLowerCase().includes(q)
        );
      })
    : bookings;

  // The rows the sidebar list actually renders. One predicate, used by both
  // the empty state and the list itself — they used to be two copies of the
  // same filter, which is how the counter above could say "1 resultat" over a
  // list saying "Ingen bookinger matcher søket".
  //
  // Cancelled bookings are hidden by default (they are noise in a month view)
  // but must be *reachable*: the drawer's `Slett` is the only way to remove
  // one, and while the list refused to show them that button could never be
  // pressed (P-1).
  const listedStatuses = showCancelled
    ? ['confirmed', 'pending', 'completed', 'cancelled']
    : ['confirmed', 'pending', 'completed'];
  const inListedMonth = (b: BookingInfo) => {
    // While searching, match across all months — otherwise the search box
    // reports a hit for a booking that is silently filtered out of the list.
    if (bookingSearch.trim()) return true;
    const start = new Date(b.startDate);
    return start.getMonth() === calendarMonth.month && start.getFullYear() === calendarMonth.year;
  };
  const listedBookings = filteredBookings
    .filter((b) => listedStatuses.includes(b.status) && inListedMonth(b))
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  // How many rows the "Vis avbrutte" switch would add — so the empty state can
  // explain itself instead of flatly contradicting the search counter.
  const hiddenCancelledCount = showCancelled
    ? 0
    : filteredBookings.filter((b) => b.status === 'cancelled' && inListedMonth(b)).length;

  // The configured MVA rate, for anything that has to split a stored gross
  // amount back into eks. MVA + MVA. The Priser tab reads the same row; the
  // booking drawer used to hardcode 25 % and disagreed with it the moment the
  // rate was not 25 (P-2). A deliberate 0 is honoured — an MVA-exempt setup is
  // a real configuration — and only a missing or unreadable row falls back.
  const mvaRateConfigured = Number(pricingConfigs.find((c) => c.key === 'mvaRate')?.value);
  const mvaRate = Number.isFinite(mvaRateConfigured) ? Math.max(0, mvaRateConfigured) : 25;

  // Compute booking date map (confirmed + completed)
  // Also computes a "turnaround" set — the day right after each booking's
  // last day, which is auto-reserved for cleanup/inspection. Customer-side
  // these days are blocked via /api/availability; here we render them with
  // a distinct color so the operator knows it's not a regular booking nor a
  // manual block, but a scheduled maintenance window.
  // Turnaround toggles (Innstillinger → Booking) — keep the striped
  // maintenance days in the admin calendar in sync with what the customer
  // availability API actually blocks. Default on.
  const blockDayBefore = (appConfigs.find((c) => c.key === 'blockDayBeforeBooking')?.value ?? 'true') !== 'false';
  const blockDayAfter = (appConfigs.find((c) => c.key === 'blockDayAfterBooking')?.value ?? 'true') !== 'false';
  const turnaroundDateSet = new Set<string>();
  const bookingDateMap = (() => {
    const map = new Map<string, BookingInfo[]>();
    for (const booking of bookings) {
      if (booking.status !== 'confirmed' && booking.status !== 'completed') continue;
      const start = new Date(booking.startDate);
      // Shared day-count — honors multi-week `customDays` (a 2-week 'week'
      // booking spans 14 days, not the 7 the old local rule assumed).
      const daysOffset = rentalDayCount(booking.rentalType as RentalType, booking.customDays) - 1;

      for (let i = 0; i <= daysOffset; i++) {
        const d = new Date(start);
        d.setDate(d.getDate() + i);
        const dateStr = toDateStr(d);
        if (!map.has(dateStr)) map.set(dateStr, []);
        map.get(dateStr)!.push(booking);
      }
      // Turnaround / prep windows: the day BEFORE the booking starts (prep,
      // pre-delivery inspection) and the day AFTER it ends (cleanup,
      // refuel). Customers see both as blocked; admin gets the striped
      // maintenance treatment so it's distinguishable from a real booking.
      if (blockDayBefore) {
        const before = new Date(start);
        before.setDate(before.getDate() - 1);
        turnaroundDateSet.add(toDateStr(before));
      }
      if (blockDayAfter) {
        const after = new Date(start);
        after.setDate(after.getDate() + daysOffset + 1);
        turnaroundDateSet.add(toDateStr(after));
      }
    }
    return map;
  })();

  // Pending booking date map (for calendar coloring)
  const pendingBookingDateMap = (() => {
    const map = new Map<string, BookingInfo[]>();
    for (const booking of bookings) {
      if (booking.status !== 'pending') continue;
      const start = new Date(booking.startDate);
      // Shared day-count — honors multi-week `customDays` (a 2-week 'week'
      // booking spans 14 days, not the 7 the old local rule assumed).
      const daysOffset = rentalDayCount(booking.rentalType as RentalType, booking.customDays) - 1;
      for (let i = 0; i <= daysOffset; i++) {
        const d = new Date(start);
        d.setDate(d.getDate() + i);
        const dateStr = toDateStr(d);
        if (!map.has(dateStr)) map.set(dateStr, []);
        map.get(dateStr)!.push(booking);
      }
    }
    return map;
  })();

  const blockedDateSet = new Set(unavailableDates.map((u) => u.date));

  // Fetch data
  //
  // One generation per run, and the newest run is the only one allowed to
  // write. `fetchData` is keyed on `calendarMonth`, so every month change
  // starts a fresh pair of requests on top of the pair already in flight; with
  // no guard, whichever pair resolved last won — including a stale one for a
  // month the admin had already navigated away from (P-17). The interleaved
  // commits that produced were also what left the panel unable to open any
  // dialog or sheet afterwards (P-16). A superseded run now aborts its own
  // requests, writes nothing, and leaves the spinner to the run that owns it.
  const fetchSeq = useRef(0);
  const fetchAbort = useRef<AbortController | null>(null);
  const fetchData = useCallback(async () => {
    const seq = ++fetchSeq.current;
    fetchAbort.current?.abort();
    const controller = new AbortController();
    fetchAbort.current = controller;
    setIsLoading(true);
    try {
      const monthStr = `${calendarMonth.year}-${String(calendarMonth.month + 1).padStart(2, '0')}`;

      const [bookingsRes, unavailableRes] = await Promise.all([
        fetch('/api/bookings', { signal: controller.signal }),
        fetch(`/api/unavailable?month=${monthStr}`, { signal: controller.signal }),
      ]);

      const bookingsData = await bookingsRes.json();
      const unavailableData = await unavailableRes.json();

      // A newer month is on screen — this answer describes a month nobody is
      // looking at any more.
      if (seq !== fetchSeq.current) return;

      if (bookingsData.bookings) {
        setBookings(
          bookingsData.bookings.map((b: any) => ({
            ...b,
            // Read startDate in LOCAL time (Norway) — matches what the
            // customer-side /api/availability returns via dbDateToStr().
            // toISOString() would give the UTC date, which can be a day off.
            startDate: toDateStr(new Date(b.startDate)),
            createdAt: new Date(b.createdAt).toISOString(),
          }))
        );
      }
      if (unavailableData.unavailableDates) {
        setUnavailableDates(unavailableData.unavailableDates);
      }
    } catch {
      // Silently fail — a superseded run's AbortError lands here too.
    } finally {
      // Only the newest run owns the spinner: an earlier one finishing must
      // not claim the panel is ready while the month on screen is still loading.
      if (seq === fetchSeq.current) setIsLoading(false);
    }
  }, [calendarMonth]);

  // Fetch pricing config
  const fetchPricingConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/config');
      const data = await res.json();
      if (data.configs) {
        setPricingConfigs(data.configs);
        const vals: Record<string, string> = {};
        for (const c of data.configs) {
          vals[c.key] = String(c.value);
        }
        setEditedValues(vals);
      }
    } catch {
      // Silently fail
    }
  }, []);

  const fetchAppConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/app-config');
      const data = await res.json();
      if (Array.isArray(data)) {
        setAppConfigs(data);
        const vals: Record<string, string> = {};
        for (const c of data) vals[c.key] = c.value;
        setEditedAppValues(vals);
      }
    } catch { /* silent */ }
  }, []);

  const fetchMachines = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/machines');
      const data = await res.json();
      if (data.machines) setMachines(data.machines);
    } catch { /* silent */ }
  }, []);

  const fetchFaq = useCallback(async () => {
    try { const d = await (await fetch('/api/admin/faq')).json(); if (d.items) setFaqItems(d.items); } catch { /* silent */ }
  }, []);
  const fetchTerms = useCallback(async () => {
    try { const d = await (await fetch('/api/admin/terms')).json(); if (d.sections) setTermsSections(d.sections); } catch { /* silent */ }
  }, []);
  const fetchInsurance = useCallback(async () => {
    try { const d = await (await fetch('/api/admin/insurance')).json(); if (d.cards) setInsuranceCards(d.cards); } catch { /* silent */ }
  }, []);
  const fetchQuoteRequests = useCallback(async () => {
    try { const d = await (await fetch('/api/admin/quote-requests', { credentials: 'include' })).json(); if (d.requests) setQuoteRequests(d.requests); } catch { /* silent */ }
  }, []);
  const fetchReviews = useCallback(async () => {
    try { const d = await (await fetch('/api/admin/reviews', { credentials: 'include' })).json(); if (d.reviews) setReviews(d.reviews); } catch { /* silent */ }
  }, []);
  const moderateReview = useCallback(async (id: string, action: 'approve' | 'reject') => {
    try {
      await fetch(`/api/admin/reviews/${id}`, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
      await fetchReviews();
    } catch { /* silent */ }
  }, [fetchReviews]);
  const deleteReview = useCallback(async (id: string) => {
    try {
      await fetch(`/api/admin/reviews/${id}`, { method: 'DELETE', credentials: 'include' });
      await fetchReviews();
    } catch { /* silent */ }
  }, [fetchReviews]);
  const fetchChecklistTemplate = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/checklist-phases', { credentials: 'include' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Kunne ikke hente sjekklister');
      if (d.phases) setChecklistPhases(d.phases);
    } catch (err) {
      console.error('fetchChecklistTemplate:', err);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => { fetchPricingConfig(); }, [fetchPricingConfig]);
  useEffect(() => { fetchAppConfig(); }, [fetchAppConfig]);
  useEffect(() => { fetchMachines(); }, [fetchMachines]);
  useEffect(() => { fetchFaq(); fetchTerms(); fetchInsurance(); fetchChecklistTemplate(); fetchQuoteRequests(); fetchReviews(); }, [fetchFaq, fetchTerms, fetchInsurance, fetchChecklistTemplate, fetchQuoteRequests, fetchReviews]);

  // Save pricing config
  const handleSaveConfig = async (totpCode?: string) => {
    setIsSavingConfig(true);
    setConfigError('');
    setConfigSaved(false);
    try {
      // Convert string drafts → numbers at save time. Empty string = 0.
      const configs = Object.entries(editedValues)
        .filter(([, v]) => v !== '')
        .map(([key, value]) => ({ key, value: Number(value) }))
        .filter(({ value }) => Number.isFinite(value));
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (totpCode) headers['X-Admin-TOTP'] = totpCode;
      const res = await fetch('/api/config', {
        method: 'POST',
        headers,
        body: JSON.stringify({ configs }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && data.requiresTotp) {
        setPendingTotpSave({ kind: 'pricing', context: 'Lagring av prisendringer' });
        return;
      }
      if (!res.ok) throw new Error('Failed to save');
      await fetchPricingConfig();
      setConfigSaved(true);
      setTimeout(() => setConfigSaved(false), 3000);
    } catch {
      setConfigError('Kunne ikke lagre innstillinger. Prøv igjen.');
    } finally {
      setIsSavingConfig(false);
    }
  };

  // ─── App config handlers ───
  const handleSaveAppConfig = async (totpCode?: string, groupOverride?: string) => {
    const targetGroup = groupOverride ?? activeSettingsGroup;
    setIsSavingApp(true);
    setAppConfigError('');
    setAppConfigSaved(false);
    try {
      // Only keys belonging to the group currently being saved AND whose
      // value actually changed. editedAppValues is one flat object shared
      // across all Innstillinger groups, so without the group filter a
      // "Lagre" click in one group would silently submit unsaved edits
      // sitting in a different, unrelated group. Filtering by changed value
      // additionally avoids dragging every (unchanged) Stripe/SMTP key along
      // and triggering the 2FA prompt for a harmless hero-text edit.
      const groupByKey = new Map(appConfigs.map((c) => [c.key, c.group]));
      const originalByKey = Object.fromEntries(appConfigs.map((c) => [c.key, c.value]));
      const updates = Object.entries(editedAppValues)
        .filter(([key]) => groupByKey.get(key) === targetGroup)
        .filter(([key, value]) => originalByKey[key] === undefined || originalByKey[key] !== value)
        .map(([key, value]) => ({ key, value }));
      if (updates.length === 0) {
        setAppConfigSaved(true);
        setTimeout(() => setAppConfigSaved(false), 3000);
        return;
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (totpCode) headers['X-Admin-TOTP'] = totpCode;
      const res = await fetch('/api/admin/app-config', {
        method: 'POST',
        headers,
        body: JSON.stringify(updates),
      });
      const data = await res.json();
      if (res.status === 401 && data.requiresTotp) {
        // Defer the save until TOTP modal yields a verified code. Remember
        // which group we were saving so the retry re-scopes correctly even
        // if the active sidebar group has since changed.
        setPendingTotpSave({ kind: 'app-config', context: 'Endring av sensitive innstillinger', group: targetGroup });
        return;
      }
      if (!res.ok) throw new Error(data.error || 'Lagring feilet');
      if (data.configs) {
        setAppConfigs(data.configs);
        // Only resync the group we just saved — editedAppValues may still
        // hold unsaved edits from other groups that must survive this save.
        setEditedAppValues((prev) => {
          const next = { ...prev };
          for (const c of data.configs) {
            if (c.group === targetGroup) next[c.key] = c.value;
          }
          return next;
        });
      }
      setAppConfigSaved(true);
      setTimeout(() => setAppConfigSaved(false), 3000);
    } catch (err) {
      setAppConfigError(err instanceof Error ? err.message : 'Feil ved lagring');
    } finally {
      setIsSavingApp(false);
    }
  };

  // Reset only the active group's unsaved edits back to last-synced server
  // values — mirrors the save scoping above so "Tilbakestill" can't wipe
  // edits sitting in other groups.
  const resetAppConfigGroup = useCallback((group: string) => {
    setEditedAppValues((prev) => {
      const next = { ...prev };
      for (const c of appConfigs) {
        if (c.group === group) next[c.key] = c.value;
      }
      return next;
    });
    // The "Ikke lagret — … krever 2FA" banner describes edits that no longer
    // exist. Left standing it contradicted the SaveBar right below it, which
    // had gone back to "Alt er lagret" (P-8).
    setAppConfigError('');
  }, [appConfigs]);

  // Switching group carries the same problem: the banner belongs to the group
  // whose save was refused, not to the one now on screen.
  const selectSettingsGroup = useCallback((group: string) => {
    setActiveSettingsGroup(group);
    setAppConfigError('');
  }, []);

  const selectPricingGroup = useCallback((group: string) => {
    setActivePricingGroup(group);
    setConfigError('');
  }, []);

  const handleTestEmail = async (template: string = 'test') => {
    setIsSendingTestEmail(true);
    setTestEmailResult('');
    try {
      const res = await fetch(`/api/admin/app-config/test-email?template=${encodeURIComponent(template)}`, { method: 'POST' });
      const data = await res.json();
      setTestEmailResult(res.ok ? `✓ Sendt: ${template}` : `✗ ${data.error}`);
    } catch {
      setTestEmailResult('✗ Feil ved sending');
    } finally {
      setIsSendingTestEmail(false);
      setTimeout(() => setTestEmailResult(''), 5000);
    }
  };

  // ─── Machine handlers ───
  const openMachineForm = (machine?: MachineInfo) => {
    setMachineFormError('');
    setEditingMachine(machine ?? null);
    setMachineForm(machine ?? { isActive: true, sortOrder: 0 });
    try { setMachineSpecs(machine?.specs ? JSON.parse(machine.specs) : []); } catch { setMachineSpecs([]); }
    try { setMachineFeatures(machine?.features ? JSON.parse(machine.features) : []); } catch { setMachineFeatures([]); }
    try { setMachineIncluded(machine?.included ? JSON.parse(machine.included) : []); } catch { setMachineIncluded([]); }
    setMachineDocuments(
      (machine?.documents ?? []).map((d) => ({ title: d.title, fileUrl: d.fileUrl }))
    );
    setShowMachineForm(true);
  };

  // Upload a manual/document (PDF or image) and append it to the form list.
  // Title defaults to the filename (sans extension); the admin can rename it.
  const uploadMachineDocument = async (file: File) => {
    setUploadingDoc(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/admin/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Opplasting feilet');
      const defaultTitle = file.name.replace(/\.[^.]+$/, '');
      setMachineDocuments((prev) => [...prev, { title: defaultTitle, fileUrl: data.url }]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Opplasting feilet');
    } finally {
      setUploadingDoc(false);
    }
  };

  // `totpCode` is only ever passed by the TOTP modal retry; button onClick
  // handlers pass a MouseEvent, which must not end up in the header.
  const handleSaveMachine = async (totpCode?: unknown) => {
    setIsSavingMachine(true);
    setMachineFormError('');
    try {
      const body = {
        ...machineForm,
        specs: JSON.stringify(machineSpecs.filter(s => s.label || s.value)),
        features: JSON.stringify(machineFeatures.filter(f => f.title || f.desc)),
        included: JSON.stringify(machineIncluded.filter(Boolean)),
        documents: machineDocuments.filter(d => d.fileUrl),
      };

      const url  = editingMachine ? `/api/admin/machines/${editingMachine.id}` : '/api/admin/machines';
      const method = editingMachine ? 'PATCH' : 'POST';
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (typeof totpCode === 'string' && totpCode) headers['X-Admin-TOTP'] = totpCode;
      const res  = await fetch(url, { method, headers, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && data.requiresTotp) {
        // Price fields changed — defer the save until the TOTP modal yields a code.
        setPendingTotpSave({ kind: 'machine', context: 'Endring av utstyrspriser' });
        return;
      }
      if (!res.ok) throw new Error(data.error || 'Feil ved lagring');
      setShowMachineForm(false);
      await fetchMachines();
      toast.success(editingMachine ? 'Utstyr oppdatert' : 'Utstyr opprettet');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Feil ved lagring');
    } finally {
      setIsSavingMachine(false);
    }
  };

  // Shared PATCH for the isActive toggles. Surfaces failures (expired
  // session, 500, network) instead of silently refetching stale state.
  const patchActive = async (url: string, isActive: boolean, refetch: () => Promise<void>, what: string) => {
    try {
      const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ isActive }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Kunne ikke oppdatere ${what} (HTTP ${res.status}).`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Kunne ikke oppdatere ${what}.`);
    } finally {
      await refetch();
    }
  };

  const handleToggleMachine = (machine: MachineInfo) =>
    patchActive(`/api/admin/machines/${machine.id}`, !machine.isActive, fetchMachines, 'utstyr');

  // ─── Fleet order ───
  // `GET /api/admin/machines` orders by `sortOrder, createdAt`, but nothing in
  // the panel ever wrote `sortOrder`: every machine sat at 0 and the fleet was
  // stuck in creation order, on the customer site as well (P-7).
  //
  // A move renumbers the whole list 0…n-1 rather than swapping two values —
  // with every row at 0, swapping two zeroes changes nothing and the order
  // silently falls back to `createdAt` again.
  const moveMachine = async (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= machines.length || isReorderingMachines) return;
    const next = [...machines];
    [next[index], next[target]] = [next[target], next[index]];
    setIsReorderingMachines(true);
    try {
      for (const [i, m] of next.entries()) {
        if (m.sortOrder === i) continue;
        const res = await fetch(`/api/admin/machines/${m.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ sortOrder: i }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `Kunne ikke endre rekkefølge (HTTP ${res.status}).`);
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Kunne ikke endre rekkefølge.');
    } finally {
      setIsReorderingMachines(false);
      await fetchMachines();
    }
  };

  const handleDeleteMachine = async (id: string) => {
    if (!confirm('Slett utstyr? Dette kan ikke angres.')) return;
    const res = await fetch(`/api/admin/machines/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(data.error || `Kunne ikke slette utstyr (HTTP ${res.status}).`);
      return;
    }
    await fetchMachines();
  };

  // ─── Delete booking ───
  const handleDeleteBooking = async (id: string) => {
    if (!confirm('Slett booking permanent? Dette kan ikke angres.')) return;
    setIsSaving(true);
    try {
      const res = await fetch(`/api/bookings/${id}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) throw new Error((await res.json()).error);
      setShowBookingDetail(false);
      setBookings((prev) => prev.filter((b) => b.id !== id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Feil ved sletting');
    } finally {
      setIsSaving(false);
    }
  };

  // ─── FAQ CRUD ───
  const openFaqForm = (item?: FaqItemData) => {
    setEditingFaq(item ?? null);
    setFaqForm(item ?? { isActive: true, sortOrder: faqItems.length });
    setShowFaqForm(true);
  };
  const handleSaveFaq = async () => {
    setIsSavingFaq(true);
    try {
      const url = editingFaq ? `/api/admin/faq/${editingFaq.id}` : '/api/admin/faq';
      const method = editingFaq ? 'PATCH' : 'POST';
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(faqForm) });
      if (!res.ok) throw new Error((await res.json()).error);
      setShowFaqForm(false);
      await fetchFaq();
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Feil'); } finally { setIsSavingFaq(false); }
  };
  const handleDeleteFaq = async (id: string) => {
    if (!confirm('Slett FAQ-element?')) return;
    await fetch(`/api/admin/faq/${id}`, { method: 'DELETE' });
    await fetchFaq();
  };
  const handleToggleFaq = (item: FaqItemData) =>
    patchActive(`/api/admin/faq/${item.id}`, !item.isActive, fetchFaq, 'FAQ');

  // ─── Terms CRUD ───
  const openTermsForm = (section?: TermsSectionData) => {
    setEditingTerms(section ?? null);
    setTermsForm(section ?? { isActive: true, sortOrder: termsSections.filter((s) => s.audience === 'consumer').length, audience: 'consumer' });
    setShowTermsForm(true);
  };
  const handleSaveTerms = async () => {
    setIsSavingTerms(true);
    try {
      const url = editingTerms ? `/api/admin/terms/${editingTerms.id}` : '/api/admin/terms';
      const method = editingTerms ? 'PATCH' : 'POST';
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(termsForm) });
      if (!res.ok) throw new Error((await res.json()).error);
      setShowTermsForm(false);
      await fetchTerms();
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Feil'); } finally { setIsSavingTerms(false); }
  };
  const handleDeleteTerms = async (id: string) => {
    if (!confirm('Slett vilkårsseksjon?')) return;
    await fetch(`/api/admin/terms/${id}`, { method: 'DELETE' });
    await fetchTerms();
  };
  const handleToggleTerms = (section: TermsSectionData) =>
    patchActive(`/api/admin/terms/${section.id}`, !section.isActive, fetchTerms, 'vilkår');

  // ── B2B quote requests ──
  const openOfferForm = (quote: QuoteRequestData) => {
    setOfferQuote(quote);
    setOfferForm({
      offerAmount: quote.offerAmount != null ? String(quote.offerAmount) : '',
      offerMessage: quote.offerMessage ?? '',
      offerValidUntil: quote.offerValidUntil ? quote.offerValidUntil.slice(0, 10) : '',
      paymentMode: quote.paymentMode === 'invoice' ? 'invoice' : 'card',
      startDate: quote.startDate ? quote.startDate.slice(0, 10) : '',
      rentalType: quote.rentalType ?? 'day',
      customDays: quote.customDays != null ? String(quote.customDays) : '',
    });
    setShowOfferForm(true);
  };
  const handleSendOffer = async () => {
    if (!offerQuote) return;
    setIsSendingOffer(true);
    try {
      const res = await fetch(`/api/admin/quote-requests/${offerQuote.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          action: 'send_offer',
          offerAmount: Number(offerForm.offerAmount),
          offerMessage: offerForm.offerMessage,
          offerValidUntil: offerForm.offerValidUntil || undefined,
          paymentMode: offerForm.paymentMode,
          startDate: offerForm.startDate || undefined,
          rentalType: offerForm.rentalType || undefined,
          customDays: offerForm.rentalType === 'custom' && offerForm.customDays ? Number(offerForm.customDays) : undefined,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Kunne ikke sende tilbud');
      setShowOfferForm(false);
      await fetchQuoteRequests();
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Feil'); } finally { setIsSendingOffer(false); }
  };
  const handleQuoteStatus = async (quote: QuoteRequestData, status: string) => {
    await fetch(`/api/admin/quote-requests/${quote.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ action: 'set_status', status }),
    });
    await fetchQuoteRequests();
  };
  const handleDeleteQuote = async (id: string) => {
    if (!confirm('Slett forespørsel?')) return;
    await fetch(`/api/admin/quote-requests/${id}`, { method: 'DELETE', credentials: 'include' });
    await fetchQuoteRequests();
  };
  const b2bEnabled = appConfigs.find((c) => c.key === 'b2bEnabled')?.value === 'true';
  const newQuoteCount = quoteRequests.filter((q) => q.status === 'ny').length;
  const pendingReviewCount = reviews.filter((r) => r.status === 'submitted').length;

  // ─── Insurance CRUD ───
  const openInsuranceForm = (card?: InsuranceCardData) => {
    setEditingInsurance(card ?? null);
    setInsuranceForm(card ?? { isActive: true, sortOrder: insuranceCards.length });
    setShowInsuranceForm(true);
  };
  const handleSaveInsurance = async () => {
    setIsSavingInsurance(true);
    try {
      const url = editingInsurance ? `/api/admin/insurance/${editingInsurance.id}` : '/api/admin/insurance';
      const method = editingInsurance ? 'PATCH' : 'POST';
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(insuranceForm) });
      if (!res.ok) throw new Error((await res.json()).error);
      setShowInsuranceForm(false);
      await fetchInsurance();
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Feil'); } finally { setIsSavingInsurance(false); }
  };
  const handleDeleteInsurance = async (id: string) => {
    if (!confirm('Slett forsikringskort?')) return;
    await fetch(`/api/admin/insurance/${id}`, { method: 'DELETE' });
    await fetchInsurance();
  };
  const handleToggleInsurance = (card: InsuranceCardData) =>
    patchActive(`/api/admin/insurance/${card.id}`, !card.isActive, fetchInsurance, 'forsikringskort');

  // ─── Checklist template CRUD ───
  const buildPhasePayload = buildChecklistPhasePayload;

  const openPhaseForm = (phase?: ChecklistPhaseData) => {
    setShowBookingDetail(false);
    setShowItemForm(false);
    setEditingPhase(phase ?? null);
    setPhaseForm(phase ?? {
      isActive: true,
      sortOrder: checklistPhases.length,
      appliesTo: 'all',
      audience: 'operator',
      intervalMode: 'once',
      intervalHours: 24,
    });
    setPhaseFormError('');
    setShowPhaseForm(true);
  };
  const handleSavePhase = async () => {
    const payload = buildPhasePayload(phaseForm);
    if (!payload.name) {
      setPhaseFormError('Navn må fylles ut.');
      return;
    }
    setPhaseFormError('');
    setIsSavingPhase(true);
    try {
      const url = editingPhase ? `/api/admin/checklist-phases/${editingPhase.id}` : '/api/admin/checklist-phases';
      const method = editingPhase ? 'PATCH' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Lagring feilet (${res.status})`);
      setShowPhaseForm(false);
      setEditingPhase(null);
      await fetchChecklistTemplate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Feil';
      setPhaseFormError(msg);
      toast.error(msg);
    } finally {
      setIsSavingPhase(false);
    }
  };
  const handleDeletePhase = async (id: string) => {
    if (!confirm('Slett fase og alle punkter i den?')) return;
    await fetch(`/api/admin/checklist-phases/${id}`, { method: 'DELETE', credentials: 'include' });
    await fetchChecklistTemplate();
  };
  const handleTogglePhase = (phase: ChecklistPhaseData) =>
    patchActive(`/api/admin/checklist-phases/${phase.id}`, !phase.isActive, fetchChecklistTemplate, 'fase');

  const openItemForm = (phaseId: string, item?: ChecklistItemData) => {
    setShowBookingDetail(false);
    setShowPhaseForm(false);
    setEditingItem(item ?? null);
    const phase = checklistPhases.find((p) => p.id === phaseId);
    const nextSort = phase ? phase.items.length : 0;
    setItemForm(item ? { ...item } : { isActive: true, sortOrder: nextSort, phaseId, answerType: 'checkbox' });
    setItemFormError('');
    setShowItemForm(true);
  };
  const handleSaveItem = async () => {
    if (!itemForm.phaseId) {
      setItemFormError('Mangler fase — lukk og prøv igjen.');
      return;
    }
    if (!itemForm.label?.trim()) {
      setItemFormError('Beskrivelse må fylles ut.');
      return;
    }
    setItemFormError('');
    setIsSavingItem(true);
    try {
      const conditionItemId = itemForm.conditionItemId || null;
      const conditionValue = conditionItemId ? (itemForm.conditionValue || null) : null;
      const numeric = (itemForm.answerType ?? 'checkbox') === 'number' || (itemForm.answerType ?? 'checkbox') === 'measurement';
      const common = {
        label: itemForm.label.trim(),
        answerType: itemForm.answerType ?? 'checkbox',
        unit: itemForm.answerType === 'measurement' ? (itemForm.unit?.trim() || null) : null,
        sortOrder: itemForm.sortOrder ?? 0,
        isActive: itemForm.isActive ?? true,
        conditionItemId,
        conditionValue,
        statKey: numeric ? (itemForm.statKey?.trim() || null) : null,
        minPhotos: (itemForm.answerType ?? 'checkbox') === 'photo'
          ? Math.max(1, itemForm.minPhotos ?? 1)
          : null,
      };
      const payload = editingItem
        ? common
        : { phaseId: itemForm.phaseId, ...common };
      const url = editingItem ? `/api/admin/checklist-items/${editingItem.id}` : '/api/admin/checklist-items';
      const method = editingItem ? 'PATCH' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Lagring feilet (${res.status})`);
      setShowItemForm(false);
      setEditingItem(null);
      await fetchChecklistTemplate();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Feil';
      setItemFormError(msg);
      toast.error(msg);
    } finally {
      setIsSavingItem(false);
    }
  };
  const handleDeleteItem = async (id: string) => {
    if (!confirm('Slett sjekklistepunkt?')) return;
    await fetch(`/api/admin/checklist-items/${id}`, { method: 'DELETE', credentials: 'include' });
    await fetchChecklistTemplate();
  };
  const handleToggleChecklistItem = (item: ChecklistItemData) =>
    patchActive(`/api/admin/checklist-items/${item.id}`, !item.isActive, fetchChecklistTemplate, 'sjekklistepunkt');

  // ─── Copy field helper ───
  const copyField = (value: string, fieldId: string) => {
    navigator.clipboard.writeText(value).then(() => {
      setCopiedField(fieldId);
      setTimeout(() => setCopiedField(null), 1500);
    });
  };

  // ─── Calendar helpers ───
  const getCalendarDays = () => {
    const { year, month } = calendarMonth;
    const firstDay = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    let startDow = firstDay.getDay() - 1;
    if (startDow < 0) startDow = 6;

    const days: (Date | null)[] = [];
    for (let i = 0; i < startDow; i++) days.push(null);
    for (let d = 1; d <= daysInMonth; d++) days.push(new Date(year, month, d));
    return days;
  };

  const prevMonth = () => {
    monthPickedByAdmin.current = true;
    setCalendarMonth((prev) => {
      const m = prev.month - 1;
      if (m < 0) return { year: prev.year - 1, month: 11 };
      return { ...prev, month: m };
    });
    setSelectedDates(new Set());
    setHoverDates(new Set());
  };

  const nextMonth = () => {
    monthPickedByAdmin.current = true;
    setCalendarMonth((prev) => {
      const m = prev.month + 1;
      if (m > 11) return { year: prev.year + 1, month: 0 };
      return { ...prev, month: m };
    });
    setSelectedDates(new Set());
    setHoverDates(new Set());
  };

  // ─── Day click handlers ───
  const handleDayClick = (date: Date) => {
    const dateStr = toDateStr(date);
    const todayStr = toDateStr(new Date());
    if (dateStr < todayStr) return;

    if (selectionMode === 'day') {
      setSelectedDates((prev) => {
        const next = new Set(prev);
        if (next.has(dateStr)) next.delete(dateStr);
        else next.add(dateStr);
        return next;
      });
    } else if (selectionMode === 'week') {
      const weekDates = getWeekDates(dateStr);
      setSelectedDates((prev) => {
        const next = new Set(prev);
        const allSelected = weekDates.every((d) => next.has(d));
        if (allSelected) {
          weekDates.forEach((d) => next.delete(d));
        } else {
          weekDates.forEach((d) => {
            if (d >= todayStr) next.add(d);
          });
        }
        return next;
      });
    } else if (selectionMode === 'month') {
      const monthDates = getMonthDates(calendarMonth.year, calendarMonth.month);
      setSelectedDates((prev) => {
        const next = new Set(prev);
        const allSelected = monthDates.every((d) => next.has(d));
        if (allSelected) {
          monthDates.forEach((d) => next.delete(d));
        } else {
          monthDates.forEach((d) => {
            if (d >= todayStr) next.add(d);
          });
        }
        return next;
      });
    }
  };

  const handleDayHover = (date: Date) => {
    if (selectionMode === 'day') {
      setHoverDates(new Set([toDateStr(date)]));
    } else if (selectionMode === 'week') {
      setHoverDates(new Set(getWeekDates(toDateStr(date))));
    } else if (selectionMode === 'month') {
      setHoverDates(new Set(getMonthDates(calendarMonth.year, calendarMonth.month)));
    }
  };

  // ─── Block/unblock actions ───
  const handleBlockDates = async () => {
    setIsSaving(true);
    try {
      const datesArray = Array.from(selectedDates).sort();
      const res = await fetch('/api/unavailable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dates: datesArray, reason: reason || null }),
      });
      const data = await res.json().catch(() => ({}));
      // Surface backend-skipped dates (already booked) so the admin
      // understands WHY some dates didn't get blocked.
      if (Array.isArray(data.skipped) && data.skipped.length > 0) {
        const list = data.skipped
          .map((d: string) => new Date(d + 'T00:00:00').toLocaleDateString('nb-NO', { day: 'numeric', month: 'short' }))
          .join(', ');
        toast.warning(`${data.skipped.length} dato(er) hoppet over (allerede booket):\n${list}\n\nDe øvrige ${data.created?.length ?? 0} dato(er) ble blokkert.`);
      }
      setSelectedDates(new Set());
      setReason('');
      setShowConfirmBlock(false);
      await fetchData();
    } catch {
      // Error handling
    } finally {
      setIsSaving(false);
    }
  };

  const handleUnblockDate = async (dateStr: string) => {
    const ud = unavailableDates.find((u) => u.date === dateStr);
    if (!ud) return;

    try {
      await fetch('/api/unavailable', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [ud.id] }),
      });
      await fetchData();
    } catch {
      // Error handling
    }
  };

  const handleUnblockSelected = async () => {
    const idsToUnblock = unavailableDates
      .filter((u) => selectedDates.has(u.date))
      .map((u) => u.id);

    if (idsToUnblock.length === 0) return;

    try {
      await fetch('/api/unavailable', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: idsToUnblock }),
      });
      setSelectedDates(new Set());
      await fetchData();
    } catch {
      // Error handling
    }
  };

  // ─── Booking detail ───
  const openBookingDetail = (booking: BookingInfo) => {
    setSelectedBooking(booking);
    setShowBookingDetail(true);
  };

  const handleBookingStatus = async (
    id: string,
    status: string,
    reason?: string,
  ) => {
    setIsSaving(true);
    try {
      const res = await fetch(`/api/bookings/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status, reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Oppdatering feilet');
      await fetchData();
      if (selectedBooking?.id === id && data.booking) {
        const b = data.booking;
        setSelectedBooking({
          ...selectedBooking,
          ...b,
          startDate: toDateStr(new Date(b.startDate)),
          fullyPaidAt: b.fullyPaidAt,
        });
      }
      if (status === 'cancelled') {
        setShowCancelDialog(false);
        setCancelReason('');
        setShowBookingDetail(false);
        // Keep the booking the admin just cancelled on screen. Closing the
        // drawer and dropping the row out of the list at the same time is how
        // it became unreachable — and `Slett` with it (P-1).
        setShowCancelled(true);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Noe gikk galt');
    } finally {
      setIsSaving(false);
    }
  };

  const handleLogout = async () => {
    await fetch('/api/admin/logout', { method: 'POST' });
    window.location.href = '/admin/login';
  };

  // ─── Render ───
  const calendarDays = getCalendarDays();
  const todayStr = today ? toDateStr(today) : '';

  // Stats
  const pendingBookings = bookings.filter((b) => b.status === 'pending');
  const confirmedBookings = bookings.filter((b) => b.status === 'confirmed');
  const blockedInMonth = unavailableDates.length;

  // Tilgjengelige dager — correct formula
  const availableDaysCount = (() => {
    const { year, month } = calendarMonth;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const now = today ?? new Date();
    let pastDays = 0;
    if (year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth())) {
      pastDays = daysInMonth;
    } else if (year === now.getFullYear() && month === now.getMonth()) {
      pastDays = Math.min(now.getDate() - 1, daysInMonth);
    }
    const mm = String(month + 1).padStart(2, '0');
    const occupiedDates = new Set([
      ...unavailableDates.map((u) => u.date),
      ...Array.from(bookingDateMap.keys()),
    ]);
    const occupiedThisMonth = Array.from(occupiedDates).filter((d) => d.startsWith(`${year}-${mm}`)).length;
    return Math.max(0, daysInMonth - pastDays - occupiedThisMonth);
  })();

  // Belegg % — confirmed bookings as a fraction of bookable days this month
  // (days in month minus blocked days, never below 1 to avoid div/0).
  const usagePercentMonth = (() => {
    const { year, month } = calendarMonth;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const denom = Math.max(1, daysInMonth - blockedInMonth);
    const mm = String(month + 1).padStart(2, '0');
    const confirmedDates = Array.from(bookingDateMap.keys()).filter((d) => d.startsWith(`${year}-${mm}`));
    return Math.round((confirmedDates.length / denom) * 100);
  })();

  // Financial stats
  // Revenue counted from confirmed + completed bookings whose rental starts in
  // the given month. Shared helper so the stat card, the trend, and the
  // 6-month chart all agree on one definition of "omsetning".
  const revenueForMonth = (year: number, month: number) =>
    bookings
      .filter((b) => {
        const start = new Date(b.startDate);
        return (b.status === 'confirmed' || b.status === 'completed') &&
          start.getMonth() === month && start.getFullYear() === year;
      })
      .reduce((sum, b) => sum + b.totalPrice, 0);

  const monthConfirmedBookings = bookings.filter((b) => {
    const start = new Date(b.startDate);
    return (b.status === 'confirmed' || b.status === 'completed') &&
      start.getMonth() === calendarMonth.month && start.getFullYear() === calendarMonth.year;
  });
  const monthConfirmedRevenue = monthConfirmedBookings.reduce((sum, b) => sum + b.totalPrice, 0);
  const avgBookingValueMonth = monthConfirmedBookings.length > 0
    ? Math.round(monthConfirmedRevenue / monthConfirmedBookings.length)
    : 0;

  // 6-month revenue series ending at the displayed month (oldest → current).
  const monthlyRevenueSeries = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(calendarMonth.year, calendarMonth.month - (5 - i), 1);
    return {
      label: NORWEGIAN_MONTH_NAMES[d.getMonth()].slice(0, 3),
      value: revenueForMonth(d.getFullYear(), d.getMonth()),
    };
  });

  // Month-over-month revenue trend for the "Inntekt" card.
  const prevMonthRevenue = monthlyRevenueSeries[monthlyRevenueSeries.length - 2]?.value ?? 0;
  const revenueTrend: 'up' | 'down' | null =
    monthConfirmedRevenue > prevMonthRevenue ? 'up'
    : monthConfirmedRevenue < prevMonthRevenue ? 'down'
    : null;
  // Only meaningful when both months have revenue; an empty current month
  // would otherwise read as an alarming "-100 %".
  const revenueDeltaPct = prevMonthRevenue > 0 && monthConfirmedRevenue > 0
    ? Math.round(((monthConfirmedRevenue - prevMonthRevenue) / prevMonthRevenue) * 100)
    : null;

  // Confirmed bookings still awaiting full payment — money left to collect.

  const totalCompletedCount = bookings.filter(b => b.status === 'completed').length;
  const totalCancelledCount = bookings.filter(b => b.status === 'cancelled').length;

  // Subtitles for stat cards.
  const oldestPendingHoursAgo = (() => {
    if (pendingBookings.length === 0) return null;
    const oldest = pendingBookings.reduce<typeof pendingBookings[number] | null>((acc, b) => {
      const dt = b.createdAt ? new Date(b.createdAt).getTime() : null;
      if (dt == null) return acc;
      if (!acc || dt < new Date(acc.createdAt!).getTime()) return b;
      return acc;
    }, null);
    if (!oldest?.createdAt) return null;
    const hours = Math.max(0, Math.floor((Date.now() - new Date(oldest.createdAt).getTime()) / 3_600_000));
    return hours;
  })();
  const nextConfirmedDaysAway = (() => {
    const now = Date.now();
    const upcoming = bookings
      .filter(b => b.status === 'confirmed' && new Date(b.startDate + 'T00:00:00').getTime() >= now)
      .sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
    if (!upcoming) return null;
    return Math.ceil((new Date(upcoming.startDate + 'T00:00:00').getTime() - now) / 86_400_000);
  })();

  return (
    <div className="min-h-screen bg-background">
      {/* ═══ NAV ═══ */}
      <nav className="sticky top-0 z-50 bg-background/80 backdrop-blur-md border-b border-border">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <a href="/" className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="w-4 h-4" />
              <span className="text-sm">Tilbake</span>
            </a>
            <Separator orientation="vertical" className="h-6" />
            <div className="flex items-center gap-2">
              {appConfigs.length === 0 ? (
                // Config not loaded yet — reserve the space instead of flashing
                // the 'G' fallback before the real logo arrives.
                <span className="w-9 h-9 shrink-0" aria-hidden />
              ) : adminLogoInHeader && adminLogoUrl ? (
                <img src={adminLogoUrl} alt={adminBusinessName} className="h-9 w-auto object-contain" />
              ) : (
                <GraveklarMark className="w-11 h-11" />
              )}
              <span className="font-bold text-xl tracking-tight text-foreground">{adminBusinessName}</span>
              <Badge variant="secondary" className="ml-1">Admin</Badge>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a href="/admin/discount-codes" title="Rabattkoder" className="inline-flex items-center justify-center w-9 h-9 rounded-md border border-border hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
              <Star className="w-4 h-4" />
            </a>
            <a href="/admin/survey" title="Behovsundersøkelse" className="inline-flex items-center justify-center w-9 h-9 rounded-md border border-border hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
              <FlaskConical className="w-4 h-4" />
            </a>
            <a href="/admin/audit-log" title="Revisjonslogg" className="inline-flex items-center justify-center w-9 h-9 rounded-md border border-border hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
              <Activity className="w-4 h-4" />
            </a>
            <AdminThemeMenu />
            <Button variant="outline" size="icon" onClick={handleLogout} title="Logg ut" aria-label="Logg ut">
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </nav>

      <main className="max-w-6xl mx-auto px-4 py-8">
        {/* Tabs */}
        <div className="flex flex-wrap gap-2 mb-8">
          {([
            { id: 'calendar',   label: 'Kalender & Bookinger', Icon: Calendar  },
            ...(b2bEnabled ? [{ id: 'forespørsler' as const, label: 'Forespørsler', Icon: Building2 }] : []),
            { id: 'pricing',    label: 'Priser',               Icon: Settings  },
            { id: 'machines',   label: 'Utstyr',               Icon: Tractor   },
            { id: 'content',    label: 'Innhold',              Icon: FileText  },
            { id: 'checklists', label: 'Sjekklister',          Icon: ListChecks },
            { id: 'omtaler',    label: 'Omtaler',              Icon: Star      },
            { id: 'settings',   label: 'Innstillinger',        Icon: Settings  },
          ] as { id: AdminTab; label: string; Icon: React.ElementType }[]).map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => {
                setShowBookingDetail(false);
                setActiveTab(id);
              }}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                activeTab === id
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
              }`}
            >
              <Icon className="w-4 h-4 inline mr-2" />
              {label}
              {id === 'forespørsler' && newQuoteCount > 0 && (
                <span className="ml-2 inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-red-500 text-white text-xs font-semibold">
                  {newQuoteCount}
                </span>
              )}
              {id === 'omtaler' && pendingReviewCount > 0 && (
                <span className="ml-2 inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-red-500 text-white text-xs font-semibold">
                  {pendingReviewCount}
                </span>
              )}
            </button>
          ))}

        </div>

        {/* ═══ PRICING CONFIG TAB ═══ */}
        {activeTab === 'pricing' && (
          <div className="flex flex-col gap-4">
          {/* Say the 2FA requirement out loud BEFORE anything is edited.
              Previously the first sign of it was an enrolment dialog thrown up
              by the Lagre button, after the admin had already changed values —
              they could neither finish the save nor tell what state the panel
              was in. */}
          {!totpEnrolled && (
            <SecurityBanner
              enrolled={false}
              onSetup={() => setShowTotpSetup(true)}
              onReset={() => {}}
            />
          )}
          <div className="flex flex-col lg:flex-row gap-6">
            {/* Sidebar */}
            <aside className="lg:w-52 shrink-0">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-1">Prisgrupper</div>
              <div className="flex lg:flex-col gap-1 overflow-x-auto lg:overflow-visible pb-2 lg:pb-0">
                {GROUP_ORDER.map((group) => {
                  const groupConfigs = sortPricingKeys(group, pricingConfigs.filter((c) => c.group === group));
                  if (groupConfigs.length === 0) return null;
                  const hasUnsaved = dirtyPricingKeys.some((k) => pricingGroupByKey.get(k) === group);
                  const Icon = PRICING_GROUP_ICONS[group] || Settings;
                  return (
                    <button
                      key={group}
                      onClick={() => selectPricingGroup(group)}
                      className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm whitespace-nowrap lg:w-full transition-all ${
                        activePricingGroup === group
                          ? 'bg-primary text-primary-foreground shadow-sm'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                      }`}
                    >
                      <Icon className="w-4 h-4 shrink-0" />
                      <span className="flex-1 text-left font-medium">{GROUP_LABELS[group] || group}</span>
                      {hasUnsaved && <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />}
                    </button>
                  );
                })}
                {/* Avbestillingsregler (cancelFreeWeeks/cancelFreeDays/
                    cancelLatePercent/cancelSameDayPercent) aren't priced
                    here — they live in Innstillinger → Booking. Quick-jump
                    so an admin looking for them in Prisgrupper lands in the
                    right place instead of a dead end. */}
                <button
                  onClick={() => { setActiveTab('settings'); selectSettingsGroup('booking'); }}
                  className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm whitespace-nowrap lg:w-full transition-all text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <XCircle className="w-4 h-4 shrink-0" />
                  <span className="flex-1 text-left font-medium">Avbestilling</span>
                  <ArrowUpRight className="w-3.5 h-3.5 shrink-0 opacity-60" />
                </button>
              </div>
            </aside>

            {/* Content panel */}
            <div className="flex-1 min-w-0">
              {GROUP_ORDER.map((group) => {
                if (group !== activePricingGroup) return null;
                const groupConfigs = sortPricingKeys(group, pricingConfigs.filter((c) => c.group === group));
                if (groupConfigs.length === 0) return null;
                const Icon = PRICING_GROUP_ICONS[group] || Settings;
                return (
                  <div key={group}>
                    <div className="mb-5">
                      <h2 className="text-xl font-bold tracking-tight flex items-center gap-2">
                        <Icon className="w-5 h-5 text-primary" />
                        {GROUP_LABELS[group] || group}
                      </h2>
                    </div>

                    {/* Success is reported by the SaveBar at the bottom of the
                        panel, next to the button that produced it — a banner up
                        here said the same thing where nobody was looking.
                        Errors stay: they need to be seen from anywhere. */}
                    {configError && (
                      <div className="mb-4 p-3 rounded-xl bg-red-50 border border-red-200 text-red-800 text-sm flex items-center gap-2">
                        <AlertCircle className="w-4 h-4 shrink-0" />{configError}
                      </div>
                    )}

                    <Card>
                      <CardContent className="pt-5 space-y-5">
                        {groupConfigs.map((configItem) => {
                          // Which fields are kroner. Deliberately no
                          // `includes('Rate')`: the only two rate keys that
                          // hold kroner are named below, and the pattern also
                          // caught `mvaRate` — a percentage, rendered as
                          // "25 … ≈ 20 kr eks. MVA" (P-9).
                          const isPriceLike =
                            configItem.key.includes('Price') || configItem.key.includes('Fee') || configItem.key.includes('deposit') || configItem.key.includes('PerKm') || configItem.key.includes('Hourly') || configItem.key === 'overtimeRate' || configItem.key === 'preOrderHourRate';
                          // Show the MVA counterpart inline so admins can
                          // compare without doing the math by hand. Uses live
                          // mvaRate + pricesIncludeMva from the same Priser
                          // tab (falls back to defaults if those fields are
                          // mid-edit and not yet saved).
                          const editedNum = Number(editedValues[configItem.key]);
                          const currentNum = Number.isFinite(editedNum) ? editedNum : configItem.value;
                          const mvaRateLive = Number(editedValues['mvaRate'] ?? pricingConfigs.find((c) => c.key === 'mvaRate')?.value ?? 25) || 25;
                          const inclLive = (Number(editedValues['pricesIncludeMva'] ?? pricingConfigs.find((c) => c.key === 'pricesIncludeMva')?.value ?? 1) || 0) > 0;
                          const factor = 1 + mvaRateLive / 100;
                          const counterpart = isPriceLike
                            ? inclLive
                              ? `≈ ${Math.round(currentNum / factor).toLocaleString('nb-NO')} kr eks. MVA`
                              : `≈ ${Math.round(currentNum * factor).toLocaleString('nb-NO')} kr inkl. MVA`
                            : null;
                          return (
                            <FieldRow
                              key={configItem.key}
                              label={configItem.label}
                              locked
                              hint={counterpart ?? undefined}
                            >
                              <PricingFieldControl
                                field={configItem}
                                current={currentNum}
                                onChange={(n) =>
                                  setEditedValues((prev) => ({ ...prev, [configItem.key]: String(n) }))
                                }
                              />
                            </FieldRow>
                          );
                        })}
                      </CardContent>
                    </Card>

                    {/* Levering sub-card: baseAddress lives in AppConfig but
                        renders here next to the numeric delivery rates, so
                        the admin sees one cohesive "Levering" view. On save
                        the address is geocoded and the derived lat/lng land
                        in SystemState (not AppConfig). Same autocomplete
                        dropdown that the customer-facing booking form uses. */}
                    {group === 'delivery' && (
                      <Card className="mt-4">
                        <CardContent className="pt-5 space-y-3">
                          <AdminBaseAddressField
                            initial={appConfigs.find((c) => c.key === 'baseAddress')?.value ?? ''}
                            edited={editedAppValues['baseAddress']}
                            setEdited={(v) => setEditedAppValues((p) => ({ ...p, baseAddress: v }))}
                            onSave={() => handleSaveAppConfig(undefined, 'delivery')}
                            isSaving={isSavingApp}
                            saved={appConfigSaved}
                          />
                        </CardContent>
                      </Card>
                    )}

                    <SaveBar
                      dirtyCount={dirtyPricingKeys.length}
                      isSaving={isSavingConfig}
                      justSaved={configSaved}
                      onSave={() => handleSaveConfig()}
                      onReset={() => { setConfigError(''); void fetchPricingConfig(); }}
                      hint={
                        dirtyPricingKeys.some((k) => pricingGroupByKey.get(k) !== group)
                          ? 'Lagrer alle prisgrupper – du har også endringer i en annen gruppe.'
                          : undefined
                      }
                    />

                    <Card className="mt-4 bg-muted/40 border-dashed">
                      <CardContent className="p-3 flex items-start gap-2">
                        <Info className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
                        <p className="text-xs text-muted-foreground">Prisendringer trer i kraft umiddelbart for nye bookinger. Eksisterende bookinger beholder opprinnelig pris.</p>
                      </CardContent>
                    </Card>
                  </div>
                );
              })}
            </div>
          </div>
          </div>
        )}

        {/* ═══ CALENDAR TAB ═══ */}
        {activeTab === 'calendar' && (
          <>
            {/* Setup banner for new operators */}
            {!isLoading && machines.length === 0 && (
              <Card className="mb-8 border-blue-300 bg-blue-50 dark:bg-blue-950/20 dark:border-blue-800">
                <CardContent className="p-4">
                  <div className="font-semibold text-sm mb-2 flex items-center gap-2">
                    <Info className="w-4 h-4 text-blue-600" /> Kom i gang
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                    <button onClick={() => setActiveTab('machines')} className="flex items-center gap-2 p-2 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors text-left">
                      <span className={`w-5 h-5 rounded-full border-2 flex items-center justify-center text-xs ${machines.length > 0 ? 'border-green-500 bg-green-500 text-white' : 'border-blue-400'}`}>
                        {machines.length > 0 ? '✓' : '1'}
                      </span>
                      Legg til utstyr
                    </button>
                    <button onClick={() => { setActiveTab('settings'); selectSettingsGroup('stripe'); }} className="flex items-center gap-2 p-2 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors text-left">
                      <span className="w-5 h-5 rounded-full border-2 border-blue-400 flex items-center justify-center text-xs">2</span>
                      Konfigurer Stripe
                    </button>
                    <button onClick={() => { setActiveTab('settings'); selectSettingsGroup('smtp'); }} className="flex items-center gap-2 p-2 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors text-left">
                      <span className="w-5 h-5 rounded-full border-2 border-blue-400 flex items-center justify-center text-xs">3</span>
                      Sett opp e-post
                    </button>
                    <button onClick={() => { setActiveTab('settings'); selectSettingsGroup('business'); }} className="flex items-center gap-2 p-2 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors text-left">
                      <span className="w-5 h-5 rounded-full border-2 border-blue-400 flex items-center justify-center text-xs">4</span>
                      Fyll inn virksomhetsinfo
                    </button>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Next booking + active checklist (combined banner) */}
            {(() => {
              const now = new Date();
              // LOCAL date — must match how booking.startDate is formatted
              // (toDateStr, Norway-local). Using UTC here would put "today" a
              // day behind just after local midnight, leaving the delivery
              // checklist disabled on the actual delivery day.
              const todayStr = toDateStr(now);
              // End-of-rental (return day) for a booking, honoring multi-week customDays.
              const returnDateOf = (b: BookingInfo) => {
                const start = new Date(b.startDate + 'T00:00:00');
                start.setDate(start.getDate() + rentalDayCount(b.rentalType as RentalType, b.customDays));
                return toDateStr(start);
              };
              // Keep a booking on this card through its entire window (prep →
              // delivery → mid-rental → return). Comparing by date STRING — not
              // a timestamp — so the booking doesn't drop off the moment the
              // clock ticks past midnight on its start day (which previously
              // hid it the whole delivery day and skipped to the next booking).
              const upcoming = bookings
                .filter(b => b.status === 'confirmed' && returnDateOf(b) >= todayStr)
                .sort((a, b) => a.startDate.localeCompare(b.startDate));
              if (upcoming.length === 0) return null;
              const next = upcoming[0];
              const daysUntil = Math.max(0, Math.ceil((new Date(next.startDate + 'T00:00:00').getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));

              const endDate = returnDateOf(next);

              const activePhases = filterPhasesForBooking(checklistPhases, next);

              const phaseByKeyword = (re: RegExp, fallbackIdx: number) =>
                activePhases.find(p => re.test(p.name)) ?? activePhases[fallbackIdx] ?? null;
              const prepPhase  = phaseByKeyword(/klargjør|forbered|prep/i, 0);
              const delivPhase = phaseByKeyword(/lever|utlever|delivery/i, Math.min(1, activePhases.length - 1));
              const returPhase = findCompletionTriggerPhase(checklistPhases, next)
                ?? phaseByKeyword(/retur|hent|return|pickup/i, activePhases.length - 1);

              const flowCtx = buildRentalFlowContext({
                booking: {
                  ...next,
                  termsAcceptedAt: next.termsAcceptedAt ? new Date(next.termsAcceptedAt) : null,
                  fullyPaidAt: next.fullyPaidAt ? new Date(next.fullyPaidAt) : null,
                  contractSentAt: next.contractSentAt ? new Date(next.contractSentAt) : null,
                  contractSignedAt: next.contractSignedAt ? new Date(next.contractSignedAt) : null,
                },
                phases: checklistPhases,
                todayStr,
                endDate,
              });
              const flow = computeRentalFlow(flowCtx);
              const signingView = flowCtx.signing;
              const signingLabel = contractSigningLabel(signingView);
              const signingTone = contractSigningTone(signingView);

              const prepDone = flowCtx.prepDone;
              const delivDone = flowCtx.handoverDone;
              const returDone = flowCtx.returnDone;

              type BannerState = {
                label: string;
                tone: 'amber' | 'emerald' | 'slate' | 'rose';
                action: { phase: typeof activePhases[number]; disabled: boolean; label: string; blockedReason?: string } | null;
              };
              const state: BannerState = (() => {
                if (!flowCtx.handoverAllowed) {
                  return {
                    label: flow.label,
                    tone: flow.tone === 'rose' ? 'rose' : 'amber',
                    action: null,
                  };
                }

                if (flow.step === 'prep' && prepPhase) {
                  return {
                    label: `${prepPhase.name} pågår nå`,
                    tone: 'amber',
                    action: { phase: prepPhase, disabled: false, label: `Start ${prepPhase.name.toLowerCase()}` },
                  };
                }

                if (flow.step === 'handover' && delivPhase && !delivDone) {
                  const disabled = todayStr < next.startDate;
                  return {
                    label: flow.label,
                    tone: 'amber',
                    action: {
                      phase: delivPhase,
                      disabled,
                      label: `Start ${delivPhase.name.toLowerCase()}`,
                      blockedReason: disabled ? 'Tilgjengelig på startdato' : undefined,
                    },
                  };
                }

                if (delivDone && delivPhase && !returDone && returPhase) {
                  return {
                    label: `${delivPhase.name} ferdig`,
                    tone: flow.step === 'return' ? 'amber' : 'emerald',
                    action: {
                      phase: returPhase,
                      disabled: false,
                      label: `Start ${returPhase.name.toLowerCase()}`,
                    },
                  };
                }

                if (returDone) {
                  return { label: 'Retur fullført', tone: 'emerald', action: null };
                }

                return {
                  label: flow.label,
                  tone: flow.tone === 'rose' ? 'rose' : flow.tone,
                  action: returPhase
                    ? { phase: returPhase, disabled: false, label: `Start ${returPhase.name.toLowerCase()}` }
                    : null,
                };
              })();

              const pillTone =
                state.tone === 'amber'   ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300' :
                state.tone === 'emerald' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' :
                state.tone === 'rose'    ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300' :
                                            'bg-slate-500/15 text-slate-700 dark:text-slate-300';
              const signingPillTone =
                signingTone === 'emerald' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' :
                signingTone === 'amber'   ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300' :
                signingTone === 'rose'    ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300' :
                                            'bg-slate-500/15 text-slate-700 dark:text-slate-300';

              return (
                <Card className="mb-6 border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/20">
                  <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center gap-4">
                    <button
                      type="button"
                      onClick={() => openBookingDetail(next)}
                      className="flex items-center gap-4 flex-1 min-w-0 text-left hover:opacity-90"
                    >
                      <div className="w-14 h-14 rounded-xl bg-blue-500 text-white flex flex-col items-center justify-center shrink-0">
                        <div className="text-xl font-bold leading-none tabular-nums">{daysUntil}</div>
                        <div className="text-[10px] leading-none mt-0.5">dager</div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-sm">Neste booking: {next.reference}</span>
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md ${pillTone} text-[11px] font-medium`}>
                            <ListChecks className="w-3 h-3" /> {state.label}
                          </span>
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md ${signingPillTone} text-[11px] font-medium`}>
                            <FileText className="w-3 h-3" /> {signingLabel}
                          </span>
                          {next.selfPickup && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-violet-500/15 text-violet-700 dark:text-violet-300 text-[11px] font-medium">
                              Selvhenting
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {next.name} · {rentalDaysLabel(next.rentalType, next.customDays)} · {new Date(next.startDate + 'T00:00:00').toLocaleDateString('nb-NO', { weekday: 'long', day: 'numeric', month: 'long' })}
                        </div>
                      </div>
                    </button>
                    <div className="flex items-center gap-3 shrink-0">
                      <div className="text-right">
                        <div className="font-bold text-primary tabular-nums">{next.totalPrice.toLocaleString('nb-NO')} kr</div>
                        <div className="text-xs text-muted-foreground">{next.fullyPaidAt ? 'Betalt' : 'Ikke betalt'}</div>
                      </div>
                      {state.action && (
                        state.action.disabled ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled
                            className="gap-1.5 opacity-50 cursor-not-allowed"
                            title={state.action.blockedReason ?? 'Tilgjengelig på riktig dato'}
                          >
                            <ListChecks className="w-4 h-4" />
                            {state.action.label}
                          </Button>
                        ) : (
                          <a href={`/admin/checklist/${next.id}`} target="_blank" rel="noopener">
                            <Button size="sm" className="bg-amber-600 hover:bg-amber-700 text-white gap-1.5">
                              <ListChecks className="w-4 h-4" />
                              {state.action.label}
                            </Button>
                          </a>
                        )
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })()}
            {/* Stats — compact clickable cards. Each opens a drill-down
                drawer or scrolls to the calendar grid. */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
              <StatCard
                size="sm"
                Icon={Clock}
                tone="amber"
                value={String(pendingBookings.length)}
                label="Venter betaling"
                sub={pendingBookings.length === 0
                  ? 'Ingen'
                  : oldestPendingHoursAgo != null
                    ? `Eldste: ${oldestPendingHoursAgo} t`
                    : ''}
                onClick={() => setStatDrawer('pending')}
              />
              <StatCard
                size="sm"
                Icon={Calendar}
                tone="blue"
                value={String(confirmedBookings.length)}
                label="Bekreftede"
                sub={nextConfirmedDaysAway != null
                  ? `Neste: ${nextConfirmedDaysAway}d`
                  : 'Ingen kommende'}
                onClick={() => setStatDrawer('confirmed')}
              />
              <StatCard
                size="sm"
                Icon={TrendingUp}
                tone="primary"
                value={`${(monthConfirmedRevenue / 1000).toFixed(0)}k`}
                label="Inntekt (mnd)"
                sub={`${monthConfirmedRevenue.toLocaleString('nb-NO')} kr`}
                trend={revenueTrend}
                delta={revenueDeltaPct != null ? `${revenueDeltaPct > 0 ? '+' : ''}${revenueDeltaPct} %` : undefined}
                onClick={() => setStatDrawer('stats')}
              />
              <StatCard
                size="sm"
                Icon={Percent}
                tone="violet"
                value={`${usagePercentMonth}%`}
                label="Belegg (mnd)"
                sub={`${availableDaysCount} ledige dager`}
                onClick={() => setStatDrawer('stats')}
              />
              <StatCard
                size="sm"
                Icon={Layers}
                tone="emerald"
                value={avgBookingValueMonth > 0 ? `${(avgBookingValueMonth / 1000).toFixed(1)}k` : '–'}
                label="Snittordre (mnd)"
                sub={monthConfirmedBookings.length > 0
                  ? `${avgBookingValueMonth.toLocaleString('nb-NO')} kr`
                  : 'Ingen ordre'}
                onClick={() => setStatDrawer('stats')}
              />
            </div>

            {/* Equipment breakdown */}
            {/* Per-machine breakdown only helps once there's more than one
                piece of equipment — with a single machine it duplicates the
                stat cards. Hidden until needed. */}
            {machines.length >= 2 && (
              <Card className="mb-8">
                <CardContent className="p-4">
                  <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Utstyr – denne måneden</div>
                  <div className="space-y-2">
                    {machines.filter(m => m.isActive).map(m => {
                      const mm = String(calendarMonth.month + 1).padStart(2, '0');
                      const mBookings = bookings.filter(b =>
                        b.machineId === m.id &&
                        ['confirmed', 'completed'].includes(b.status) &&
                        b.startDate.startsWith(`${calendarMonth.year}-${mm}`)
                      );
                      const rev = mBookings.reduce((s, b) => s + b.totalPrice, 0);
                      const daysInMonth = new Date(calendarMonth.year, calendarMonth.month + 1, 0).getDate();
                      const monthPrefix = `${calendarMonth.year}-${mm}`;
                      const blockedDaysInMonth = Array.from(blockedDateSet).filter(d => d.startsWith(monthPrefix)).length;
                      const availableDaysInMonth = Math.max(1, daysInMonth - blockedDaysInMonth);
                      // Days the machine is actually out — not how many
                      // bookings it had. Counting distinct start dates made a
                      // 7-day week rental worth exactly as much as a 3-day
                      // weekend, so two machines with very different occupancy
                      // reported the same percentage. Rentals that began last
                      // month still occupy days in this one, so they count
                      // from their overlap rather than being skipped.
                      const monthStart = `${monthPrefix}-01`;
                      const monthEnd = `${monthPrefix}-${String(daysInMonth).padStart(2, '0')}`;
                      const occupiedDays = new Set<string>();
                      for (const b of bookings) {
                        if (b.machineId !== m.id) continue;
                        if (!['confirmed', 'completed'].includes(b.status)) continue;
                        const span = rentalDayCount(b.rentalType as RentalType, b.customDays);
                        for (let i = 0; i < span; i++) {
                          const d = addDays(b.startDate, i);
                          if (d > monthEnd) break;
                          if (d >= monthStart) occupiedDays.add(d);
                        }
                      }
                      const bookedDays = occupiedDays.size;
                      const utilPct = Math.min(100, Math.round((bookedDays / availableDaysInMonth) * 100));
                      return (
                        <div key={m.id} className="flex items-center gap-3 text-sm">
                          <div className="flex-1 min-w-0">
                            <div className="font-medium truncate">{m.name}</div>
                            <div className="text-xs text-muted-foreground">{mBookings.length} booking{mBookings.length !== 1 ? 'er' : ''} · {rev.toLocaleString('nb-NO')} kr</div>
                          </div>
                          <div className="w-24 text-right">
                            <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                              <div className="h-full bg-primary rounded-full" style={{ width: `${utilPct}%` }} />
                            </div>
                            <div className="text-xs text-muted-foreground mt-0.5">{utilPct}% utnyttelse</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Booking search + export */}
            <div className="mb-6">
              <div className="flex gap-2 items-start">
              <div className="relative flex-1 max-w-sm">
                <Input
                  placeholder="Søk bookinger (navn, ref, telefon, e-post)…"
                  value={bookingSearch}
                  onChange={(e) => setBookingSearch(e.target.value)}
                  className="pr-8"
                />
                {bookingSearch && (
                  <button
                    onClick={() => setBookingSearch('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
              <Button variant="outline" size="sm" onClick={() => {
                const methodLabel = (m: string | null | undefined) =>
                  m === 'vipps' ? 'Vipps' : m === 'card' ? 'Kort' : (m || '');
                const rows = filteredBookings.map(b => [
                  b.reference, b.name, b.email, b.phone,
                  machines.find(m => m.id === b.machineId)?.name || '',
                  b.startDate, RENTAL_TYPE_LABELS[b.rentalType] || b.rentalType,
                  STATUS_LABELS[b.status] || b.status,
                  b.totalPrice,
                  methodLabel(b.paymentMethod),
                ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
                const header = ['Referanse','Navn','E-post','Telefon','Utstyr','Startdato','Type','Status','Pris','Betalingsmetode']
                  .map(v => `"${v}"`).join(',');
                const csv = [header, ...rows].join('\n');
                const bom = '﻿';
                const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                // `toDateStr`, not `toISOString()`: the Oslo-local day. An
                // export run just after local midnight would otherwise be
                // filed under yesterday's date (V-1). `todayStr` is the same
                // helper — spelled out here because this component already
                // binds that name to its own mounted-safe copy.
                a.href = url; a.download = `bookinger-${toDateStr(new Date())}.csv`;
                a.click(); URL.revokeObjectURL(url);
              }}>
                Eksporter CSV
              </Button>
              </div>
              {bookingSearch && (
                /* Counts what the list below actually renders. Counting every
                   match instead is how "1 resultat" came to sit above "Ingen
                   bookinger matcher søket" (P-1). */
                <p className="text-xs text-muted-foreground mt-1">{listedBookings.length} resultat{listedBookings.length !== 1 ? 'er' : ''}</p>
              )}
            </div>

            <div id="calendar-grid" className="grid grid-cols-1 lg:grid-cols-3 gap-8 scroll-mt-20">
              {/* Calendar */}
              <div className="lg:col-span-2">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Calendar className="w-5 h-5" />
                      Tilgjengelighet
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {/* Selection mode */}
                    <div className="flex items-center gap-2 mb-4">
                      <span className="text-sm text-muted-foreground">Velg:</span>
                      <div className="flex gap-1">
                        {(['day', 'week'] as SelectionMode[]).map((mode) => (
                          <button
                            key={mode}
                            onClick={() => {
                              setSelectionMode(mode);
                              setSelectedDates(new Set());
                            }}
                            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                              selectionMode === mode
                                ? 'bg-primary text-primary-foreground'
                                : 'bg-muted text-muted-foreground hover:bg-muted/80'
                            }`}
                          >
                            {mode === 'day' ? 'Dag' : 'Uke'}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Month navigation */}
                    <div className="flex items-center justify-between mb-4">
                      <button onClick={prevMonth} className="p-1.5 rounded-lg hover:bg-muted transition-colors">
                        <ChevronLeft className="w-5 h-5" />
                      </button>
                      <span className="font-semibold">
                        {NORWEGIAN_MONTH_NAMES[calendarMonth.month]} {calendarMonth.year}
                      </span>
                      <button onClick={nextMonth} className="p-1.5 rounded-lg hover:bg-muted transition-colors">
                        <ChevronRight className="w-5 h-5" />
                      </button>
                    </div>

                    {/* Day names */}
                    <div className="grid grid-cols-7 gap-1 mb-1">
                      {NORWEGIAN_DAY_NAMES.map((day) => (
                        <div key={day} className="text-center text-xs font-medium text-muted-foreground py-1">
                          {day}
                        </div>
                      ))}
                    </div>

                    {/* Day grid */}
                    <div className="grid grid-cols-7 gap-1">
                      {calendarDays.map((date, i) => {
                        if (!date) return <div key={`empty-${i}`} className="h-11" />;

                        const dateStr = toDateStr(date);
                        const isPast = dateStr < todayStr;
                        const isBooked = bookingDateMap.has(dateStr);
                        const isPending = pendingBookingDateMap.has(dateStr);
                        const isBlocked = blockedDateSet.has(dateStr);
                        // Turnaround = scheduled maintenance, the day after
                        // each booking ends. Only show this state when no
                        // stronger state already applies.
                        const isTurnaround = turnaroundDateSet.has(dateStr) && !isBooked && !isPending && !isBlocked;
                        const isSelected = selectedDates.has(dateStr);
                        const isHovered = hoverDates.has(dateStr) && !isSelected;

                        // Span-connector logic: when the previous/next day is
                        // part of the SAME booking, we visually bridge the
                        // cells across the grid gap and drop the inner
                        // rounded corner so multi-day bookings read as one
                        // continuous block.
                        const colInWeek = i % 7;
                        const occupiedHere = isBooked || isPending;
                        const idsHere = new Set([
                          ...(bookingDateMap.get(dateStr) || []),
                          ...(pendingBookingDateMap.get(dateStr) || []),
                        ].map(b => b.id));
                        const neighborShares = (offset: number): boolean => {
                          if (!occupiedHere) return false;
                          const n = new Date(date); n.setDate(n.getDate() + offset);
                          const ns = toDateStr(n);
                          const bookings = [
                            ...(bookingDateMap.get(ns) || []),
                            ...(pendingBookingDateMap.get(ns) || []),
                          ];
                          return bookings.some(b => idsHere.has(b.id));
                        };
                        const connectLeft = !isSelected && colInWeek > 0 && neighborShares(-1);
                        const connectRight = !isSelected && colInWeek < 6 && neighborShares(1);
                        const connectorBg = isBooked ? 'bg-blue-500/20' : 'bg-orange-400/20';
                        const roundingCls = connectLeft && connectRight
                          ? 'rounded-none'
                          : connectLeft
                            ? 'rounded-r-lg'
                            : connectRight
                              ? 'rounded-l-lg'
                              : 'rounded-lg';

                        return (
                          <button
                            key={dateStr}
                            onClick={() => !isPast && handleDayClick(date)}
                            onMouseEnter={() => !isPast && handleDayHover(date)}
                            onMouseLeave={() => setHoverDates(new Set())}
                            disabled={isPast}
                            title={isTurnaround ? 'Vedlikehold etter forrige booking' : undefined}
                            className={`
                              relative h-11 ${roundingCls} text-sm transition-all flex flex-col items-center justify-center gap-0
                              ${isPast ? 'text-muted-foreground/30 cursor-not-allowed' : 'cursor-pointer'}
                              ${isSelected
                                ? 'bg-destructive text-destructive-foreground font-bold ring-2 ring-destructive/50'
                                : isBooked
                                  ? 'bg-blue-500/20 text-blue-700 dark:text-blue-300 font-medium hover:bg-blue-500/30'
                                  : isPending
                                    ? 'bg-orange-400/20 text-orange-700 dark:text-orange-300 font-medium hover:bg-orange-400/30'
                                    : isBlocked
                                      ? 'bg-slate-700/60 text-slate-100 dark:bg-slate-600/60 dark:text-slate-100 font-medium line-through hover:bg-slate-700/70'
                                      : isTurnaround
                                        ? 'bg-amber-400/15 text-amber-700 dark:text-amber-300 font-medium hover:bg-amber-400/25 [background:repeating-linear-gradient(45deg,rgb(251_191_36/0.18)_0px,rgb(251_191_36/0.18)_4px,transparent_4px,transparent_8px)]'
                                        : isHovered
                                          ? 'bg-primary/10 text-primary'
                                          : 'hover:bg-muted'
                              }
                            `}
                          >
                            {connectLeft && (
                              <span aria-hidden className={`absolute top-0 bottom-0 -left-1 w-1 ${connectorBg}`} />
                            )}
                            {connectRight && (
                              <span aria-hidden className={`absolute top-0 bottom-0 -right-1 w-1 ${connectorBg}`} />
                            )}
                            <span className="leading-none">{date.getDate()}</span>
                            <div className="flex gap-0.5 mt-0.5">
                              {isBooked && !isSelected && (
                                <span className="w-1 h-1 rounded-full bg-blue-500" />
                              )}
                              {isPending && !isBooked && !isSelected && (
                                <span className="w-1 h-1 rounded-full bg-orange-500" />
                              )}
                              {isTurnaround && !isSelected && (
                                <span className="w-1 h-1 rounded-full bg-amber-500" title="Vedlikehold" />
                              )}
                              {isBlocked && !isSelected && (
                                <span className="w-1 h-1 rounded-full bg-amber-500" />
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>

                    {/* Legend */}
                    <div className="flex flex-wrap gap-4 mt-4 text-xs text-muted-foreground">
                      <div className="flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded bg-blue-500/20 border border-blue-500/40 inline-block" />
                        <span>Bekreftet</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded bg-orange-400/20 border border-orange-400/40 inline-block" />
                        <span>Venter</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded bg-slate-700/60 border border-slate-700 inline-block" />
                        <span>Blokkert</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span
                          className="w-3 h-3 rounded border border-amber-400/40 inline-block"
                          style={{ background: 'repeating-linear-gradient(45deg, rgb(251 191 36 / 0.45) 0px, rgb(251 191 36 / 0.45) 2px, transparent 2px, transparent 4px)' }}
                        />
                        <span title="Auto-vedlikehold dagen etter en booking ender">Vedlikehold</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded bg-destructive inline-block" />
                        <span>Valgt</span>
                      </div>
                    </div>

                    {/* Selection actions */}
                    {selectedDates.size > 0 && (
                      <div className="mt-4 p-4 rounded-xl bg-muted/50 border border-border">
                        <div className="flex items-center justify-between mb-3">
                          <span className="text-sm font-medium">
                            {selectedDates.size} dato{selectedDates.size > 1 ? 'r' : ''} valgt
                          </span>
                          <div className="flex gap-2">
                            {Array.from(selectedDates).some((d) => blockedDateSet.has(d)) && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={handleUnblockSelected}
                                className="text-amber-600 border-amber-300 hover:bg-amber-50"
                              >
                                <X className="w-3 h-3 mr-1" />
                                Fjern blokkering
                              </Button>
                            )}
                            {showMockBookingPanel && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-amber-700 border-amber-300 hover:bg-amber-50"
                                onClick={() => setShowMockBookingSheet(true)}
                              >
                                <FlaskConical className="w-3 h-3 mr-1" />
                                Opprett testbooking
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => setShowConfirmBlock(true)}
                            >
                              Marker utilgjengelig
                            </Button>
                          </div>
                        </div>
                        <Input
                          placeholder="Årsak (valgfritt, f.eks. &quot;Ferie&quot;, &quot;Vedlikehold&quot;)"
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          className="text-sm"
                        />
                      </div>
                    )}

                    {/* Quick actions */}
                    <div className="mt-4 flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          const monthDates = getMonthDates(calendarMonth.year, calendarMonth.month)
                            .filter((d) => d >= todayStr);
                          setSelectedDates(new Set(monthDates));
                          setSelectionMode('month');
                        }}
                        className="text-xs"
                      >
                        Velg hele måneden
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Sidebar: Bookings & Blocked dates list */}
              <div className="space-y-6">
                {/* Confirmed bookings this month */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2">
                        <Calendar className="w-4 h-4" />
                        {bookingSearch.trim() ? 'Søkeresultater' : 'Bookinger denne måneden'}
                      </span>
                      {/* The only door back to a cancelled booking, and the
                          `Slett` button in its drawer (P-1). */}
                      <button
                        type="button"
                        onClick={() => setShowCancelled((v) => !v)}
                        aria-pressed={showCancelled}
                        title="Vis eller skjul avbestilte bookinger i listen"
                        className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                          showCancelled
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted text-muted-foreground hover:bg-muted/80'
                        }`}
                      >
                        {showCancelled ? 'Skjul avbestilte' : 'Vis avbestilte'}
                      </button>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 max-h-[400px] overflow-y-auto">
                    {isLoading ? (
                      <div className="flex justify-center py-4">
                        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                      </div>
                    ) : listedBookings.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-4">
                        {bookingSearch.trim() ? 'Ingen bookinger matcher søket' : 'Ingen bookinger denne måneden'}
                        {hiddenCancelledCount > 0 && (
                          <>
                            {' — '}
                            {hiddenCancelledCount === 1
                              ? '1 avbestilt booking er skjult'
                              : `${hiddenCancelledCount} avbestilte bookinger er skjult`}
                            {'. Trykk «Vis avbestilte».'}
                          </>
                        )}
                      </p>
                    ) : (
                      listedBookings
                        .map((booking) => (
                          <button
                            key={booking.id}
                            onClick={() => openBookingDetail(booking)}
                            className={`w-full text-left p-3 rounded-lg border transition-colors ${
                              booking.status === 'confirmed'
                                ? 'border-blue-500/20 bg-blue-500/5 hover:bg-blue-500/10'
                                : booking.status === 'completed'
                                  ? 'border-green-500/20 bg-green-500/5 hover:bg-green-500/10'
                                  : booking.status === 'cancelled'
                                    ? 'border-rose-500/20 bg-rose-500/5 hover:bg-rose-500/10 opacity-70'
                                    : 'border-orange-400/20 bg-orange-400/5 hover:bg-orange-400/10'
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <span className={`font-medium text-sm ${booking.status === 'cancelled' ? 'line-through' : ''}`}>{booking.name}</span>
                              <div className="flex gap-1">
                                {booking.status !== 'confirmed' && (
                                  <Badge variant="outline" className={`text-xs ${
                                    booking.status === 'completed'
                                      ? 'text-green-600 border-green-500/40'
                                      : booking.status === 'cancelled'
                                        ? 'text-rose-600 border-rose-500/40'
                                        : 'text-orange-600 border-orange-400/40'
                                  }`}>
                                    {STATUS_LABELS[booking.status]}
                                  </Badge>
                                )}
                                <Badge variant="secondary" className="text-xs">
                                  {RENTAL_TYPE_LABELS[booking.rentalType] || booking.rentalType}
                                </Badge>
                                {booking.checklistData && booking.checklistData !== '{}' && (() => {
                                  const cd = parseChecklistData(booking.checklistData as string);
                                  const machine = machines.find(m => m.id === booking.machineId);
                                  const fuelNeeds = machine ? computeFuelNeeds({
                                    totalHours: booking.totalHours || 0,
                                    tankLiters: machine.fuelTankLiters,
                                    consumptionPerHour: machine.fuelConsumptionPerHour,
                                  }) : null;
                                  const includeFuel = !!(fuelNeeds?.computable && fuelNeeds.cansNeeded > 0);
                                  const { done, total } = countChecklistProgress(checklistPhases, cd, booking, {
                                    includeFuel,
                                    fuelDone: cd['__fuel-cans'] === true,
                                  });
                                  if (total === 0) return null;
                                  return <Badge variant="outline" className={`text-xs ${done >= total ? 'text-green-600 border-green-500/40' : 'text-blue-600 border-blue-400/40'}`}>
                                    {done >= total ? '✓ Sjekk' : `${done}/${total}`}
                                  </Badge>;
                                })()}
                              </div>
                            </div>
                            <div className="text-xs text-muted-foreground mt-1">
                              {new Date(booking.startDate + 'T00:00:00').toLocaleDateString('nb-NO', {
                                weekday: 'short',
                                day: 'numeric',
                                month: 'short',
                              })}
                              {' · '}
                              {booking.totalPrice.toLocaleString('nb-NO')} kr
                            </div>
                          </button>
                        ))
                    )}
                  </CardContent>
                </Card>

                {/* Blocked dates this month */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 text-amber-500" />
                      Blokkerte datoer
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-1.5 max-h-[300px] overflow-y-auto">
                    {isLoading ? (
                      <div className="flex justify-center py-4">
                        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                      </div>
                    ) : unavailableDates.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-4">Ingen blokkerte datoer</p>
                    ) : (
                      unavailableDates.map((ud) => (
                        <div
                          key={ud.id}
                          className="flex items-center justify-between p-2 rounded-lg bg-amber-500/5 border border-amber-500/10"
                        >
                          <div>
                            <span className="text-sm font-medium">
                              {new Date(ud.date + 'T00:00:00').toLocaleDateString('nb-NO', {
                                weekday: 'short',
                                day: 'numeric',
                                month: 'short',
                              })}
                            </span>
                            {ud.reason && (
                              <span className="text-xs text-muted-foreground ml-2">({ud.reason})</span>
                            )}
                          </div>
                          <button
                            onClick={() => handleUnblockDate(ud.date)}
                            className="p-1 rounded hover:bg-amber-500/10 text-amber-600 transition-colors"
                            title="Fjern blokkering"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))
                    )}
                  </CardContent>
                </Card>

              </div>
            </div>

          </>
        )}

        {/* ═══ MACHINES TAB ═══ */}
        {activeTab === 'machines' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Utstyr</h2>
              <Button size="sm" onClick={() => openMachineForm()}>
                <Plus className="w-4 h-4 mr-2" />Legg til utstyr
              </Button>
            </div>
            {machines.length === 0 && (
              <Card><CardContent className="py-12 text-center text-muted-foreground">Ingen utstyr registrert ennå. Legg til ditt første utstyr.</CardContent></Card>
            )}
            {machines.map((m, mIndex) => (
              <Card key={m.id} className={m.isActive ? '' : 'opacity-60'}>
                <CardContent className="p-5 flex flex-col sm:flex-row sm:items-center gap-5">
                  {/* Image area */}
                  <div className="w-full sm:w-32 h-32 rounded-xl bg-gradient-to-br from-muted to-muted/40 border border-border flex items-center justify-center shrink-0 overflow-hidden">
                    {m.imageUrl
                      ? <img src={m.imageUrl} alt={m.name} className="w-full h-full object-cover" />
                      : <Tractor className="w-10 h-10 text-muted-foreground/60" />}
                  </div>
                  {/* Identity */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="font-semibold text-lg">{m.name}</div>
                      {m.year && <span className="text-muted-foreground text-sm">{m.year}</span>}
                    </div>
                    <div className="text-sm text-muted-foreground">{m.model}</div>
                    {m.description && (
                      <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{m.description}</div>
                    )}
                    <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
                      {m.quantity && m.quantity > 1 && (
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                          <Package className="w-3 h-3" /> {m.quantity} enheter
                        </span>
                      )}
                      {(m as { fuelTankLiters?: number | null }).fuelTankLiters && (
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                          ⛽ {(m as { fuelTankLiters?: number | null }).fuelTankLiters} L tank
                        </span>
                      )}
                    </div>
                  </div>
                  {/* Actions */}
                  <div className="flex sm:flex-col items-center sm:items-end gap-2 shrink-0">
                    <Toggle
                      value={m.isActive}
                      onChange={() => handleToggleMachine(m)}
                      labelOn="Aktiv"
                      labelOff="Inaktiv"
                    />
                    <div className="flex items-center gap-1.5">
                      {/* Fleet order — the sequence customers see (P-7). */}
                      {machines.length > 1 && (
                        <>
                          <Button size="sm" variant="outline" title="Flytt opp"
                            aria-label={`Flytt ${m.name} opp`}
                            disabled={mIndex === 0 || isReorderingMachines}
                            onClick={() => moveMachine(mIndex, -1)}>
                            <ChevronUp className="w-4 h-4" />
                          </Button>
                          <Button size="sm" variant="outline" title="Flytt ned"
                            aria-label={`Flytt ${m.name} ned`}
                            disabled={mIndex === machines.length - 1 || isReorderingMachines}
                            onClick={() => moveMachine(mIndex, 1)}>
                            <ChevronDown className="w-4 h-4" />
                          </Button>
                        </>
                      )}
                      <Button size="sm" variant="outline" onClick={() => openMachineForm(m)}>
                        Rediger
                      </Button>
                      <Button size="sm" variant="outline" className="text-destructive hover:bg-destructive/10"
                        onClick={() => handleDeleteMachine(m.id)} title="Slett">
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* ═══ SETTINGS TAB ═══ */}
        {activeTab === 'settings' && (
          <div className="space-y-4">
            <SecurityBanner
              enrolled={totpEnrolled}
              onSetup={() => setShowTotpSetup(true)}
              onReset={async () => {
                if (!confirm('Slette 2FA-oppsett? Du må sette det opp på nytt for å beskytte sensitive endringer.')) return;
                const code = window.prompt('Skriv inn nåværende 2FA-kode for å bekrefte sletting:');
                if (!code) return;
                const password = window.prompt('Bekreft med admin-passordet:');
                if (!password) return;
                const res = await fetch('/api/admin/totp/setup', {
                  method: 'DELETE',
                  headers: { 'Content-Type': 'application/json', 'X-Admin-TOTP': code },
                  body: JSON.stringify({ password }),
                });
                const data = await res.json();
                if (res.ok) {
                  setTotpEnrolled(false);
                  toast.success('2FA er deaktivert.');
                } else {
                  toast.error(data.error || 'Kunne ikke deaktivere');
                }
              }}
            />
            <div className="flex flex-col lg:flex-row gap-6">
            {/* Sidebar */}
            <aside className="lg:w-52 shrink-0">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-1">Innstillinger</div>
              <div className="flex lg:flex-col gap-1 overflow-x-auto lg:overflow-visible pb-2 lg:pb-0">
                {APP_CONFIG_GROUP_ORDER.map((group) => {
                  const groupConfigs = appConfigs.filter((c) => c.group === group);
                  if (groupConfigs.length === 0) return null;
                  const hasUnsaved = (dirtyAppKeysByGroup.get(group) ?? 0) > 0;
                  const Icon = SETTINGS_GROUP_ICONS[group] || Settings;
                  return (
                    <button
                      key={group}
                      onClick={() => selectSettingsGroup(group)}
                      className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm whitespace-nowrap lg:w-full transition-all ${
                        activeSettingsGroup === group
                          ? 'bg-primary text-primary-foreground shadow-sm'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                      }`}
                    >
                      <Icon className="w-4 h-4 shrink-0" />
                      <span className="flex-1 text-left font-medium">{APP_CONFIG_GROUP_LABELS[group] ?? group}</span>
                      {hasUnsaved && <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" title="Ulagrede endringer" />}
                      {SENSITIVE_GROUPS.has(group) && <Lock className="w-3 h-3 shrink-0 opacity-60" />}
                    </button>
                  );
                })}
              </div>
            </aside>

            {/* Content panel */}
            <div className="flex-1 min-w-0">
              {APP_CONFIG_GROUP_ORDER.map((group) => {
                if (group !== activeSettingsGroup) return null;
                const groupConfigs = appConfigs.filter((c) => c.group === group && c.type !== 'hidden');
                if (groupConfigs.length === 0) return null;
                const Icon = SETTINGS_GROUP_ICONS[group] || Settings;
                const groupDescriptions: Record<string, string> = {
                  business:       'Navn, kontaktinfo og branding som vises til kunder.',
                  'rental-types': 'Hvilke leietyper som er aktive, og hvilke dager/tider som gjelder for hver.',
                  booking:        'Regler for bookingskjemaet – tidsfrister, standardvalg og avbestilling.',
                  discounts:      'Førstegangskunde-rabatt, returkunde-koder og maksimal samlet rabatt. Backend er pris-autoritet.',
                  stripe:         'Kortbetaling via Stripe – Visa, Mastercard, Apple Pay og Google Pay.',
                  smtp:           'E-postserver for utsending av bekreftelser og varsler.',
                  content:        'Tekst og SEO – overskrifter, meta-tittel, beskrivelse og søkeord for Google.',
                  ui:             'Hva som vises på forsiden – seksjoner, merker og standardvalg som "Mest populær".',
                  theme:          'Farger, hero-bilde og visuelle effekter på utstyrsbildene.',
                  system:         'Tekniske innstillinger – vedlikeholdsmodus.',
                };
                return (
                  <div key={group}>
                    <div className="mb-5">
                      <h2 className="text-xl font-bold tracking-tight flex items-center gap-2">
                        <Icon className="w-5 h-5 text-primary" />
                        {APP_CONFIG_GROUP_LABELS[group] ?? group}
                        {SENSITIVE_GROUPS.has(group) && (
                          <Badge variant="outline" className="ml-1 text-amber-600 border-amber-300 gap-1">
                            <Lock className="w-3 h-3" />Sensitiv
                          </Badge>
                        )}
                      </h2>
                      {groupDescriptions[group] && (
                        <p className="text-sm text-muted-foreground mt-1">{groupDescriptions[group]}</p>
                      )}
                    </div>

                    {appConfigError && (
                      <div className="mb-4 p-3 rounded-xl bg-red-50 border border-red-200 text-red-800 text-sm flex items-center gap-2">
                        <AlertCircle className="w-4 h-4 shrink-0" />{appConfigError}
                      </div>
                    )}

                    <Card>
                      <CardContent className="pt-5 space-y-5">
                        {groupConfigs.map((cfg) => (
                          <FieldRow
                            key={cfg.key}
                            label={cfg.label}
                            hint={cfg.hint}
                            locked={SENSITIVE_GROUPS.has(group)}
                            full={cfg.type === 'textarea' || cfg.type === 'image' || KEY_FULL_WIDTH.has(cfg.key)}
                          >
                            <ConfigFieldControl
                              cfg={cfg}
                              current={editedAppValues[cfg.key] ?? cfg.value}
                              onChange={(next) => setEditedAppValues((p) => ({ ...p, [cfg.key]: next }))}
                              machines={machines}
                            />
                            {cfg.key === 'surveyLeadDiscountCode' && (
                              <a
                                href="/admin/discount-codes"
                                className="mt-1.5 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                              >
                                Gå til Rabattkoder <ArrowUpRight className="w-3 h-3" />
                              </a>
                            )}
                          </FieldRow>
                        ))}
                        {group === 'content' && (
                          <SeoPreview
                            values={Object.fromEntries(appConfigs.map((c) => [c.key, editedAppValues[c.key] ?? c.value]))}
                            machines={machines.map((m) => ({ name: m.name, model: m.model, category: m.category }))}
                          />
                        )}
                        {group === 'smtp' && (
                          <div className="pt-3 border-t border-border space-y-2">
                            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                              Test hver e-posttype
                            </div>
                            <p className="text-xs text-muted-foreground">
                              Sender et eksempel til admin-e-posten med dummy-bookingdata.
                            </p>
                            <div className="flex flex-wrap gap-2">
                              {([
                                { id: 'test',              label: 'Tilkoblingstest' },
                                { id: 'new-booking-admin', label: 'Ny booking (admin-varsel)' },
                                { id: 'confirmed',         label: 'Booking bekreftet' },
                                { id: 'cancelled',         label: 'Booking avbestilt' },
                                { id: 'reminder',          label: 'Påminnelse dagen før' },
                                { id: 'payment-retry',     label: 'Betaling feilet (retry)' },
                              ]).map(({ id, label }) => (
                                <Button
                                  key={id}
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handleTestEmail(id)}
                                  disabled={isSendingTestEmail}
                                  className="text-xs"
                                >
                                  {isSendingTestEmail
                                    ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
                                    : <FlaskConical className="w-3.5 h-3.5 mr-1.5" />}
                                  {label}
                                </Button>
                              ))}
                            </div>
                            {testEmailResult && <p className="text-sm font-mono">{testEmailResult}</p>}
                          </div>
                        )}
                      </CardContent>
                    </Card>

                    {group === 'stripe' && (
                      <Card className="mt-4 border-blue-200 dark:border-blue-800">
                        <CardContent className="pt-5 space-y-2">
                          <h3 className="font-semibold text-sm flex items-center gap-2">
                            <CreditCard className="w-4 h-4 text-blue-600" />Webhook-oppsett
                          </h3>
                          <p className="text-xs text-muted-foreground">
                            Gå til <strong>stripe.com/dashboard → Developers → Webhooks</strong> og legg til:
                          </p>
                          <code className="block text-xs bg-muted px-2 py-1.5 rounded select-all">
                            {(appConfigs.find((c) => c.key === 'siteUrl')?.value || (typeof window !== 'undefined' ? window.location.origin : 'https://dittdomene.no'))}/api/payment/stripe/webhook
                          </code>
                          <p className="text-xs text-muted-foreground">
                            Hendelse: <strong>checkout.session.completed</strong>. Kopier «Signing secret» (whsec_…) og lim inn i feltet over.
                          </p>
                        </CardContent>
                      </Card>
                    )}

                    {group === 'vipps' && (
                      <Card className="mt-4 border-orange-200 dark:border-orange-900">
                        <CardContent className="pt-5 space-y-2">
                          <h3 className="font-semibold text-sm flex items-center gap-2">
                            <CreditCard className="w-4 h-4 text-orange-600" />Webhook-oppsett
                          </h3>
                          <p className="text-xs text-muted-foreground">
                            Nøklene hentes fra <strong>portal.vippsmobilepay.com → Utvikler</strong>. Når de er lagret,
                            registrer webhooken fra terminalen:
                          </p>
                          <code className="block text-xs bg-muted px-2 py-1.5 rounded select-all">
                            npx tsx scripts/vipps-webhook.ts register
                          </code>
                          <p className="text-xs text-muted-foreground">
                            Den registrerer <code className="text-[11px]">{(appConfigs.find((c) => c.key === 'siteUrl')?.value || 'https://dittdomene.no')}/api/payment/vipps/webhook</code>{' '}
                            og lagrer «Webhook Secret» automatisk i feltet over. Secreten vises kun én gang hos Vipps,
                            så den kan ikke hentes igjen — bare erstattes ved å registrere på nytt.
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Uten en gyldig secret avvises alle innkommende webhooks, og betalinger blir kun bekreftet
                            når kunden faktisk kommer tilbake til nettsiden.
                          </p>
                        </CardContent>
                      </Card>
                    )}

                    {group === 'system' && (
                      <Card className="mt-4 border-red-200 dark:border-red-900">
                        <CardContent className="pt-5">
                          <details>
                            <summary className="cursor-pointer text-sm font-semibold text-red-600 flex items-center gap-2">
                              <Trash2 className="w-4 h-4" />Avansert — Slett alle bookinger
                            </summary>
                            <div className="mt-3 space-y-3">
                              <p className="text-sm text-muted-foreground">Sletter ALLE bookinger og blokkerte datoer. Dette kan ikke angres. Brukes kun ved testing eller komplett re-start av databasen.</p>
                              <Button variant="destructive" size="sm" onClick={async () => {
                                if (!confirm('Er du sikker? Alle bookinger og blokkerte datoer slettes permanent.')) return;
                                const typed = prompt('Siste sjanse — skriv SLETT ALT (i versaler) for å bekrefte:');
                                if (typed !== 'SLETT ALT') {
                                  toast.error('Bekreftelse stemmer ikke. Avbrutt.');
                                  return;
                                }
                                const totpCode = totpEnrolled
                                  ? (prompt('2FA-kode (6 sifre):') ?? '').trim()
                                  : '';
                                if (totpEnrolled && !/^\d{6}$/.test(totpCode)) {
                                  toast.error('Ugyldig 2FA-kode. Avbrutt.');
                                  return;
                                }
                                try {
                                  const res = await fetch('/api/admin/reset', {
                                    method: 'POST',
                                    headers: {
                                      'Content-Type': 'application/json',
                                      ...(totpCode ? { 'x-admin-totp': totpCode } : {}),
                                    },
                                    body: JSON.stringify({ confirm: 'SLETT ALT' }),
                                  });
                                  const data = await res.json();
                                  if (res.ok) {
                                    toast.success(`Slettet ${data.deletedBookings} bookinger. Siden lastes på nytt.`);
                                    window.location.reload();
                                  } else {
                                    toast.error(data.error || 'Feil ved sletting');
                                  }
                                } catch { toast.error('Feil ved sletting'); }
                              }}>
                                <Trash2 className="w-4 h-4 mr-2" />Slett alle bookinger
                              </Button>
                            </div>
                          </details>
                        </CardContent>
                      </Card>
                    )}

                    <SaveBar
                      dirtyCount={dirtyAppKeysByGroup.get(group) ?? 0}
                      isSaving={isSavingApp}
                      justSaved={appConfigSaved && activeSettingsGroup === group}
                      onSave={() => handleSaveAppConfig(undefined, group)}
                      onReset={() => resetAppConfigGroup(group)}
                    />
                  </div>
                );
              })}
            </div>
            </div>{/* end inner flex */}
          </div>
        )}
        {/* ═══ FORESPØRSLER (B2B) TAB ═══ */}
        {activeTab === 'forespørsler' && (
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold">Bedriftsforespørsler</h2>
              <p className="text-sm text-muted-foreground">Forespørsler om leie til bedrift. Send eller revider tilbud her. Kalenderen blokkeres ikke før et tilbud er akseptert.</p>
            </div>
            {quoteRequests.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-10">Ingen forespørsler ennå.</p>
            )}
            {quoteRequests.map((q) => {
              const statusMeta: Record<string, { label: string; cls: string }> = {
                ny: { label: 'Ny', cls: 'bg-blue-100 text-blue-700' },
                tilbud_sendt: { label: 'Tilbud sendt', cls: 'bg-amber-100 text-amber-700' },
                akseptert: { label: 'Akseptert', cls: 'bg-green-100 text-green-700' },
                konvertert: { label: 'Konvertert', cls: 'bg-green-100 text-green-700' },
                avslatt: { label: 'Avslått', cls: 'bg-red-100 text-red-700' },
                utlopt: { label: 'Utløpt', cls: 'bg-muted text-muted-foreground' },
                trukket: { label: 'Trukket', cls: 'bg-muted text-muted-foreground' },
              };
              const meta = statusMeta[q.status] ?? { label: q.status, cls: 'bg-muted text-muted-foreground' };
              const periodParts: string[] = [];
              if (q.rentalType) periodParts.push(q.rentalType === 'custom' && q.customDays ? `Tilpasset (${q.customDays} d)` : ({ day: '1 dag', weekend: 'Helg', week: '1 uke' } as Record<string, string>)[q.rentalType] ?? q.rentalType);
              if (q.startDate) periodParts.push(`fra ${new Date(q.startDate).toLocaleDateString('nb-NO', { day: 'numeric', month: 'short', year: 'numeric' })}`);
              return (
                <Card key={q.id}>
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold">{q.company}</span>
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${meta.cls}`}>{meta.label}</span>
                          {q.trainingConfirmed && (
                            <span className="inline-flex items-center gap-1 text-xs text-green-700"><ShieldCheck className="w-3.5 h-3.5" />M2 bekreftet</span>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5 font-mono">{q.reference} · org.nr {q.orgNumber}</div>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="sm" variant="ghost"><MoreHorizontal className="w-4 h-4" /></Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {q.acceptToken && (
                            <DropdownMenuItem onClick={() => { navigator.clipboard?.writeText(`${window.location.origin}/tilbud/${q.acceptToken}`); }}>
                              <Copy className="w-4 h-4 mr-2" />Kopier tilbudslenke
                            </DropdownMenuItem>
                          )}
                          {q.status !== 'trukket' && q.status !== 'konvertert' && (
                            <DropdownMenuItem onClick={() => handleQuoteStatus(q, 'trukket')}>
                              <XCircle className="w-4 h-4 mr-2" />Trekk tilbake
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => handleDeleteQuote(q.id)} className="text-destructive">
                            <Trash2 className="w-4 h-4 mr-2" />Slett
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>

                    <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
                      <div className="text-muted-foreground">Kontakt: <span className="text-foreground">{q.contactName}</span></div>
                      <div className="text-muted-foreground">Maskin: <span className="text-foreground">{q.machine?.name ?? 'Ikke bestemt'}</span></div>
                      <div className="text-muted-foreground">E-post: <a href={`mailto:${q.email}`} className="text-primary hover:underline">{q.email}</a></div>
                      <div className="text-muted-foreground">Telefon: <a href={`tel:${q.phone}`} className="text-foreground hover:underline">{q.phone}</a></div>
                      <div className="text-muted-foreground">Periode: <span className="text-foreground">{periodParts.join(' · ') || 'Ikke bestemt'}</span></div>
                      {q.offerAmount != null && (
                        <div className="text-muted-foreground">Tilbud: <span className="text-foreground font-medium">{q.offerAmount.toLocaleString('nb-NO')} kr</span>{q.offerValidUntil ? ` (til ${new Date(q.offerValidUntil).toLocaleDateString('nb-NO')})` : ''}</div>
                      )}
                    </div>

                    {q.projectDescription && (
                      <p className="text-sm bg-muted/40 rounded-lg p-3 text-muted-foreground whitespace-pre-wrap">{q.projectDescription}</p>
                    )}

                    <div className="flex items-center gap-2 pt-1">
                      {q.status !== 'konvertert' && (
                        <Button size="sm" onClick={() => openOfferForm(q)}>
                          <Mail className="w-4 h-4 mr-1.5" />{q.status === 'tilbud_sendt' ? 'Revider tilbud' : 'Send tilbud'}
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
        {/* ═══ OMTALER TAB ═══ */}
        {activeTab === 'omtaler' && (
          <div>
            <div className="mb-4">
              <h2 className="text-lg font-semibold">Kundeomtaler</h2>
              <p className="text-sm text-muted-foreground">Godkjenn omtaler før de vises på forsiden. Innsendte omtaler venter på godkjenning.</p>
            </div>
            {reviews.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-10">Ingen omtaler ennå.</p>
            )}
            <div className="space-y-3">
              {reviews.map((r) => (
                <Card key={r.id}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-4 flex-wrap">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="flex items-center gap-0.5">
                            {[1, 2, 3, 4, 5].map((n) => (
                              <Star key={n} className={`w-4 h-4 ${(r.rating ?? 0) >= n ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/25'}`} />
                            ))}
                          </span>
                          <span className="text-sm font-medium">{r.reviewerName || '—'}</span>
                          <span className={`text-xs px-2 py-0.5 rounded-full ${
                            r.status === 'approved' ? 'bg-green-100 text-green-700'
                            : r.status === 'rejected' ? 'bg-red-100 text-red-700'
                            : 'bg-amber-100 text-amber-700'
                          }`}>
                            {r.status === 'approved' ? 'Publisert' : r.status === 'rejected' ? 'Avvist' : 'Venter'}
                          </span>
                        </div>
                        {r.comment && <p className="text-sm text-foreground/90 mb-1">“{r.comment}”</p>}
                        <p className="text-xs text-muted-foreground">
                          {r.booking.reference} · {r.booking.name}
                          {r.submittedAt ? ` · ${new Date(r.submittedAt).toLocaleDateString('nb-NO')}` : ''}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {r.status !== 'approved' && (
                          <Button size="sm" variant="outline" onClick={() => moderateReview(r.id, 'approve')}>
                            <Check className="w-4 h-4 mr-1" /> Godkjenn
                          </Button>
                        )}
                        {r.status !== 'rejected' && (
                          <Button size="sm" variant="outline" onClick={() => moderateReview(r.id, 'reject')}>
                            <X className="w-4 h-4 mr-1" /> Avvis
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => deleteReview(r.id)} aria-label="Slett">
                          <Trash2 className="w-4 h-4 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}
        {/* ═══ INNHOLD TAB ═══ */}
        {activeTab === 'content' && (
          <div className="space-y-8">
            {/* Hero-tekst, undertekst og SEO-nøkkelord (content-gruppen) er nå
                redigerbare under Innstillinger → Innhold, sammen med hero-bildet
                i Utseende. Denne fanen styrer FAQ, vilkår og forsikring. */}

            {/* FAQ */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2"><HelpCircle className="w-4 h-4" />FAQ</CardTitle>
                <Button size="sm" onClick={() => openFaqForm()}><Plus className="w-4 h-4 mr-1" />Legg til</Button>
              </CardHeader>
              <CardContent className="space-y-2">
                {faqItems.length === 0 && <p className="text-sm text-muted-foreground text-center py-4">Ingen FAQ-elementer ennå.</p>}
                {faqItems.map((item) => (
                  <div key={item.id} className={`flex items-start justify-between gap-3 p-3 rounded-lg border ${item.isActive ? 'border-border bg-background' : 'border-border/50 bg-muted/30 opacity-60'}`}>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm">{item.question}</div>
                      <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{item.answer}</div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Toggle value={item.isActive} onChange={() => handleToggleFaq(item)} labelOn="" labelOff="" />
                      <Button size="sm" variant="outline" onClick={() => openFaqForm(item)}>Rediger</Button>
                      <Button size="sm" variant="outline" className="text-destructive hover:bg-destructive/10" onClick={() => handleDeleteFaq(item.id)}><Trash2 className="w-4 h-4" /></Button>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            {/* Terms */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2"><FileText className="w-4 h-4" />Vilkår (ToC)</CardTitle>
                <Button size="sm" onClick={() => openTermsForm()}><Plus className="w-4 h-4 mr-1" />Legg til</Button>
              </CardHeader>
              <CardContent className="space-y-4">
                {termsSections.length === 0 && <p className="text-sm text-muted-foreground text-center py-4">Ingen vilkårsseksjoner ennå.</p>}
                {(['consumer', 'business'] as const).map((aud) => {
                  const group = termsSections.filter((s) => s.audience === aud);
                  if (group.length === 0) return null;
                  return (
                    <div key={aud} className="space-y-2">
                      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {aud === 'business' ? 'Bedrift (B2B)' : 'Privat (forbruker)'}
                      </div>
                      {group.map((section) => (
                        <div key={section.id} className={`flex items-start justify-between gap-3 p-3 rounded-lg border ${section.isActive ? 'border-border bg-background' : 'border-border/50 bg-muted/30 opacity-60'}`}>
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-sm">{section.title}</div>
                            <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{section.content}</div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <Toggle value={section.isActive} onChange={() => handleToggleTerms(section)} labelOn="" labelOff="" />
                            <Button size="sm" variant="outline" onClick={() => openTermsForm(section)}>Rediger</Button>
                            <Button size="sm" variant="outline" className="text-destructive hover:bg-destructive/10" onClick={() => handleDeleteTerms(section.id)}><Trash2 className="w-4 h-4" /></Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </CardContent>
            </Card>

            {/* Insurance */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2"><ShieldCheck className="w-4 h-4" />Forsikring</CardTitle>
                <Button size="sm" onClick={() => openInsuranceForm()}><Plus className="w-4 h-4 mr-1" />Legg til</Button>
              </CardHeader>
              <CardContent className="space-y-2">
                {insuranceCards.length === 0 && <p className="text-sm text-muted-foreground text-center py-4">Ingen forsikringskort ennå.</p>}
                {insuranceCards.map((card) => (
                  <div key={card.id} className={`flex items-start justify-between gap-3 p-3 rounded-lg border ${card.isActive ? 'border-border bg-background' : 'border-border/50 bg-muted/30 opacity-60'}`}>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm">{card.label} <span className="text-primary ml-1">{card.value}</span></div>
                      <div className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{card.detail}</div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Toggle value={card.isActive} onChange={() => handleToggleInsurance(card)} labelOn="" labelOff="" />
                      <Button size="sm" variant="outline" onClick={() => openInsuranceForm(card)}>Rediger</Button>
                      <Button size="sm" variant="outline" className="text-destructive hover:bg-destructive/10" onClick={() => handleDeleteInsurance(card.id)}><Trash2 className="w-4 h-4" /></Button>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

          </div>
        )}

        {/* ─── CHECKLISTS TAB ─── */}
        {activeTab === 'checklists' && (
          <div className="space-y-6">
            <ChecklistQrPanel
              siteUrl={editedAppValues['siteUrl'] || appConfigs.find((c) => c.key === 'siteUrl')?.value || ''}
              businessName={adminBusinessName}
            />
            <TestChecklistPanel />
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2"><ListChecks className="w-4 h-4" />Sjekkliste-mal</CardTitle>
                  <p className="text-xs text-muted-foreground mt-0.5">Definer faser og punkter som vises i sjekklisten for hver booking.</p>
                </div>
                <Button size="sm" onClick={() => openPhaseForm()}><Plus className="w-4 h-4 mr-1" />Ny fase</Button>
              </CardHeader>
              <CardContent className="space-y-3">
                {checklistPhases.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-6">
                    Ingen faser ennå. Legg til en fase (f.eks. «Forberedelse», «Levering», «Henting»).
                  </p>
                )}
                <ChecklistPhasesList
                  phases={checklistPhases}
                  onTogglePhase={handleTogglePhase}
                  onEditPhase={openPhaseForm}
                  onDeletePhase={handleDeletePhase}
                  onReordered={fetchChecklistTemplate}
                  onEditItem={(phaseId, item) => openItemForm(phaseId, item as ChecklistItemData)}
                  onDeleteItem={handleDeleteItem}
                  onToggleItem={(item) => handleToggleChecklistItem(item as ChecklistItemData)}
                  onItemsReordered={fetchChecklistTemplate}
                  onAddItem={(phaseId) => openItemForm(phaseId)}
                />
                <div className="text-xs text-muted-foreground border-t border-border pt-3 mt-3">
                  <strong>Rekkefølge:</strong> dra <GripVertical className="w-3 h-3 inline -mt-0.5" /> på et punkt for å flytte det. <strong>Svartyper:</strong> Avkrysning · Ja/Nei · Tall · Tekst · Bilde (krever foto) · Måling (med enhet, f.eks. L / mm). <strong>Betinget:</strong> et punkt kan settes til å vises kun når et annet punkt har et bestemt svar (f.eks. «Skader?» = Ja → obligatorisk foto).
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </main>

      {showMockBookingPanel && (
        <MockBookingSheet
          open={showMockBookingSheet}
          onOpenChange={setShowMockBookingSheet}
          startDate={Array.from(selectedDates).sort()[0] ?? ''}
          machines={machines.map((m) => ({ id: m.id, name: m.name, model: m.model }))}
          onCreated={() => {
            setSelectedDates(new Set());
            fetchData();
          }}
        />
      )}

      {/* ── Confirm Block Dialog ── */}
      <Dialog open={showConfirmBlock} onOpenChange={setShowConfirmBlock}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Bekreft blokkering</DialogTitle>
            <DialogDescription>
              Marker {selectedDates.size} dato{selectedDates.size > 1 ? 'er' : ''} som utilgjengelige.
              Disse datoene vil vises som &quot;Opptatt&quot; for kunder som prøver å booke.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            {/* The route silently skips any date a booking already holds and
                only reports them afterwards, in the response — so the dialog
                listed every date as if every date would be blocked (P-14).
                The booking maps the calendar already renders from say which
                ones will not be. */}
            {(() => {
              const dates = Array.from(selectedDates).sort();
              const isBooked = (d: string) => bookingDateMap.has(d) || pendingBookingDateMap.has(d);
              const bookedCount = dates.filter(isBooked).length;
              return (
                <>
                  <div className="text-sm space-y-1 max-h-32 overflow-y-auto">
                    {dates.map((d) => (
                      <div
                        key={d}
                        className={isBooked(d)
                          ? 'text-amber-700 dark:text-amber-400 flex items-center gap-1.5'
                          : 'text-muted-foreground'}
                      >
                        {isBooked(d) && <AlertCircle className="w-3.5 h-3.5 shrink-0" />}
                        <span>
                          {new Date(d + 'T00:00:00').toLocaleDateString('nb-NO', {
                            weekday: 'short',
                            day: 'numeric',
                            month: 'long',
                          })}
                          {isBooked(d) && ' — allerede booket, hoppes over'}
                        </span>
                      </div>
                    ))}
                  </div>
                  {bookedCount > 0 && (
                    <div className="mt-2 p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 text-amber-800 dark:text-amber-300 text-sm">
                      {bookedCount} av {dates.length} dato{dates.length > 1 ? 'er' : ''} er allerede booket og blir ikke blokkert.
                      {dates.length - bookedCount === 0
                        ? ' Ingen datoer blir blokkert.'
                        : ` ${dates.length - bookedCount} dato${dates.length - bookedCount > 1 ? 'er' : ''} blokkeres.`}
                    </div>
                  )}
                </>
              );
            })()}
            {reason && (
              <div className="mt-2 text-sm">
                <span className="text-muted-foreground">Årsak: </span>
                <span className="font-medium">{reason}</span>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowConfirmBlock(false)}>
              Avbryt
            </Button>
            <Button variant="destructive" onClick={handleBlockDates} disabled={isSaving}>
              {isSaving ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Lagrer...
                </>
              ) : (
                'Blokker datoer'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Booking Detail Drawer ── */}
      <Sheet open={showBookingDetail} onOpenChange={setShowBookingDetail}>
        <SheetContent side="right" className="sm:max-w-[640px] flex flex-col p-0">
          <SheetHeader className="shrink-0">
            <SheetTitle>Bookingdetaljer</SheetTitle>
            <SheetDescription>
              <span className="inline-flex items-center gap-1">
                {selectedBooking?.reference}
                {selectedBooking && (
                  <button
                    onClick={() => copyField(selectedBooking.reference, 'reference')}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                    title="Kopier referanse"
                  >
                    {copiedField === 'reference' ? <Check className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3" />}
                  </button>
                )}
              </span>
              {' · '}{selectedBooking?.name}{' · '}
              {selectedBooking && (STATUS_LABELS[selectedBooking.status] || selectedBooking.status)}
            </SheetDescription>
          </SheetHeader>

          <div className="overflow-y-auto flex-1 px-5 py-4">
          {selectedBooking && (
            <div className="space-y-3">
              {(() => {
                const eq = machines.find(m => m.id === selectedBooking.machineId);
                const needs = computeFuelNeeds({
                  totalHours: selectedBooking.totalHours || 0,
                  tankLiters: eq?.fuelTankLiters,
                  consumptionPerHour: eq?.fuelConsumptionPerHour,
                });
                if (!needs.computable) return null;
                const ok = needs.cansNeeded === 0;
                return (
                  <div className={`rounded-lg border p-3 ${
                    ok
                      ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30'
                      : 'border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30'
                  }`}>
                    <div className="flex items-center gap-2 mb-2">
                      <Fuel className={`w-4 h-4 shrink-0 ${ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}`} />
                      <div className={`font-semibold text-sm ${ok ? 'text-emerald-900 dark:text-emerald-200' : 'text-amber-900 dark:text-amber-200'}`}>
                        {fuelCansLabel(needs)}
                      </div>
                    </div>
                    <div className={`text-xs space-y-0.5 font-mono tabular-nums ${
                      ok ? 'text-emerald-800 dark:text-emerald-300' : 'text-amber-800 dark:text-amber-300'
                    }`}>
                      <div className="flex justify-between">
                        <span>Estimert forbruk</span>
                        <span>{Math.round(needs.estimatedUsage)} L</span>
                      </div>
                      <div className="flex justify-between">
                        <span>+ sikkerhetsmargin</span>
                        <span>{needs.margin} L</span>
                      </div>
                      <div className="flex justify-between border-t border-current/20 pt-0.5 mt-0.5">
                        <span>= Behov totalt</span>
                        <span>{Math.round(needs.plannedTotal)} L</span>
                      </div>
                      <div className="flex justify-between">
                        <span>− full tank</span>
                        <span>{needs.tank} L</span>
                      </div>
                      <div className="flex justify-between border-t border-current/20 pt-0.5 mt-0.5 font-bold">
                        <span>= Trenger i kanner</span>
                        <span>{needs.beyondTank > 0 ? `${Math.round(needs.beyondTank)} L → ${needs.cansNeeded} kanner` : '0 L → ingen kanner'}</span>
                      </div>
                    </div>
                  </div>
                );
              })()}
              {/* Pending-payment status badge — shows the deadline countdown
                  if the webhook set one, or a generic "not paid" warning
                  otherwise. */}
              {selectedBooking.status === 'pending' && (() => {
                const rec = selectedBooking as unknown as { paymentDeadline?: string | null };
                // Two possible deadlines:
                //  - paymentDeadline: set by Stripe webhook on
                //    async_payment_failed / expired (1-hour grace).
                //  - Implicit: createdAt + 30 min cleanup window for
                //    "never reached payment" bookings.
                // Whichever is sooner becomes the effective deadline.
                const STALE_MS = 30 * 60 * 1000;
                const stripeDeadline = rec.paymentDeadline ? new Date(rec.paymentDeadline) : null;
                const created = selectedBooking.createdAt ? new Date(selectedBooking.createdAt) : null;
                const staleDeadline = created ? new Date(created.getTime() + STALE_MS) : null;
                const deadline = stripeDeadline ?? staleDeadline;
                const msLeft = deadline ? deadline.getTime() - Date.now() : null;
                const minsLeft = msLeft !== null ? Math.max(0, Math.floor(msLeft / 60000)) : null;
                const expired = msLeft !== null && msLeft <= 0;
                const source = stripeDeadline ? 'Stripe-sesjon utløpt' : 'Inaktiv (ikke betalt innen 30 min)';
                return (
                  <div className={`flex items-center gap-3 p-3 rounded-lg border ${
                    expired
                      ? 'border-rose-300 bg-rose-50/60 dark:border-rose-900 dark:bg-rose-950/20'
                      : 'border-amber-300 bg-amber-50/50 dark:border-amber-900 dark:bg-amber-950/20'
                  }`}>
                    <Clock className={`w-5 h-5 shrink-0 ${expired ? 'text-rose-600' : 'text-amber-600'}`} />
                    <div className="flex-1 min-w-0">
                      <div className={`font-semibold text-sm ${
                        expired ? 'text-rose-900 dark:text-rose-200' : 'text-amber-900 dark:text-amber-200'
                      }`}>
                        Venter på betaling
                        {minsLeft !== null && !expired && (
                          <span className="ml-2 font-mono tabular-nums">{minsLeft} min igjen</span>
                        )}
                        {expired && <span className="ml-2 text-xs font-normal">{source}</span>}
                      </div>
                      <div className={`text-xs mt-0.5 ${
                        expired ? 'text-rose-800 dark:text-rose-300' : 'text-amber-800 dark:text-amber-300'
                      }`}>
                        {expired
                          ? 'Utløpt — kanselleres ved neste cron-kjøring.'
                          : `Auto-kanselleres etter ${deadline?.toLocaleString('nb-NO', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })} hvis ikke betalt.`}
                      </div>
                    </div>
                  </div>
                );
              })()}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <div className="text-muted-foreground text-xs">Navn</div>
                  <div className="flex items-center gap-1">
                    <span className="font-medium">{selectedBooking.name}</span>
                    <button onClick={() => copyField(selectedBooking.name, 'name')} className="text-muted-foreground hover:text-foreground transition-colors" title="Kopier navn">
                      {copiedField === 'name' ? <Check className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3" />}
                    </button>
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground text-xs">Telefon</div>
                  <div className="flex items-center gap-1">
                    <a href={`tel:${selectedBooking.phone.replace(/\s/g, '')}`} className="font-medium text-primary hover:underline">
                      {selectedBooking.phone}
                    </a>
                    <button onClick={() => copyField(selectedBooking.phone, 'phone')} className="text-muted-foreground hover:text-foreground transition-colors" title="Kopier telefon">
                      {copiedField === 'phone' ? <Check className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3" />}
                    </button>
                  </div>
                </div>
                <div className="col-span-2">
                  <div className="text-muted-foreground text-xs">E-post</div>
                  <div className="flex items-center gap-1">
                    <a href={`mailto:${selectedBooking.email}`} className="font-medium text-primary hover:underline break-all">
                      {selectedBooking.email}
                    </a>
                    <button onClick={() => copyField(selectedBooking.email, 'email')} className="text-muted-foreground hover:text-foreground transition-colors shrink-0" title="Kopier e-post">
                      {copiedField === 'email' ? <Check className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3" />}
                    </button>
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground text-xs">Periode</div>
                  <div className="font-medium">
                    {(() => {
                      const start = new Date(selectedBooking.startDate + 'T00:00:00');
                      const daysOffset = rentalDayCount(selectedBooking.rentalType as RentalType, selectedBooking.customDays) - 1;
                      const end = new Date(start);
                      end.setDate(end.getDate() + daysOffset);
                      const fmt = (d: Date) => d.toLocaleDateString('nb-NO', { weekday: 'short', day: 'numeric', month: 'short' });
                      const totalDays = daysOffset + 1;
                      return daysOffset === 0
                        ? `${fmt(start)} (1 dag)`
                        : `${fmt(start)} – ${fmt(end)} (${totalDays} dager)`;
                    })()}
                  </div>
                </div>
                {selectedBooking.preferredTime && (
                  <div>
                    <div className="text-muted-foreground text-xs">Ønsket tid</div>
                    <div className="font-medium">{selectedBooking.preferredTime}</div>
                  </div>
                )}
                <div className="col-span-2">
                  <div className="text-muted-foreground text-xs">Leveringsadresse</div>
                  <div className="flex items-center gap-1">
                    <span className="font-medium">{selectedBooking.deliveryAddress}</span>
                    <button onClick={() => copyField(selectedBooking.deliveryAddress, 'address')} className="text-muted-foreground hover:text-foreground transition-colors shrink-0" title="Kopier adresse">
                      {copiedField === 'address' ? <Check className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3" />}
                    </button>
                  </div>
                </div>
                {selectedBooking.machineId && (() => {
                  const m = machines.find(x => x.id === selectedBooking.machineId);
                  return m ? (
                    <div className="col-span-2">
                      <div className="text-muted-foreground text-xs">Utstyr</div>
                      <div className="font-medium">{formatMachineLabel(m)}</div>
                    </div>
                  ) : null;
                })()}
                <div>
                  <div className="text-muted-foreground text-xs">Leietype</div>
                  <div className="font-medium">
                    {RENTAL_TYPE_LABELS[selectedBooking.rentalType]}
                    {selectedBooking.rentalType === 'custom' && selectedBooking.customDays
                      ? ` (${selectedBooking.customDays} dager)`
                      : ''}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground text-xs">Leveringsavstand</div>
                  <div className="font-medium">{selectedBooking.deliveryDistance} km</div>
                </div>
              </div>
              <Separator />
              {/* Detailed price breakdown — basePrice + extra hours +
                  delivery − discount = subtotal, then split into eks. MVA
                  + MVA = total. Matches what the customer paid via Stripe. */}
              {(() => {
                const b = selectedBooking;
                const rec = b as unknown as { discountKr?: number | null; discountLabel?: string | null };
                const discountKr = rec.discountKr ?? 0;
                const discountLabel = rec.discountLabel ?? null;
                const subtotalBeforeDiscount = b.basePrice + (b.extraHoursCost || 0) + (b.deliveryFee || 0);
                const total = b.totalPrice;
                // The lines must reconcile to the total the customer actually
                // paid. They can be a krone apart, because each line is
                // rounded on its own while the total is one rounding of the
                // sum (A-6) — so state the residual rather than let the panel
                // print a breakdown that does not add up (P-3).
                const rounding = total - (subtotalBeforeDiscount - discountKr);
                const exMva = Math.round(total / (1 + mvaRate / 100));
                const mva = total - exMva;
                return (
                  <div className="rounded-lg border border-border bg-muted/20 p-3 text-sm">
                    <div className="font-medium text-xs uppercase text-muted-foreground mb-2">Prisbrudd</div>
                    <div className="space-y-1.5">
                      <div className="flex justify-between gap-3">
                        <span className="text-muted-foreground">Leiepris</span>
                        <span className="tabular-nums">{b.basePrice.toLocaleString('nb-NO')} kr</span>
                      </div>
                      {b.extraHoursCost > 0 && (
                        <div className="flex justify-between gap-3">
                          <span className="text-muted-foreground">Forhåndsbestilte timer ({b.extraHours})</span>
                          <span className="tabular-nums">{b.extraHoursCost.toLocaleString('nb-NO')} kr</span>
                        </div>
                      )}
                      {b.deliveryFee > 0 && (
                        <div className="flex justify-between gap-3">
                          <span className="text-muted-foreground">{b.selfPickup ? 'Selvhentingsgebyr' : 'Levering'}</span>
                          <span className="tabular-nums">{b.deliveryFee.toLocaleString('nb-NO')} kr</span>
                        </div>
                      )}
                      <div className="flex justify-between gap-3 pt-1.5 border-t border-border/50">
                        <span className="text-muted-foreground">Subtotal</span>
                        <span className="tabular-nums">{subtotalBeforeDiscount.toLocaleString('nb-NO')} kr</span>
                      </div>
                      {discountKr > 0 && (
                        <div className="flex justify-between gap-3 text-emerald-700 dark:text-emerald-400">
                          <span>{discountLabel || 'Rabatt'}</span>
                          <span className="tabular-nums">-{discountKr.toLocaleString('nb-NO')} kr</span>
                        </div>
                      )}
                      {rounding !== 0 && (
                        // A krone or two is the per-line rounding (A-6). More
                        // than that is a discount the row never recorded — an
                        // older booking written before `discountKr` was stored
                        // — and calling that "avrunding" would be a lie, so it
                        // is named for what it is and coloured to be looked at.
                        <div className={`flex justify-between gap-3 ${Math.abs(rounding) > 2 ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}>
                          <span>{Math.abs(rounding) <= 2 ? 'Avrunding' : 'Avvik (ikke spesifisert)'}</span>
                          <span className="tabular-nums">
                            {rounding > 0 ? '+' : '−'}{Math.abs(rounding).toLocaleString('nb-NO')} kr
                          </span>
                        </div>
                      )}
                      <div className="flex justify-between gap-3 text-xs pt-1.5 border-t border-border/50">
                        <span className="text-muted-foreground">Sum eks. MVA</span>
                        <span className="tabular-nums text-muted-foreground">{exMva.toLocaleString('nb-NO')} kr</span>
                      </div>
                      <div className="flex justify-between gap-3 text-xs">
                        <span className="text-muted-foreground">MVA {mvaRate.toLocaleString('nb-NO')} %</span>
                        <span className="tabular-nums text-muted-foreground">{mva.toLocaleString('nb-NO')} kr</span>
                      </div>
                      <div className="flex justify-between gap-3 pt-1.5 border-t border-border text-base font-bold">
                        <span>Totalt</span>
                        <span className="tabular-nums text-primary">{total.toLocaleString('nb-NO')} kr</span>
                      </div>
                    </div>
                  </div>
                );
              })()}
              {/* Hours breakdown */}
              <div className="mt-3 p-3 rounded-lg bg-muted/30 border border-border text-sm">
                <div className="font-medium text-xs uppercase text-muted-foreground mb-2">Timeroversikt</div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-muted-foreground text-xs">Inkluderte timer</div>
                    <div className="font-medium">{selectedBooking.includedHours || '—'} timer</div>
                  </div>
                  {selectedBooking.extraHours > 0 && (
                    <div>
                      <div className="text-muted-foreground text-xs">Forbestilte timer</div>
                      <div className="font-medium">{selectedBooking.extraHours} timer ({selectedBooking.extraHoursCost.toLocaleString('nb-NO')} kr)</div>
                    </div>
                  )}
                  <div>
                    <div className="text-muted-foreground text-xs">Totalt antall timer</div>
                    <div className="font-bold text-primary">{selectedBooking.totalHours || '—'} timer</div>
                  </div>
                </div>
              </div>
              <div className="mt-3 text-sm">
                <div className="text-muted-foreground text-xs">Betaling</div>
                {selectedBooking.fullyPaidAt ? (
                  <div className="font-medium text-green-600 flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Betalt {new Date(selectedBooking.fullyPaidAt).toLocaleDateString('nb-NO')}
                    {selectedBooking.paymentMethod && (
                      <span className="ml-1 text-xs font-normal text-muted-foreground">
                        · {selectedBooking.paymentMethod === 'vipps' ? 'Vipps' :
                            selectedBooking.paymentMethod === 'card' ? 'Kort' :
                            selectedBooking.paymentMethod}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="font-medium text-red-600 flex items-center gap-1">
                    <XCircle className="w-3.5 h-3.5" /> Ikke betalt
                  </div>
                )}
              </div>
              {selectedBooking.fullyPaidAt && (
                <div className="pt-2 border-t border-border mt-2">
                  <a
                    href={`/admin/bookings/${selectedBooking.id}/contract`}
                    target="_blank"
                    rel="noopener"
                    className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
                  >
                    <FileText className="w-3.5 h-3.5" />
                    Vis frosset kontrakt
                  </a>
                </div>
              )}

              {selectedBooking.status === 'confirmed' && (
                <div className="pt-3">
                  <ContractSigningPanel
                    booking={selectedBooking}
                    onUpdated={(updated) => {
                      setSelectedBooking((prev) => (prev ? { ...prev, ...updated } : prev));
                      setBookings((prev) =>
                        prev.map((b) => (b.id === updated.id ? { ...b, ...updated } : b)),
                      );
                    }}
                  />
                </div>
              )}

              {selectedBooking.notes && (
                <>
                  <Separator />
                  <div>
                    <div className="text-muted-foreground text-xs mb-1">Kommentar</div>
                    <div className="text-sm bg-muted/50 p-2 rounded">{selectedBooking.notes}</div>
                  </div>
                </>
              )}

              {/* Timeline — derived from existing timestamps; no new endpoints. */}
              <Separator />
              <div>
                <div className="text-muted-foreground text-xs mb-2 font-semibold uppercase tracking-wider">Tidslinje</div>
                <BookingTimeline booking={selectedBooking} />
              </div>

              <CompletedChecklistsSummary
                bookingId={selectedBooking.id}
                checklistData={selectedBooking.checklistData}
              />
            </div>
          )}
          </div>

          <DialogFooter className="flex-row gap-2 flex-wrap shrink-0 border-t border-border bg-muted/20 px-5 py-3">
            {/* Print contract — opens the frozen contract in a helper tab that
                fires the print dialog immediately and closes itself, so the
                admin gets the PDF (named "Kontrakt - <e-post>") in one click
                without navigating into the contract page. */}
            {selectedBooking && ['confirmed', 'completed'].includes(selectedBooking.status) && (
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={() => window.open(`/admin/bookings/${selectedBooking.id}/contract?autoprint=1`, '_blank')}
                title="Skriv ut / lagre kontrakt som PDF"
              >
                <Printer className="w-4 h-4 mr-1" />Skriv ut kontrakt
              </Button>
            )}
            {/* Pending booking actions: mark paid (skip Stripe), cancel */}
            {selectedBooking?.status === 'pending' && (
              <>
                <Button
                  variant="default"
                  size="sm"
                  className="bg-emerald-600 hover:bg-emerald-700 text-white"
                  onClick={async () => {
                    if (!confirm('Marker som betalt og bekreft? Dette hopper over Stripe.')) return;
                    // The response decides. Reloading regardless made a failed
                    // manual payment — an expired session, a 500 — look exactly
                    // like a successful one: the page came back, the booking
                    // was still pending, and nothing said why (P-6).
                    try {
                      const res = await fetch(`/api/bookings/${selectedBooking.id}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({ status: 'confirmed', fullyPaid: true }),
                      });
                      if (!res.ok) {
                        const data = await res.json().catch(() => ({}));
                        throw new Error(data.error || `Kunne ikke markere som betalt (HTTP ${res.status}).`);
                      }
                      window.location.reload();
                    } catch (err) {
                      toast.error(err instanceof Error ? err.message : 'Kunne ikke markere som betalt.');
                    }
                  }}
                  disabled={isSaving}
                >
                  <CheckCircle2 className="w-4 h-4 mr-1" />Marker som betalt
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  className="text-destructive border-destructive/30 hover:bg-destructive/10"
                  onClick={() => {
                    setCancelReason('');
                    setShowCancelDialog(true);
                  }}
                  disabled={isSaving}
                >
                  <XCircle className="w-4 h-4 mr-1" />Kanseller
                </Button>
              </>
            )}

            {selectedBooking?.status === 'confirmed' && (
              <Button
                variant="outline"
                size="sm"
                type="button"
                className="text-destructive border-destructive/30 hover:bg-destructive/10"
                onClick={() => {
                  setCancelReason('');
                  setShowCancelDialog(true);
                }}
                disabled={isSaving}
              >
                <XCircle className="w-4 h-4 mr-1" />Kanseller
              </Button>
            )}

            {/* Delete for cancelled/completed */}
            {selectedBooking && ['cancelled', 'completed'].includes(selectedBooking.status) && (
              <Button variant="outline" size="sm" className="text-destructive border-destructive/30 hover:bg-destructive/10"
                onClick={() => handleDeleteBooking(selectedBooking.id)} disabled={isSaving}>
                <Trash2 className="w-4 h-4 mr-1" />Slett
              </Button>
            )}

            <Button type="button" variant="outline" onClick={() => setShowBookingDetail(false)}>Lukk</Button>
          </DialogFooter>
        </SheetContent>
      </Sheet>

      <Dialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Kanseller booking</DialogTitle>
            <DialogDescription>
              {selectedBooking?.status === 'confirmed'
                ? `Kunden får e-post med årsak${selectedBooking.fullyPaidAt ? ' og eventuell goodwill-rabattkode' : ''}.`
                : 'Bookingen fjernes fra kalenderen.'}
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Label htmlFor="cancel-reason">Årsak (påkrevd)</Label>
            <Textarea
              id="cancel-reason"
              className="mt-1.5"
              rows={3}
              placeholder="F.eks. kunde avbestilte, feilbooking, …"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setShowCancelDialog(false)}>
              Avbryt
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={isSaving || !cancelReason.trim()}
              onClick={() => {
                if (!selectedBooking || !cancelReason.trim()) return;
                handleBookingStatus(selectedBooking.id, 'cancelled', cancelReason.trim());
              }}
            >
              {isSaving ? 'Kansellerer…' : 'Kanseller booking'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Machine Form Drawer ── */}
      <Sheet open={showMachineForm} onOpenChange={setShowMachineForm}>
        <SheetContent side="right" className="sm:max-w-[600px] flex flex-col p-0">
          <SheetHeader className="shrink-0">
            <SheetTitle>{editingMachine ? 'Rediger utstyr' : 'Legg til utstyr'}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
            {machineFormError && (
              <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-800 text-sm flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />{machineFormError}
              </div>
            )}
            {([
              { key: 'name',     label: 'Navn',     placeholder: 'Rippa R22-1 Pro' },
              { key: 'category', label: 'Kategori', placeholder: 'f.eks. Gravemaskin, Tilhenger' },
              { key: 'model',    label: 'Modell',   placeholder: 'r22' },
              { key: 'year',  label: 'År',     placeholder: '2025' },
            ] as { key: keyof MachineInfo; label: string; placeholder: string }[]).map(({ key, label, placeholder }) => (
              <div key={key}>
                <Label>{label}</Label>
                <Input
                  type="text" className="mt-1" placeholder={placeholder}
                  value={(machineForm[key] as string) ?? ''}
                  onChange={(e) => setMachineForm((p) => ({ ...p, [key]: e.target.value }))}
                />
              </div>
            ))}
            <div>
              <Label>Bilde</Label>
              <div className="mt-1.5">
                <ImageDropzone
                  value={(machineForm.imageUrl as string | null) || null}
                  onChange={(url) => setMachineForm((p) => ({ ...p, imageUrl: url ?? '' }))}
                />
              </div>
            </div>
            <div>
              <Label>Beskrivelse</Label>
              <Textarea className="mt-1" rows={2} value={machineForm.description ?? ''}
                onChange={(e) => setMachineForm((p) => ({ ...p, description: e.target.value }))} />
            </div>
            <details>
              <summary className="cursor-pointer text-sm font-semibold flex items-center gap-2 text-muted-foreground">
                Avansert — bildestørrelse i rammen
              </summary>
              <div className="mt-2">
                <Slider
                  value={Number((machineForm as Record<string, unknown>).photoScale ?? 100)}
                  onChange={(n) => setMachineForm((p) => ({ ...p, photoScale: n }))}
                  min={0}
                  max={200}
                  marks={[0, 100, 200]}
                />
                <p className="text-xs text-muted-foreground mt-1">0 = liten i rammen, 100 = fyller rammen, &gt;100 = bildet beskjæres av rammen.</p>
              </div>
            </details>
            <div>
              <Label>Antall tilgjengelig</Label>
              <div className="mt-1.5">
                <Stepper
                  value={machineForm.quantity ?? 1}
                  onChange={(n) => setMachineForm((p) => ({ ...p, quantity: Math.max(1, n) }))}
                  min={1}
                  max={99}
                  unit="enheter"
                />
              </div>
              <p className="text-xs text-muted-foreground mt-1">Hvor mange enheter har du av dette utstyret?</p>
            </div>
            <div className="border-t border-border pt-3">
              <details>
                <summary className="cursor-pointer text-sm font-semibold flex items-center gap-2">
                  <Settings className="w-4 h-4 text-muted-foreground" />
                  Bruk egen pris for dette utstyret
                </summary>
                <div className="mt-3">
                  <p className="text-xs text-muted-foreground mb-2">La stå tomme for å bruke standardprisene fra Priser-innstillingene. Bare nødvendig hvis dette utstyret skal koste noe annet enn resten av flåten.</p>
                  <div className="grid grid-cols-2 gap-2">
                    {([
                      { key: 'dayPrice', label: 'Dagpris (kr)' },
                      { key: 'weekendPrice', label: 'Helgpris (kr)' },
                      { key: 'weekPrice', label: 'Ukepris (kr)' },
                      { key: 'dayIncludedHours', label: 'Timer inkl. (dag)' },
                      { key: 'weekendIncludedHours', label: 'Timer inkl. (helg)' },
                      { key: 'weekIncludedHours', label: 'Timer inkl. (uke)' },
                      { key: 'overtimeRate', label: 'Overtidspris (kr/t)' },
                      { key: 'preOrderHourRate', label: 'Forbestilt time (kr/t)' },
                    ] as { key: string; label: string }[]).map(({ key, label }) => (
                      <div key={key}>
                        <Label htmlFor={`machine-price-${key}`} className="text-xs">{label}</Label>
                        <Input id={`machine-price-${key}`} type="number" className="mt-0.5 h-8 text-sm" placeholder="Standard"
                          value={String((machineForm as Record<string, unknown>)[key] ?? '')}
                          onChange={(e) => setMachineForm((p) => ({ ...p, [key]: e.target.value === '' ? null : Number(e.target.value) }))} />
                      </div>
                    ))}
                  </div>
                </div>
              </details>
            </div>
            <div className="border-t border-border pt-3">
              <Label className="text-sm font-semibold">Drivstoff</Label>
              <p className="text-xs text-muted-foreground mb-2">Brukes for automatisk beregning av ekstra drivstoff ved levering.</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Tankkapasitet</Label>
                  <div className="mt-1">
                    <Stepper
                      value={Number((machineForm as Record<string, unknown>).fuelTankLiters ?? 0)}
                      onChange={(n) => setMachineForm((p) => ({ ...p, fuelTankLiters: n === 0 ? null : n }))}
                      min={0}
                      max={500}
                      step={1}
                      unit="L"
                    />
                  </div>
                </div>
                <div>
                  <Label className="text-xs">Forbruk per time</Label>
                  <div className="mt-1">
                    <Stepper
                      value={Number((machineForm as Record<string, unknown>).fuelConsumptionPerHour ?? 0)}
                      onChange={(n) => setMachineForm((p) => ({ ...p, fuelConsumptionPerHour: n === 0 ? null : n }))}
                      min={0}
                      max={50}
                      step={1}
                      unit="L/t"
                    />
                  </div>
                </div>
              </div>
            </div>
            {/* Specs */}
            <div>
              <Label className="text-sm">Spesifikasjoner</Label>
              <div className="mt-1 space-y-1.5">
                {machineSpecs.map((s, i) => (
                  <div key={i} className="flex gap-1.5 items-center">
                    <Input
                      placeholder="Etikett" className="flex-1 h-8 text-sm"
                      value={s.label}
                      onChange={e => setMachineSpecs(prev => prev.map((x, j) => j === i ? { ...x, label: e.target.value } : x))}
                    />
                    <Input
                      placeholder="Verdi" className="flex-1 h-8 text-sm"
                      value={s.value}
                      onChange={e => setMachineSpecs(prev => prev.map((x, j) => j === i ? { ...x, value: e.target.value } : x))}
                    />
                    <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0"
                      onClick={() => setMachineSpecs(prev => prev.filter((_, j) => j !== i))}>
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                ))}
                <Button type="button" variant="outline" size="sm" className="w-full h-8 text-xs mt-1"
                  onClick={() => setMachineSpecs(prev => [...prev, { label: '', value: '' }])}>
                  + Legg til rad
                </Button>
              </div>
            </div>

            {/* Features */}
            <div>
              <Label className="text-sm">Egenskaper</Label>
              <div className="mt-1 space-y-1.5">
                {machineFeatures.map((f, i) => (
                  <div key={i} className="flex gap-1.5 items-center">
                    <Input
                      placeholder="Tittel" className="w-32 shrink-0 h-8 text-sm"
                      value={f.title}
                      onChange={e => setMachineFeatures(prev => prev.map((x, j) => j === i ? { ...x, title: e.target.value } : x))}
                    />
                    <Input
                      placeholder="Beskrivelse" className="flex-1 h-8 text-sm"
                      value={f.desc}
                      onChange={e => setMachineFeatures(prev => prev.map((x, j) => j === i ? { ...x, desc: e.target.value } : x))}
                    />
                    <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0"
                      onClick={() => setMachineFeatures(prev => prev.filter((_, j) => j !== i))}>
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                ))}
                <Button type="button" variant="outline" size="sm" className="w-full h-8 text-xs mt-1"
                  onClick={() => setMachineFeatures(prev => [...prev, { title: '', desc: '' }])}>
                  + Legg til egenskap
                </Button>
              </div>
            </div>

            {/* Included */}
            <div>
              <Label className="text-sm">Inkludert i leien</Label>
              <div className="mt-1 space-y-1.5">
                {machineIncluded.map((item, i) => (
                  <div key={i} className="flex gap-1.5 items-center">
                    <Input
                      placeholder="f.eks. 2 gravebøtter" className="flex-1 h-8 text-sm"
                      value={item}
                      onChange={e => setMachineIncluded(prev => prev.map((x, j) => j === i ? e.target.value : x))}
                    />
                    <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0"
                      onClick={() => setMachineIncluded(prev => prev.filter((_, j) => j !== i))}>
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                ))}
                <Button type="button" variant="outline" size="sm" className="w-full h-8 text-xs mt-1"
                  onClick={() => setMachineIncluded(prev => [...prev, ''])}>
                  + Legg til punkt
                </Button>
              </div>
            </div>

            {/* Documents / manuals — PDFs or images, shown publicly on the
                "Leievilkår og manualer" page so customers can read them first. */}
            <div>
              <Label className="text-sm">Dokumenter / manualer</Label>
              <p className="text-xs text-muted-foreground mt-0.5">PDF eller bilde. Vises offentlig på «Leievilkår og manualer»-siden.</p>
              <div className="mt-1.5 space-y-1.5">
                {machineDocuments.map((doc, i) => (
                  <div key={i} className="flex gap-1.5 items-center">
                    <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                    <Input
                      placeholder="Tittel (f.eks. Bruksanvisning)" className="flex-1 h-8 text-sm"
                      value={doc.title}
                      onChange={e => setMachineDocuments(prev => prev.map((x, j) => j === i ? { ...x, title: e.target.value } : x))}
                    />
                    <a href={doc.fileUrl} target="_blank" rel="noopener noreferrer"
                      className="text-xs text-primary underline underline-offset-2 shrink-0" title={doc.fileUrl}>vis</a>
                    <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0"
                      onClick={() => setMachineDocuments(prev => prev.filter((_, j) => j !== i))}>
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                ))}
                <label className={`inline-flex items-center justify-center gap-2 w-full h-8 text-xs mt-1 rounded-md border border-border transition-colors ${uploadingDoc ? 'opacity-60 cursor-wait' : 'hover:bg-muted cursor-pointer'}`}>
                  {uploadingDoc ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                  {uploadingDoc ? 'Laster opp…' : 'Last opp dokument'}
                  <input
                    type="file" accept="application/pdf,image/*" className="hidden" disabled={uploadingDoc}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadMachineDocument(f); e.target.value = ''; }}
                  />
                </label>
              </div>
            </div>
          </div>
          <div className="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-border bg-muted/20">
            <Button variant="outline" onClick={() => setShowMachineForm(false)}>Avbryt</Button>
            <Button onClick={handleSaveMachine} disabled={isSavingMachine}>
              {isSavingMachine ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
              {editingMachine ? 'Lagre endringer' : 'Legg til'}
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* ── FAQ Form Drawer ── */}
      <Sheet open={showFaqForm} onOpenChange={setShowFaqForm}>
        <SheetContent side="right" className="sm:max-w-[520px] flex flex-col p-0">
          <SheetHeader className="shrink-0">
            <SheetTitle>{editingFaq ? 'Rediger FAQ' : 'Legg til FAQ'}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            <div>
              <Label>Spørsmål</Label>
              <Input className="mt-1.5" value={faqForm.question ?? ''} onChange={(e) => setFaqForm((p) => ({ ...p, question: e.target.value }))} />
            </div>
            <div>
              <Label>Svar</Label>
              <Textarea className="mt-1.5" rows={5} value={faqForm.answer ?? ''} onChange={(e) => setFaqForm((p) => ({ ...p, answer: e.target.value }))} />
            </div>
            <div>
              <Label>Rekkefølge</Label>
              <div className="mt-1.5">
                <Stepper value={faqForm.sortOrder ?? 0} onChange={(n) => setFaqForm((p) => ({ ...p, sortOrder: n }))} min={0} max={100} />
              </div>
              <p className="text-xs text-muted-foreground mt-1">Lavere tall = høyere opp i listen.</p>
            </div>
          </div>
          <div className="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-border bg-muted/20">
            <Button variant="outline" onClick={() => setShowFaqForm(false)}>Avbryt</Button>
            <Button onClick={handleSaveFaq} disabled={isSavingFaq}>
              {isSavingFaq ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
              {editingFaq ? 'Lagre' : 'Legg til'}
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* ── B2B Offer Drawer ── */}
      <Sheet open={showOfferForm} onOpenChange={setShowOfferForm}>
        <SheetContent side="right" className="sm:max-w-[520px] flex flex-col p-0">
          <SheetHeader className="shrink-0">
            <SheetTitle>{offerQuote?.status === 'tilbud_sendt' ? 'Revider tilbud' : 'Send tilbud'}</SheetTitle>
            <SheetDescription>
              {offerQuote ? `${offerQuote.company} · ${offerQuote.reference}` : ''}
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            <div>
              <Label>Tilbudsbeløp (kr, eks. mva) *</Label>
              <Input
                className="mt-1.5"
                type="number"
                min={1}
                value={offerForm.offerAmount}
                onChange={(e) => setOfferForm((p) => ({ ...p, offerAmount: e.target.value }))}
                placeholder="f.eks. 4500"
              />
            </div>
            <div>
              <Label>Betalingsmåte</Label>
              <div className="mt-1.5">
                <SegmentedControl
                  options={[
                    { value: 'card', label: 'Kort (Stripe)' },
                    { value: 'invoice', label: 'Faktura' },
                  ]}
                  value={offerForm.paymentMode}
                  onChange={(v) => setOfferForm((p) => ({ ...p, paymentMode: v as 'card' | 'invoice' }))}
                />
              </div>
            </div>
            <div>
              <Label>Gyldig til</Label>
              <Input
                className="mt-1.5"
                type="date"
                value={offerForm.offerValidUntil}
                onChange={(e) => setOfferForm((p) => ({ ...p, offerValidUntil: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground mt-1">Tomt = 14 dager fra nå.</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Startdato *</Label>
                <Input
                  className="mt-1.5"
                  type="date"
                  value={offerForm.startDate}
                  onChange={(e) => setOfferForm((p) => ({ ...p, startDate: e.target.value }))}
                />
              </div>
              <div>
                <Label>Leieperiode</Label>
                <select
                  className="mt-1.5 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={offerForm.rentalType}
                  onChange={(e) => setOfferForm((p) => ({ ...p, rentalType: e.target.value }))}
                >
                  <option value="day">1 dag</option>
                  <option value="weekend">Helg</option>
                  <option value="week">1 uke</option>
                  <option value="custom">Tilpasset</option>
                </select>
              </div>
            </div>
            {offerForm.rentalType === 'custom' && (
              <div>
                <Label>Antall dager</Label>
                <Input
                  className="mt-1.5"
                  type="number"
                  min={1}
                  max={365}
                  value={offerForm.customDays}
                  onChange={(e) => setOfferForm((p) => ({ ...p, customDays: e.target.value }))}
                />
              </div>
            )}
            <p className="text-xs text-muted-foreground -mt-1">Startdato kreves for at kunden skal kunne akseptere – kalenderen låses ved aksept.</p>
            <div>
              <Label>Melding til kunden</Label>
              <Textarea
                className="mt-1.5"
                rows={6}
                value={offerForm.offerMessage}
                onChange={(e) => setOfferForm((p) => ({ ...p, offerMessage: e.target.value }))}
                placeholder="Hva inngår, leveringsdetaljer, forbehold …"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Kunden får en e-post med en lenke for å se og akseptere tilbudet. Bedriftsvilkårene gjelder ved aksept.
            </p>
          </div>
          <div className="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-border bg-muted/20">
            <Button variant="outline" onClick={() => setShowOfferForm(false)}>Avbryt</Button>
            <Button onClick={handleSendOffer} disabled={isSendingOffer || !offerForm.offerAmount}>
              {isSendingOffer ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Mail className="w-4 h-4 mr-2" />}
              Send tilbud
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Terms Form Drawer ── */}
      <Sheet open={showTermsForm} onOpenChange={setShowTermsForm}>
        <SheetContent side="right" className="sm:max-w-[600px] flex flex-col p-0">
          <SheetHeader className="shrink-0">
            <SheetTitle>{editingTerms ? 'Rediger vilkårsseksjon' : 'Legg til vilkårsseksjon'}</SheetTitle>
            <SheetDescription>Bruk {`{{token}}`} for dynamiske verdier (f.eks. {`{{deliveryIncludedKm}}`}, {`{{egenandel}}`}).</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            <div>
              <Label>Målgruppe</Label>
              <div className="mt-1.5">
                <SegmentedControl
                  options={[
                    { value: 'consumer', label: 'Privat' },
                    { value: 'business', label: 'Bedrift' },
                  ]}
                  value={termsForm.audience ?? 'consumer'}
                  onChange={(v) => setTermsForm((p) => ({ ...p, audience: v as 'consumer' | 'business' }))}
                />
              </div>
            </div>
            <div>
              <Label>Tittel</Label>
              <Input className="mt-1.5" value={termsForm.title ?? ''} onChange={(e) => setTermsForm((p) => ({ ...p, title: e.target.value }))} />
            </div>
            <div>
              <Label>Innhold</Label>
              <Textarea className="mt-1.5 font-mono text-sm" rows={10} value={termsForm.content ?? ''} onChange={(e) => setTermsForm((p) => ({ ...p, content: e.target.value }))} />
              <p className="text-xs text-muted-foreground mt-1">Tilgjengelige tokens: {`{{businessName}}`}, {`{{orgNumber}}`}, {`{{deliveryIncludedKm}}`}, {`{{deliveryPerKm}}`}, {`{{maxDeliveryRadius}}`}, {`{{preOrderHourRate}}`}, {`{{overtimeRate}}`}, {`{{dayIncludedHours}}`}, {`{{weekendIncludedHours}}`}, {`{{weekIncludedHours}}`}, {`{{egenandel}}`}, {`{{minAge}}`}, {`{{cancelFreeLabel}}`}, {`{{cancelLatePercent}}`}, {`{{cancelSameDayPercent}}`}.</p>
            </div>
            <div>
              <Label>Rekkefølge</Label>
              <div className="mt-1.5">
                <Stepper value={termsForm.sortOrder ?? 0} onChange={(n) => setTermsForm((p) => ({ ...p, sortOrder: n }))} min={0} max={1000} step={10} />
              </div>
            </div>
          </div>
          <div className="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-border bg-muted/20">
            <Button variant="outline" onClick={() => setShowTermsForm(false)}>Avbryt</Button>
            <Button onClick={handleSaveTerms} disabled={isSavingTerms}>
              {isSavingTerms ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
              {editingTerms ? 'Lagre' : 'Legg til'}
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Checklist Phase Form Drawer ── */}
      <ChecklistPhaseFormSheet
        open={showPhaseForm}
        onOpenChange={setShowPhaseForm}
        form={phaseForm}
        onChange={(patch) => setPhaseForm((p) => ({ ...p, ...patch }))}
        onSave={handleSavePhase}
        saving={isSavingPhase}
        error={phaseFormError}
        editing={!!editingPhase}
      />

      {/* ── Checklist Item Form Drawer ── */}
      <Sheet open={showItemForm} onOpenChange={setShowItemForm}>
        <SheetContent side="right" className="sm:max-w-[520px] flex flex-col p-0">
          <SheetHeader className="shrink-0">
            <SheetTitle>{editingItem ? 'Rediger punkt' : 'Nytt punkt'}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            {itemFormError && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 text-destructive text-sm px-3 py-2">
                {itemFormError}
              </div>
            )}
            <FieldRow label="Beskrivelse">
              <TextInput
                placeholder="f.eks. Utstyr rengjort"
                value={itemForm.label ?? ''}
                onChange={(v) => setItemForm((p) => ({ ...p, label: v }))}
              />
            </FieldRow>
            <FieldRow label="Svartype" full>
              <AnswerTypePicker
                value={itemForm.answerType ?? 'checkbox'}
                onChange={(value) => setItemForm((p) => ({ ...p, answerType: value }))}
              />
              <p className="text-xs text-muted-foreground mt-2">
                {(itemForm.answerType ?? 'checkbox') === 'checkbox'    && 'Enkelt hake – fullført eller ikke.'}
                {(itemForm.answerType ?? 'checkbox') === 'yesno'       && 'Ja/Nei-spørsmål. Begge svar fullfører – bruk det til å utløse betingede punkter (f.eks. skade → foto).'}
                {(itemForm.answerType ?? 'checkbox') === 'number'      && 'Numerisk verdi, f.eks. timestand.'}
                {(itemForm.answerType ?? 'checkbox') === 'text'        && 'Fritekst, f.eks. notater eller serienummer.'}
                {(itemForm.answerType ?? 'checkbox') === 'photo'       && 'Last opp eller ta bilde direkte fra mobil.'}
                {(itemForm.answerType ?? 'checkbox') === 'measurement' && 'Tall med enhet, f.eks. drivstoffnivå i liter.'}
              </p>
            </FieldRow>
            {(itemForm.answerType === 'measurement') && (
              <div>
                <Label>Enhet</Label>
                <Input
                  className="mt-1.5"
                  placeholder="f.eks. liter, km, bar, timer"
                  value={itemForm.unit ?? ''}
                  onChange={(e) => setItemForm((p) => ({ ...p, unit: e.target.value }))}
                />
              </div>
            )}
            {(itemForm.answerType === 'photo') && (
              <div className="rounded-lg border border-border p-3 space-y-1.5 bg-muted/20">
                <Label className="block">Minimum antall bilder</Label>
                <p className="text-xs text-muted-foreground">
                  Operatør/leietaker kan legge til flere bilder. Punktet fullføres først når minst så mange er lastet opp.
                </p>
                <div className="mt-1">
                  <Stepper value={itemForm.minPhotos ?? 1} onChange={(n) => setItemForm((p) => ({ ...p, minPhotos: Math.max(1, n) }))} min={1} max={20} />
                </div>
              </div>
            )}
            {(itemForm.answerType === 'number' || itemForm.answerType === 'measurement') && (
              <div className="rounded-lg border border-border p-3 space-y-1.5 bg-muted/20">
                <Label className="block">Statistikk-nøkkel <span className="text-muted-foreground font-normal">(valgfritt)</span></Label>
                <p className="text-xs text-muted-foreground">
                  Mål samme verdi i flere faser (f.eks. «Timeteller» på Levering og Retur) for å regne ut differansen på PDF-en. Gi begge punktene samme nøkkel — eller la stå tom for å pare automatisk på likt navn.
                </p>
                <Input
                  className="mt-1"
                  placeholder="f.eks. timeteller"
                  value={itemForm.statKey ?? ''}
                  onChange={(e) => setItemForm((p) => ({ ...p, statKey: e.target.value }))}
                />
              </div>
            )}
            {/* Conditional visibility: show this item only when a sibling item
                holds a given answer (e.g. "Skader?" = Ja → mandatory photo). */}
            {(() => {
              const phaseForItem = checklistPhases.find((p) => p.id === itemForm.phaseId);
              const siblings = (phaseForItem?.items ?? []).filter(
                (i) => i.id !== editingItem?.id
                  && ['checkbox', 'yesno', 'text', 'number'].includes(i.answerType),
              );
              const parent = siblings.find((i) => i.id === itemForm.conditionItemId);
              const parentIsBool = parent ? ['checkbox', 'yesno'].includes(parent.answerType) : false;
              return (
                <div className="rounded-lg border border-border p-3 space-y-3 bg-muted/20">
                  <div>
                    <Label className="block">Betinget visning</Label>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Vis og krev dette punktet kun når et annet punkt har et bestemt svar.
                    </p>
                  </div>
                  <select
                    className="w-full h-9 rounded-md border border-border bg-background px-2 text-sm"
                    value={itemForm.conditionItemId ?? ''}
                    onChange={(e) => setItemForm((p) => ({
                      ...p,
                      conditionItemId: e.target.value || null,
                      conditionValue: e.target.value ? (p.conditionValue ?? 'ja') : null,
                    }))}
                  >
                    <option value="">Alltid synlig</option>
                    {siblings.map((i) => (
                      <option key={i.id} value={i.id}>Hvis «{i.label}»</option>
                    ))}
                  </select>
                  {itemForm.conditionItemId && (
                    parentIsBool ? (
                      <div className="flex gap-2">
                        {(['ja', 'nei'] as const).map((v) => {
                          const on = (itemForm.conditionValue ?? 'ja').toLowerCase() === v;
                          return (
                            <button
                              key={v}
                              type="button"
                              onClick={() => setItemForm((p) => ({ ...p, conditionValue: v }))}
                              className={`px-4 py-1.5 rounded-full text-sm border transition-colors ${
                                on ? 'bg-primary text-primary-foreground border-primary'
                                   : 'bg-background text-muted-foreground border-border hover:bg-muted'
                              }`}
                            >
                              {v === 'ja' ? 'er Ja' : 'er Nei'}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div>
                        <Label className="text-xs">Lik verdi</Label>
                        <Input
                          className="mt-1.5"
                          placeholder="f.eks. nei, defekt, 0"
                          value={itemForm.conditionValue ?? ''}
                          onChange={(e) => setItemForm((p) => ({ ...p, conditionValue: e.target.value }))}
                        />
                      </div>
                    )
                  )}
                </div>
              );
            })()}
          </div>
          <div className="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-border bg-muted/20">
            <Button type="button" variant="outline" onClick={() => setShowItemForm(false)}>Avbryt</Button>
            <Button type="button" onClick={handleSaveItem} disabled={isSavingItem}>
              {isSavingItem ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
              {editingItem ? 'Lagre' : 'Legg til punkt'}
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Insurance Form Drawer ── */}
      <Sheet open={showInsuranceForm} onOpenChange={setShowInsuranceForm}>
        <SheetContent side="right" className="sm:max-w-[520px] flex flex-col p-0">
          <SheetHeader className="shrink-0">
            <SheetTitle>{editingInsurance ? 'Rediger forsikringskort' : 'Legg til forsikringskort'}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            <div>
              <Label>Etikett</Label>
              <Input className="mt-1.5" placeholder='f.eks. "Ansvarsforsikring"' value={insuranceForm.label ?? ''} onChange={(e) => setInsuranceForm((p) => ({ ...p, label: e.target.value }))} />
            </div>
            <div>
              <Label>Verdi</Label>
              <Input className="mt-1.5" placeholder='f.eks. "Inkludert" eller "5 000 kr"' value={insuranceForm.value ?? ''} onChange={(e) => setInsuranceForm((p) => ({ ...p, value: e.target.value }))} />
            </div>
            <div>
              <Label>Detalj (kort beskrivelse)</Label>
              <Textarea className="mt-1.5" rows={3} value={insuranceForm.detail ?? ''} onChange={(e) => setInsuranceForm((p) => ({ ...p, detail: e.target.value }))} />
            </div>
            <div>
              <Label>Rekkefølge</Label>
              <div className="mt-1.5">
                <Stepper value={insuranceForm.sortOrder ?? 0} onChange={(n) => setInsuranceForm((p) => ({ ...p, sortOrder: n }))} min={0} max={100} />
              </div>
            </div>
          </div>
          <div className="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-border bg-muted/20">
            <Button variant="outline" onClick={() => setShowInsuranceForm(false)}>Avbryt</Button>
            <Button onClick={handleSaveInsurance} disabled={isSavingInsurance}>
              {isSavingInsurance ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
              {editingInsurance ? 'Lagre' : 'Legg til'}
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* TOTP prompt — auto-opens whenever a sensitive save was rejected
          with 401 / requiresTotp. The modal handles enrollment first-time. */}
      <TotpPromptModal
        open={pendingTotpSave !== null}
        onClose={() => {
          // Backing out of the 2FA step means the save did not happen. Say so
          // — the panel still shows the edited number, and without this the
          // admin walks away believing a price change went through.
          const target = pendingTotpSave;
          setPendingTotpSave(null);
          if (target?.kind === 'pricing') {
            setConfigError('Ikke lagret — prisendringer krever 2FA. Endringene dine står fortsatt i skjemaet.');
          } else if (target?.kind === 'app-config') {
            setAppConfigError('Ikke lagret — denne innstillingen krever 2FA. Endringene dine står fortsatt i skjemaet.');
          } else if (target?.kind === 'machine') {
            // The machine drawer stays open behind the modal with the edited
            // price still in it, and said nothing at all — unlike the two
            // panels above, which is the whole of P-11.
            setMachineFormError('Ikke lagret — prisendringer krever 2FA. Endringene dine står fortsatt i skjemaet.');
          }
        }}
        context={pendingTotpSave?.context}
        onVerified={(code) => {
          const target = pendingTotpSave;
          setPendingTotpSave(null);
          if (target?.kind === 'app-config') void handleSaveAppConfig(code, target.group);
          else if (target?.kind === 'pricing') void handleSaveConfig(code);
          else if (target?.kind === 'machine') void handleSaveMachine(code);
        }}
      />

      {/* Standalone enrollment trigger from the security banner. */}
      <TotpPromptModal
        open={showTotpSetup}
        onClose={() => setShowTotpSetup(false)}
        context="2FA-oppsett"
        onVerified={() => {
          setShowTotpSetup(false);
          setTotpEnrolled(true);
        }}
      />

      {/* ── Stat drill-down drawer ── */}
      <Sheet open={statDrawer !== null} onOpenChange={(open) => !open && setStatDrawer(null)}>
        <SheetContent side="right" className="sm:max-w-[560px] flex flex-col p-0">
          <SheetHeader className="shrink-0">
            <SheetTitle>
              {statDrawer === 'pending'   && `Venter på betaling (${pendingBookings.length})`}
              {statDrawer === 'confirmed' && `Bekreftede bookinger (${confirmedBookings.length})`}
              {statDrawer === 'stats'     && `Statistikk — ${NORWEGIAN_MONTH_NAMES[calendarMonth.month]} ${calendarMonth.year}`}
            </SheetTitle>
            <SheetDescription>
              {statDrawer === 'pending'   && 'Bookinger der Stripe-betaling ikke er gjennomført. Klikk for å åpne detaljer.'}
              {statDrawer === 'confirmed' && 'Alle bekreftede bookinger på tvers av måneder.'}
              {statDrawer === 'stats'     && 'Omsetning, belegg og kontotelling for valgt måned.'}
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            {statDrawer === 'pending' && (
              pendingBookings.length === 0 ? (
                <div className="text-center text-sm text-muted-foreground py-12">Ingen pågående.</div>
              ) : pendingBookings.map((b) => (
                <button
                  key={b.id}
                  onClick={() => { setStatDrawer(null); openBookingDetail(b); }}
                  className="w-full text-left p-3 rounded-lg border border-amber-500/30 bg-amber-500/5 hover:bg-amber-500/10 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs">{b.reference}</span>
                    <span className="text-sm font-bold tabular-nums">{b.totalPrice.toLocaleString('nb-NO')} kr</span>
                  </div>
                  <div className="text-sm font-medium mt-0.5">{b.name}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {new Date(b.startDate + 'T00:00:00').toLocaleDateString('nb-NO', { weekday: 'short', day: 'numeric', month: 'short' })}
                    {' · '}{RENTAL_TYPE_LABELS[b.rentalType] || b.rentalType}
                  </div>
                </button>
              ))
            )}
            {statDrawer === 'confirmed' && (
              confirmedBookings.length === 0 ? (
                <div className="text-center text-sm text-muted-foreground py-12">Ingen bekreftede.</div>
              ) : confirmedBookings
                  .sort((a, b) => a.startDate.localeCompare(b.startDate))
                  .map((b) => (
                <button
                  key={b.id}
                  onClick={() => { setStatDrawer(null); openBookingDetail(b); }}
                  className="w-full text-left p-3 rounded-lg border border-blue-500/30 bg-blue-500/5 hover:bg-blue-500/10 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs">{b.reference}</span>
                    <span className="text-sm font-bold tabular-nums">{b.totalPrice.toLocaleString('nb-NO')} kr</span>
                  </div>
                  <div className="text-sm font-medium mt-0.5">{b.name}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {new Date(b.startDate + 'T00:00:00').toLocaleDateString('nb-NO', { weekday: 'short', day: 'numeric', month: 'short' })}
                    {' · '}{RENTAL_TYPE_LABELS[b.rentalType] || b.rentalType}
                    {b.fullyPaidAt && ' · Betalt'}
                  </div>
                </button>
              ))
            )}
            {statDrawer === 'stats' && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="p-4 rounded-xl border border-border bg-card">
                    <div className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider">Omsetning</div>
                    <div className="text-2xl font-bold text-primary mt-1 tabular-nums">{monthConfirmedRevenue.toLocaleString('nb-NO')} kr</div>
                  </div>
                  <div className="p-4 rounded-xl border border-border bg-card">
                    <div className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider">Bekreftede</div>
                    <div className="text-2xl font-bold mt-1 tabular-nums">{confirmedBookings.length}</div>
                  </div>
                  <div className="p-4 rounded-xl border border-border bg-card">
                    <div className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider">Belegg</div>
                    <div className="text-2xl font-bold text-violet-600 mt-1 tabular-nums">{usagePercentMonth}%</div>
                  </div>
                  <div className="p-4 rounded-xl border border-border bg-card">
                    <div className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider">Snittordre</div>
                    <div className="text-2xl font-bold mt-1 tabular-nums">{avgBookingValueMonth > 0 ? `${avgBookingValueMonth.toLocaleString('nb-NO')} kr` : '–'}</div>
                  </div>
                  <div className="p-4 rounded-xl border border-border bg-card">
                    <div className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider">Fullført totalt</div>
                    <div className="text-2xl font-bold text-emerald-600 mt-1 tabular-nums">{totalCompletedCount}</div>
                  </div>
                  <div className="p-4 rounded-xl border border-border bg-card">
                    <div className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider">Avbestilte totalt</div>
                    <div className="text-2xl font-bold text-muted-foreground mt-1 tabular-nums">{totalCancelledCount}</div>
                  </div>
                </div>
                <div className="p-4 rounded-xl border border-border bg-card">
                  <div className="flex items-center justify-between mb-3">
                    <div className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider">Omsetning siste 6 mnd</div>
                    {revenueTrend && revenueDeltaPct != null && (
                      <span className={`inline-flex items-center gap-0.5 text-[11px] font-semibold tabular-nums ${revenueTrend === 'up' ? 'text-emerald-600' : 'text-rose-600'}`}>
                        {revenueTrend === 'up' ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
                        {revenueDeltaPct > 0 ? '+' : ''}{revenueDeltaPct} % vs. forrige mnd
                      </span>
                    )}
                  </div>
                  {monthlyRevenueSeries.some((m) => m.value > 0) ? (
                    <MiniBarChart data={monthlyRevenueSeries} />
                  ) : (
                    <div className="text-center text-xs text-muted-foreground py-8">Ingen omsetning registrert i denne perioden.</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
