import { db } from '@/lib/db';
import { surveyDefaults, type SeedQuestion } from '@/lib/survey-defaults';
import { loadConfigValues } from '@/lib/config-server';
import { loadAppConfig } from '@/lib/app-config';
import { buildPricingFromConfig } from '@/lib/pricing';

// Single source of truth for the Behovsundersøkelse questions. Both the
// customer wizard (via GET /api/survey/questions) and the admin response
// viewer read from SurveyQuestion through here — no hand-synced label maps.

export type SurveyQuestionType = SeedQuestion['type'];

export type SurveyQuestionDTO = {
  key: string;
  type: SurveyQuestionType;
  section: string;
  label: string;
  hint: string | null;
  options: string[];
  config: Record<string, unknown>;
  required: boolean;
};

function parseOptions(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function parseConfig(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function formatKr(n: number): string {
  return `${Math.round(n).toLocaleString('nb-NO')} kr`;
}

// Conditional discount copy. Text wrapped in [[rabatt]]…[[/rabatt]] is kept
// only when the survey lead discount is enabled; {{rabatt}} becomes the
// percent. When disabled, the wrapped span is removed entirely so the survey
// never names a discount that isn't on offer. Authored so the base sentence
// still reads cleanly once the span is gone.
function applyDiscountTokens(text: string | null, enabled: boolean, percentLabel: string): string | null {
  if (!text) return text;
  let out = enabled
    ? text.replace(/\[\[rabatt\]\]/g, '').replace(/\[\[\/rabatt\]\]/g, '')
    : text.replace(/\[\[rabatt\]\][\s\S]*?\[\[\/rabatt\]\]/g, '');
  out = out.replace(/\{\{rabatt\}\}/g, enabled ? percentLabel : '');
  // Tidy whitespace/punctuation left behind by a removed span.
  return out.replace(/\s+([.,!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
}

/** Seed the default question set when the table is empty (mirrors FaqItem).
 *  Race-safe: a concurrent seed hits the unique(key) constraint and is
 *  swallowed — the rows are being created either way.
 *
 *  There used to be a process-local `seeded` flag here that skipped the COUNT
 *  once the table had been seeded. It never reset, so if the table became
 *  empty again (an admin deleting every question through the builder, which
 *  the DELETE route allows with no floor) the wizard served an empty question
 *  set to every customer until the next restart — finding N-2. A COUNT over
 *  ~20 rows is not worth that failure mode. */
export async function seedSurveyQuestionsIfEmpty(): Promise<void> {
  const count = await db.surveyQuestion.count();
  if (count === 0) {
    try {
      await db.surveyQuestion.createMany({
        data: surveyDefaults.map((q) => ({
          key: q.key,
          type: q.type,
          section: q.section,
          label: q.label,
          hint: q.hint ?? null,
          options: q.options ? JSON.stringify(q.options) : null,
          config: q.config ? JSON.stringify(q.config) : null,
          required: q.required,
          sortOrder: q.sortOrder,
          isActive: true,
        })),
      });
    } catch (err) {
      console.warn('[survey] seed skipped (already seeding or partial):', err);
    }
  }
}

/** Active questions for the customer wizard, ordered, with `{{helgpris}}` /
 *  `{{ukepris}}` tokens in price-callout hints substituted from LIVE pricing
 *  so the shown price never drifts from the real one. */
export async function loadActiveSurveyQuestions(): Promise<SurveyQuestionDTO[]> {
  await seedSurveyQuestionsIfEmpty();
  const rows = await db.surveyQuestion.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
  });

  const appCfg = await loadAppConfig();
  const leadEnabled = appCfg['surveyLeadDiscountEnabled'] === 'true';
  const percent = Number(appCfg['surveyLeadDiscountPercent'] || '15') || 15;
  const percentLabel = `${percent} %`;
  const discount = (t: string | null) => applyDiscountTokens(t, leadEnabled, percentLabel);

  // Live price/included-hours tokens — substituted in labels AND hints so the
  // shown numbers never drift from the real PricingConfig.
  const pricing = buildPricingFromConfig(await loadConfigValues());
  const priceTokens: Record<string, string> = {
    '{{helgpris}}': formatKr(pricing.weekend.basePrice),
    '{{ukepris}}': formatKr(pricing.week.basePrice),
    '{{helgtimer}}': String(Math.round(pricing.weekend.includedHours)),
    '{{uketimer}}': String(Math.round(pricing.week.includedHours)),
  };
  const substPrice = (t: string | null): string | null => {
    if (!t) return t;
    let out = t;
    for (const [k, v] of Object.entries(priceTokens)) out = out.split(k).join(v);
    return out;
  };

  return rows.map((r) => {
    const config = parseConfig(r.config);
    if (typeof config.consentLabel === 'string') {
      config.consentLabel = discount(config.consentLabel);
    }
    return {
      key: r.key,
      type: r.type as SurveyQuestionType,
      section: r.section,
      label: discount(substPrice(r.label)) ?? r.label,
      hint: discount(substPrice(r.hint)),
      options: parseOptions(r.options),
      config,
      required: r.required,
    };
  });
}

/** Ordered {key,label,type} for the admin response viewer — replaces the old
 *  hardcoded LABELS map. Includes inactive questions so historical answers
 *  still render a friendly label. */
export async function loadSurveyLabels(): Promise<{ key: string; label: string; type: string }[]> {
  await seedSurveyQuestionsIfEmpty();
  const rows = await db.surveyQuestion.findMany({
    orderBy: { sortOrder: 'asc' },
    select: { key: true, label: true, type: true },
  });
  return rows;
}
