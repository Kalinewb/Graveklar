'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import Image from 'next/image';
import {
  Phone, Calendar,
  Clock,
  MapPin,
  ChevronRight,
  ChevronLeft,
  Shield,
  ShieldCheck,
  Truck,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  Wrench,
  Star,
  Info,
  Loader2,
  Navigation,
  X,
} from 'lucide-react';
import { GraveklarMark } from '@/components/GraveklarMark';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
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
import { Textarea } from '@/components/ui/textarea';
import {
  getConfigValue,
  buildPricingFromConfig,
  calculateCustomPrice,
  type RentalType,
  type ConfigValues,
  type CustomPriceBreakdown,
} from '@/lib/pricing';
import { readMvaSettings } from '@/lib/mva';
import { getCancelFreeHours, getCancelFreeLabel } from '@/lib/cancellation';
import { FAQ_DEFAULTS } from '@/lib/faq-defaults';
import Footer from '@/components/Footer';
import TermsDialog from '@/components/TermsDialog';
import EquipmentShowcase from '@/components/EquipmentShowcase';
import { ThemeToggle } from '@/components/ThemeToggle';
import { FramedEquipmentImage, equipmentEffectsFromConfig } from '@/lib/equipment-bg';

/* ─── constants ─── */
const NORWEGIAN_DAY_NAMES = ['man', 'tir', 'ons', 'tor', 'fre', 'lør', 'søn'];
const NORWEGIAN_MONTH_NAMES = [
  'januar', 'februar', 'mars', 'april', 'mai', 'juni',
  'juli', 'august', 'september', 'oktober', 'november', 'desember',
];

// Built-in starter FAQ, shown only when the admin has never configured any
// FAQ rows. Sourced from the shared defaults so the homepage fallback and the
// DB seed (scripts/seed-faq.ts) can never drift apart.
const FAQ_ITEMS = FAQ_DEFAULTS.map((f) => ({ q: f.question, a: f.answer }));

/* ─── Machine ─── */
interface MachineInfo {
  id: string;
  name: string;
  category?: string | null;
  model: string;
  year?: string | null;
  imageUrl?: string | null;
  description?: string | null;
  specs?: string | null;
  features?: string | null;
  included?: string | null;
  quantity?: number;
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
}

/* ─── Delivery calculation state ─── */
interface DeliveryInfo {
  /** Signed proof from /api/delivery; sent back with the booking. */
  token?: string;
  distance: number;
  fee: number;
  address: string;
  straightLine: boolean;
  withinRadius: boolean;
}

interface AddressSuggestion {
  display_name: string;
  short_name: string;
  lat: string;
  lon: string;
  type: string;
}

/* ─── helper ─── */
/** Booking dates arrive either as full ISO timestamps (API responses) or as
 *  local YYYY-MM-DD strings (server-rendered Stripe return). A bare date is
 *  parsed as UTC by `new Date()` and would render one day early in Oslo, so
 *  pin it to local midnight. */
function parseBookingDate(s: string): Date {
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s);
}
function formatDate(d: Date) {
  return d.toLocaleDateString('nb-NO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}


/* ═══════════════════════════════════════════════════
   MAIN PAGE
   ═══════════════════════════════════════════════════ */
export interface HomePageProps {
  initialConfig: ConfigValues;
  initialAppConfig: Record<string, string>;
  initialMachines: MachineInfo[];
  initialFaq: { question: string; answer: string }[];
  /** True once the admin has created at least one FAQ row (active or not).
   *  When false the built-in fallback set is shown; when true the admin's
   *  toggles are authoritative and the section hides if all are off. */
  faqConfigured: boolean;
  initialTerms: { title: string; content: string }[];
  initialInsurance: { label: string; value: string; detail: string }[];
  initialStripeEnabled: boolean;
  initialVippsEnabled: boolean;
  /** Server-side Stripe return: derived from `?stripe=X&ref=Y` searchParams.
   *  When present, the confirmation modal renders from this durable
   *  booking lookup instead of sessionStorage. */
  stripeReturn: {
    status: string;
    booking: {
      id: string; reference: string; name: string; rentalType: string;
      customDays: number | null; startDate: string; deliveryAddress: string;
      selfPickup: boolean; basePrice: number; deliveryFee: number;
      extraHours: number; extraHoursCost: number; totalPrice: number;
      includedHours: number; totalHours: number;
      machineName: string | null; machineModel: string | null;
      discountKr: number | null; discountLabel: string | null; status: string;
      cancelToken: string | null;
    } | null;
  } | null;
  reviews: {
    id: string;
    rating: number;
    comment: string | null;
    reviewerName: string;
    date: string;
  }[];
  reviewAggregate: { count: number; average: number };
}

export default function Home({
  initialConfig,
  initialAppConfig,
  initialMachines,
  initialFaq,
  faqConfigured,
  initialTerms,
  initialInsurance,
  initialStripeEnabled,
  initialVippsEnabled,
  stripeReturn,
  reviews,
  reviewAggregate,
}: HomePageProps) {
  // tileType drives the UI (3 tiles: day / weekend / week). Internally, when
  // tileType==='day' AND dayCount>1, the rentalType sent to the backend
  // becomes 'custom' — same per-day weekday/weekend pricing — but the
  // calendar's start-day restriction still uses the day-tile rule so you
  // can't START on a weekend, only extend into one.
  const [tileType, setTileType] = useState<'day' | 'weekend' | 'week'>('weekend');
  const [dayCount, setDayCount] = useState(1);
  const rentalType: 'day' | 'weekend' | 'week' | 'custom' =
    tileType === 'day' && dayCount > 1 ? 'custom' : tileType;
  const setRentalType = (next: 'day' | 'weekend' | 'week' | 'custom') => {
    if (next === 'custom') { setTileType('day'); setDayCount((n) => Math.max(2, n)); return; }
    setTileType(next);
    if (next !== 'day') setDayCount(1);
  };
  const [startDate, setStartDate] = useState('');
  // customDays is the legacy field consumed by the backend + pricing engine
  // for 'custom' rental type. It's derived from dayCount whenever the user
  // is on the 'day' tile with N>1, so we keep one source of truth.
  const customDays = tileType === 'day' && dayCount > 1 ? dayCount : 2;
   
  const setCustomDays = (next: number | ((n: number) => number)) => {
    const n = typeof next === 'function' ? (next as (n: number) => number)(customDays) : next;
    if (tileType === 'day') setDayCount(Math.max(1, n));
  };
  const [weekCount, setWeekCount] = useState(1);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [discountCode, setDiscountCode] = useState('');
  // Manual rabattkode field is hidden by default — only revealed when the
  // customer ticks "Jeg har en rabattkode". Auto-reveals if a code is
  // somehow already populated (URL prefill, paste, browser autofill) so the
  // input doesn't silently swallow it.
  const [showDiscountInput, setShowDiscountInput] = useState(false);
  useEffect(() => {
    if (discountCode.trim() && !showDiscountInput) setShowDiscountInput(true);
     
  }, [discountCode]);
  // Canonical Quote — populated by debounced /api/quote calls. Single
  // source of truth for what the customer is shown and what they're
  // charged. The frontend NEVER derives discounts, MVA, or totals from
  // raw config — those numbers come from this object only.
  interface QuoteShape {
    basePrice: number;
    extraHoursCost: number;
    extraHours: number;
    includedHours: number;
    totalHours: number;
    deliveryFee: number;
    subtotal: number;
    discountLines: Array<{ kind: string; label: string; percent: number; amountKr: number }>;
    discountKr: number;
    discountLabel: string | null;
    cappedByCeiling: boolean;
    totalPrice: number;
    mvaBreakdown: { exMva: number; mvaAmt: number; mvaRate: number; inclMva: boolean };
    warnings: Array<{ code: string; message: string }>;
    // False when /api/bookings would refuse this combination. The form's own
    // controls already prevent every case, so this is the belt-and-braces
    // layer: if it ever fires, the customer is told why instead of being sent
    // to Stripe for a booking that gets rejected on the way back.
    bookable: boolean;
    blockedReason: string | null;
    generatedAt: string;
  }
  const [quote, setQuote] = useState<QuoteShape | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [preferredTime, setPreferredTime] = useState('');
  const [websiteHoneypot, setWebsiteHoneypot] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [confirmationData, setConfirmationData] = useState<any>(null);
  const [showTerms, setShowTerms] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [error, setError] = useState('');
  // Equipment-info modal: machine id whose specs/features are shown, or null.
  const [infoMachineId, setInfoMachineId] = useState<string | null>(null);

  // Dynamic config from API (initialized server-side)
  const [config, setConfig] = useState<ConfigValues>(initialConfig);
  const [appConfig, setAppConfig] = useState<Record<string, string>>(initialAppConfig);

  // Machines
  const [machines, setMachines] = useState<MachineInfo[]>(initialMachines);
  const [selectedMachineId, setSelectedMachineId] = useState<string>(() => {
    const defaultId = initialAppConfig['defaultMachineId'];
    if (defaultId && initialMachines.some((m) => m.id === defaultId)) return defaultId;
    if (initialMachines.length === 1) return initialMachines[0].id;
    return '';
  });

  // Delivery method
  const [selfPickup, setSelfPickup] = useState(false);

  // Extra hours pre-order
  const [extraHours, setExtraHours] = useState(0);

  // Delivery calculation state
  const [deliveryInfo, setDeliveryInfo] = useState<DeliveryInfo | null>(null);
  const [isCalculatingDelivery, setIsCalculatingDelivery] = useState(false);
  const [deliveryError, setDeliveryError] = useState('');
  const [deliveryOutsideRadius, setDeliveryOutsideRadius] = useState(false);
  const deliveryDebounceRef = useRef<NodeJS.Timeout | null>(null);

  // Address auto-suggest state
  const [addressSuggestions, setAddressSuggestions] = useState<AddressSuggestion[]>([]);
  const [showAddressSuggestions, setShowAddressSuggestions] = useState(false);
  const [isSuggestingAddress, setIsSuggestingAddress] = useState(false);
  const addressSuggestDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const addressWrapperRef = useRef<HTMLDivElement>(null);
  const [selectedCoords, setSelectedCoords] = useState<{ lat: string; lon: string } | null>(null);

  // Calendar state
  const [mounted, setMounted] = useState(false);
  const [heroCategoryIdx, setHeroCategoryIdx] = useState(0);
  const heroCategories = Array.from(new Set(machines.map(m => m.category).filter(Boolean))) as string[];
  const today = mounted ? new Date() : null;
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [unavailableDates, setUnavailableDates] = useState<string[]>([]);
  const [tentativeDates, setTentativeDates] = useState<string[]>([]);
  const [weekendWarning, setWeekendWarning] = useState('');

  // Booking confirmation dialog state
  const [showBookingConfirm, setShowBookingConfirm] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);

  // Dynamic content from DB (initialized server-side)
  const [dynamicFaq] = useState(initialFaq);
  const [dynamicTerms] = useState(initialTerms);
  const [dynamicInsurance] = useState(initialInsurance);

  // Resolved FAQ list for the homepage. If the admin has configured FAQ
  // (faqConfigured), the active rows are authoritative — an empty result
  // hides the section. Only when nothing has ever been configured do we fall
  // back to the built-in starter questions.
  const faqList = faqConfigured
    ? dynamicFaq.map((item) => ({ q: item.question, a: item.answer }))
    : FAQ_ITEMS;

  // Payment state. `stripeStatus` is the shared post-payment status for both
  // providers — 'processing' is Vipps-only (customer got back before the
  // webhook settled the payment).
  const [stripeEnabled] = useState(initialStripeEnabled);
  const [vippsEnabled] = useState(initialVippsEnabled);
  const paymentEnabled = stripeEnabled || vippsEnabled;
  const [isPayingStripe, setIsPayingStripe] = useState(false);
  const [stripeStatus, setStripeStatus] = useState<'idle' | 'success' | 'cancelled' | 'error' | 'processing'>('idle');
  const [retryExpired, setRetryExpired] = useState(false);
  // Which provider the customer clicked — drives the per-button spinner.
  const [payingWith, setPayingWith] = useState<'vipps' | 'stripe' | null>(null);

  // ─── Mount effect: client-side only (dates, stripe return) ───
  // Stripe-return UI is now driven by `stripeReturn` from the server (read
  // from ?stripe=X&ref=Y in page.tsx). sessionStorage is no longer required
  // — a customer landing here from the Stripe receipt email, a new tab, or
  // a privacy-tabbed browser still sees their confirmation.
  useEffect(() => {
    const now = new Date();
    setCalendarMonth({ year: now.getFullYear(), month: now.getMonth() });
    setMounted(true);

    if (stripeReturn) {
      const row = stripeReturn.booking;
      const known = ['success', 'cancelled', 'error', 'processing'].includes(stripeReturn.status);
      if (row) setConfirmationData(row);
      // Open the dialog for every return we can say something useful about —
      // including the ones with no resolvable reference. Five branches of the
      // Stripe callback used to redirect without a ref, and this effect only
      // opened the dialog for 'success', so a failed payment landed the
      // customer on the ordinary home page with no dialog, no message and a
      // query string that was then stripped (Q-2).
      if (row || known) setShowConfirmation(true);

      // The booking row outranks the query string. `?stripe=cancelled` on a
      // row that is already confirmed and paid happens whenever the customer
      // presses Back out of Checkout after paying — or a prefetcher follows
      // cancel_url — and telling them the booking was never confirmed, then
      // (once "Prøv igjen" gets its 410) that it expired, is wrong twice over
      // for a booking they already own (Q-1).
      const paid = row?.status === 'confirmed' || row?.status === 'completed';
      if (paid) setStripeStatus('success');
      else if (stripeReturn.status === 'success') setStripeStatus('success');
      else if (stripeReturn.status === 'cancelled') setStripeStatus('cancelled');
      else if (stripeReturn.status === 'processing') setStripeStatus('processing');
      else if (stripeReturn.status === 'error') setStripeStatus('error');

      // A booking that is already cancelled cannot be paid for: /create answers
      // 410. Go straight to the "start over" copy instead of offering a retry
      // button that is guaranteed to fail.
      if (!paid && row?.status === 'cancelled') setRetryExpired(true);

      // Clean the query string so a refresh doesn't re-trigger the modal.
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [stripeReturn]);

  useEffect(() => {
    if (heroCategories.length <= 1) return;
    const interval = setInterval(() => {
      setHeroCategoryIdx(prev => (prev + 1) % heroCategories.length);
    }, 6000);
    return () => clearInterval(interval);
  }, [heroCategories.length]);

  // ─── Canonical /api/quote fetch ────────────────────────────────────
  // Whenever any price-affecting input changes, debounce a /api/quote
  // call and replace the local `quote` state. EVERY monetary number the
  // customer sees is read from this object. The /api/bookings handler
  // re-runs the same buildQuote at submit time and rejects with 409 if
  // the value the customer agreed to no longer matches.
  useEffect(() => {
    if (!startDate || !mounted) {
      setQuote(null);
      return;
    }
    const ac = new AbortController();
    const t = setTimeout(async () => {
      setQuoteLoading(true);
      try {
        const res = await fetch('/api/quote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: ac.signal,
          body: JSON.stringify({
            rentalType,
            startDate,
            customDays: rentalType === 'custom' ? customDays : (rentalType === 'week' && weekCount > 1 ? weekCount * 7 : undefined),
            machineId: selectedMachineId || undefined,
            selfPickup,
            deliveryDistance: selfPickup ? 0 : (deliveryInfo?.distance ?? 0),
            deliveryFee: selfPickup ? 0 : (deliveryInfo?.fee ?? 0),
            extraHours,
            email: email.trim() || undefined,
            phone: phone.trim() || undefined,
            code: discountCode.trim() || undefined,
          }),
        });
        if (!res.ok) {
          setQuote(null);
          return;
        }
        const data = (await res.json()) as QuoteShape;
        setQuote(data);
      } catch (err) {
        if ((err as { name?: string }).name !== 'AbortError') {
          setQuote(null);
        }
      } finally {
        setQuoteLoading(false);
      }
    }, 350);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [
    rentalType, startDate, customDays, weekCount, selectedMachineId,
    selfPickup, deliveryInfo, extraHours,
    email, phone, discountCode, mounted,
  ]);

  // Reset the picked startDate when the user picks a different *tile*
  // (Døgn / Helg / Uke). Bumping the day-stepper inside the Døgn tile
  // flips the derived `rentalType` from 'day' to 'custom', which used to
  // also fire this reset and wipe the selected date — track tileType
  // instead so multi-day day rentals keep their startDate.
  const prevTileType = useRef(tileType);
  useEffect(() => {
    if (prevTileType.current !== tileType) {
      setStartDate('');
      setWeekCount(1);
      prevTileType.current = tileType;
    }
  }, [tileType]);

  // ─── Derive effective config (merge equipment-specific pricing over globals) ───
  const selectedEquipment = machines.find(m => m.id === selectedMachineId) ?? machines[0] ?? null;
  const effectiveConfig = { ...config } as ConfigValues;
  if (selectedEquipment) {
    if (selectedEquipment.dayPrice != null) effectiveConfig['dayPrice'] = selectedEquipment.dayPrice;
    if (selectedEquipment.weekendPrice != null) effectiveConfig['weekendPrice'] = selectedEquipment.weekendPrice;
    if (selectedEquipment.weekPrice != null) effectiveConfig['weekPrice'] = selectedEquipment.weekPrice;
    if (selectedEquipment.dayIncludedHours != null) effectiveConfig['dayIncludedHours'] = selectedEquipment.dayIncludedHours;
    if (selectedEquipment.weekendIncludedHours != null) effectiveConfig['weekendIncludedHours'] = selectedEquipment.weekendIncludedHours;
    if (selectedEquipment.weekIncludedHours != null) effectiveConfig['weekIncludedHours'] = selectedEquipment.weekIncludedHours;
    if (selectedEquipment.overtimeRate != null) effectiveConfig['overtimeRate'] = selectedEquipment.overtimeRate;
    if (selectedEquipment.preOrderHourRate != null) effectiveConfig['preOrderHourRate'] = selectedEquipment.preOrderHourRate;
  }

  // ─── Derived pricing from config ───
  const pricing = buildPricingFromConfig(effectiveConfig);
  const overtimeRate = getConfigValue(effectiveConfig, 'overtimeRate');
  const preOrderHourRate = getConfigValue(effectiveConfig, 'preOrderHourRate');
  const minDeliveryFee = getConfigValue(config, 'minDeliveryFee');
  // Source of truth is AppConfig (group 'booking'); fall back to legacy
  // `config` for installs that haven't migrated yet.
  const minBookingDaysAhead = Math.round(
    Number(appConfig['minBookingDaysAhead'] ?? '') ||
    getConfigValue(config, 'minBookingDaysAhead') ||
    0
  );
  const cancelFreeHours = getCancelFreeHours(appConfig);
  const cancelLatePercent = Number(appConfig['cancelLatePercent'] || '50');
  const cancelSameDayPercent = Number(appConfig['cancelSameDayPercent'] || '100');

  // Enabled rental types from config
  const enabledTypes = (appConfig['enabledRentalTypes'] || 'day,weekend,week').split(',').map(s => s.trim()).filter(Boolean);

  // Rental schedule config (which days are clickable per type)
  const dayAllowedDays = new Set((appConfig['dayAllowedDays'] || '1,2,3,4').split(',').map(s => Number(s.trim())));
  const weekendStartDay = Number(appConfig['weekendStartDay'] || '5');
  const weekStartDay = Number(appConfig['weekStartDay'] || '1');

  function isDayAllowedForRentalType(rentalType: string, dow: number): boolean {
    // Multi-day "day" rentals still use the day-tile start rules (can't
    // START on a weekend) even though rentalType resolves to 'custom'
    // internally for pricing. tileType drives the start gate.
    if (tileType === 'day') return dayAllowedDays.has(dow === 0 ? 7 : dow);
    if (rentalType === 'day') return dayAllowedDays.has(dow === 0 ? 7 : dow);
    if (rentalType === 'weekend') {
      const startDow = weekendStartDay;
      return dow === startDow || dow === 6 || dow === 0;
    }
    if (rentalType === 'week') return true;
    return true;
  }

  function snapToStartDay(date: Date, rentalType: string): Date {
    const dow = date.getDay();
    if (rentalType === 'weekend') {
      const startDow = weekendStartDay === 7 ? 0 : weekendStartDay;
      const diff = ((dow - startDow) + 7) % 7;
      if (diff > 0) {
        const snapped = new Date(date);
        snapped.setDate(snapped.getDate() - diff);
        return snapped;
      }
    }
    if (rentalType === 'week') {
      const startDow = weekStartDay === 7 ? 0 : weekStartDay;
      const diff = ((dow - startDow) + 7) % 7;
      if (diff > 0) {
        const snapped = new Date(date);
        snapped.setDate(snapped.getDate() - diff);
        return snapped;
      }
    }
    return date;
  }

  // Cancellation free label (weeks + days, from new config split)
  const cancelFreeLabel = getCancelFreeLabel(appConfig);

  // Custom price breakdown for custom rental type
  const customBreakdown: CustomPriceBreakdown | null = rentalType === 'custom' && startDate
    ? calculateCustomPrice(startDate, customDays, config)
    : null;

  const customBreakdownNoDate: CustomPriceBreakdown | null = rentalType === 'custom' && !startDate && today
    ? calculateCustomPrice(toDateStr(today), customDays, config)
    : null;

  // How many days the user can chain onto a Day-tile rental before the span
  // hits an unavailable (booked or admin-blocked) or tentative (pending-pay)
  // date. Caps the + stepper so the customer can't book over a busy day.
  // Without a startDate yet, allow the full 1–7 range.
  const maxDayCountFromStart = (() => {
    if (!startDate || tileType !== 'day') return 7;
    const blocked = new Set([...unavailableDates, ...tentativeDates]);
    for (let i = 1; i <= 7; i++) {
      const d = new Date(startDate + 'T00:00:00');
      d.setDate(d.getDate() + i);
      if (blocked.has(toDateStr(d))) return i;
    }
    return 7;
  })();

  // Clamp dayCount back down if a startDate change shrinks the safe window.
  useEffect(() => {
    if (tileType !== 'day') return;
    if (dayCount > maxDayCountFromStart) setDayCount(maxDayCountFromStart);
  }, [maxDayCountFromStart, tileType, dayCount]);

  // Base price calculation
  const basePrice = rentalType === 'custom'
    ? (customBreakdown?.totalPrice ?? customBreakdownNoDate?.totalPrice ?? 0)
    : rentalType === 'week'
      ? pricing[rentalType].basePrice * weekCount
      : pricing[rentalType].basePrice;

  const includedHours = rentalType === 'custom'
    ? customDays * getConfigValue(effectiveConfig, 'dayIncludedHours')
    : rentalType === 'week'
      ? pricing[rentalType].includedHours * weekCount
      : pricing[rentalType].includedHours;

  const rentalDays = rentalType === 'day' ? 1
    : rentalType === 'weekend' ? 3
    : rentalType === 'week' ? 7 * weekCount
    : customDays;

  // Dynamic schedule labels for the pricing cards ("Fre 15:00 – Man 07:00").
  // Admin-editable display text — and, just below, the only description the
  // app has of when the rental actually starts and ends.
  const dayScheduleText = appConfig['daySchedule'] || '07:00 – 07:00 neste dag';
  const weekendScheduleText = appConfig['weekendSchedule'] || 'Fre 15:00 – Man 07:00';
  const weekScheduleText = appConfig['weekSchedule'] || 'Man 07:00 – Man 07:00';
  const rentalScheduleText = rentalType === 'weekend'
    ? weekendScheduleText
    : rentalType === 'week'
      ? weekScheduleText
      : dayScheduleText;

  // How many hours the rental period can physically contain.
  //
  // The calendar-day count overstates it: a weekend spans three days but runs
  // "Fre 15:00 – Man 07:00", i.e. 64 elapsed hours, not 72. Bounding the extra
  // hours by days × 24 sold 52 pre-ordered hours on top of 20 included — up to
  // 15 600 kr of hours the rental has no room for (Q-11).
  //
  // The schedule strings are admin-edited free text, so they are only trusted
  // when a start *and* an end clock time can be read out of them; anything else
  // falls back to the calendar-day bound.
  const rentalPeriodHours = (() => {
    const fallback = rentalDays * 24;
    const times = rentalScheduleText.match(/\d{1,2}[:.]\d{2}/g);
    if (!times || times.length < 2) return fallback;
    const clock = (t: string) => {
      const [h, m] = t.split(/[:.]/).map(Number);
      return h + m / 60;
    };
    const total = fallback + (clock(times[1]) - clock(times[0]));
    return total > 0 ? Math.floor(total) : fallback;
  })();

  // Included + pre-ordered hours can never exceed the period itself.
  const maxExtraHours = Math.max(0, rentalPeriodHours - includedHours);

  const totalHours = includedHours + extraHours;
  const extraHoursCost = extraHours * preOrderHourRate;
  const deliveryFee = selfPickup ? 0 : (deliveryInfo?.fee ?? 0);
  const totalPrice = basePrice + extraHoursCost + deliveryFee;

  // ─── Address auto-suggest ───
  const fetchAddressSuggestions = useCallback(async (query: string) => {
    if (query.trim().length < 3) {
      setAddressSuggestions([]);
      setShowAddressSuggestions(false);
      return;
    }

    setIsSuggestingAddress(true);
    try {
      const res = await fetch('/api/address-suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const data = await res.json();
      if (data.results && data.results.length > 0) {
        setAddressSuggestions(data.results);
        setShowAddressSuggestions(true);
      } else {
        setAddressSuggestions([]);
        setShowAddressSuggestions(false);
      }
    } catch {
      setAddressSuggestions([]);
      setShowAddressSuggestions(false);
    } finally {
      setIsSuggestingAddress(false);
    }
  }, []);

  const calculateDeliveryWithCoords = useCallback(async (addr: string, lat: string, lon: string) => {
    setIsCalculatingDelivery(true);
    setDeliveryError('');
    setDeliveryOutsideRadius(false);

    try {
      const res = await fetch('/api/delivery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: addr, lat, lng: lon }),
      });

      const data = await res.json();

      if (data.error && data.fee === null && data.distance) {
        setDeliveryOutsideRadius(true);
        setDeliveryInfo(null);
        setDeliveryError(data.error);
        return;
      }

      if (data.error) {
        setDeliveryError(data.error);
        setDeliveryInfo(null);
        return;
      }

      setDeliveryInfo({
        distance: data.distance,
        fee: data.fee,
        address: data.address,
        straightLine: data.straightLine,
        withinRadius: data.withinRadius,
        token: data.token,
      });
      setDeliveryError('');
      setDeliveryOutsideRadius(false);
    } catch {
      setDeliveryError('Kunne ikke beregne levering. Prøv igjen.');
      setDeliveryInfo(null);
    } finally {
      setIsCalculatingDelivery(false);
    }
  }, []);

  const selectAddressSuggestion = useCallback(
    (suggestion: AddressSuggestion) => {
      setAddress(suggestion.short_name);
      setShowAddressSuggestions(false);
      setAddressSuggestions([]);
      setSelectedCoords({ lat: suggestion.lat, lon: suggestion.lon });
      calculateDeliveryWithCoords(suggestion.short_name, suggestion.lat, suggestion.lon);
    },
    [calculateDeliveryWithCoords]
  );

  const calculateDelivery = useCallback(async (addr: string) => {
    if (addr.trim().length < 5) {
      setDeliveryInfo(null);
      setDeliveryError('');
      setDeliveryOutsideRadius(false);
      return;
    }

    setIsCalculatingDelivery(true);
    setDeliveryError('');
    setDeliveryOutsideRadius(false);

    try {
      const res = await fetch('/api/delivery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: addr }),
      });

      const data = await res.json();

      if (data.error && data.fee === null && data.distance) {
        setDeliveryOutsideRadius(true);
        setDeliveryInfo(null);
        setDeliveryError(data.error);
        return;
      }

      if (data.error) {
        setDeliveryError(data.error);
        setDeliveryInfo(null);
        return;
      }

      setDeliveryInfo({
        distance: data.distance,
        fee: data.fee,
        address: data.address,
        straightLine: data.straightLine,
        withinRadius: data.withinRadius,
        token: data.token,
      });
      setDeliveryError('');
      setDeliveryOutsideRadius(false);
    } catch {
      setDeliveryError('Kunne ikke beregne levering. Prøv igjen.');
      setDeliveryInfo(null);
    } finally {
      setIsCalculatingDelivery(false);
    }
  }, []);

  const handleAddressChange = useCallback(
    (value: string) => {
      setAddress(value);
      setDeliveryInfo(null);
      setDeliveryError('');
      setDeliveryOutsideRadius(false);
      setSelectedCoords(null);

      if (addressSuggestDebounceRef.current) clearTimeout(addressSuggestDebounceRef.current);
      if (value.trim().length >= 3) {
        addressSuggestDebounceRef.current = setTimeout(() => {
          fetchAddressSuggestions(value);
        }, 300);
      } else {
        setAddressSuggestions([]);
        setShowAddressSuggestions(false);
      }

      if (deliveryDebounceRef.current) clearTimeout(deliveryDebounceRef.current);
      if (value.trim().length >= 5) {
        deliveryDebounceRef.current = setTimeout(() => {
          calculateDelivery(value);
        }, 800);
      }
    },
    [fetchAddressSuggestions, calculateDelivery]
  );

  // ─── Availability fetch ───
  // Auto-advance the calendar to the first month that actually has a
  // selectable start date for the current rental type. Keyed by
  // rentalType+machine so switching rental type re-targets the search; `tries`
  // caps the month-by-month hop so a fully-booked stretch can't loop forever.
  const MAX_AUTO_ADVANCE = 13;
  const autoAdvanceRef = useRef<{ key: string; lastMonth: string; tries: number }>({ key: '', lastMonth: '', tries: 0 });
  useEffect(() => {
    const fetchAvailability = async () => {
      const monthStr = `${calendarMonth.year}-${String(calendarMonth.month + 1).padStart(2, '0')}`;
      try {
        const machineParam = selectedMachineId ? `&machineId=${selectedMachineId}` : '';
        const res = await fetch(`/api/availability?month=${monthStr}&rentalType=${rentalType}${machineParam}`);
        const data = await res.json();
        if (data.unavailableDates) {
          setUnavailableDates(data.unavailableDates);
          setTentativeDates(Array.isArray(data.tentativeDates) ? data.tentativeDates : []);

          // Jump to the first month with a genuinely bookable start. The check
          // MUST mirror the calendar cell's disable logic — day-of-week,
          // weekend/week start-day snapping AND the lead-time floor — not just
          // "is the day unbooked". Otherwise a month whose only free days are
          // invalid starts (e.g. a Tuesday when only Friday-start weekends are
          // sold, or any day inside the lead-time window) looks bookable and we
          // never advance — the "stuck on June, nothing selectable" bug.
          const advanceKey = `${rentalType}|${selectedMachineId ?? ''}`;
          if (autoAdvanceRef.current.key !== advanceKey) {
            autoAdvanceRef.current = { key: advanceKey, lastMonth: '', tries: 0 };
          }
          // Evaluate each source month at most once per (rentalType, machine).
          // The mount effect re-sets calendarMonth to a fresh object, so this
          // fetch can fire twice for the same month; without this guard the
          // second run advances off the ALREADY-advanced month and overshoots
          // (June→July→August). It also means manually navigating back to an
          // empty month won't yank the customer forward again.
          if (
            autoAdvanceRef.current.lastMonth !== monthStr &&
            autoAdvanceRef.current.tries < MAX_AUTO_ADVANCE
          ) {
            autoAdvanceRef.current.lastMonth = monthStr;
            const blocked = new Set<string>([
              ...(data.unavailableDates as string[]),
              ...(Array.isArray(data.tentativeDates) ? (data.tentativeDates as string[]) : []),
            ]);
            const todayStr = toDateStr(new Date());
            const earliest = new Date();
            earliest.setDate(earliest.getDate() + minBookingDaysAhead);
            const earliestStr = toDateStr(earliest);
            const wkStartDow = weekendStartDay === 7 ? 0 : weekendStartDay;
            const spanFree = (startStr: string, len: number) => {
              const s = new Date(`${startStr}T00:00:00`);
              for (let i = 0; i < len; i++) {
                const c = new Date(s);
                c.setDate(c.getDate() + i);
                if (blocked.has(toDateStr(c))) return false;
              }
              return true;
            };
            const isSelectable = (date: Date): boolean => {
              const ds = toDateStr(date);
              if (ds < todayStr) return false;
              if (minBookingDaysAhead > 0 && ds < earliestStr) return false;
              if (blocked.has(ds)) return false;
              const dow = date.getDay();
              if (!isDayAllowedForRentalType(rentalType, dow)) return false;
              if (rentalType === 'weekend') {
                // Only the weekend's start day (Friday by default) is a real
                // start; Sat/Sun merely snap back to it.
                if (dow !== wkStartDow) return false;
                return spanFree(ds, 3);
              }
              if (rentalType === 'week') {
                const monStr = toDateStr(snapToStartDay(date, 'week'));
                if (monStr < todayStr) return false;
                if (blocked.has(monStr)) return false;
                if (minBookingDaysAhead > 0 && monStr < earliestStr) return false;
                return spanFree(monStr, 7);
              }
              return true; // day / custom-day: the cell itself is already valid
            };
            const { year, month } = calendarMonth;
            const daysInMonth = new Date(year, month + 1, 0).getDate();
            let hasAvailable = false;
            for (let d = 1; d <= daysInMonth; d++) {
              if (isSelectable(new Date(year, month, d))) { hasAvailable = true; break; }
            }
            if (hasAvailable) {
              // Settled on a bookable month — stop auto-advancing so the
              // customer's own month navigation isn't overridden.
              autoAdvanceRef.current.tries = MAX_AUTO_ADVANCE;
            } else {
              autoAdvanceRef.current.tries += 1;
              setCalendarMonth(prev => {
                const m = prev.month + 1;
                return m > 11 ? { year: prev.year + 1, month: 0 } : { year: prev.year, month: m };
              });
            }
          }
        }
      } catch {
        // Silently fail
      }
    };
    fetchAvailability();
  }, [calendarMonth, rentalType, selectedMachineId]);

  // Reset selected date when machine changes
  const handleSelectMachine = (id: string) => {
    setSelectedMachineId(id);
    setStartDate('');
    setWeekendWarning('');
    // Send the calendar back to the current month so the auto-advance can
    // search forward again for THIS machine. Without it the view stayed on
    // whatever month the previous machine's availability had pushed it to —
    // a machine that was fully booked in September left the calendar in
    // October, hiding September dates that the newly picked machine had free.
    const now = new Date();
    setCalendarMonth({ year: now.getFullYear(), month: now.getMonth() });
  };

  // ─── Close address suggestions on click outside ───
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (addressWrapperRef.current && !addressWrapperRef.current.contains(e.target as Node)) {
        setShowAddressSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // ─── Calendar helpers ───
  const getCalendarDays = () => {
    const { year, month } = calendarMonth;
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const daysInMonth = lastDay.getDate();

    let startDow = firstDay.getDay() - 1;
    if (startDow < 0) startDow = 6;

    const days: (Date | null)[] = [];

    for (let i = 0; i < startDow; i++) {
      days.push(null);
    }

    for (let d = 1; d <= daysInMonth; d++) {
      days.push(new Date(year, month, d));
    }

    return days;
  };

  const getRentalDateRange = (startStr: string): string[] => {
    const dates: string[] = [];
    const d = new Date(startStr + 'T00:00:00');
    const numDays = rentalType === 'weekend' ? 3 : rentalType === 'custom' ? customDays : rentalDays;
    for (let i = 0; i < numDays; i++) {
      const current = new Date(d);
      current.setDate(current.getDate() + i);
      dates.push(toDateStr(current));
    }
    return dates;
  };

  const isRangeUnavailable = (startStr: string): boolean => {
    const range = getRentalDateRange(startStr);
    const blocked = new Set([...unavailableDates, ...tentativeDates]);
    return range.some((dateStr) => blocked.has(dateStr));
  };

  const handleCalendarDayClick = (date: Date) => {
    let dateStr = toDateStr(date);
    const todayStr = toDateStr(new Date());

    if (dateStr < todayStr) return;
    if (minBookingDaysAhead > 0) {
      const earliest = new Date();
      earliest.setDate(earliest.getDate() + minBookingDaysAhead);
      if (dateStr < toDateStr(earliest)) return;
    }
    if (unavailableDates.includes(dateStr)) return;

    const dow = date.getDay();
    if (!isDayAllowedForRentalType(rentalType, dow)) return;
    if (rentalType === 'weekend' || rentalType === 'week') {
      const snapped = snapToStartDay(date, rentalType);
      dateStr = toDateStr(snapped);
      if (unavailableDates.includes(dateStr)) return;
      if (dateStr < todayStr) return;
      if (minBookingDaysAhead > 0) {
        const earliest = new Date();
        earliest.setDate(earliest.getDate() + minBookingDaysAhead);
        if (dateStr < toDateStr(earliest)) return;
      }
    }

    if (isRangeUnavailable(dateStr)) {
      setWeekendWarning('En eller flere dager i perioden er allerede booket eller blokkert. Velg en annen dato.');
      setStartDate('');
      return;
    }

    setStartDate(dateStr);
    setWeekendWarning('');
  };

  const prevMonth = () => {
    setCalendarMonth((prev) => {
      const m = prev.month - 1;
      if (m < 0) return { year: prev.year - 1, month: 11 };
      return { ...prev, month: m };
    });
  };

  const nextMonth = () => {
    setCalendarMonth((prev) => {
      const m = prev.month + 1;
      if (m > 11) return { year: prev.year + 1, month: 0 };
      return { ...prev, month: m };
    });
  };

  // ─── Form submission ───
  const handleFormSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      setError('');

      if (machines.length > 1 && !selectedMachineId) {
        setError('Velg utstyr før du fortsetter.');
        return;
      }

      if (!name || !phone || !email || !startDate || (!selfPickup && !address)) {
        setError('Vennligst fyll ut alle obligatoriske felt.');
        return;
      }

      if (!selfPickup && !deliveryInfo && !deliveryOutsideRadius) {
        setError('Vennligst vent til leveringsprisen er beregnet.');
        return;
      }

      if (!selfPickup && deliveryOutsideRadius) {
        setError('Adressen er utenfor leveringsområdet. Kontakt oss for avtale.');
        return;
      }

      setTermsAccepted(false);
      setShowBookingConfirm(true);
    },
    // `selfPickup` and `selectedMachineId` were missing, so the callback kept
    // whatever they were when it was last created. After "Hent selv" →
    // "Levering til deg" it still read `selfPickup: true` and skipped its own
    // `!selfPickup && !deliveryInfo` guard — the confirmation dialog then
    // promised a 68 km delivery for 0 kr (Q-5).
    [name, phone, email, address, startDate, rentalType, selfPickup, selectedMachineId, deliveryInfo, deliveryOutsideRadius]
  );

  // `provider` decides which payment endpoint the new booking is sent to.
  // Everything up to that point — validation, pricing, the booking row — is
  // identical, and the amount is always the server's, never the client's.
  const handleConfirmBooking = useCallback(async (provider: 'vipps' | 'stripe' = 'vipps') => {
    if (!termsAccepted) return;
    setIsConfirming(true);
    setPayingWith(provider);
    try {
      const res = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          phone,
          email,
          deliveryAddress: selfPickup ? 'Selvhenting' : address,
          rentalType,
          startDate,
          customDays: rentalType === 'custom' ? customDays : rentalType === 'week' && weekCount > 1 ? weekCount * 7 : undefined,
          preferredTime: preferredTime.trim() || undefined,
          deliveryDistance: selfPickup ? 0 : (deliveryInfo?.distance ?? 0),
          deliveryFee: selfPickup ? 0 : (deliveryInfo?.fee ?? 0),
          deliveryQuoteToken: selfPickup ? undefined : deliveryInfo?.token,
          extraHours,
          notes,
          termsAccepted: true,
          website: websiteHoneypot,
          machineId: selectedMachineId || undefined,
          selfPickup,
          discountCode: discountCode.trim() || undefined,
          // Pass the quoted total so the server can reject drift between
          // what the customer saw and what would actually be charged.
          expectedTotalKr: quote?.totalPrice,
        }),
      });

      const data = await res.json();
      // Price drift: server's fresh quote differs from what the customer
      // saw. Replace the local quote with the server's and let the user
      // re-confirm — they're being asked to agree to a new total.
      if (res.status === 409 && data.priceDrift) {
        if (data.quote) setQuote(data.quote);
        setError(`Prisen har endret seg fra ${data.expected?.toLocaleString('nb-NO') ?? '?'} kr til ${data.actual?.toLocaleString('nb-NO') ?? '?'} kr. Bekreft det nye beløpet og prøv igjen.`);
        setShowBookingConfirm(false);
        setIsConfirming(false);
        return;
      }
      if (!res.ok) throw new Error(data.error || 'Booking feilet');

      const bookingData = { ...data.booking, deliveryInfo };

      sessionStorage.setItem('pendingBookingConfirmation', JSON.stringify(bookingData));
      setShowBookingConfirm(false);
      const payRes = await fetch(`/api/payment/${provider}/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookingId: data.booking.id }),
      });
      const payData = await payRes.json();
      if (payData.url) {
        window.location.href = payData.url;
        return;
      }
      throw new Error('Kunne ikke opprette betaling. Prøv igjen.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Noe gikk galt. Prøv igjen eller ring oss direkte.');
      setShowBookingConfirm(false);
    } finally {
      setIsConfirming(false);
      setPayingWith(null);
    }
    // `selfPickup`, `selectedMachineId`, `weekCount`, `discountCode` and
    // `quote` are all read in the body but were absent here, so a stale
    // closure could post a booking that differed from what the customer had
    // just agreed to — most visibly `selfPickup`, which sent `deliveryFee: 0`
    // with no `deliveryQuoteToken` for an address the dialog had just quoted
    // 1 551 kr for (Q-5).
  }, [name, phone, email, address, startDate, rentalType, selfPickup, selectedMachineId, customDays, weekCount, preferredTime, deliveryInfo, deliveryFee, extraHours, notes, discountCode, quote, termsAccepted, websiteHoneypot, stripeEnabled, vippsEnabled]);

  /* Return date — the morning the machine comes back.
   *
   * Every schedule this page prints ends on the day AFTER the last rental day:
   * a weekend is "Fre 15:00 – Man 07:00", a week "Man 07:00 – Man 07:00", a
   * døgn "07:00 – 07:00 neste dag". The summary used to stop at the last
   * rental day, so it said "fredag – søndag" right next to a pricing card that
   * said "Fre 15:00 – Man 07:00" (Q-13). `rentalDays` is the reserved calendar
   * span (1 / 3 / 7 × weekCount / customDays); the return is one day past it. */
  const returnDate = (() => {
    if (!startDate) return null;
    const d = new Date(startDate + 'T00:00:00');
    d.setDate(d.getDate() + rentalDays);
    return d;
  })();

  const endDateStr = returnDate
    ? `${formatDate(new Date(startDate + 'T00:00:00'))} – ${formatDate(returnDate)}`
    : '';

  const computedEndDate = returnDate ? formatDate(returnDate) : '';

  const calendarDays = getCalendarDays();
  const todayStr = today ? toDateStr(today) : '';

  const highlightedDates = (() => {
    if (!startDate) return new Set<string>();
    const dates = new Set<string>();
    const d = new Date(startDate + 'T00:00:00');
    const numDays = rentalType === 'weekend' ? 3 : rentalType === 'custom' ? customDays : rentalDays;
    for (let i = 0; i < numDays; i++) {
      const current = new Date(d);
      current.setDate(current.getDate() + i);
      dates.add(toDateStr(current));
    }
    return dates;
  })();

  // Prices computed from hourly rate × included hours (per-machine override
  // wins via mergeEquipmentConfig). buildPricingFromConfig encapsulates the
  // formula so HomePage and booking-service stay in lockstep.
  const _pricing = buildPricingFromConfig(effectiveConfig);
  const PRICES = {
    day:     { label: '1 dag',  hours: _pricing.day.includedHours,     price: _pricing.day.basePrice,     days: 1, schedule: dayScheduleText },
    weekend: { label: 'Helg',   hours: _pricing.weekend.includedHours, price: _pricing.weekend.basePrice, days: 3, schedule: weekendScheduleText },
    week:    { label: '1 uke',  hours: _pricing.week.includedHours,    price: _pricing.week.basePrice,    days: 7, schedule: weekScheduleText },
    custom:  { label: 'Tilpasset', hours: 0, price: 0, days: 0, schedule: '' },
  };

  const weekdayHourly = getConfigValue(config, 'weekdayHourly');
  const weekendHourly = getConfigValue(config, 'weekendHourly');
  const dayIncludedHours = getConfigValue(config, 'dayIncludedHours');

  /* ─── What the payment-return dialog says ───────────────────────────────
   * The provider's status only records where the browser last was. Two other
   * facts decide what the customer should actually be told, and both used to
   * be ignored here:
   *   • whether a booking resolved at all — `?stripe=success` with a dead
   *     reference showed the full success dialog and the sentence "Betaling og
   *     booking () er registrert", an unverified claim with an empty
   *     parenthesis where the reference should be (Q-3), while the ref-less
   *     failure branches showed nothing at all (Q-2);
   *   • the booking row's own status, which the mount effect above now folds
   *     into `stripeStatus` (Q-1).
   * Kept as one object rather than four nested ternaries in the JSX so the
   * combinations are visible in one place. */
  const returnResolved = Boolean(confirmationData);
  const returnDialog = (() => {
    const ref = confirmationData?.reference ? ` (${confirmationData.reference})` : '';
    if (!returnResolved) {
      // Nothing to attach the return to. Never claim a payment in either
      // direction — say what is known and give the customer somewhere to go.
      return stripeStatus === 'success'
        ? {
            tone: 'warn' as const,
            title: 'Vi fant ikke bookingen',
            body: 'Betalingen kan ha gått gjennom, men vi finner ingen booking på referansen i lenken. Sjekk e-posten din for bekreftelse – kommer den ikke, ta kontakt med oss, så finner vi ut av det.',
          }
        : {
            tone: 'warn' as const,
            title: 'Betalingen ble ikke fullført',
            body: 'Vi klarte ikke å knytte betalingen til en booking, og ingen booking er bekreftet. Har du fått en betalingsbekreftelse fra banken, ta kontakt med oss før du prøver på nytt.',
          };
    }
    if (stripeStatus === 'success') {
      return {
        tone: 'ok' as const,
        title: 'Booking bekreftet og betalt!',
        body: `Betaling og booking${ref} er registrert. Du får bekreftelse på e-post.`,
      };
    }
    if (stripeStatus === 'cancelled' || stripeStatus === 'error') {
      return {
        tone: 'warn' as const,
        title: 'Betaling avbrutt',
        body: 'Betalingen ble ikke fullført, så bookingen er ikke bekreftet.',
      };
    }
    if (stripeStatus === 'processing') {
      // Vipps hadn't finished processing when the customer got back. The
      // webhook settles it server-side within seconds, so promise the email
      // rather than a spinner that lies.
      return {
        tone: 'busy' as const,
        title: 'Vi bekrefter betalingen...',
        body: `Betalingen din behandles${ref}. Du får bekreftelse på e-post så snart den er godkjent – vanligvis i løpet av noen sekunder.`,
      };
    }
    return {
      tone: 'ok' as const,
      title: 'Booking mottatt!',
      body: `Vi har mottatt bookingen din${ref}. Du får bekreftelse på e-post.`,
    };
  })();

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* ═══ NAV ═══ */}
      <nav className="sticky top-0 z-50 bg-background/80 backdrop-blur-md border-b border-border">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between gap-3">
          <a href="#" className="flex items-center gap-2 shrink-0">
            {appConfig['logoInHeader'] !== 'false' && appConfig['logoUrl'] ? (
              <img
                src={appConfig['logoUrl']}
                alt={appConfig['businessName'] || 'Graveklar'}
                className="h-10 w-auto object-contain"
              />
            ) : (
              <GraveklarMark className="w-11 h-11" />
            )}
            <span className="font-bold text-xl tracking-tight text-foreground">{appConfig['businessName'] || 'Graveklar'}</span>
          </a>
          {(appConfig['contactPhone']) && (
            <a
              href={`tel:${(appConfig['contactPhone']).replace(/\s/g, '')}`}
              aria-label={`Ring ${appConfig['contactPhone']}`}
              className="md:hidden shrink-0 inline-flex items-center gap-1.5 text-sm font-medium text-primary whitespace-nowrap"
            >
              <Phone className="w-4 h-4" aria-hidden="true" />
              {/* Number text only when there is room next to the logo and CTA */}
              <span className="hidden min-[420px]:inline">{appConfig['contactPhone']}</span>
            </a>
          )}
          <div className="hidden md:flex items-center gap-6 text-sm font-medium text-muted-foreground">
            <a href="#maskin" className="hover:text-foreground transition-colors">Utstyr</a>
            <a href="#priser" className="hover:text-foreground transition-colors">Priser</a>
            <a href="#levering" className="hover:text-foreground transition-colors">Levering</a>
            <a href="#booking" className="hover:text-foreground transition-colors">Booking</a>
            {appConfig['showTermsSection'] !== 'false' && (
              <a href="#vilkar" className="hover:text-foreground transition-colors">Vilkår</a>
            )}
          </div>
          <div className="shrink-0">
            <ThemeToggle />
          </div>
          <a href="#booking" className="shrink-0">
            {/* Outline, not filled: the hero's booking button is the one
                primary action above the fold; this is its shortcut. */}
            <Button size="sm" variant="outline" className="border-primary">
              <span className="hidden min-[420px]:inline">Sjekk ledige datoer</span>
              <span className="min-[420px]:hidden">Se datoer</span>
            </Button>
          </a>
        </div>
      </nav>

      <main className="flex-1">
        {/* ═══ HERO ═══ */}
        <section className="relative overflow-hidden">
          <div className="absolute inset-0">
            {/* This is the page's LCP element. As a plain <img> the 1920px
                upload went out at full size (425 KiB) and wasn't discovered
                until the client rendered — 5.0 s LCP on mobile. next/image
                preloads it with fetchpriority=high, serves it resized to the
                viewport and recompressed, and `sizes` tells it the image is
                always full-bleed. It sits at 30 % opacity behind a gradient,
                so a lower quality is invisible. */}
            <Image
              src={appConfig['heroImageUrl'] || '/hero.jpg'}
              alt=""
              fill
              priority
              sizes="100vw"
              quality={45}
              className="object-cover opacity-30"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
            />
            <div className="absolute inset-0 bg-gradient-to-r from-background via-background/90 to-background/60" />
          </div>
          <div className="relative max-w-6xl mx-auto px-4 py-20 md:py-32">
            {/* One width cap for the whole text block. The heading and
                subtext each had their own, but the CTA row, trust rows and
                disclaimer ran to the full container, so the block visibly
                widened below the heading on large screens. */}
            <div className="max-w-2xl">
            <Badge variant="secondary" className="mb-4 text-xs font-medium uppercase tracking-wider">
              {appConfig['serviceArea'] || 'Bodø & Salten, Nordland'}
            </Badge>
            {(() => {
              const heading = (appConfig['heroHeading'] || '').trim() || '{kategori} levert på døra.';
              const tagline = (appConfig['heroTagline'] || '').trim();
              const currentCategory = heroCategories.length > 0 ? heroCategories[heroCategoryIdx] : '';
              const hasPlaceholder = /\{kategori\}/i.test(heading);

              // Split the heading into the bit BEFORE the rotating word, the
              // word itself, and the bit AFTER. Render the rotating word on
              // its own line so width changes can never reflow neighbouring
              // text into the wrong column at narrow viewports.
              const parts = heading.split(/\{kategori\}/i);
              const beforeText = (parts[0] ?? '').trim();
              const afterText = (parts[1] ?? '').trim();

              return (
                <>
                  <h1 className="text-4xl md:text-6xl font-bold tracking-tight text-foreground max-w-2xl leading-[1.1]">
                    {beforeText && <span className="block">{beforeText}</span>}
                    {hasPlaceholder && currentCategory && (
                      <span
                        key={`cat-${heroCategoryIdx}`}
                        className="block text-primary animate-[fadeIn_0.5s_ease-in-out]"
                      >
                        {currentCategory}
                      </span>
                    )}
                    {afterText && <span className="block">{afterText}</span>}
                    {!hasPlaceholder && (
                      <span className="block">{heading}</span>
                    )}
                  </h1>
                  {tagline && (
                    <p className="mt-3 text-2xl md:text-4xl font-semibold tracking-tight leading-snug text-foreground">
                      {tagline}
                    </p>
                  )}
                </>
              );
            })()}
            {(() => {
              // WYSIWYG: an empty heroSubtext renders nothing (no hidden
              // fallback). The seed default in app-config-defaults supplies
              // starter copy on a fresh install; once the admin clears the
              // field, the subtext is genuinely hidden.
              const raw = (appConfig['heroSubtext'] || '').trim();
              if (!raw) return null;
              // {pris} / {dayPrice} tokens get the live day-price substituted
              // so admin-edited subtext stays dynamic.
              const dayPrice = PRICES.day.price.toLocaleString('nb-NO');
              const subtext = raw.replace(/\{pris\}/gi, dayPrice).replace(/\{dayPrice\}/gi, dayPrice);
              return (
                <p className="mt-6 text-lg md:text-xl text-muted-foreground max-w-xl leading-relaxed">
                  {subtext}
                </p>
              );
            })()}
            {appConfig['b2bEnabled'] === 'true' && (
              <div className="mt-8 inline-flex items-center rounded-lg border border-border bg-card/70 p-1 text-sm backdrop-blur">
                <span className="px-4 py-1.5 rounded-md bg-primary text-primary-foreground font-medium">Privat</span>
                <a
                  href="/bedrift"
                  className="px-4 py-1.5 rounded-md text-muted-foreground hover:text-foreground transition-colors font-medium"
                >
                  Bedrift
                </a>
              </div>
            )}
            <div className={`${appConfig['b2bEnabled'] === 'true' ? 'mt-5' : 'mt-8'} flex flex-col sm:flex-row gap-4`}>
              <a href="#booking">
                <Button size="lg" className="bg-primary hover:bg-primary/90 text-primary-foreground gap-2">
                  Sjekk ledige datoer <ArrowRight className="w-4 h-4" />
                </Button>
              </a>
              {/* Secondary action as a link, not a second button. With the
                  nav button, the hero used to show three near-equal CTAs
                  above the fold; the booking button is now the only one
                  that reads as a button here. */}
              <a
                href="#priser"
                className="inline-flex items-center gap-1.5 self-start sm:self-center text-sm font-medium text-foreground underline underline-offset-4 decoration-primary/60 hover:decoration-primary transition-colors"
              >
                Se hva som er inkludert <ArrowRight className="w-4 h-4 text-primary" />
              </a>
            </div>
            <div className="mt-14 flex flex-wrap gap-x-8 gap-y-3 text-sm leading-relaxed text-muted-foreground">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-primary" />
                <span>Alt inkludert – ingen skjulte gebyrer</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-primary" />
                {/* State the radius here rather than hiding it behind an
                    asterisk. Every address in Bodø sits ~65-68 km from the
                    base, so "Levering + henting inkludert*" promised free
                    delivery to essentially no one in the city the site sells
                    to, and the customer only learned otherwise after typing
                    an address. */}
                <span>Levering + henting inkludert inntil {getConfigValue(config, 'deliveryIncludedKm')} km</span>
              </div>
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-primary" />
                <span>GPS-sporet · forsikret</span>
              </div>
              {appConfig['showInsurerLabel'] === 'true' && (
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-primary" />
                  <span>Forsikret via Fremtind/DNB</span>
                </div>
              )}
              {appConfig['showNoExperienceClaim'] === 'true' && (
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-primary" />
                  <span>Ingen erfaring nødvendig</span>
                </div>
              )}
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              Lenger unna: {getConfigValue(config, 'deliveryPerKm')} kr per km utover de første {getConfigValue(config, 'deliveryIncludedKm')} km. Vi kjører inntil {getConfigValue(config, 'maxDeliveryRadius')} km. Skriv inn adressen din for eksakt pris.
            </p>
            {/* Trust bar */}
            <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
              {appConfig['bookingCount'] && Number(appConfig['bookingCount']) >= Math.max(1, Number(appConfig['bookingCountMin'] ?? 1)) && (
                <span className="flex items-center gap-1"><Star className="w-3.5 h-3.5 text-amber-500" />{appConfig['bookingCount']} gjennomførte bookinger</span>
              )}
              {appConfig['reviewsEnabled'] !== 'false' && reviewAggregate.count > 0 && (
                <a href="#omtaler" className="flex items-center gap-1 hover:text-foreground transition-colors" title="Se kundeomtaler">
                  <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                  <span className="font-medium text-foreground">{reviewAggregate.average.toLocaleString('nb-NO')}</span>
                  /5 ({reviewAggregate.count} {reviewAggregate.count === 1 ? 'omtale' : 'omtaler'})
                </a>
              )}
              {appConfig['orgNumber'] && (
                <a
                  href={`https://virksomhet.brreg.no/nb/oppslag/enheter/${appConfig['orgNumber'].replace(/\s+/g, '')}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-foreground transition-colors"
                  title="Slå opp i Brønnøysundregistrene"
                >
                  Org.nr {appConfig['orgNumber']}
                </a>
              )}
              {appConfig['contactPhone'] && <span className="hidden md:inline">Ring oss: {appConfig['contactPhone']}</span>}
            </div>
            </div>
          </div>
        </section>

        {/* ═══ HOW IT WORKS ═══ */}
        <section className="py-16 md:py-24 bg-card">
          <div className="max-w-6xl mx-auto px-4">
            <div className="text-center mb-12">
              <h2 className="text-3xl font-bold tracking-tight">Slik fungerer det</h2>
              <p className="mt-3 text-muted-foreground">Fire enkle steg til ferdig gravejobb</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              {[
                { icon: Calendar, title: '1. Book', desc: 'Velg dato og leietype. Skriv inn adressen, så beregner vi leveringsprisen automatisk.' },
                { icon: Truck, title: '2. Vi leverer', desc: 'Graveren kjøres til din adresse på avtalt tidspunkt.' },
                { icon: Wrench, title: '3. Du graver', desc: 'Vi gir deg en gjennomgang. Så setter du i gang!' },
                { icon: CheckCircle2, title: '4. Vi henter', desc: 'Når du er ferdig, henter vi utstyret. Enkelt!' },
              ].map((step) => (
                <div key={step.title} className="text-center p-6">
                  <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
                    <step.icon className="w-7 h-7 text-primary" />
                  </div>
                  <h3 className="font-semibold text-lg mb-2">{step.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{step.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ═══ EQUIPMENT ═══ */}
        <section id="maskin" className="py-16 md:py-24">
          <div className="max-w-6xl mx-auto px-4">
            <div className="text-center mb-12">
              <Badge variant="secondary" className="mb-4">Utstyr</Badge>
              <h2 className="text-3xl font-bold tracking-tight mb-3">
                {machines.length > 1 ? 'Utstyr til leie' : (machines[0]?.name || 'Utstyr')}
              </h2>
              {machines.length === 1 && machines[0]?.model && (
                <p className="text-muted-foreground">{machines[0].model}</p>
              )}
            </div>

            {machines.length > 1 ? (
              <EquipmentShowcase
                machines={machines}
                selectedMachineId={selectedMachineId || machines[0].id}
                onSelect={handleSelectMachine}
                effects={equipmentEffectsFromConfig(appConfig)}
                popularMachineId={(appConfig['popularMachineId'] || '').trim()}
                showMostPopular={appConfig['showMostPopular'] !== 'false' && machines.length >= 2}
              />
            ) : (() => {
              const m = machines[0] ?? null;
              const mSpecs: { label: string; value: string }[] = (() => { try { return m?.specs ? JSON.parse(m.specs) : []; } catch { return []; } })();
              const mFeatures: { title: string; desc: string }[] = (() => { try { return m?.features ? JSON.parse(m.features) : []; } catch { return []; } })();
              const mIncluded: string[] = (() => { try { return m?.included ? JSON.parse(m.included) : []; } catch { return []; } })();
              return (
                <div>
                  <FramedEquipmentImage
                    src={m?.imageUrl || '/excavator-card.jpg'}
                    alt={m?.name || 'Utstyr'}
                    effects={equipmentEffectsFromConfig(appConfig)}
                    photoScale={m?.photoScale ?? null}
                    containerClassName="mb-8 max-w-2xl mx-auto aspect-[6/5]"
                  />
                  {m?.description && <p className="text-muted-foreground leading-relaxed mb-8 max-w-2xl mx-auto">{m.description}</p>}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 max-w-4xl mx-auto">
                    <div>
                      {mSpecs.length > 0 && (
                        <div className="grid grid-cols-2 gap-3 mb-6">
                          {mSpecs.map((s) => (
                            <div key={s.label} className="p-3 rounded-lg bg-muted/50">
                              <div className="text-xs text-muted-foreground uppercase tracking-wider">{s.label}</div>
                              <div className="text-sm font-medium mt-0.5">{s.value}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div>
                      {mIncluded.length > 0 && (
                        <div className="mb-4">
                          <div className="text-sm font-semibold mb-2">Inkludert</div>
                          <div className="space-y-1">
                            {mIncluded.map((item, i) => (
                              <div key={i} className="flex items-center gap-2 text-sm text-muted-foreground">
                                <CheckCircle2 className="w-3.5 h-3.5 text-primary shrink-0" />{item}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {mFeatures.length > 0 && (
                        <div>
                          <div className="text-sm font-semibold mb-2">Egenskaper</div>
                          <div className="space-y-1">
                            {mFeatures.map((f, i) => (
                              <div key={i} className="text-sm"><span className="font-medium">{f.title}:</span> <span className="text-muted-foreground">{f.desc}</span></div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        </section>

        {/* ═══ PRICING ═══ */}
        <section id="priser" className="py-16 md:py-24 bg-card">
          <div className="max-w-6xl mx-auto px-4">
            <div className="text-center mb-12">
              <Badge variant="secondary" className="mb-4">Priser</Badge>
              <h2 className="text-3xl font-bold tracking-tight">Alt inkludert – én pris, ingen overraskelser</h2>
              <p className="mt-3 text-muted-foreground"><span className="text-foreground font-medium">Drivstoff for hele leieperioden</span>, levering, forsikring og vask er inkludert. Alle priser inkl. mva.</p>
            </div>

            {(() => {
              // Default: highlight "Helg" as the popular tile. Off only
              // if explicitly disabled via legacy AppConfig.
              const showPopular = appConfig['showMostPopular'] !== 'false';
              const popularType = (appConfig['popularRentalType'] || 'weekend').trim();
              const priceTiles = ([
                { type: 'day' as const },
                { type: 'weekend' as const },
                { type: 'week' as const },
              ])
                .filter(({ type }) => enabledTypes.includes(type))
                .map(({ type }) => ({ type, popular: showPopular && type === popularType }));

              // Match the column count + container width to how many rental
              // types are actually enabled, so the cards stay centered on the
              // page when one or two booking types are disabled instead of
              // left-aligning inside a fixed 3-column grid.
              const gridClass =
                priceTiles.length === 1 ? 'md:grid-cols-1 max-w-sm'
                : priceTiles.length === 2 ? 'md:grid-cols-2 max-w-3xl'
                : 'md:grid-cols-3 max-w-5xl';

              return (
                <div className={`grid grid-cols-1 ${gridClass} gap-6 mx-auto`}>
                  {priceTiles.map(({ type, popular }) => {
                const p = PRICES[type];
                return (
                  <Card
                    key={type}
                    className={`relative ${popular ? 'border-primary border-2 shadow-lg scale-[1.02]' : 'border-border'}`}
                  >
                    {popular && (
                      <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                        <Badge className="bg-primary text-primary-foreground">Mest populær</Badge>
                      </div>
                    )}
                    <CardHeader className="text-center pb-2">
                      <CardTitle className="text-lg">{p.label}</CardTitle>
                      <CardDescription className="text-center space-y-0.5">
                        <div className="flex items-center justify-center gap-1">
                          <Clock className="w-3.5 h-3.5" />
                          {`${p.hours} timer inkludert`}
                        </div>
                        {p.schedule && <div className="text-xs">{p.schedule}</div>}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="text-center">
                      <div className="text-4xl font-bold text-primary mb-1">{p.price.toLocaleString('nb-NO')}</div>
                      <div className="text-sm text-muted-foreground">kr inkl. mva</div>
                      {(() => {
                        const mvaRateCard = readMvaSettings(config).rate;
                        const inclMvaCard = (Number(getConfigValue(config, 'pricesIncludeMva')) || 0) > 0;
                        const mvaAmountCard = inclMvaCard
                          ? Math.round(p.price - p.price / (1 + mvaRateCard / 100))
                          : Math.round(p.price * (mvaRateCard / 100));
                        return mvaAmountCard > 0 ? (
                          <div className="text-xs text-muted-foreground">herav {mvaAmountCard.toLocaleString('nb-NO')} kr mva</div>
                        ) : null;
                      })()}
                      {p.hours > 0 && (
                        <div className="text-xs text-muted-foreground mb-4">≈ {Math.round(p.price / p.hours).toLocaleString('nb-NO')} kr/t</div>
                      )}
                      <Separator className="my-3" />
                      <div className="text-xs text-muted-foreground space-y-1">
                        {(() => {
                          // Period-specific fuel label — "for 1 dag" feels
                          // very different from "for hele uken", and the
                          // latter is what justifies the price visually.
                          const fuelLabel =
                            type === 'day'     ? 'Drivstoff for hele døgnet'
                            : type === 'weekend' ? 'Drivstoff for hele helgen'
                            : type === 'week'    ? 'Drivstoff for hele uken'
                            : 'Drivstoff for hele leieperioden';
                          return (
                            <p className="flex items-center gap-1 font-semibold text-foreground">
                              <CheckCircle2 className="w-3.5 h-3.5 text-primary shrink-0" />{fuelLabel}
                            </p>
                          );
                        })()}
                        <p className="flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-primary shrink-0" />Levering + henting inntil {getConfigValue(config, 'deliveryIncludedKm')} km</p>
                        <p className="flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-primary shrink-0" />Forsikring + vask inkl.</p>
                        {/* Both rates, because they differ: {preOrderHourRate}
                            is what you pay if you book the hours up front,
                            {overtimeRate} is what unplanned overrun costs.
                            Showing only the cheaper one advertised a discount
                            on the penalty rate. */}
                        <p className="text-xs mt-1">Ekstra timer: {overtimeRate} kr/t · forbestilt {preOrderHourRate} kr/t</p>
                        <p className="text-[10px] mt-1">Lenger unna: {getConfigValue(config, 'deliveryPerKm')} kr/km · maks {getConfigValue(config, 'maxDeliveryRadius')} km.</p>
                      </div>
                      <Button
                        className="mt-4 w-full"
                        variant={popular ? 'default' : 'outline'}
                        onClick={() => {
                          setRentalType(type);
                          setStartDate('');
                          setExtraHours(0);
                          document.getElementById('booking')?.scrollIntoView({ behavior: 'smooth' });
                        }}
                      >
                        Velg {p.label}
                      </Button>
                    </CardContent>
                  </Card>
                );
                  })}
                </div>
              );
            })()}

            <div className="mt-8 max-w-4xl mx-auto">
              <Card className="bg-muted/50 border-dashed">
                <CardContent className="flex items-start gap-3 p-4">
                  <Info className="w-5 h-5 text-muted-foreground mt-0.5 shrink-0" />
                  <div className="text-sm text-muted-foreground">
                    <strong>Hva er inkludert?</strong> <span className="text-foreground font-semibold">Drivstoff for hele leieperioden</span>, levering og henting (inntil {getConfigValue(config, 'deliveryIncludedKm')} km), forsikring, vask og personlig opplæring.
                    Trenger du litt ekstra tid? Forbestill ekstra timer til kun {preOrderHourRate} kr per time.
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </section>

        {/* ═══ DELIVERY ═══ */}
        <section id="levering" className="py-16 md:py-24">
          <div className="max-w-6xl mx-auto px-4">
            <div className="text-center mb-12">
              <Badge variant="secondary" className="mb-4">Levering</Badge>
              <h2 className="text-3xl font-bold tracking-tight">Levering inkludert – vi tar oss av alt</h2>
              <p className="mt-3 text-muted-foreground">Levering og henting er inkludert i prisen inntil {getConfigValue(config, 'deliveryIncludedKm')} km</p>
            </div>
            <div className="max-w-3xl mx-auto">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <Card className="text-center border-primary/30">
                  <CardContent className="p-6">
                    <Navigation className="w-8 h-8 text-primary mx-auto mb-3" />
                    <div className="font-semibold mb-1">Automatisk beregning</div>
                    <p className="text-sm text-muted-foreground">Skriv inn adressen din, så beregner vi leveringsprisen automatisk</p>
                  </CardContent>
                </Card>
                <Card className="text-center border-primary/30">
                  <CardContent className="p-6">
                    <Truck className="w-8 h-8 text-primary mx-auto mb-3" />
                    <div className="font-semibold mb-1">Levering til din dør</div>
                    <p className="text-sm text-muted-foreground">Vi leverer utstyret til deg og henter det når du er ferdig</p>
                  </CardContent>
                </Card>
                <Card className="text-center border-primary/30">
                  <CardContent className="p-6">
                    <MapPin className="w-8 h-8 text-primary mx-auto mb-3" />
                    <div className="font-semibold mb-1">{appConfig['serviceArea'] || 'Bodø & Salten'}</div>
                    <p className="text-sm text-muted-foreground">Vi leverer i {appConfig['serviceArea'] || 'Bodø og Salten'}-området</p>
                  </CardContent>
                </Card>
                <Card className="text-center border-primary/30">
                  <CardContent className="p-6">
                    <MapPin className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
                    <div className="font-semibold mb-1">Hent selv</div>
                    <p className="text-sm text-muted-foreground">Hent utstyret selv – ingen leveringskostnad</p>
                  </CardContent>
                </Card>
              </div>
              <div className="mt-6">
                <Card className="bg-muted/50 border-dashed">
                  <CardContent className="flex items-start gap-3 p-4">
                    <Info className="w-5 h-5 text-muted-foreground mt-0.5 shrink-0" />
                    <div className="text-sm text-muted-foreground">
                      <strong>Prøv det!</strong> Skriv inn adressen din i booking-skjemaet nedenfor for å se nøyaktig leveringspris.
                      Leveringsprisen gjelder én vei – vi kjører maskinen til deg og henter den når du er ferdig.
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          </div>
        </section>

        {/* ═══ BOOKING ═══ */}
        <section id="booking" className="py-16 md:py-24 bg-card">
          <div className="max-w-6xl mx-auto px-4">
            <div className="text-center mb-12">
              <Badge variant="secondary" className="mb-4">Booking</Badge>
              <h2 className="text-3xl font-bold tracking-tight">Sjekk tilgjengelighet og book</h2>
              <p className="mt-3 text-muted-foreground">Velg dato, se total pris, og bekreft – betaling med kort, ingen skjulte gebyrer</p>
            </div>

            {!paymentEnabled ? (
              <div className="max-w-2xl mx-auto">
                <Card className="border-2 border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800">
                  <CardContent className="p-8 text-center">
                    <AlertCircle className="w-10 h-10 text-amber-500 mx-auto mb-4" />
                    <h3 className="text-lg font-semibold mb-2">Booking er ikke tilgjengelig ennå</h3>
                    <p className="text-muted-foreground">
                      Vi jobber med å få booking på plass. Ta kontakt med oss direkte for å avtale leie.
                    </p>
                    {appConfig['contactPhone'] && (
                      <a href={`tel:${appConfig['contactPhone'].replace(/\s/g, '')}`} className="inline-block mt-4 text-primary font-semibold underline underline-offset-2">
                        {appConfig['contactPhone']}
                      </a>
                    )}
                  </CardContent>
                </Card>
              </div>
            ) : machines.length > 1 && !selectedMachineId ? (
            <div className="max-w-2xl mx-auto">
              <div className="space-y-3">
                {machines.map((m) => {
                  // The headline price has to quote something the customer can
                  // actually buy. `enabledRentalTypes` can switch the døgn
                  // rental off entirely, and this used to print "2 995 kr
                  // fra/dag" under every machine while every day in the
                  // calendar answered "Ikke tilgjengelig for denne leietypen"
                  // — the cheapest real option was the 5 990 kr weekend (Q-8).
                  const eqOption = ([
                    { type: 'day', price: m.dayPrice ?? PRICES.day.price, unit: 'fra/dag' },
                    { type: 'weekend', price: m.weekendPrice ?? PRICES.weekend.price, unit: 'fra/helg' },
                    { type: 'week', price: m.weekPrice ?? PRICES.week.price, unit: 'fra/uke' },
                  ] as const)
                    .filter((o) => enabledTypes.includes(o.type))
                    .sort((a, b) => a.price - b.price)[0] ?? null;
                  const mSpecs: { label: string; value: string }[] = (() => { try { return m.specs ? JSON.parse(m.specs) : []; } catch { return []; } })();
                  // "Mest populær" badge on a specific machine only when an
                  // operator has explicitly opted in (legacy AppConfig). With
                  // a single machine the badge is meaningless, so it doesn't
                  // show by default.
                  const isPopularMachine = appConfig['showMostPopular'] !== 'false'
                    && (appConfig['popularMachineId'] || '').trim() === m.id;
                  return (
                    <div
                      key={m.id}
                      onClick={() => handleSelectMachine(m.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSelectMachine(m.id); } }}
                      className={`relative w-full flex items-center gap-4 p-5 rounded-xl border-2 hover:border-primary hover:bg-primary/5 text-left transition-all cursor-pointer ${isPopularMachine ? 'border-primary/60' : 'border-border'}`}
                    >
                      {isPopularMachine && (
                        <div className="absolute -top-3 left-4">
                          <Badge className="bg-primary text-primary-foreground text-[10px]">Mest populær</Badge>
                        </div>
                      )}
                      {m.imageUrl ? (
                        <FramedEquipmentImage
                          src={m.imageUrl}
                          alt={m.name}
                          effects={equipmentEffectsFromConfig(appConfig)}
                          photoScale={m.photoScale ?? null}
                          containerClassName="w-24 aspect-[6/5] shrink-0"
                          rounded="rounded-xl"
                          innerRounded="rounded-md"
                        />
                      ) : (
                        <div className="w-24 aspect-[6/5] rounded-xl bg-muted flex items-center justify-center shrink-0">
                          <Wrench className="w-10 h-10 text-muted-foreground" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="font-bold text-lg flex items-center gap-2">
                          <span className="truncate">{m.name}</span>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setInfoMachineId(m.id); }}
                            className="shrink-0 w-6 h-6 rounded-full bg-muted hover:bg-muted/80 flex items-center justify-center transition-colors"
                            aria-label="Vis spesifikasjoner"
                            title="Vis spesifikasjoner"
                          >
                            <Info className="w-3.5 h-3.5 text-muted-foreground" />
                          </button>
                        </div>
                        <div className="text-sm text-muted-foreground">{m.model}{m.year ? ` · ${m.year}` : ''}</div>
                        {m.description && (
                          <div className="text-sm text-muted-foreground mt-1 line-clamp-2">{m.description}</div>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        {eqOption && (
                          <>
                            <div className="text-primary font-bold text-lg">{eqOption.price.toLocaleString('nb-NO')} kr</div>
                            <div className="text-xs text-muted-foreground">{eqOption.unit}</div>
                          </>
                        )}
                        <ArrowRight className="w-5 h-5 text-primary mt-2 ml-auto" />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            ) : (
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-8 max-w-5xl mx-auto">
              {/* ── Form ── */}
              <form onSubmit={handleFormSubmit} className="lg:col-span-3 space-y-6" suppressHydrationWarning>
                {/* Equipment change button — shown when multiple items */}
                {machines.length > 1 && selectedMachineId && (
                  <div className="flex items-center gap-3 p-3 rounded-xl bg-primary/5 border border-primary/20">
                    {selectedEquipment?.imageUrl && (
                      <Image src={selectedEquipment.imageUrl} alt={selectedEquipment.name} width={48} height={48} className="w-12 h-12 rounded-lg object-cover shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-sm">{selectedEquipment?.name}</div>
                      <div className="text-xs text-muted-foreground">{selectedEquipment?.model}</div>
                    </div>
                    <Button type="button" variant="outline" size="sm" onClick={() => { setSelectedMachineId(''); setStartDate(''); }}>
                      Bytt utstyr
                    </Button>
                  </div>
                )}

              {/* Rental type */}
                <div>
                  <Label className="text-sm font-medium mb-3 block">Leietype</Label>
                  <div className="grid grid-cols-3 gap-3">
                    {(['day', 'weekend', 'week'] as const).filter(t => enabledTypes.includes(t)).map((tile) => {
                      const p = PRICES[tile];
                      const active = tileType === tile;
                      return (
                        <button
                          key={tile}
                          type="button"
                          onClick={() => {
                            setTileType(tile);
                            setDayCount(1);
                            setStartDate('');
                            setExtraHours(0);
                          }}
                          className={`p-3 rounded-xl border-2 text-center transition-colors ${
                            active
                              ? 'border-primary bg-primary/5 shadow-sm'
                              : 'border-border hover:border-primary/40'
                          }`}
                        >
                          <div className="font-semibold text-sm">{p.label}</div>
                          <div className="text-xs text-muted-foreground mt-0.5">{p.hours} timer</div>
                          <div className="text-(color:--primary-text) font-bold mt-1">{p.price.toLocaleString('nb-NO')} kr</div>
                          <div className="text-[10px] text-muted-foreground">inkl. mva</div>
                          {p.hours > 0 && (
                            <div className="text-[10px] text-muted-foreground mt-0.5">≈ {Math.round(p.price / p.hours).toLocaleString('nb-NO')} kr/t</div>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  {/* Day count stepper — appears for the 'day' tile. Lets the
                      customer extend a day rental into multiple days (incl.
                      weekend tail) without starting on a weekend. */}
                  {tileType === 'day' && (
                    <div className="mt-4 p-3 rounded-xl bg-primary/5 border border-primary/20">
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-medium">Antall dager:</span>
                        <button type="button"
                          onClick={() => setDayCount((d) => Math.max(1, d - 1))}
                          disabled={dayCount <= 1}
                          className="w-8 h-8 rounded-lg border border-border flex items-center justify-center hover:bg-muted transition-colors font-bold text-lg disabled:opacity-40 disabled:cursor-not-allowed">−</button>
                        <span className="text-lg font-bold text-primary min-w-[2ch] text-center">{dayCount}</span>
                        <button type="button"
                          onClick={() => setDayCount((d) => Math.min(maxDayCountFromStart, d + 1))}
                          disabled={dayCount >= maxDayCountFromStart}
                          className="w-8 h-8 rounded-lg border border-border flex items-center justify-center hover:bg-muted transition-colors font-bold text-lg disabled:opacity-40 disabled:cursor-not-allowed">+</button>
                        <span className="text-sm text-muted-foreground ml-1">
                          {dayCount === 1 ? '(start må være hverdag)' : 'kan strekke seg inn i helgen'}
                        </span>
                      </div>
                      {startDate && dayCount >= maxDayCountFromStart && maxDayCountFromStart < 7 && (
                        <div className="text-xs text-amber-600 mt-2">
                          Maks {maxDayCountFromStart} {maxDayCountFromStart === 1 ? 'dag' : 'dager'} fra denne startdatoen — neste dag er booket eller blokkert.
                        </div>
                      )}
                      {dayCount > 1 && (
                        <div className="text-xs text-muted-foreground mt-2">
                          Pris per dag: hverdag {(weekdayHourly * dayIncludedHours).toLocaleString('nb-NO')} kr · helg {(weekendHourly * dayIncludedHours).toLocaleString('nb-NO')} kr
                        </div>
                      )}
                    </div>
                  )}

                  {/* Week count selector */}
                  {rentalType === 'week' && (
                    <div className="mt-4 p-3 rounded-xl bg-primary/5 border border-primary/20">
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-medium">Antall uker:</span>
                        <button type="button" onClick={() => setWeekCount(w => Math.max(1, w - 1))} aria-label="Færre uker"
                          className="w-8 h-8 rounded-lg border border-border flex items-center justify-center hover:bg-muted transition-colors font-bold text-lg">−</button>
                        <span className="text-lg font-bold text-primary min-w-[2ch] text-center">{weekCount}</span>
                        <button type="button" onClick={() => setWeekCount(w => Math.min(8, w + 1))} aria-label="Flere uker"
                          className="w-8 h-8 rounded-lg border border-border flex items-center justify-center hover:bg-muted transition-colors font-bold text-lg">+</button>
                        <span className="text-sm text-muted-foreground ml-1">
                          {weekCount * 7} dager · {weekCount * PRICES.week.hours} timer
                        </span>
                      </div>
                    </div>
                  )}

                </div>

                {/* Calendar - Inline */}
                <div>
                  {/* Clicking any day of a weekend/week snaps the selection to
                      the period's start day — that is deliberate, so the
                      customer picks *which* weekend rather than hunting for the
                      Friday. The old "(kun fredager)" label described the
                      constraint but contradicted what the calendar let you
                      click; say what actually happens instead. */}
                  <Label className="text-sm font-medium">
                    {rentalType === 'weekend' ? 'Velg helg' : rentalType === 'week' ? 'Velg uke' : 'Velg startdato'}
                    {tileType === 'day' && dayCount > 1 ? ` (${dayCount} dager)` : ''}
                  </Label>
                  {(rentalType === 'weekend' || rentalType === 'week') && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {rentalType === 'weekend'
                        ? 'Klikk en dag i helgen du vil ha – leien starter alltid fredag.'
                        : 'Klikk en dag i uken du vil ha – leien starter alltid mandag.'}
                    </p>
                  )}
                  <div className="mt-1.5 rounded-xl border border-border bg-background p-4">
                    {/* Month navigation */}
                    <div className="flex items-center justify-between mb-4">
                      <button
                        type="button"
                        onClick={prevMonth}
                        className="p-1.5 rounded-lg hover:bg-muted transition-colors"
                        aria-label="Forrige måned"
                      >
                        <ChevronLeft className="w-5 h-5" />
                      </button>
                      <span className="font-semibold text-sm">
                        {NORWEGIAN_MONTH_NAMES[calendarMonth.month]} {calendarMonth.year}
                      </span>
                      <button
                        type="button"
                        onClick={nextMonth}
                        className="p-1.5 rounded-lg hover:bg-muted transition-colors"
                        aria-label="Neste måned"
                      >
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
                        if (!date) {
                          return <div key={`empty-${i}`} className="h-9" />;
                        }

                        const dateStr = toDateStr(date);
                        const isPast = dateStr < todayStr;
                        const isTooSoon = (() => {
                          if (minBookingDaysAhead <= 0 || !todayStr) return false;
                          const earliest = new Date();
                          earliest.setDate(earliest.getDate() + minBookingDaysAhead);
                          return dateStr < toDateStr(earliest);
                        })();
                        const isTentative = tentativeDates.includes(dateStr);
                        const isUnavailable = unavailableDates.includes(dateStr) || isTentative;
                        const isStart = startDate === dateStr;
                        const isInRange = highlightedDates.has(dateStr);
                        const isToday = dateStr === todayStr;
                        const dow = date.getDay();
                        const isNotAllowed = !isDayAllowedForRentalType(rentalType, dow);
                        // Why the *anchor* day of a span (a weekend's Friday, a
                        // week's Monday) cannot start a rental — or null when it
                        // can. A reason, not a boolean: the ladder below used to
                        // fold all three causes into "Opptatt – utstyret er
                        // allerede booket", so a Saturday whose Friday was merely
                        // inside the lead-time window, or already past, told the
                        // customer the machine was booked when nothing was booked
                        // at all (Q-7). `startedLabel` is what to say when the
                        // span has simply begun without them.
                        const anchorBlockedReason = (anchorStr: string, startedLabel: string): string | null => {
                          if (anchorStr < todayStr) return startedLabel;
                          if (unavailableDates.includes(anchorStr)) return 'Opptatt – utstyret er allerede booket';
                          if (isRangeUnavailable(anchorStr)) return 'Opptatt – utstyret er allerede booket';
                          if (minBookingDaysAhead > 0 && todayStr) {
                            const earliest = new Date();
                            earliest.setDate(earliest.getDate() + minBookingDaysAhead);
                            if (anchorStr < toDateStr(earliest)) {
                              return `Booking må gjøres minst ${minBookingDaysAhead} dager i forveien`;
                            }
                          }
                          return null;
                        };
                        // A Sat/Sun snaps to its Friday, so it is only selectable
                        // when that Friday is itself a bookable weekend start.
                        const weekendFriReason = rentalType === 'weekend' && (dow === 6 || dow === 0)
                          ? (() => {
                              const fri = new Date(date);
                              if (dow === 6) fri.setDate(fri.getDate() - 1);
                              if (dow === 0) fri.setDate(fri.getDate() - 2);
                              return anchorBlockedReason(toDateStr(fri), 'Helgen har allerede startet – leien starter fredag');
                            })()
                          : null;
                        const weekendFriBlocked = weekendFriReason !== null;
                        // For weekend rentals, a Friday is only bookable if
                        // the full Fri+Sat+Sun span is free — checking just
                        // the Friday cell would let customers pick a start
                        // date that hits a booked Sat or Sun.
                        const weekendSpanBlocked = rentalType === 'weekend' && dow === 5 && isRangeUnavailable(dateStr);
                        // Week rentals start on Monday and a click snaps to
                        // that Monday — so EVERY day in a week is only
                        // selectable when its Monday is a bookable start (not
                        // past/booked, span free, outside the lead-time
                        // window). Mirrors the snap-and-revalidate in
                        // handleCalendarDayClick; without it the Sat/Sun of an
                        // unbookable week (e.g. one starting inside the lead
                        // time) still looked open.
                        const weekStartReason = rentalType === 'week'
                          ? anchorBlockedReason(
                              toDateStr(snapToStartDay(date, 'week')),
                              'Uken har allerede startet – leien starter mandag',
                            )
                          : null;
                        const weekStartBlocked = weekStartReason !== null;
                        const isDisabled = isPast || isTooSoon || isUnavailable || isNotAllowed || weekendFriBlocked || weekendSpanBlocked || weekStartBlocked;
                        // Any FUTURE day the customer cannot pick — lead-time
                        // window, admin/booked block, an invalid start day for
                        // the selected rental type (e.g. Sat/Sun for a day
                        // rental), or a weekend whose Friday/span is taken —
                        // must READ as blocked (muted + strike-through), not
                        // just faintly different, so the calendar's look
                        // matches what's actually selectable. Past days keep
                        // their own subtler treatment below.
                        const isBlocked = isUnavailable || isTooSoon || isNotAllowed || weekendFriBlocked || weekendSpanBlocked || weekStartBlocked;

                        // Most specific reason first — "booked" beats "too
                        // soon" beats "wrong start day" for a day that is
                        // several of those at once. The anchor reason carries
                        // its own wording (Q-7) and is never flattened to
                        // "Opptatt".
                        const dayUnavailableReason = isTentative
                          ? 'Venter på betaling – kan bli ledig igjen om litt'
                          : isPast
                            ? 'Datoen har passert'
                            : isUnavailable || weekendSpanBlocked
                              ? 'Opptatt – utstyret er allerede booket'
                              : weekendFriReason ?? weekStartReason
                                ?? (isTooSoon
                                  ? `Booking må gjøres minst ${minBookingDaysAhead} dager i forveien`
                                  : isNotAllowed
                                    ? 'Ikke tilgjengelig for denne leietypen'
                                    : null);

                        return (
                          <button
                            key={dateStr}
                            type="button"
                            disabled={isDisabled}
                            onClick={() => handleCalendarDayClick(date)}
                            className={`
                              relative h-11 rounded-lg text-sm transition-[background-color,border-color] flex items-center justify-center
                              ${isStart
                                ? 'bg-primary text-primary-foreground font-bold shadow-sm'
                                : isInRange
                                  ? 'bg-primary/20 text-primary font-semibold'
                                  : isTentative
                                    ? 'bg-amber-500/20 text-amber-700 dark:text-amber-300 cursor-not-allowed'
                                    : isBlocked
                                      ? 'bg-muted/40 text-muted-foreground/40 line-through cursor-not-allowed'
                                      : isPast
                                        ? 'text-muted-foreground/30 cursor-not-allowed'
                                        : 'hover:bg-primary/10 hover:text-primary cursor-pointer font-medium'
                              }
                              ${isToday && !isStart && !isInRange ? 'ring-2 ring-primary/30 ring-inset' : ''}
                            `}
                            aria-label={
                              // A greyed-out square explains nothing on its own,
                              // and on touch there is no hover to reveal the
                              // legend — so put the reason in the accessible
                              // name too, not just the tooltip.
                              `${date.toLocaleDateString('nb-NO', { weekday: 'long', day: 'numeric', month: 'long' })}${dayUnavailableReason ? ` – ${dayUnavailableReason}` : ''}`
                            }
                            title={dayUnavailableReason ?? undefined}
                          >
                            {date.getDate()}
                            {isTentative && !isStart && !isInRange && (
                              <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-amber-500" />
                            )}
                            {isToday && !isStart && !isInRange && !isTentative && (
                              <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-primary" />
                            )}
                          </button>
                        );
                      })}
                    </div>

                    {/* Legend */}
                    <div className="flex flex-wrap gap-3 mt-3 text-xs text-muted-foreground">
                      <div className="flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded bg-primary inline-block" />
                        <span>Startdato</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded bg-primary/20 inline-block" />
                        <span>Leieperiode</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded bg-muted/40 inline-block line-through" />
                        <span>Opptatt</span>
                      </div>
                      {tentativeDates.length > 0 && (
                        <div className="flex items-center gap-1.5">
                          <span className="w-3 h-3 rounded bg-amber-500/20 inline-block" />
                          <span>Venter på betaling – kan bli ledig om litt</span>
                        </div>
                      )}
                      <div className="flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded ring-2 ring-primary/30 ring-inset inline-block" />
                        <span>I dag</span>
                      </div>
                    </div>

                    {weekendWarning && (
                      <div className="mt-3 p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm flex items-center gap-2">
                        <AlertCircle className="w-4 h-4 shrink-0" />
                        {weekendWarning}
                      </div>
                    )}

                    {startDate && (
                      <div className="mt-3 p-3 rounded-lg bg-primary/5 border border-primary/20 text-sm">
                        <span className="text-muted-foreground">Valgt dato: </span>
                        <span className="font-medium text-foreground">
                          {new Date(startDate + 'T00:00:00').toLocaleDateString('nb-NO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Per-day price breakdown for multi-day Day rentals.
                      Renders under the calendar once both a startDate and
                      a multi-day dayCount are chosen. */}
                  {tileType === 'day' && dayCount > 1 && startDate && customBreakdown && (
                    <div className="mt-3 p-3 rounded-lg bg-background border border-border text-sm">
                      <div className="font-medium text-xs uppercase text-muted-foreground mb-2">Prisoppgjør per dag</div>
                      <div className="space-y-1">
                        {customBreakdown.days.map((day) => (
                          <div key={day.date} className="flex justify-between items-center">
                            <span className={day.isWeekend ? 'text-amber-600' : 'text-muted-foreground'}>
                              {new Date(day.date + 'T00:00:00').toLocaleDateString('nb-NO', { weekday: 'short', day: 'numeric', month: 'short' })}
                              {day.isWeekend ? ' (helg)' : ''}
                            </span>
                            <span className="font-medium">{day.price.toLocaleString('nb-NO')} kr</span>
                          </div>
                        ))}
                      </div>
                      <Separator className="my-2" />
                      <div className="flex justify-between font-semibold">
                        <span>Totalt ({customBreakdown.weekdayDays} hverdager, {customBreakdown.weekendDays} helgedager)</span>
                        <span className="text-(color:--primary-text)">{customBreakdown.totalPrice.toLocaleString('nb-NO')} kr</span>
                      </div>
                    </div>
                  )}
                </div>

                {/* Pre-order extra hours */}
                <div>
                  <div className="p-4 rounded-xl border-2 border-primary/20 bg-primary/5">
                    <div className="flex items-start gap-3 mb-3">
                      <Clock className="w-5 h-5 text-primary mt-0.5 shrink-0" />
                      <div>
                        <div className="font-semibold text-sm">Forbestill ekstra timer</div>
                        <p className="text-xs text-muted-foreground mt-1">
                          Du har <span className="font-semibold text-foreground">{includedHours} timer inkludert</span>.
                          Trenger du mer? Forbestill ekstra timer nå til
                          <span className="font-semibold text-(color:--primary-text)"> {preOrderHourRate} kr/time</span> i stedet for
                          <span className="font-semibold text-destructive"> {overtimeRate} kr/time</span> per ekstra time utover inkludert.
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => setExtraHours(h => Math.max(0, h - 1))}
                        aria-label="Færre ekstra timer"
                        className="w-8 h-8 rounded-lg border border-border flex items-center justify-center hover:bg-muted transition-colors font-bold text-lg"
                        disabled={extraHours <= 0}
                      >
                        −
                      </button>
                      <span className="text-lg font-bold text-primary min-w-[2ch] text-center">{extraHours}</span>
                      <button
                        type="button"
                        onClick={() => setExtraHours(h => Math.min(maxExtraHours, h + 1))}
                        aria-label="Flere ekstra timer"
                        className="w-8 h-8 rounded-lg border border-border flex items-center justify-center hover:bg-muted transition-colors font-bold text-lg"
                        disabled={extraHours >= maxExtraHours}
                      >
                        +
                      </button>
                      {extraHours > 0 && (
                        <span className="text-sm text-muted-foreground">
                          {extraHours} timer × {preOrderHourRate} kr = <span className="font-semibold text-(color:--primary-text)">{extraHoursCost.toLocaleString('nb-NO')} kr</span>
                        </span>
                      )}
                    </div>
                    {extraHours >= maxExtraHours && maxExtraHours > 0 && (
                      <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                        <Info className="w-3 h-3" /> Maks {maxExtraHours} ekstra timer – leieperioden er {rentalPeriodHours} timer ({rentalScheduleText})
                      </p>
                    )}
                    {/* Hours breakdown summary */}
                    <div className="mt-3 p-3 rounded-lg bg-background border border-border text-sm">
                      <div className="font-medium text-xs uppercase text-muted-foreground mb-2">Timeroversikt</div>
                      <div className="space-y-1">
                        <div className="flex justify-between items-center">
                          <span className="text-muted-foreground">Inkluderte timer</span>
                          <span className="font-medium">{includedHours} timer</span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-muted-foreground">Ekstra forbestilte timer</span>
                          <span className="font-medium">{extraHours} timer</span>
                        </div>
                        <Separator className="my-1" />
                        <div className="flex justify-between items-center font-semibold">
                          <span>Totalt antall timer</span>
                          <span className="text-(color:--primary-text)">{totalHours} timer</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Delivery method toggle */}
                <div>
                  <Label className="text-sm font-medium mb-3 block">Leveringsmetode</Label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        setSelfPickup(false);
                        // "Hent selv" threw the delivery quote away but left the
                        // typed address on screen. Coming back here without
                        // re-pricing it showed "Leveringsadresse: … · Leveringspris:
                        // 0 kr" and posted deliveryFee 0 with no quote token (Q-5).
                        // Re-price what is still in the field; if there is nothing
                        // to re-price, clear it so the required-address guard fires
                        // instead of a silent 0 kr delivery.
                        if (deliveryInfo || !address.trim()) return;
                        if (selectedCoords) {
                          void calculateDeliveryWithCoords(address, selectedCoords.lat, selectedCoords.lon);
                        } else if (address.trim().length >= 5) {
                          void calculateDelivery(address);
                        } else {
                          setAddress('');
                        }
                      }}
                      className={`p-3 rounded-xl border-2 text-center transition-colors ${!selfPickup ? 'border-primary bg-primary/5 shadow-sm' : 'border-border hover:border-primary/40'}`}
                    >
                      <Truck className="w-5 h-5 mx-auto mb-1 text-primary" />
                      <div className="font-semibold text-sm">Levering til deg</div>
                      <div className="text-xs text-muted-foreground mt-0.5">Inkludert inntil {getConfigValue(config, 'deliveryIncludedKm')} km</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => { setSelfPickup(true); setDeliveryInfo(null); setDeliveryError(''); setDeliveryOutsideRadius(false); }}
                      className={`p-3 rounded-xl border-2 text-center transition-colors ${selfPickup ? 'border-primary bg-primary/5 shadow-sm' : 'border-border hover:border-primary/40'}`}
                    >
                      <MapPin className="w-5 h-5 mx-auto mb-1 text-primary" />
                      <div className="font-semibold text-sm">Hent selv – ingen leveringskostnad</div>
                      <div className="text-xs text-muted-foreground mt-0.5">Tilhenger inkludert</div>
                    </button>
                  </div>
                </div>

                {/* Delivery address with auto-suggest */}
                {selfPickup ? (
                  <div className="space-y-3">
                    <div className="p-4 rounded-xl border border-primary/20 bg-primary/5 text-sm">
                      <div className="font-medium mb-1 flex items-center gap-2"><MapPin className="w-4 h-4 text-primary" /> Selvhenting</div>
                      <p className="text-muted-foreground">
                        Du henter og leverer maskinen selv – ingen leveringskostnad.
                        Opphentingsadresse avtales etter bekreftelse.
                      </p>
                    </div>
                    <div className="p-4 rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 text-sm">
                      <div className="font-semibold text-amber-800 dark:text-amber-300 mb-2 flex items-center gap-2">
                        <AlertCircle className="w-4 h-4 shrink-0" /> Viktig informasjon om selvhenting
                      </div>
                      <p className="text-amber-700 dark:text-amber-400 leading-relaxed">
                        Du er selv ansvarlig for å ha et kjøretøy som er godkjent for å trekke <strong>3 500 kg totalvekt</strong> og ha gyldig <strong>kompetansebevis for tilhenger</strong>. Vi forbeholder oss retten til å nekte utlevering dersom disse kravene ikke er oppfylt ved oppmøte.
                      </p>
                    </div>
                  </div>
                ) : (
                <div ref={addressWrapperRef}>
                  <Label htmlFor="deliveryAddress" className="text-sm font-medium">
                    Leveringsadresse *
                  </Label>
                  <div className="relative mt-1.5">
                    <Input
                      id="deliveryAddress"
                      role="combobox"
                      aria-autocomplete="list"
                      aria-expanded={showAddressSuggestions && addressSuggestions.length > 0}
                      aria-controls="deliveryAddress-suggestions"
                      value={address}
                      onChange={(e) => handleAddressChange(e.target.value)}
                      onFocus={() => {
                        if (addressSuggestions.length > 0) setShowAddressSuggestions(true);
                      }}
                      required
                      placeholder="F.eks. Storgata 1, Bodø"
                      autoComplete="off"
                      className={deliveryInfo ? 'pr-10 border-primary/50' : deliveryError ? 'pr-10 border-destructive/50' : ''}
                    />
                    {isSuggestingAddress && !isCalculatingDelivery && (
                      <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground animate-spin" />
                    )}
                    {isCalculatingDelivery && (
                      <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground animate-spin" />
                    )}
                    {deliveryInfo && !isCalculatingDelivery && !isSuggestingAddress && (
                      <CheckCircle2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-primary" />
                    )}
                    {deliveryError && !isCalculatingDelivery && !isSuggestingAddress && (
                      <AlertCircle className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-destructive" />
                    )}

                    {/* Address suggestions dropdown */}
                    {showAddressSuggestions && addressSuggestions.length > 0 && (
                      <div id="deliveryAddress-suggestions" role="listbox" aria-label="Adresseforslag" className="absolute z-50 top-full left-0 right-0 mt-1 bg-background border border-border rounded-lg shadow-lg max-h-48 overflow-y-auto custom-scrollbar">
                        {addressSuggestions.map((suggestion, idx) => (
                          <button
                            key={idx}
                            type="button"
                            role="option"
                            aria-selected={false}
                            onClick={() => selectAddressSuggestion(suggestion)}
                            className="w-full text-left px-3 py-2.5 text-sm hover:bg-primary/5 transition-colors flex items-start gap-2 border-b border-border/50 last:border-b-0"
                          >
                            <MapPin className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
                            <div className="min-w-0">
                              <span className="block font-medium truncate">{suggestion.short_name}</span>
                              <span className="block text-xs text-muted-foreground truncate">{suggestion.display_name}</span>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {deliveryInfo && (
                    <div className="mt-2 p-3 rounded-lg bg-primary/5 border border-primary/20 text-sm">
                      <div className="flex items-center gap-2 text-primary font-medium">
                        <Navigation className="w-4 h-4" />
                        {deliveryInfo.fee === 0 ? (
                          <span>Levering inkludert! ({deliveryInfo.distance} km)</span>
                        ) : (
                          <span>Levering: +{deliveryInfo.fee.toLocaleString('nb-NO')} kr ({deliveryInfo.distance} km – utover {getConfigValue(config, 'deliveryIncludedKm')} km inkludert)</span>
                        )}
                      </div>
                    </div>
                  )}
                  {deliveryError && !deliveryOutsideRadius && (
                    <p className="mt-2 text-sm text-destructive flex items-center gap-1.5">
                      <AlertCircle className="w-3.5 h-3.5" />
                      {deliveryError}
                    </p>
                  )}
                  {deliveryOutsideRadius && (
                    <div className="mt-2 p-3 rounded-lg bg-amber-50 border border-amber-200 dark:bg-amber-950/30 dark:border-amber-800">
                      <div className="flex items-center gap-1.5 text-amber-800 dark:text-amber-300 font-medium text-sm mb-1">
                        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                        {deliveryError}
                      </div>
                      <p className="text-amber-700 dark:text-amber-400 text-xs">
                        Ta kontakt med oss direkte for å avtale levering:
                        {appConfig['contactPhone'] && (
                          <> <a href={`tel:${appConfig['contactPhone'].replace(/\s/g, '')}`} className="font-semibold underline">{appConfig['contactPhone']}</a></>
                        )}
                        {appConfig['contactEmail'] && (
                          <> · <a href={`mailto:${appConfig['contactEmail']}`} className="font-semibold underline">{appConfig['contactEmail']}</a></>
                        )}
                      </p>
                    </div>
                  )}
                  {/* Only useful before a price exists. Once the address is
                      priced, this line sat under the real figure telling the
                      customer it would be calculated — and "min. 0 kr" says
                      nothing at all, so it only appears when there is a floor. */}
                  {!deliveryInfo && (
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      Velg adressen fra listen, så beregner vi leveringsprisen automatisk{minDeliveryFee > 0 ? ` (minimum ${minDeliveryFee} kr)` : ''}.
                    </p>
                  )}
                </div>
                )} {/* end selfPickup else */}

                <Separator />

                {/* Customer info */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="name">Navn *</Label>
                    <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required className="mt-1.5" placeholder="Ola Nordmann" />
                  </div>
                  <div>
                    <Label htmlFor="phone">Telefon *</Label>
                    <Input id="phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required className="mt-1.5" placeholder="412 34 567" />
                  </div>
                </div>
                <div>
                  <Label htmlFor="email">E-post *</Label>
                  <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="mt-1.5" placeholder="ola@eksempel.no" />
                </div>
                <div>
                  <Label htmlFor="preferredTime">Ønsket levering/henting (valgfritt)</Label>
                  <Input
                    id="preferredTime"
                    value={preferredTime}
                    onChange={(e) => setPreferredTime(e.target.value)}
                    className="mt-1.5"
                    placeholder="F.eks. 08:00, formiddag, etter kl. 16"
                  />
                </div>
                <div>
                  <Label htmlFor="notes">Kommentar (valgfritt)</Label>
                  <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1.5" placeholder="F.eks. beskrivelse av prosjekt, spesielle ønsker..." rows={3} />
                </div>

                <input
                  type="text"
                  name="website"
                  value={websiteHoneypot}
                  onChange={(e) => setWebsiteHoneypot(e.target.value)}
                  className="hidden"
                  tabIndex={-1}
                  autoComplete="off"
                  aria-hidden
                />

                {/* ── Discount block (just above the confirm button) ─────────────
                    First-time eligibility is auto-applied and shown as a banner.
                    Manual rabattkode input is gated by a checkbox so most users
                    don't see it (reduces friction + reduces "do I have a code?"
                    confusion). The checkbox auto-checks if a code is already
                    typed (URL prefill / autofill). */}
                <div className="space-y-3">
                  {(() => {
                    const firstTimeLine = quote?.discountLines.find((l) => l.kind === 'first-time');
                    if (!firstTimeLine) return null;
                    return (
                      <div className="flex items-start gap-2 p-3 rounded-xl bg-green-50 border border-green-200 text-green-800 dark:bg-green-950/20 dark:border-green-900 dark:text-green-300 text-sm">
                        <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                        <span>
                          <strong>Førstegangskunde – {firstTimeLine.percent}% rabatt</strong> trekkes automatisk fra totalen.
                        </span>
                      </div>
                    );
                  })()}

                  <div>
                    <label className="inline-flex items-center gap-2 cursor-pointer select-none text-sm text-foreground">
                      <input
                        type="checkbox"
                        checked={showDiscountInput}
                        onChange={(e) => setShowDiscountInput(e.target.checked)}
                        className="w-4 h-4 rounded border-border accent-primary cursor-pointer"
                      />
                      <span>Jeg har en rabattkode</span>
                    </label>

                    {showDiscountInput && (
                      <div className="mt-2">
                        <Input
                          id="discountCode"
                          value={discountCode}
                          onChange={(e) => setDiscountCode(e.target.value.toUpperCase())}
                          className="font-mono uppercase tracking-wider"
                          placeholder="Rabattkode"
                          maxLength={12}
                          autoComplete="off"
                        />
                        {quote && discountCode.trim() && (() => {
                          // Status derives from the canonical quote:
                          //   - code-kind line present → the code is applied to
                          //     THIS booking, and createPendingBooking spends it
                          //     (redeemCampaignCode / the repeat-code claim)
                          //   - warnings include a `code-...` reason → invalid
                          //   - neither, next to a first-time discount → the
                          //     engine dropped the code in favour of first-time
                          //     and left it unredeemed, so it really is still
                          //     good next time.
                          const codeLine = quote.discountLines.find((l) => l.kind === 'repeat' || l.kind === 'campaign');
                          const codeWarning = quote.warnings.find((w) => w.code.startsWith('code-'));
                          const hasFirstTime = quote.discountLines.some((l) => l.kind === 'first-time');
                          if (codeLine) {
                            // Never "tas vare på til neste booking" here. That
                            // copy was written for a repeat code losing to the
                            // first-time discount — but computeDiscount removes
                            // the losing line, so a line that IS present is a
                            // line that IS charged and spent. Told to a campaign
                            // code (which stacks with first-time) it was simply
                            // false: usedCount was incremented and a
                            // CampaignRedemption row written (Q-9).
                            return (
                              <p className="text-xs mt-1.5">
                                <span className="text-green-700 dark:text-green-400">
                                  ✓ Rabattkode gyldig – {codeLine.percent}% trekkes{hasFirstTime ? ' i tillegg til førstegangsrabatten' : ''}.
                                </span>
                              </p>
                            );
                          }
                          if (codeWarning) {
                            return <p className="text-xs mt-1.5"><span className="text-destructive">✗ {codeWarning.message}</span></p>;
                          }
                          if (hasFirstTime) {
                            return (
                              <p className="text-xs mt-1.5">
                                <span className="text-amber-700 dark:text-amber-400">
                                  ⓘ Førstegangskunde-rabatten brukes denne gangen – koden er ikke brukt opp og gjelder til neste booking.
                                </span>
                              </p>
                            );
                          }
                          return null;
                        })()}
                      </div>
                    )}
                  </div>
                </div>

                {error && (
                  <div className="flex items-center gap-2 text-destructive text-sm">
                    <AlertCircle className="w-4 h-4" />
                    {error}
                  </div>
                )}

                {quote && !quote.bookable && quote.blockedReason && (
                  <div className="flex items-center gap-2 text-destructive text-sm">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    {quote.blockedReason}
                  </div>
                )}

                <Button type="submit" size="lg" className="w-full bg-primary hover:bg-primary/90 text-primary-foreground" disabled={isSubmitting || isCalculatingDelivery || (quote ? !quote.bookable : false)}>
                  {isSubmitting ? 'Bekrefter...' : isCalculatingDelivery ? 'Beregner levering...' : 'Bekreft booking'}
                </Button>
              </form>

              {/* ── Price summary ── */}
              <div className="lg:col-span-2">
                <Card className="sticky top-24 border-2 border-primary/20">
                  <CardHeader>
                    <CardTitle className="text-lg flex items-center gap-2">
                      <Star className="w-5 h-5 text-primary" /> Din booking
                    </CardTitle>
                    {machines.length > 0 && (
                      <p className="text-sm text-muted-foreground">
                        {selectedMachineId
                          ? (() => { const m = machines.find(x => x.id === selectedMachineId); return m ? `${m.name} · ${m.model}` : ''; })()
                          : machines.length > 1 ? 'Ingen maskin valgt' : `${machines[0].name} · ${machines[0].model}`}
                      </p>
                    )}
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {/* Before a date is picked we don't have a real rental
                        period, so totals would be misleading. Show a placeholder
                        instead of a phantom price. */}
                    {!startDate ? (
                      <div className="text-sm text-muted-foreground border border-dashed border-border rounded-lg p-3 text-center">
                        Velg en dato i kalenderen for å se totalpris.
                      </div>
                    ) : (
                    <>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">
                        {rentalType === 'custom'
                          ? `Døgn × ${customDays}`
                          : `${PRICES[rentalType].label}`
                        }
                      </span>
                      <span className="font-medium">{basePrice.toLocaleString('nb-NO')} kr</span>
                    </div>
                    {/* Hours breakdown */}
                    <div className="rounded-lg bg-muted/40 p-2.5 text-xs space-y-1">
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground">Inkluderte timer</span>
                        <span className="font-medium">{includedHours} timer</span>
                      </div>
                      {extraHours > 0 && (
                        <div className="flex justify-between items-center">
                          <span className="text-muted-foreground">Ekstra forbestilte timer</span>
                          <span className="font-medium">{extraHours} timer</span>
                        </div>
                      )}
                      <div className="flex justify-between items-center font-semibold">
                        <span>Totalt antall timer</span>
                        <span className="text-(color:--primary-text)">{totalHours} timer</span>
                      </div>
                    </div>
                    {extraHours > 0 && (
                      <div className="flex justify-between text-sm">
                        <span className="text-muted-foreground">
                          Forbestilte timer ({extraHours} × {preOrderHourRate} kr)
                        </span>
                        <span className="font-medium">{extraHoursCost.toLocaleString('nb-NO')} kr</span>
                      </div>
                    )}
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">{selfPickup ? 'Selvhenting' : 'Levering'}</span>
                      <span className="font-medium">
                        {selfPickup ? 'Inkludert' :
                         !address ? 'Skriv inn adresse' :
                         isCalculatingDelivery ? 'Beregner...' :
                         deliveryInfo ? (deliveryInfo.fee === 0 ? 'Inkludert!' : `+${deliveryInfo.fee.toLocaleString('nb-NO')} kr`) :
                         deliveryError ? '—' : 'Skriv inn adresse'}
                      </span>
                    </div>
                    {/* Discount lines — authoritative from /api/quote. The
                        frontend renders these verbatim and does no math of
                        its own. The server runs the same buildQuote at
                        booking-submission time and rejects on drift. */}
                    {quote?.discountLines.map((line, i) => (
                      <div key={`${line.kind}-${i}`} className="flex justify-between text-sm text-green-700">
                        <span>{line.label} (-{line.percent}%)</span>
                        <span className="font-medium">-{line.amountKr.toLocaleString('nb-NO')} kr</span>
                      </div>
                    ))}
                    <Separator />
                    {/* MVA + total — authoritative when quote is available.
                        Before the quote arrives (or fails) we render the
                        local approximation so the customer never sees a
                        blank summary. The local approximation is best-effort
                        only; the booking submit re-validates against the
                        server's buildQuote. */}
                    {(() => {
                      const haveTotal = selfPickup || (address && deliveryInfo);
                      // Prefer quote values when available; fall back to the
                      // local approximation while the debounce/network is in
                      // flight. The shown numbers will reconcile within ~400ms.
                      let exMva: number, mvaAmt: number, mvaRate: number, totalIncl: number;
                      if (quote) {
                        exMva = quote.mvaBreakdown.exMva;
                        mvaAmt = quote.mvaBreakdown.mvaAmt;
                        mvaRate = quote.mvaBreakdown.mvaRate;
                        totalIncl = quote.totalPrice;
                      } else {
                        const preDiscount = haveTotal ? totalPrice : (basePrice + extraHoursCost);
                        mvaRate = readMvaSettings(config).rate;
                        const inclMva = (Number(getConfigValue(config, 'pricesIncludeMva')) || 0) > 0;
                        const factor = 1 + mvaRate / 100;
                        exMva = inclMva ? Math.round(preDiscount / factor) : preDiscount;
                        mvaAmt = inclMva ? preDiscount - exMva : Math.round(preDiscount * (mvaRate / 100));
                        totalIncl = inclMva ? preDiscount : preDiscount + mvaAmt;
                      }
                      return (
                        <>
                          <div className="space-y-1 text-sm text-muted-foreground">
                            <div className="flex justify-between">
                              <span>Sum eks. MVA</span>
                              <span className="font-medium tabular-nums">{exMva.toLocaleString('nb-NO')} kr</span>
                            </div>
                            <div className="flex justify-between">
                              <span>MVA ({mvaRate} %)</span>
                              <span className="font-medium tabular-nums">{mvaAmt.toLocaleString('nb-NO')} kr</span>
                            </div>
                          </div>
                          <div className="flex justify-between font-semibold text-base">
                            <div>
                              <div>Totalt</div>
                              <div className="text-xs font-normal text-muted-foreground">
                                inkl. mva{quoteLoading ? ' · oppdaterer…' : ''}
                              </div>
                            </div>
                            <span className="text-primary tabular-nums">
                              {haveTotal
                                ? `${totalIncl.toLocaleString('nb-NO')} kr`
                                : `${totalIncl.toLocaleString('nb-NO')} kr + levering`}
                            </span>
                          </div>
                        </>
                      );
                    })()}
                    {/* "Du betaler ingenting i tillegg" call-out — the goal
                        is to make it obvious that fuel for the full period
                        is baked into the headline price. */}
                    {(() => {
                      const fuelLabel =
                        rentalType === 'day'     ? 'hele døgnet'
                        : rentalType === 'weekend' ? 'hele helgen'
                        : rentalType === 'week'    ? 'hele uken'
                        : 'hele leieperioden';
                      return (
                        <div className="rounded-lg bg-primary/5 border border-primary/20 p-3 text-xs">
                          <div className="font-semibold text-foreground mb-1.5">Du betaler ingenting i tillegg for:</div>
                          <ul className="space-y-1 text-foreground/80">
                            <li className="flex items-start gap-1.5">
                              <CheckCircle2 className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
                              {/* "fylt", not "fyllt" — and the machine arrives
                                  rather than being collected when the customer
                                  chose delivery. */}
                              <span><span className="font-medium">Drivstoff for {fuelLabel}</span> – fylt opp og klar {selfPickup ? 'når du henter' : 'når vi leverer'}</span>
                            </li>
                            <li className="flex items-start gap-1.5">
                              <CheckCircle2 className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
                              <span>Forsikring og vask etter retur</span>
                            </li>
                            <li className="flex items-start gap-1.5">
                              <CheckCircle2 className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
                              <span>{selfPickup ? 'Avhenting og retur på vår plass' : 'Levering og henting'}</span>
                            </li>
                          </ul>
                        </div>
                      );
                    })()}
                    <div className="rounded-lg bg-muted/60 p-3 text-xs space-y-1 text-muted-foreground">
                      <div className="flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5" />
                        <span>Ekstra timer: {overtimeRate} kr/t | Forbestilt: {preOrderHourRate} kr/t</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Shield className="w-3.5 h-3.5" />
                        <span>Kortbetaling ved booking</span>
                      </div>
                    </div>

                    {startDate && (
                      <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm">
                        <div className="font-medium text-primary mb-1">Periode</div>
                        <div className="text-muted-foreground">{endDateStr}</div>
                        {/* The schedule the dates are derived from, printed
                            with them: the two used to disagree (Q-13). */}
                        <div className="text-xs text-muted-foreground/80 mt-0.5">{rentalScheduleText}</div>
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={() => setShowTerms(true)}
                      className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground transition-colors"
                    >
                      Ved å booke godtar du våre vilkår og betingelser
                    </button>
                    </>
                    )}
                  </CardContent>
                </Card>
              </div>
            </div>
            )} {/* end classic/wizard conditional */}
          </div>
        </section>

        {/* ═══ FAQ ═══ */}
        {/* faqConfigured distinguishes "never set up" (show fallback) from
            "configured + toggled off" (respect the toggles). The section
            hides entirely when the resulting list is empty so a fully
            toggled-off FAQ disappears instead of reverting to the fallback. */}
        {appConfig['showFaqSection'] !== 'false' && faqList.length > 0 && (
        <section className="py-16 md:py-24">
          <div className="max-w-3xl mx-auto px-4">
            <div className="text-center mb-12">
              <h2 className="text-3xl font-bold tracking-tight">Ofte stilte spørsmål</h2>
            </div>
            <div className="space-y-4">
              {faqList.map((item) => (
                <details key={item.q} className="group rounded-xl border border-border bg-card">
                  <summary className="flex items-center justify-between p-4 cursor-pointer text-sm font-medium hover:bg-muted/30 transition-colors rounded-xl">
                    {item.q}
                    <ChevronRight className="w-4 h-4 text-muted-foreground transition-transform group-open:rotate-90" />
                  </summary>
                  <div className="px-4 pb-4 text-sm text-muted-foreground leading-relaxed">{item.a}</div>
                </details>
              ))}
            </div>
          </div>
        </section>
        )}

        {/* ═══ TERMS (quick ref) ═══ */}
        {appConfig['showTermsSection'] !== 'false' && (
        <section id="vilkar" className="py-16 md:py-24 bg-card">
          <div className="max-w-3xl mx-auto px-4">
            <div className="text-center mb-12">
              <Badge variant="secondary" className="mb-4">Vilkår</Badge>
              <h2 className="text-3xl font-bold tracking-tight">Vilkår og betingelser</h2>
              <p className="mt-3 text-muted-foreground">Kort oppsummering – fullstendige vilkår vises ved booking</p>
            </div>
            <div className="space-y-4">
              {(dynamicTerms.length
                ? dynamicTerms.map(s => ({ title: s.title, text: s.content }))
                : [
                  {
                    title: 'Leieperiode og brukstid',
                    text: `1 dag inkluderer ${getConfigValue(config, 'dayIncludedHours')} timer, helg (fre 16:00 – man 08:00) inkluderer ${getConfigValue(config, 'weekendIncludedHours')} timer, og 1 uke inkluderer ${getConfigValue(config, 'weekIncludedHours')} timer. Ekstra timer utover inkludert: ${overtimeRate} kr/t. Forbestill ekstra timer: ${preOrderHourRate} kr/t.`,
                  },
                  {
                    title: 'Betaling',
                    text: `Prisen inkluderer levering og henting inntil ${getConfigValue(config, 'deliveryIncludedKm')} km, drivstoff, forsikring og vask. Betaling skjer i henhold til bookingbekreftelsen.`,
                  },
                  {
                    title: 'Drivstoff',
                    text: 'Drivstoff er inkludert i leieprisen. Tilstrekkelig drivstoff for hele leieperioden leveres med utstyret.',
                  },
                  {
                    title: 'Skader og ansvar',
                    text: 'Leietaker er ansvarlig for skader forårsaket av uforsvarlig bruk eller brudd på vilkårene. Normal slitasje er utleiers ansvar. Forsikringens egenandeler er leietakers ansvar.',
                  },
                  {
                    title: 'Forsikring',
                    text: 'Maskinen er forsikret med kasko- og maskinskadedekning. Ansvarsforsikring dekker tredjepart opp til 20 000 000 kr. Forsikringen dekker ikke skader ved brudd på bruksvilkårene.',
                  },
                  {
                    title: 'Avbestilling',
                    text: `Gratis avbestilling inntil ${cancelFreeLabel} før avtalt leiestart. Avbestilling under ${cancelFreeLabel}: ${cancelLatePercent} % av leieprisen. Samme dag eller no-show: ${cancelSameDayPercent} % av leieprisen.`,
                  },
                  {
                    title: 'Sikkerhet og krav',
                    text: `Leietaker må delta på sikkerhetsorientering ved utlevering. Leietaker må være fylt ${appConfig['minAge'] || '21'} år og fremvise gyldig legitimasjon. Maskinen kan ikke brukes til riving uten forhåndsgodkjenning, i vann dypere enn 30 cm, eller til arbeid som overskrider maskinens kapasitet.`,
                  },
                  {
                    title: 'Retur og vask',
                    text: 'Maskinen skal returneres i rimelig ren stand. Normalt greinutsyn fra gravearbeid aksepteres. Unødig skitten retur medfører et rengjøringsgebyr på 500 kr.',
                  },
                  {
                    title: 'Levering og henting',
                    text: `Levering og henting er inkludert inntil ${getConfigValue(config, 'deliveryIncludedKm')} km. For lengre distanser beregnes tillegg per km. Minimumsgebyr: ${minDeliveryFee} kr. Leveringsområde: ${appConfig['serviceArea'] || 'Bodø og Salten'}.`,
                  },
                ]
              ).map((t) => (
                <Card key={t.title}>
                  <CardContent className="p-4">
                    <h3 className="font-semibold text-sm mb-1">{t.title}</h3>
                    <p className="text-sm text-muted-foreground leading-relaxed">{t.text}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </section>
        )}

        {/* ═══ INSURANCE ═══ */}
        {appConfig['showInsuranceSection'] !== 'false' && (
        <section className="py-16 md:py-24">
          <div className="max-w-4xl mx-auto px-4">
            <div className="text-center mb-12">
              <Badge variant="secondary" className="mb-4">Forsikring</Badge>
              <h2 className="text-3xl font-bold tracking-tight">Full forsikringsdekning</h2>
              <p className="mt-3 text-muted-foreground">Full kasko- og maskinskadedekning</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {(dynamicInsurance.length
                ? dynamicInsurance
                : [
                  { label: 'Ansvarsforsikring', value: 'Opp til 20 000 000 kr', detail: 'Ingen egenandel (uregistrert)' },
                  { label: 'Kasko', value: '239 000 kr', detail: 'Egenandel: 12 000 kr' },
                  { label: 'Minikasko', value: '239 000 kr', detail: 'Brann/tyveri: 12 000 kr egenandel' },
                  { label: 'Maskinskade', value: 'Dekkes', detail: 'Egenandel: 10 000 kr' },
                  { label: 'Veihjelp', value: 'Inkludert', detail: 'Egenandel: 2 500 kr' },
                  { label: 'Rettshjelp', value: 'Inkludert', detail: '4 000 kr + 20% av overskytende' },
                ]
              ).map((item) => (
                <Card key={item.label} className="border-border">
                  <CardContent className="p-4">
                    <Shield className="w-5 h-5 text-primary mb-2" />
                    <div className="font-semibold text-sm">{item.label}</div>
                    <div className="text-primary font-bold mt-0.5">{item.value}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{item.detail}</div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </section>
        )}

        {appConfig['reviewsEnabled'] !== 'false' && reviews.length > 0 && (
        <section id="omtaler" className="py-16 border-t border-border bg-muted/30">
          <div className="max-w-5xl mx-auto px-4">
            <div className="text-center mb-10">
              <h2 className="text-2xl md:text-3xl font-bold tracking-tight">Hva kundene sier</h2>
              {reviewAggregate.count > 0 && (
                <div className="mt-3 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                  <span className="flex items-center gap-0.5">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <Star key={n} className={`w-4 h-4 ${reviewAggregate.average >= n - 0.5 ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/30'}`} />
                    ))}
                  </span>
                  <span className="font-semibold text-foreground">{reviewAggregate.average.toLocaleString('nb-NO')}</span>
                  av 5 · {reviewAggregate.count} {reviewAggregate.count === 1 ? 'omtale' : 'omtaler'}
                </div>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {reviews.map((r) => (
                <Card key={r.id} className="h-full">
                  <CardContent className="p-5 flex flex-col h-full">
                    <div className="flex items-center gap-0.5 mb-3">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <Star key={n} className={`w-4 h-4 ${r.rating >= n ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/25'}`} />
                      ))}
                    </div>
                    {r.comment && (
                      <p className="text-sm text-foreground/90 leading-relaxed flex-1">“{r.comment}”</p>
                    )}
                    <div className="mt-4 text-xs text-muted-foreground">
                      {r.reviewerName} · {new Date(r.date).toLocaleDateString('nb-NO', { month: 'long', year: 'numeric' })}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </section>
        )}
      </main>

      <Footer appConfig={appConfig} />

      {/* ═══ BOOKING CONFIRMATION DIALOG ═══ */}
      <Dialog open={showBookingConfirm} onOpenChange={setShowBookingConfirm}>
        <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto custom-scrollbar">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Calendar className="w-5 h-5 text-primary" /> Bekreft din booking
            </DialogTitle>
            <DialogDescription>
              Se gjennom detaljene før du bekrefter bookingen.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="rounded-lg bg-primary/5 p-4 space-y-2">
              {/* Which machine — the last screen before payment used to list
                  everything except the thing being rented. */}
              {selectedEquipment && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Utstyr:</span>
                  <span className="font-medium text-right max-w-[200px]">
                    {selectedEquipment.name}{selectedEquipment.model ? ` · ${selectedEquipment.model}` : ''}
                  </span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">Leietype:</span>
                <span className="font-medium">
                  {rentalType === 'custom'
                    ? `Døgn × ${customDays}`
                    : `${PRICES[rentalType].label}`
                  }
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Leiepris:</span>
                <span className="font-medium">{basePrice.toLocaleString('nb-NO')} kr</span>
              </div>
              {extraHours > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Forbestilte timer ({extraHours} × {preOrderHourRate} kr):</span>
                  <span className="font-medium">{extraHoursCost.toLocaleString('nb-NO')} kr</span>
                </div>
              )}
              <Separator />
              <div className="flex justify-between">
                <span className="text-muted-foreground">Startdato:</span>
                <span className="font-medium">
                  {startDate ? new Date(startDate + 'T00:00:00').toLocaleDateString('nb-NO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '—'}
                </span>
              </div>
              {/* "Retur", not "Sluttdato": the date is the morning the machine
                  comes back, which is the day after the last rental day for
                  every schedule the page prints (Q-13). */}
              <div className="flex justify-between">
                <span className="text-muted-foreground">Retur:</span>
                <span className="font-medium">{computedEndDate || '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Leieperiode:</span>
                <span className="font-medium">{rentalScheduleText}</span>
              </div>
              <Separator />
              {/* Hours breakdown */}
              <div className="rounded-lg bg-background p-3 space-y-1.5 border border-border">
                <div className="font-medium text-xs uppercase text-muted-foreground mb-1">Timeroversikt</div>
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Inkluderte timer</span>
                  <span className="font-medium">{includedHours} timer</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Ekstra forbestilte timer</span>
                  <span className="font-medium">{extraHours} timer</span>
                </div>
                <Separator className="my-1" />
                <div className="flex justify-between items-center font-semibold">
                  <span>Totalt antall timer</span>
                  <span className="text-(color:--primary-text)">{totalHours} timer</span>
                </div>
              </div>
              <Separator />
              {/* Self-pickup is one fact, not two: "Leveringsmetode:
                  Selvhenting" followed by "Levering: Inkludert" read as a
                  contradiction on a booking with no delivery leg. */}
              {selfPickup ? (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Leveringsmetode:</span>
                  <span className="font-medium">Selvhenting – du henter selv</span>
                </div>
              ) : (
                <>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Leveringsadresse:</span>
                    <span className="font-medium text-right max-w-[200px]">{address}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Leveringspris:</span>
                    <span className="font-medium">{deliveryFee.toLocaleString('nb-NO')} kr</span>
                  </div>
                </>
              )}
              {/* Discount lines come from /api/quote — backend is the sole
                  pricing authority, frontend never subtracts on its own. */}
              {quote?.discountLines.map((line, i) => (
                <div key={`confirm-${line.kind}-${i}`} className="flex justify-between text-green-700">
                  <span className="text-muted-foreground">{line.label} (-{line.percent}%)</span>
                  <span className="font-medium">-{line.amountKr.toLocaleString('nb-NO')} kr</span>
                </div>
              ))}
              <Separator />
              <div className="flex justify-between font-semibold text-base">
                <div><span>Totalt</span><div className="text-xs font-normal text-muted-foreground">inkl. mva</div></div>
                <span className="text-(color:--primary-text)">{(quote?.totalPrice ?? totalPrice).toLocaleString('nb-NO')} kr</span>
              </div>
            </div>
            <div className="rounded-lg bg-muted/50 p-3 space-y-1.5">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Navn:</span>
                <span className="font-medium">{name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Telefon:</span>
                <span className="font-medium">{phone}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">E-post:</span>
                <span className="font-medium">{email}</span>
              </div>
              {/* The customer asked for a specific time; the review step used
                  to drop it silently even though it is stored on the booking. */}
              {preferredTime.trim() && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Ønsket tid:</span>
                  <span className="font-medium text-right max-w-[200px]">{preferredTime}</span>
                </div>
              )}
              {notes && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Kommentar:</span>
                  <span className="font-medium text-right max-w-[200px]">{notes}</span>
                </div>
              )}
            </div>
            {/* Cancellation fees */}
            <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 p-3 space-y-2">
              <div className="font-medium text-sm flex items-center gap-2 text-amber-800 dark:text-amber-300">
                <AlertCircle className="w-4 h-4 shrink-0" />
                Avbestillingsvilkår
              </div>
              <div className="space-y-1 text-xs text-amber-700 dark:text-amber-400">
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0 text-green-600" />
                  <span>Gratis avbestilling inntil <strong>{cancelFreeLabel}</strong> før avtalt leiestart</span>
                </div>
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-500" />
                  <span>Avbestilling under {cancelFreeLabel}: <strong>{cancelLatePercent} %</strong> av leieprisen ({Math.round(basePrice * cancelLatePercent / 100).toLocaleString('nb-NO')} kr)</span>
                </div>
                <div className="flex items-start gap-2">
                  <X className="w-3.5 h-3.5 mt-0.5 shrink-0 text-red-500" />
                  <span>Samme dag eller no-show: <strong>{cancelSameDayPercent} %</strong> av leieprisen ({Math.round(basePrice * cancelSameDayPercent / 100).toLocaleString('nb-NO')} kr)</span>
                </div>
              </div>
            </div>
            {/* Terms checkbox — clicking it while unchecked opens the TOC.
                Acceptance only sticks after scrolling to the bottom of the
                TOC dialog and clicking "Jeg godtar". */}
            <div
              role="checkbox"
              aria-checked={termsAccepted}
              tabIndex={0}
              onClick={() => {
                if (termsAccepted) setTermsAccepted(false);
                else setShowTerms(true);
              }}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault();
                  if (termsAccepted) setTermsAccepted(false);
                  else setShowTerms(true);
                }
              }}
              className="flex items-start gap-3 p-3 rounded-lg border border-border bg-muted/30 cursor-pointer hover:bg-muted/50 transition-colors"
            >
              <input
                type="checkbox"
                checked={termsAccepted}
                readOnly
                tabIndex={-1}
                aria-labelledby="terms-accept-label"
                className="mt-0.5 w-4 h-4 rounded border-border text-primary focus:ring-primary pointer-events-none"
              />
              <span id="terms-accept-label" className="text-xs text-muted-foreground leading-relaxed">
                Jeg har lest og godtar{' '}
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setShowTerms(true); }}
                  className="text-primary underline underline-offset-2 hover:text-primary/80 font-medium"
                >
                  vilkår og betingelser
                </button>
                {' '}og{' '}
                <a
                  href="/personvern"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-primary underline underline-offset-2 hover:text-primary/80 font-medium"
                >
                  personvernerklæringen
                </a>
                , inkludert avbestillingsvilkårene ovenfor. Jeg er kjent med at leie for en bestemt dato eller periode er unntatt angreretten etter angrerettloven § 22 bokstav m, slik at jeg ikke har 14 dagers angrerett på denne bestillingen.
              </span>
            </div>
          </div>
          {/* Payment choice. Vipps is the primary method — full-width and
              first; card is the quieter fallback underneath. When only one
              provider is configured its button stands alone. */}
          <DialogFooter className="flex-col gap-2 sm:flex-col sm:gap-2 sm:space-x-0">
            {vippsEnabled && (
              <Button
                onClick={() => handleConfirmBooking('vipps')}
                disabled={isConfirming || !termsAccepted}
                className="w-full h-12 bg-[#FF5B24] hover:bg-[#e04f1f] text-white text-base font-semibold"
              >
                {isConfirming && payingWith === 'vipps' ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Sender til Vipps...
                  </>
                ) : (
                  `Betal med Vipps – ${(quote?.totalPrice ?? totalPrice).toLocaleString('nb-NO')} kr`
                )}
              </Button>
            )}
            {stripeEnabled && (
              <Button
                onClick={() => handleConfirmBooking('stripe')}
                disabled={isConfirming || !termsAccepted}
                variant={vippsEnabled ? 'outline' : 'default'}
                className={vippsEnabled ? 'w-full' : 'w-full h-12 bg-primary hover:bg-primary/90 text-primary-foreground text-base font-semibold'}
              >
                {isConfirming && payingWith === 'stripe' ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Sender til betaling...
                  </>
                ) : vippsEnabled ? (
                  'Betal med kort'
                ) : (
                  `Bekreft og betal – ${(quote?.totalPrice ?? totalPrice).toLocaleString('nb-NO')} kr`
                )}
              </Button>
            )}
            {!paymentEnabled && (
              <Button
                onClick={() => handleConfirmBooking('vipps')}
                disabled={isConfirming || !termsAccepted}
                className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                {isConfirming ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Bekrefter...
                  </>
                ) : (
                  'Bekreft booking'
                )}
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={() => setShowBookingConfirm(false)}
              disabled={isConfirming}
              className="w-full"
            >
              Avbryt
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ═══ CONFIRMATION DIALOG (success) ═══ */}
      <Dialog open={showConfirmation} onOpenChange={(open) => { setShowConfirmation(open); if (!open) window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {returnDialog.tone === 'warn'
                ? <AlertCircle className="w-5 h-5 text-amber-500" />
                : returnDialog.tone === 'busy'
                  ? <Loader2 className="w-5 h-5 text-primary animate-spin" />
                  : <CheckCircle2 className="w-5 h-5 text-primary" />}
              {returnDialog.title}
            </DialogTitle>
            <DialogDescription>{returnDialog.body}</DialogDescription>
          </DialogHeader>
          {confirmationData && (
            <div className="space-y-3 text-sm">
              <div className="rounded-lg bg-primary/5 p-4 space-y-2">
                {confirmationData.reference && (
                  <div className="flex justify-between"><span className="text-muted-foreground">Referanse:</span><span className="font-mono font-medium">{confirmationData.reference}</span></div>
                )}
                <div className="flex justify-between"><span className="text-muted-foreground">Navn:</span><span className="font-medium">{confirmationData.name}</span></div>
                {/* The machine is the whole reason the customer is here — name
                    it on the receipt, not only on the Stripe page. */}
                {(confirmationData.machineName || selectedEquipment?.name) && (
                  <div className="flex justify-between"><span className="text-muted-foreground">Utstyr:</span><span className="font-medium">
                    {confirmationData.machineName ?? selectedEquipment?.name}
                    {(confirmationData.machineModel ?? selectedEquipment?.model)
                      ? ` · ${confirmationData.machineModel ?? selectedEquipment?.model}`
                      : ''}
                  </span></div>
                )}
                <div className="flex justify-between"><span className="text-muted-foreground">Periode:</span><span className="font-medium">
                  {confirmationData.rentalType === 'custom'
                    ? `Døgn × ${confirmationData.customDays || customDays}`
                    : PRICES[confirmationData.rentalType as keyof typeof PRICES].label
                  }
                </span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Dato:</span><span className="font-medium">{parseBookingDate(confirmationData.startDate).toLocaleDateString('nb-NO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span></div>
                {/* Self-pickup has no delivery leg; showing "Levering:
                    Selvhenting" and "Selvhenting: Inkludert" said the same
                    thing twice and read as a contradiction. */}
                {!confirmationData.selfPickup && (
                  <div className="flex justify-between"><span className="text-muted-foreground">Levering:</span><span className="font-medium">{confirmationData.deliveryAddress}</span></div>
                )}
                {/* Hours breakdown in confirmation */}
                <div className="rounded-lg bg-background p-2.5 space-y-1 border border-border text-xs">
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Inkluderte timer</span>
                    {/* `??`, not `||`: the booking's own hours are authoritative
                        and 0 is a legitimate value. Falling back to live form
                        state made a paid week rental's receipt read 20 timer
                        (the default weekend selection) instead of 60. */}
                    <span className="font-medium">{confirmationData.includedHours ?? includedHours} timer</span>
                  </div>
                  {confirmationData.extraHours > 0 && (
                    <div className="flex justify-between items-center">
                      <span className="text-muted-foreground">Ekstra forbestilte timer</span>
                      <span className="font-medium">{confirmationData.extraHours} timer</span>
                    </div>
                  )}
                  <Separator className="my-0.5" />
                  <div className="flex justify-between items-center font-semibold">
                    <span>Totalt antall timer</span>
                    <span className="text-(color:--primary-text)">{confirmationData.totalHours ?? totalHours} timer</span>
                  </div>
                </div>
                {confirmationData.extraHours > 0 && (
                  <div className="flex justify-between"><span className="text-muted-foreground">Forbestilte timer:</span><span className="font-medium">{confirmationData.extraHours} timer ({confirmationData.extraHoursCost.toLocaleString('nb-NO')} kr)</span></div>
                )}
                {confirmationData.selfPickup ? (
                  <div className="flex justify-between"><span className="text-muted-foreground">Selvhenting:</span><span className="font-medium text-green-600">Inkludert</span></div>
                ) : confirmationData.deliveryFee > 0 ? (
                  <div className="flex justify-between"><span className="text-muted-foreground">Levering (utover inkludert):</span><span className="font-medium">+{confirmationData.deliveryFee.toLocaleString('nb-NO')} kr</span></div>
                ) : confirmationData.deliveryFee === 0 && !confirmationData.selfPickup ? (
                  <div className="flex justify-between"><span className="text-muted-foreground">Levering:</span><span className="font-medium text-green-600">Inkludert</span></div>
                ) : null}
              </div>
              <Separator />
              <div className="flex justify-between font-semibold">
                <div><span>Totalt</span><div className="text-xs font-normal text-muted-foreground">inkl. mva</div></div>
                <span className="text-(color:--primary-text)">{confirmationData.totalPrice.toLocaleString('nb-NO')} kr</span>
              </div>
              {/* Cancellation reminder in confirmation */}
              <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 p-2.5 text-xs text-amber-700 dark:text-amber-400">
                <div className="font-medium mb-1 flex items-center gap-1.5 text-amber-800 dark:text-amber-300">
                  <AlertCircle className="w-3.5 h-3.5" />
                  Husk avbestillingsvilkårene
                </div>
                <p>Gratis avbestilling inntil {cancelFreeLabel} før. Under {cancelFreeLabel}: {cancelLatePercent} %. Samme dag: {cancelSameDayPercent} %.</p>
              </div>
            </div>
          )}
          {/* The title already says "Booking bekreftet og betalt!" and the
              description already promises the e-mail, so a green "Betaling
              mottatt / du mottar bekreftelse på e-post" panel underneath said
              everything a third time. Spend the space on the one thing the
              customer can actually do next: manage the booking they just
              paid for — the dialog quotes the cancellation terms, so it
              should also lead to where cancelling happens. */}
          {stripeStatus === 'success' && confirmationData?.cancelToken && (
            <a
              href={`/booking/cancel?token=${encodeURIComponent(confirmationData.cancelToken)}`}
              className="flex items-center justify-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm font-medium hover:bg-muted transition-colors"
            >
              Se eller avbestill bookingen
              <ArrowRight className="w-4 h-4" />
            </a>
          )}
          {(stripeStatus === 'cancelled' || stripeStatus === 'error') && confirmationData && (
            <div className="space-y-2">
              {retryExpired ? (
                <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-3 text-center space-y-2">
                  <p className="text-sm text-amber-800 dark:text-amber-200">
                    Bookingen utløp fordi betalingen ikke ble fullført innen 30 minutter. Velg datoer på nytt for å booke.
                  </p>
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => {
                      sessionStorage.removeItem('pendingBookingConfirmation');
                      setShowConfirmation(false);
                      setConfirmationData(null);
                      setStripeStatus('idle');
                      setRetryExpired(false);
                      window.location.hash = '#booking';
                    }}
                  >
                    Start på nytt
                  </Button>
                </div>
              ) : (
                <>
                  <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-3 text-center">
                    <p className="text-sm text-amber-800 dark:text-amber-200">
                      {stripeStatus === 'error' ? 'Det oppstod en feil med betalingen.' : 'Betalingen ble avbrutt.'} Du kan prøve igjen — bookingen utløper om 30 minutter.
                    </p>
                  </div>
                  <Button
                    className={`w-full font-semibold gap-2${vippsEnabled ? ' h-12 bg-[#FF5B24] hover:bg-[#e04f1f] text-white' : ''}`}
                    disabled={isPayingStripe}
                    onClick={async () => {
                      setIsPayingStripe(true);
                      try {
                        // Retry through the primary provider — Vipps when it's
                        // configured, otherwise card.
                        const res = await fetch(`/api/payment/${vippsEnabled ? 'vipps' : 'stripe'}/create`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ bookingId: confirmationData.id }),
                        });
                        if (res.status === 410) {
                          setRetryExpired(true);
                          setIsPayingStripe(false);
                          return;
                        }
                        const data = await res.json();
                        if (data.url) {
                          sessionStorage.setItem('pendingBookingConfirmation', JSON.stringify(confirmationData));
                          window.location.href = data.url;
                        } else setIsPayingStripe(false);
                      } catch { setIsPayingStripe(false); }
                    }}
                  >
                    {isPayingStripe ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                    Prøv igjen – {confirmationData.totalPrice?.toLocaleString('nb-NO')} kr
                  </Button>
                </>
              )}
            </div>
          )}
          {/* No booking behind the return: there is nothing to retry and no
              receipt to show, so offer the two things that actually help —
              start over, and a phone number (Q-2 / Q-3). */}
          {showConfirmation && !returnResolved && (
            <div className="space-y-2">
              <Button
                variant="outline"
                className="w-full"
                onClick={() => {
                  setShowConfirmation(false);
                  setStripeStatus('idle');
                  window.location.hash = '#booking';
                }}
              >
                Velg datoer på nytt
              </Button>
              {appConfig['contactPhone'] && (
                <a
                  href={`tel:${appConfig['contactPhone'].replace(/\s/g, '')}`}
                  className="flex items-center justify-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm font-medium hover:bg-muted transition-colors"
                >
                  <Phone className="w-4 h-4" aria-hidden="true" />
                  Ring oss på {appConfig['contactPhone']}
                </a>
              )}
            </div>
          )}
          <Button variant="outline" onClick={() => { setShowConfirmation(false); window.scrollTo({ top: 0, behavior: 'smooth' }); }} className="w-full">
            Lukk
          </Button>
        </DialogContent>
      </Dialog>

      <TermsDialog
        open={showTerms}
        onOpenChange={setShowTerms}
        onAccept={() => { setTermsAccepted(true); setShowTerms(false); }}
        sections={dynamicTerms}
        businessName={appConfig['businessName'] || 'Graveklar'}
        orgNumber={appConfig['orgNumber']}
      />

      {/* Equipment info modal */}
      <Dialog open={infoMachineId !== null} onOpenChange={(o) => !o && setInfoMachineId(null)}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto custom-scrollbar">
          {(() => {
            const m = machines.find((x) => x.id === infoMachineId);
            if (!m) return null;
            const specs: { label: string; value: string }[] = (() => { try { return m.specs ? JSON.parse(m.specs) : []; } catch { return []; } })();
            const features: { title: string; desc: string }[] = (() => { try { return m.features ? JSON.parse(m.features) : []; } catch { return []; } })();
            const included: string[] = (() => { try { return m.included ? JSON.parse(m.included) : []; } catch { return []; } })();
            return (
              <>
                <DialogHeader>
                  <DialogTitle>{m.name}{m.model ? ` ${m.model}` : ''}{m.year ? ` · ${m.year}` : ''}</DialogTitle>
                  {m.description && <DialogDescription>{m.description}</DialogDescription>}
                </DialogHeader>
                <div className="space-y-4 mt-2">
                  {specs.length > 0 && (
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Spesifikasjoner</div>
                      <div className="grid grid-cols-2 gap-2">
                        {specs.map((s) => (
                          <div key={s.label} className="p-2 rounded-lg bg-muted/50">
                            <div className="text-xs text-muted-foreground">{s.label}</div>
                            <div className="text-sm font-medium">{s.value}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {included.length > 0 && (
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Inkludert</div>
                      <ul className="space-y-1">
                        {included.map((item, i) => (
                          <li key={i} className="flex items-center gap-2 text-sm text-muted-foreground">
                            <CheckCircle2 className="w-3.5 h-3.5 text-primary shrink-0" />{item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {features.length > 0 && (
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Egenskaper</div>
                      <ul className="space-y-1">
                        {features.map((f, i) => (
                          <li key={i} className="text-sm"><span className="font-medium">{f.title}:</span> <span className="text-muted-foreground">{f.desc}</span></li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setInfoMachineId(null)} className="w-full">Lukk</Button>
                </DialogFooter>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}
