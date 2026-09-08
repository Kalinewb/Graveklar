/**
 * L1/L2 boundary — src/lib/terms-template.ts. Uses the scratch DB because
 * buildTermsContext() and renderAcceptedTerms() read live AppConfig +
 * PricingConfig + TermsSection rows; the token-substitution and hashing
 * functions themselves are pure.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildTermsContext,
  renderTermsString,
  termsVersionHash,
  renderAcceptedTerms,
  type TermsContext,
} from '@/lib/terms-template';
import { ensureDefaultTermsSeeded, ensureDefaultBusinessTermsSeeded } from '@/lib/terms-defaults';
import { db, ensureSchema, resetDb, seedConfigDefaults } from '../helpers/db';
import { setPricing } from '../helpers/booking';

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetDb();
});

// ── renderTermsString ───────────────────────────────────────────────────────

describe('renderTermsString', () => {
  const ctx: TermsContext = { businessName: 'Graveklar', empty: '' };

  it('resolves a known token', () => {
    const { output, missing } = renderTermsString('Hilsen fra {{businessName}}', ctx);
    expect(output).toBe('Hilsen fra Graveklar');
    expect(missing).toEqual([]);
  });

  it('tolerates spaces inside the braces', () => {
    expect(renderTermsString('{{ businessName }}', ctx).output).toBe('Graveklar');
    expect(renderTermsString('{{  businessName  }}', ctx).output).toBe('Graveklar');
  });

  it('an unknown token renders the placeholder and is reported missing', () => {
    const { output, missing } = renderTermsString('{{doesNotExist}}', ctx);
    expect(output).toBe('[mangler verdi: doesNotExist]');
    expect(missing).toEqual(['doesNotExist']);
  });

  it('an empty-string context value is ALSO treated as missing', () => {
    const { output, missing } = renderTermsString('{{empty}}', ctx);
    expect(output).toBe('[mangler verdi: empty]');
    expect(missing).toEqual(['empty']);
  });

  it('collects every distinct missing token, in order of first appearance', () => {
    const { missing } = renderTermsString('{{a}} og {{b}} og {{a}} igjen', ctx);
    expect(missing).toEqual(['a', 'b', 'a']);
  });

  it('leaves text with no tokens untouched', () => {
    expect(renderTermsString('Ingen variabler her.', ctx).output).toBe('Ingen variabler her.');
  });
});

// ── buildTermsContext — every documented token ──────────────────────────────

describe('buildTermsContext', () => {
  it('resolves every documented token from a fully-configured context', async () => {
    await seedConfigDefaults({
      businessName: 'Graveklar AS',
      orgNumber: '123456789',
      contactEmail: 'kontakt@graveklar.no',
      contactPhone: '99011223',
      serviceArea: 'Salten',
      siteUrl: 'https://graveklar.no',
      cancelFreeWeeks: '1',
      cancelFreeDays: '2',
      cancelLatePercent: '40',
      cancelSameDayPercent: '90',
      egenandel: '7500',
      minAge: '23',
    });
    await setPricing({
      deliveryIncludedKm: 35,
      deliveryPerKm: 22,
      minDeliveryFee: 200,
      maxDeliveryRadius: 175,
      preOrderHourRate: 189,
      overtimeRate: 209,
      dayIncludedHours: 12,
      weekendIncludedHours: 24,
      weekIncludedHours: 60,
    });

    const ctx = await buildTermsContext();

    expect(ctx).toMatchObject({
      businessName: 'Graveklar AS',
      orgNumber: '123456789',
      contactEmail: 'kontakt@graveklar.no',
      contactPhone: '99011223',
      serviceArea: 'Salten',
      siteUrl: 'https://graveklar.no',
      cancelFreeLabel: '1 uke og 2 dager',
      cancelLatePercent: '40',
      cancelSameDayPercent: '90',
      deliveryIncludedKm: '35',
      deliveryPerKm: '22',
      minDeliveryFee: '200',
      maxDeliveryRadius: '175',
      preOrderHourRate: '189',
      overtimeRate: '209',
      dayIncludedHours: '12',
      weekendIncludedHours: '24',
      weekIncludedHours: '60',
      egenandel: '7500',
      minAge: '23',
    });

    // Every value is a string — templating substitutes verbatim.
    for (const key of Object.keys(ctx)) expect(typeof ctx[key]).toBe('string');
  });

  it('falls back to sane defaults when AppConfig/PricingConfig rows are absent', async () => {
    // No seeding at all — loadAppConfig()/pricingConfig.findMany() see empty tables.
    const ctx = await buildTermsContext();
    expect(ctx.businessName).toBe('Graveklar');
    expect(ctx.deliveryIncludedKm).toBe('30');
    expect(ctx.deliveryPerKm).toBe('25');
    expect(ctx.minDeliveryFee).toBe('0');
    expect(ctx.maxDeliveryRadius).toBe('150');
    expect(ctx.preOrderHourRate).toBe('179');
    expect(ctx.overtimeRate).toBe('199');
    expect(ctx.dayIncludedHours).toBe('10');
    expect(ctx.weekendIncludedHours).toBe('20');
    expect(ctx.weekIncludedHours).toBe('56');
    expect(ctx.egenandel).toBe('5000');
    expect(ctx.minAge).toBe('21');
  });
});

// ── termsVersionHash ─────────────────────────────────────────────────────────

describe('termsVersionHash', () => {
  const sections = [{ title: 'Partene', content: 'Innhold A' }];
  const ctx: TermsContext = { businessName: 'Graveklar', orgNumber: '123' };

  it('is stable regardless of key order in the context object', () => {
    const ctxReordered: TermsContext = { orgNumber: '123', businessName: 'Graveklar' };
    expect(termsVersionHash({ sections, ctx })).toBe(termsVersionHash({ sections, ctx: ctxReordered }));
  });

  it('is unchanged by a no-op re-render with identical content', () => {
    const h1 = termsVersionHash({ sections: [...sections], ctx: { ...ctx } });
    const h2 = termsVersionHash({ sections: [...sections], ctx: { ...ctx } });
    expect(h1).toBe(h2);
  });

  it('changes when any section content is edited', () => {
    const edited = [{ title: 'Partene', content: 'Innhold B' }];
    expect(termsVersionHash({ sections: edited, ctx })).not.toBe(termsVersionHash({ sections, ctx }));
  });

  it('changes when any section title is edited', () => {
    const edited = [{ title: 'Partene v2', content: 'Innhold A' }];
    expect(termsVersionHash({ sections: edited, ctx })).not.toBe(termsVersionHash({ sections, ctx }));
  });

  it('changes when a context value changes', () => {
    const edited: TermsContext = { ...ctx, orgNumber: '999' };
    expect(termsVersionHash({ sections, ctx: edited })).not.toBe(termsVersionHash({ sections, ctx }));
  });

  it('changes when section order changes (order is part of the digest)', () => {
    const two = [{ title: 'A', content: '1' }, { title: 'B', content: '2' }];
    const reordered = [{ title: 'B', content: '2' }, { title: 'A', content: '1' }];
    expect(termsVersionHash({ sections: two, ctx })).not.toBe(termsVersionHash({ sections: reordered, ctx }));
  });
});

// ── renderAcceptedTerms — HTML escaping + audience seeding ─────────────────

describe('renderAcceptedTerms', () => {
  it('escapes &, < and > in both static content and substituted token values', async () => {
    await seedConfigDefaults({ businessName: 'A&B <Utleie>' });
    await db.termsSection.create({
      data: {
        title: 'Farlig <tag>',
        content: 'Drives av {{businessName}} — vilkår & betingelser <viktig>',
        sortOrder: 0,
        isActive: true,
        audience: 'consumer',
      },
    });

    const rendered = await renderAcceptedTerms('consumer');

    expect(rendered.html).not.toContain('<tag>');
    expect(rendered.html).not.toContain('<Utleie>');
    expect(rendered.html).not.toContain('<viktig>');
    expect(rendered.html).toContain('Farlig &lt;tag&gt;');
    expect(rendered.html).toContain('A&amp;B &lt;Utleie&gt;');
    expect(rendered.html).toContain('vilkår &amp; betingelser &lt;viktig&gt;');
  });

  it('seeds default consumer terms only when the consumer table is empty', async () => {
    expect(await db.termsSection.count({ where: { audience: 'consumer' } })).toBe(0);
    const first = await ensureDefaultTermsSeeded();
    expect(first.seeded).toBe(true);
    expect(first.count).toBeGreaterThan(0);

    // A pre-existing custom section blocks reseeding, even a single one.
    await db.termsSection.deleteMany({ where: { audience: 'consumer' } });
    await db.termsSection.create({
      data: { title: 'Custom', content: 'Custom content', audience: 'consumer', sortOrder: 0, isActive: true },
    });
    const second = await ensureDefaultTermsSeeded();
    expect(second.seeded).toBe(false);
    expect(await db.termsSection.count({ where: { audience: 'consumer' } })).toBe(1);
  });

  it('seeds default business terms independently of the consumer table', async () => {
    await ensureDefaultTermsSeeded();
    expect(await db.termsSection.count({ where: { audience: 'business' } })).toBe(0);
    const result = await ensureDefaultBusinessTermsSeeded();
    expect(result.seeded).toBe(true);
    // Consumer set is untouched by the business seed.
    expect(await db.termsSection.count({ where: { audience: 'consumer' } })).toBeGreaterThan(0);
  });

  it('renderAcceptedTerms("business") lazy-seeds only the business set', async () => {
    expect(await db.termsSection.count({ where: { audience: 'business' } })).toBe(0);
    await renderAcceptedTerms('business');
    expect(await db.termsSection.count({ where: { audience: 'business' } })).toBeGreaterThan(0);
    expect(await db.termsSection.count({ where: { audience: 'consumer' } })).toBe(0);
  });

  it('only renders active sections, in sortOrder', async () => {
    await db.termsSection.createMany({
      data: [
        { title: 'Second', content: 'B', sortOrder: 1, isActive: true, audience: 'consumer' },
        { title: 'Hidden', content: 'X', sortOrder: 0, isActive: false, audience: 'consumer' },
        { title: 'First', content: 'A', sortOrder: 0, isActive: true, audience: 'consumer' },
      ],
    });
    const rendered = await renderAcceptedTerms('consumer');
    expect(rendered.sections.map((s) => s.title)).toEqual(['First', 'Second']);
    expect(rendered.html).not.toContain('Hidden');
  });

  it('reports missing tokens across all rendered sections', async () => {
    await db.termsSection.create({
      data: { title: '{{unknownTitleToken}}', content: 'Body {{unknownBodyToken}}', sortOrder: 0, isActive: true, audience: 'consumer' },
    });
    const rendered = await renderAcceptedTerms('consumer');
    expect(rendered.missingTokens.sort()).toEqual(['unknownBodyToken', 'unknownTitleToken']);
  });
});
