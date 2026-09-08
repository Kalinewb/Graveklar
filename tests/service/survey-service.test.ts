import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db, ensureSchema, invalidateCaches, resetDb, seedConfigDefaults } from '../helpers/db';
import { surveyDefaults } from '@/lib/survey-defaults';

// L3 — src/lib/survey-service.ts. The Behovsundersøkelse question source of
// truth: seeding, live-price token substitution, conditional discount copy.
//
// IMPORTANT ordering note: `seeded` in survey-service.ts is process-/module-
// local state with no reset hook (see FINDING N-2 at the bottom of this
// file). Vitest gives each *file* a fresh module registry, but NOT each test
// within a file — so this file relies on declaration order:
//   1. The very first test below is the only one that can observe `seeded`
//      start out false, and is the only place a race on the initial seed can
//      be demonstrated. It runs first, deliberately.
//   2. Every other "shape" test creates its OWN SurveyQuestion rows directly
//      (bypassing the seeder) so it does not depend on whether the seeder
//      actually ran for a given call — it works whether the flag short-
//      circuits or not.
//   3. The FINDING test is last, so it can rely on `seeded` already being
//      true from everything before it.

let seedSurveyQuestionsIfEmpty: typeof import('@/lib/survey-service').seedSurveyQuestionsIfEmpty;
let loadActiveSurveyQuestions: typeof import('@/lib/survey-service').loadActiveSurveyQuestions;
let loadSurveyLabels: typeof import('@/lib/survey-service').loadSurveyLabels;

beforeAll(async () => {
  await ensureSchema();
  const mod = await import('@/lib/survey-service');
  ({ seedSurveyQuestionsIfEmpty, loadActiveSurveyQuestions, loadSurveyLabels } = mod);
});

beforeEach(async () => {
  await resetDb();
  await seedConfigDefaults();
});

// ── 1. First test in the file: the real seeder, from a genuinely empty table ─

describe('seedSurveyQuestionsIfEmpty — first call in this module', () => {
  it('seeds the exact default set, and is race-safe under two concurrent callers', async () => {
    expect(await db.surveyQuestion.count()).toBe(0);

    // Two concurrent callers on a table that starts empty: the loser hits the
    // unique(key) constraint on createMany and swallows it (see the
    // docstring in src/lib/survey-service.ts:66-68) rather than crashing or
    // duplicating rows.
    await Promise.all([seedSurveyQuestionsIfEmpty(), seedSurveyQuestionsIfEmpty()]);

    const rows = await db.surveyQuestion.findMany({ orderBy: { sortOrder: 'asc' } });
    expect(rows).toHaveLength(surveyDefaults.length);
    expect(rows.every((r) => r.isActive)).toBe(true);
    expect(rows.map((r) => r.key)).toEqual(surveyDefaults.map((q) => q.key));
  });

  it('does not add a second batch when the table already has rows', async () => {
    await seedSurveyQuestionsIfEmpty();
    const before = await db.surveyQuestion.count();
    await seedSurveyQuestionsIfEmpty();
    expect(await db.surveyQuestion.count()).toBe(before);
  });
});

// ── 2. Shape tests: each creates its own rows, independent of seeding state ──

describe('loadActiveSurveyQuestions — ordering and shape', () => {
  it('only returns isActive rows, ordered by sortOrder', async () => {
    await db.surveyQuestion.createMany({
      data: [
        { key: 'c', type: 'text', section: 'S', label: 'C', required: true, isActive: true, sortOrder: 30 },
        { key: 'a', type: 'text', section: 'S', label: 'A', required: true, isActive: true, sortOrder: 10 },
        { key: 'hidden', type: 'text', section: 'S', label: 'Hidden', required: true, isActive: false, sortOrder: 20 },
        { key: 'b', type: 'text', section: 'S', label: 'B', required: true, isActive: true, sortOrder: 20 },
      ],
    });
    const qs = await loadActiveSurveyQuestions();
    expect(qs.map((q) => q.key)).toEqual(['a', 'b', 'c']);
  });

  it('parses options and config JSON, and falls back to [] / {} on garbage', async () => {
    await db.surveyQuestion.createMany({
      data: [
        {
          key: 'ok', type: 'radio', section: 'S', label: 'Ok', required: true, isActive: true, sortOrder: 10,
          options: JSON.stringify(['a', 'b']), config: JSON.stringify({ max: 3 }),
        },
        {
          key: 'garbage', type: 'radio', section: 'S', label: 'Garbage', required: true, isActive: true, sortOrder: 20,
          options: 'not json', config: 'not json either',
        },
      ],
    });
    const qs = await loadActiveSurveyQuestions();
    expect(qs.find((q) => q.key === 'ok')).toMatchObject({ options: ['a', 'b'], config: { max: 3 } });
    expect(qs.find((q) => q.key === 'garbage')).toMatchObject({ options: [], config: {} });
  });
});

describe('loadActiveSurveyQuestions — live pricing token substitution', () => {
  async function pricingTokens() {
    const { loadConfigValues } = await import('@/lib/config-server');
    const { buildPricingFromConfig } = await import('@/lib/pricing');
    const pricing = buildPricingFromConfig(await loadConfigValues());
    return {
      helgpris: `${Math.round(pricing.weekend.basePrice).toLocaleString('nb-NO')} kr`,
      ukepris: `${Math.round(pricing.week.basePrice).toLocaleString('nb-NO')} kr`,
      helgtimer: String(Math.round(pricing.weekend.includedHours)),
      uketimer: String(Math.round(pricing.week.includedHours)),
    };
  }

  it('substitutes {{helgpris}}/{{ukepris}} in the label AND the hint from LIVE PricingConfig', async () => {
    const tok = await pricingTokens();
    await db.surveyQuestion.create({
      data: {
        key: 'pris_faktisk', type: 'price-callout', section: 'Pris',
        label: 'En helg koster {{helgpris}}', hint: 'En uke koster {{ukepris}}',
        required: false, isActive: true, sortOrder: 10,
      },
    });
    const [q] = await loadActiveSurveyQuestions();
    expect(q.label).toBe(`En helg koster ${tok.helgpris}`);
    expect(q.hint).toBe(`En uke koster ${tok.ukepris}`);
  });

  it('substitutes {{helgtimer}}/{{uketimer}} the same way', async () => {
    const tok = await pricingTokens();
    await db.surveyQuestion.create({
      data: {
        key: 'forvpris_helg', type: 'range', section: 'Pris',
        label: 'label', hint: 'Inkludert {{helgtimer}} timer, uke har {{uketimer}}',
        required: false, isActive: true, sortOrder: 10,
      },
    });
    const [q] = await loadActiveSurveyQuestions();
    expect(q.hint).toBe(`Inkludert ${tok.helgtimer} timer, uke har ${tok.uketimer}`);
  });

  it('reacts to a live PricingConfig change (never a stale/hardcoded price)', async () => {
    await db.surveyQuestion.create({
      data: {
        key: 'pris', type: 'price-callout', section: 'Pris',
        label: '{{helgpris}}', hint: null, required: false, isActive: true, sortOrder: 10,
      },
    });
    const before = (await loadActiveSurveyQuestions())[0].label;
    await db.pricingConfig.update({ where: { key: 'weekendHourly' }, data: { value: 999 } });
    invalidateCaches();
    const after = (await loadActiveSurveyQuestions())[0].label;
    expect(after).not.toBe(before);
  });
});

describe('loadActiveSurveyQuestions — [[rabatt]] discount span', () => {
  async function surveyRow(label: string, hint: string | null = null, config: Record<string, unknown> = {}) {
    await db.surveyQuestion.create({
      data: {
        key: 'epost', type: 'email', section: 'Til slutt', label, hint,
        config: Object.keys(config).length ? JSON.stringify(config) : null,
        required: false, isActive: true, sortOrder: 10,
      },
    });
  }

  it('strips the wrapped span entirely when surveyLeadDiscountEnabled is off (the default)', async () => {
    await surveyRow('Helt valgfritt.[[rabatt]] Du får {{rabatt}} rabatt.[[/rabatt]]');
    const [q] = await loadActiveSurveyQuestions();
    expect(q.label).toBe('Helt valgfritt.');
    expect(q.label).not.toMatch(/rabatt/i);
  });

  it('keeps the span and substitutes the configured percent when enabled', async () => {
    await db.appConfig.update({ where: { key: 'surveyLeadDiscountEnabled' }, data: { value: 'true' } });
    await db.appConfig.update({ where: { key: 'surveyLeadDiscountPercent' }, data: { value: '20' } });
    invalidateCaches();
    await surveyRow('Helt valgfritt.[[rabatt]] Du får {{rabatt}} rabatt.[[/rabatt]]');
    const [q] = await loadActiveSurveyQuestions();
    expect(q.label).toBe('Helt valgfritt. Du får 20 % rabatt.');
  });

  it('defaults to 15 % when surveyLeadDiscountPercent is unset/non-numeric', async () => {
    await db.appConfig.update({ where: { key: 'surveyLeadDiscountEnabled' }, data: { value: 'true' } });
    await db.appConfig.update({ where: { key: 'surveyLeadDiscountPercent' }, data: { value: 'not-a-number' } });
    invalidateCaches();
    await surveyRow('[[rabatt]]{{rabatt}} rabatt[[/rabatt]]');
    const [q] = await loadActiveSurveyQuestions();
    expect(q.label).toBe('15 % rabatt');
  });

  it('also substitutes inside config.consentLabel', async () => {
    await surveyRow('label', null, {
      consentLabel: 'Meld meg på[[rabatt]] og få {{rabatt}} rabatt[[/rabatt]].',
    });
    const [q] = await loadActiveSurveyQuestions();
    expect(q.config.consentLabel).toBe('Meld meg på.');
  });
});

describe('loadSurveyLabels', () => {
  it('includes inactive questions (so historical answers still render a label)', async () => {
    await db.surveyQuestion.createMany({
      data: [
        { key: 'active', type: 'text', section: 'S', label: 'Active', required: true, isActive: true, sortOrder: 10 },
        { key: 'retired', type: 'text', section: 'S', label: 'Retired', required: true, isActive: false, sortOrder: 20 },
      ],
    });
    const labels = await loadSurveyLabels();
    expect(labels.map((l) => l.key)).toEqual(['active', 'retired']);
    expect(labels[1]).toEqual({ key: 'retired', label: 'Retired', type: 'text' });
  });
});

// ── 3. The finding: last, because it depends on everything above having run ─

describe('reseeding after the table is emptied', () => {
  // FIXED N-2: `seeded` in src/lib/survey-service.ts used to be a module-level
  // boolean with no reset and no re-check of `count === 0` once true. It
  // existed purely to skip a COUNT query per request once the table was
  // known-seeded — but if SurveyQuestion ever became empty again after the
  // first seed (every row deleted through DELETE
  // /api/admin/survey/questions/[id], one at a time, which the route allows
  // with no floor), `seedSurveyQuestionsIfEmpty()` never seeded again for the
  // life of the process: the customer wizard silently served an empty question
  // set until the next deploy. The flag is gone; the COUNT runs every time.
  it('reseeds the defaults if the table is empty again after the first seed', async () => {
    // Every describe above has already run a real seeding call, so under the
    // old flag this would be a no-op. beforeEach's resetDb() just wiped the
    // table — "an admin deleted every question", without 190 DELETE calls.
    expect(await db.surveyQuestion.count()).toBe(0);
    const qs = await loadActiveSurveyQuestions();
    expect(qs.length).toBeGreaterThan(0);
    expect(qs.map((q) => q.key)).toEqual(surveyDefaults.map((q) => q.key));
  });

  // Rewritten for FIXED N-2: reseeding must not double up on a table that
  // still has rows — the COUNT is the whole guard now.
  it('does not reseed while any question row survives', async () => {
    await db.surveyQuestion.create({
      data: { key: 'lone_survivor', type: 'text', section: 'S', label: 'Alene', sortOrder: 10, isActive: true },
    });
    const qs = await loadActiveSurveyQuestions();
    expect(qs.map((q) => q.key)).toEqual(['lone_survivor']);
    expect(await db.surveyQuestion.count()).toBe(1);
  });
});
