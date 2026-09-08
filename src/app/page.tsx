import { toDateStr } from '@/lib/dates';
import { db } from '@/lib/db';
import { loadConfigValues } from '@/lib/config-server';
import { loadAppConfig, publicAppConfig } from '@/lib/app-config';
import { buildTermsContext, renderTermsString } from '@/lib/terms-template';
import { isStripeEnabled } from '@/lib/stripe';
import { isVippsEnabled } from '@/lib/vipps-config';
import { getApprovedReviews, getReviewAggregate } from '@/lib/review';
import { buildAggregateRatingJsonLd, buildFaqPageJsonLd, buildSiteMetadata, jsonLdScriptHtml } from '@/lib/seo';
import type { Metadata } from 'next';
import HomePage from './HomePage';
import MaintenancePage from '@/components/MaintenancePage';
import { SurveyScreen } from '@/components/survey/SurveyScreen';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const [cfg, machines] = await Promise.all([
    loadAppConfig(),
    db.machine.findMany({
      where: { isActive: true },
      select: { name: true, model: true, category: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    }),
  ]);
  return buildSiteMetadata(cfg, machines, { path: '/' });
}

interface PageProps {
  // Next 16: searchParams is a Promise on dynamic pages.
  searchParams: Promise<{ stripe?: string; vipps?: string; ref?: string }>;
}

export default async function Page({ searchParams }: PageProps) {
  const sp = await searchParams;

  // Both providers land back here with the same contract: ?<provider>=<status>&ref=…
  // Keeping one status pipeline means the confirmation UI doesn't care which
  // one the customer used. Vipps adds a 'processing' status for the case where
  // the customer beats the webhook back to the site.
  const returnStatus = sp.vipps ?? sp.stripe;

  // Durable Stripe-return data. Previously the success/cancelled UI relied
  // on sessionStorage, which is gone in: a new browser tab opened from the
  // Stripe receipt email, an aggressively privacy-tabbed Safari, or a back/
  // forward navigation that flushed the page. Looking up the booking by
  // reference on the server eliminates that whole class of "I paid but the
  // site shows nothing" support tickets.
  let stripeReturnBooking: {
    id: string;
    reference: string;
    name: string;
    rentalType: string;
    customDays: number | null;
    startDate: string;
    deliveryAddress: string;
    selfPickup: boolean;
    basePrice: number;
    deliveryFee: number;
    extraHours: number;
    extraHoursCost: number;
    // Hours and equipment come straight off the booking row. Leaving them out
    // made the confirmation dialog fall back to the live form state, which
    // after the Stripe redirect is the default weekend selection — so a week
    // rental's receipt claimed 20 included hours instead of 60, and no
    // receipt could name the machine the customer had just paid for.
    includedHours: number;
    totalHours: number;
    machineName: string | null;
    machineModel: string | null;
    totalPrice: number;
    discountKr: number | null;
    discountLabel: string | null;
    status: string;
    cancelToken: string | null;
  } | null = null;
  if (returnStatus && sp.ref) {
    const b = await db.booking
      .findUnique({ where: { reference: sp.ref }, include: { machine: true } })
      .catch(() => null);
    if (b) {
      stripeReturnBooking = {
        id: b.id,
        reference: b.reference,
        name: b.name,
        rentalType: b.rentalType,
        customDays: b.customDays,
        // Local calendar date — toISOString() would shift Oslo midnight to the
        // previous UTC day and show customers a start date one day early.
        startDate: toDateStr(b.startDate),
        deliveryAddress: b.deliveryAddress,
        selfPickup: b.selfPickup,
        basePrice: b.basePrice,
        deliveryFee: b.deliveryFee,
        extraHours: b.extraHours,
        extraHoursCost: b.extraHoursCost,
        includedHours: b.includedHours,
        totalHours: b.totalHours,
        machineName: b.machine?.name ?? null,
        machineModel: b.machine?.model ?? null,
        totalPrice: b.totalPrice,
        discountKr: b.discountKr,
        discountLabel: b.discountLabel,
        status: b.status,
        // Lets the confirmation offer "se eller avbestill bookingen" instead
        // of only quoting the cancellation terms at the customer.
        cancelToken: b.cancelToken,
      };
    }
  }

  const [config, appConfig, machines, faq, faqTotal, terms, insurance, stripeEnabled, vippsEnabled, completedCount, reviews, reviewAggregate] = await Promise.all([
    loadConfigValues(),
    loadAppConfig(),
    db.machine.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
    db.faqItem.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
    // Total FAQ rows regardless of isActive. Distinguishes "admin has never
    // set up FAQ" (→ show the built-in fallback set) from "admin configured
    // FAQ and toggled some/all off" (→ honour the toggles, never resurrect
    // the hardcoded fallback). Without this, turning every FAQ off would make
    // the old hardcoded questions reappear.
    db.faqItem.count(),
    db.termsSection.findMany({ where: { isActive: true, audience: 'consumer' }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
    db.insuranceCard.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
    isStripeEnabled(),
    isVippsEnabled(),
    db.booking.count({ where: { status: 'completed' } }),
    getApprovedReviews(12),
    getReviewAggregate(),
  ]);

  // Override the admin-editable bookingCount with the real count of
  // completed bookings. Auto-derived so the number on the website is always
  // accurate without manual sync.
  //
  // Built as a derived object rather than written into `appConfig` in place:
  // loadAppConfig() hands out a snapshot, and mutating what a shared loader
  // returned is the habit that made finding I-5 possible in the first place.
  const pageConfig: Record<string, string> = { ...appConfig, bookingCount: String(completedCount) };

  // Resolve TOC tokens ({{businessName}}, {{egenandel}}, …) against live
  // AppConfig + PricingConfig before the terms reach the client. The booking
  // page section and the in-checkout TermsDialog render this text verbatim,
  // so unresolved tokens would surface raw (e.g. "{{overtimeRate}}") to the
  // customer. Mirrors what /vilkar already does server-side.
  const termsCtx = await buildTermsContext();
  const resolvedTerms = terms.map((t) => ({
    title: renderTermsString(t.title, termsCtx).output,
    content: renderTermsString(t.content, termsCtx).output,
  }));

  if (pageConfig['maintenanceMode'] === 'true') {
    return (
      <MaintenancePage
        businessName={pageConfig['businessName'] || 'Graveklar'}
        message={pageConfig['maintenanceMessage'] || 'Vi er midlertidig utilgjengelige. Prøv igjen snart.'}
        contactEmail={pageConfig['contactEmail']}
        contactPhone={pageConfig['contactPhone']}
      />
    );
  }

  // Survey mode — take visitors straight to the Behovsundersøkelse instead of
  // the normal landing page (used in the pre-launch window). Same component
  // the /undersokelse route renders.
  if (pageConfig['surveyMode'] === 'true') {
    return <SurveyScreen />;
  }

  return (
    <>
      {(() => {
        const faqLd = buildFaqPageJsonLd(faq.map((f) => ({ question: f.question, answer: f.answer })));
        const ratingLd = buildAggregateRatingJsonLd(pageConfig, reviewAggregate);
        const blocks = [faqLd, ratingLd].filter(Boolean);
        if (blocks.length === 0) return null;
        return (
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: jsonLdScriptHtml(blocks.length === 1 ? blocks[0] : blocks) }}
          />
        );
      })()}
      <HomePage
      initialConfig={config}
      initialAppConfig={publicAppConfig(pageConfig)}
      initialMachines={machines.map(m => ({
        id: m.id,
        name: m.name,
        category: m.category,
        model: m.model,
        year: m.year,
        imageUrl: m.imageUrl,
        description: m.description,
        specs: m.specs,
        features: m.features,
        included: m.included,
        quantity: m.quantity,
        dayPrice: m.dayPrice,
        weekendPrice: m.weekendPrice,
        weekPrice: m.weekPrice,
        dayIncludedHours: m.dayIncludedHours,
        weekendIncludedHours: m.weekendIncludedHours,
        weekIncludedHours: m.weekIncludedHours,
        overtimeRate: m.overtimeRate,
        preOrderHourRate: m.preOrderHourRate,
        fuelTankLiters: m.fuelTankLiters,
        fuelConsumptionPerHour: m.fuelConsumptionPerHour,
        photoScale: m.photoScale,
      }))}
      initialFaq={faq.map(f => ({ question: f.question, answer: f.answer }))}
      faqConfigured={faqTotal > 0}
      initialTerms={resolvedTerms}
      initialInsurance={insurance.map(c => ({ label: c.label, value: c.value, detail: c.detail }))}
      initialStripeEnabled={stripeEnabled}
      initialVippsEnabled={vippsEnabled}
      stripeReturn={returnStatus ? { status: returnStatus, booking: stripeReturnBooking } : null}
      reviews={reviews.map((r) => ({
        id: r.id,
        rating: r.rating,
        comment: r.comment,
        reviewerName: r.reviewerName,
        date: r.submittedAt.toISOString(),
      }))}
      reviewAggregate={reviewAggregate}
    />
    </>
  );
}
