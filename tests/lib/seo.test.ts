import { describe, expect, it } from 'vitest';

import {
  absoluteUrl,
  buildAggregateRatingJsonLd,
  buildDefaultKeywords,
  buildFaqPageJsonLd,
  buildLocalBusinessJsonLd,
  buildSeoDescription,
  buildSeoTitle,
  buildSiteMetadata,
  buildWebSiteJsonLd,
  jsonLdScriptHtml,
  parseSeoKeywords,
  resolveOgImage,
  resolveSeoKeywords,
  siteBaseUrl,
  type SeoMachine,
} from '@/lib/seo';

// L1 — src/lib/seo.ts. Pure functions: metadata, keywords, JSON-LD builders.
// No database, no HTTP — every cfg is a plain object built in-test.

describe('parseSeoKeywords', () => {
  it('empty/undefined/whitespace-only → []', () => {
    expect(parseSeoKeywords(undefined)).toEqual([]);
    expect(parseSeoKeywords('')).toEqual([]);
    expect(parseSeoKeywords('   ')).toEqual([]);
  });

  it('splits on comma, trims, and drops empty entries', () => {
    expect(parseSeoKeywords('a, b ,c,, d')).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('buildDefaultKeywords', () => {
  it('includes the business name and area-derived phrases, lowercased', () => {
    const words = buildDefaultKeywords({ businessName: 'Graveklar', serviceArea: 'Bodø' });
    expect(words).toContain('graveklar');
    expect(words).toContain('bodø');
    expect(words).toContain('utleie bodø');
    expect(words).toContain('leie utstyr bodø');
    expect(words).toContain('maskinutleie bodø');
  });

  it('always includes the static equipment terms', () => {
    const words = buildDefaultKeywords({});
    expect(words).toEqual(expect.arrayContaining(['utstyr utleie', 'maskinutleie', 'minigraver leie']));
  });

  it('adds each machine\'s name, category and "name model"', () => {
    const machines: SeoMachine[] = [{ name: 'Testgraver', category: 'minigraver', model: 'TB216' }];
    const words = buildDefaultKeywords({}, machines);
    expect(words).toContain('testgraver');
    expect(words).toContain('minigraver');
    expect(words).toContain('testgraver tb216');
  });

  it('caps the result at 24 entries', () => {
    const machines: SeoMachine[] = Array.from({ length: 40 }, (_, i) => ({ name: `Maskin${i}` }));
    const words = buildDefaultKeywords({ businessName: 'Graveklar', serviceArea: 'Bodø' }, machines);
    expect(words.length).toBeLessThanOrEqual(24);
  });

  it('an empty cfg produces no blank/undefined entries', () => {
    const words = buildDefaultKeywords({});
    expect(words.every((w) => w.length > 0)).toBe(true);
  });
});

describe('resolveSeoKeywords', () => {
  it('manual keywords win when present', () => {
    const words = resolveSeoKeywords({ seoKeywords: 'egendefinert, ord', businessName: 'Graveklar' });
    expect(words).toEqual(['egendefinert', 'ord']);
  });

  it('falls back to the auto-generated set when seoKeywords is blank', () => {
    const words = resolveSeoKeywords({ seoKeywords: '', businessName: 'Graveklar', serviceArea: 'Bodø' });
    expect(words).toContain('graveklar');
  });
});

describe('buildSeoTitle', () => {
  it('an explicit seoTitle wins outright', () => {
    expect(buildSeoTitle({ seoTitle: 'Egendefinert tittel' })).toBe('Egendefinert tittel');
  });

  it('falls back to "{name} | Utstyrsutleie i {area}" when an area is set', () => {
    expect(buildSeoTitle({ businessName: 'Graveklar', serviceArea: 'Bodø' })).toBe('Graveklar | Utstyrsutleie i Bodø');
  });

  it('drops the "i {area}" suffix when there is no area', () => {
    expect(buildSeoTitle({ businessName: 'Graveklar', serviceArea: '' })).toBe('Graveklar | Utstyrsutleie');
  });

  it('defaults the business name to "Graveklar" when unset', () => {
    expect(buildSeoTitle({})).toBe('Graveklar | Utstyrsutleie');
  });

  it('ignores a seoTitle that is only whitespace', () => {
    expect(buildSeoTitle({ seoTitle: '   ', businessName: 'Graveklar' })).toBe('Graveklar | Utstyrsutleie');
  });
});

describe('buildSeoDescription', () => {
  it('an explicit seoDescription wins, sliced to 160', () => {
    const override = 'x'.repeat(200);
    expect(buildSeoDescription({ seoDescription: override })).toBe('x'.repeat(160));
  });

  it('a heroTagline of exactly 160 characters is used as-is', () => {
    const tagline = 'x'.repeat(160);
    expect(buildSeoDescription({ heroTagline: tagline })).toBe(tagline);
    expect(buildSeoDescription({ heroTagline: tagline }).length).toBe(160);
  });

  // FIXED W-7: the tagline is written for a headline, not for a search
  // snippet. graveklar.no shipped `<meta name="description" content="Alt
  // inkludert.">` — 14 characters — because any tagline ≤160 was accepted.
  // Below a 50-character floor we fall through to the generated sentence.
  it('a heroTagline too short to be a snippet falls through to the generated sentence', () => {
    const result = buildSeoDescription({ heroTagline: 'Alt inkludert.', businessName: 'Graveklar', serviceArea: 'Bodø' });
    expect(result).not.toBe('Alt inkludert.');
    expect(result).toContain('Graveklar');
    expect(result).toContain('Bodø');
    expect(result.length).toBeGreaterThanOrEqual(50);
  });

  it('a heroTagline long enough to be a snippet is still used as-is', () => {
    const tagline = 'Leie av minigraver i Bodø med levering, drivstoff og forsikring inkludert.';
    expect(tagline.length).toBeGreaterThanOrEqual(50);
    expect(buildSeoDescription({ heroTagline: tagline, businessName: 'Graveklar' })).toBe(tagline);
  });

  it('an explicit seoDescription is used however short it is (W-7 changed only the tagline path)', () => {
    expect(buildSeoDescription({ seoDescription: 'Kort.', businessName: 'Graveklar' })).toBe('Kort.');
  });

  it('a heroTagline of 161 characters is too long and falls through to the generated sentence', () => {
    const tagline = 'x'.repeat(161);
    const result = buildSeoDescription({ heroTagline: tagline, businessName: 'Graveklar' });
    expect(result).not.toBe(tagline);
    expect(result).toContain('Graveklar');
  });

  it('the generated fallback mentions up to two machine names, joined with "og"', () => {
    const machines: SeoMachine[] = [{ name: 'Testgraver' }, { name: 'Hjullaster' }, { name: 'Tredje' }];
    const result = buildSeoDescription({ businessName: 'Graveklar' }, machines);
    expect(result).toContain('Testgraver og Hjullaster');
    expect(result).not.toContain('Tredje');
  });

  it('the generated fallback is always sliced to at most 160 characters', () => {
    const machines: SeoMachine[] = [
      { name: 'x'.repeat(100) },
      { name: 'y'.repeat(100) },
    ];
    const result = buildSeoDescription({ businessName: 'Graveklar', serviceArea: 'Bodø' }, machines);
    expect(result.length).toBeLessThanOrEqual(160);
  });
});

describe('siteBaseUrl', () => {
  it('strips one or more trailing slashes', () => {
    expect(siteBaseUrl({ siteUrl: 'https://example.no/' })).toBe('https://example.no');
    expect(siteBaseUrl({ siteUrl: 'https://example.no///' })).toBe('https://example.no');
  });

  it('defaults to https://graveklar.no when unset or blank', () => {
    expect(siteBaseUrl({})).toBe('https://graveklar.no');
    expect(siteBaseUrl({ siteUrl: '' })).toBe('https://graveklar.no');
  });
});

describe('absoluteUrl', () => {
  it('passes an already-absolute (http…) path through unchanged', () => {
    expect(absoluteUrl({ siteUrl: 'https://example.no' }, 'http://elsewhere.example/x.jpg')).toBe(
      'http://elsewhere.example/x.jpg',
    );
  });

  it('joins a leading-slash path onto the base with exactly one slash', () => {
    expect(absoluteUrl({ siteUrl: 'https://example.no' }, '/hero.jpg')).toBe('https://example.no/hero.jpg');
  });

  it('adds the missing slash for a path with none', () => {
    expect(absoluteUrl({ siteUrl: 'https://example.no' }, 'hero.jpg')).toBe('https://example.no/hero.jpg');
  });
});

describe('resolveOgImage', () => {
  it('defaults to /hero.jpg, resolved against the base', () => {
    expect(resolveOgImage({ siteUrl: 'https://example.no' })).toBe('https://example.no/hero.jpg');
  });

  it('an absolute heroImageUrl is used as-is', () => {
    expect(resolveOgImage({ heroImageUrl: 'https://cdn.example.com/x.jpg' })).toBe('https://cdn.example.com/x.jpg');
  });

  it('a relative heroImageUrl is resolved against the base', () => {
    expect(resolveOgImage({ siteUrl: 'https://example.no', heroImageUrl: '/uploads/x.jpg' })).toBe(
      'https://example.no/uploads/x.jpg',
    );
  });

  // FIXED R-1: a protocol-relative image URL ("//cdn.example.com/x.jpg")
  // resolves against the current scheme. It starts with "/", so `absoluteUrl`
  // used to take the "already has a leading slash" branch and PREPEND the
  // site's own origin, handing crawlers "https://example.no//cdn…" — neither
  // the CDN link nor a valid same-origin path.
  it('a protocol-relative heroImageUrl resolves to a valid URL on the current scheme', async () => {
    const result = resolveOgImage({ siteUrl: 'https://example.no', heroImageUrl: '//cdn.example.com/x.jpg' });
    expect(() => new URL(result)).not.toThrow();
    expect(result).toBe('https://cdn.example.com/x.jpg');
  });

  // Rewritten for FIXED R-1: the host is the CDN's, not ours.
  it('keeps the scheme of the site URL when resolving a protocol-relative image', () => {
    expect(resolveOgImage({ siteUrl: 'http://localhost:3001', heroImageUrl: '//cdn.example.com/x.jpg' }))
      .toBe('http://cdn.example.com/x.jpg');
    const result = resolveOgImage({ siteUrl: 'https://example.no', heroImageUrl: '//cdn.example.com/x.jpg' });
    expect(new URL(result).host).toBe('cdn.example.com');
  });
});

describe('buildSiteMetadata', () => {
  const cfg = { businessName: 'Graveklar', serviceArea: 'Bodø', siteUrl: 'https://example.no' };

  it('sets alternates.canonical from the path when not noIndex', () => {
    const meta = buildSiteMetadata(cfg, [], { path: '/kontakt' });
    expect(meta.alternates).toEqual({ canonical: 'https://example.no/kontakt' });
    expect(meta.robots).toBeUndefined();
  });

  it('sets robots.index=false and omits alternates when noIndex is true', () => {
    const meta = buildSiteMetadata(cfg, [], { path: '/admin-preview', noIndex: true });
    expect(meta.robots).toEqual({ index: false, follow: false });
    expect(meta.alternates).toBeUndefined();
  });

  it('canonical falls back to the bare site URL with no path', () => {
    const meta = buildSiteMetadata(cfg);
    expect(meta.alternates).toEqual({ canonical: 'https://example.no' });
  });

  it('metadataBase is a URL built from siteUrl', () => {
    const meta = buildSiteMetadata(cfg);
    expect(meta.metadataBase).toBeInstanceOf(URL);
    expect(meta.metadataBase?.toString()).toBe('https://example.no/');
  });

  it('an empty siteUrl falls back to the default and does not throw', () => {
    expect(() => buildSiteMetadata({ businessName: 'Graveklar' })).not.toThrow();
  });

  // FIXED R-2: `new URL(siteUrl)` had no guard and `siteBaseUrl` never checked
  // for (or added) a scheme, so an admin saving `siteUrl = "graveklar.no"` (a
  // very plausible typo — leaving off "https://") crashed metadata generation
  // on EVERY page: every `generateMetadata()` calls this with no try/catch
  // anywhere in the chain.
  it('a siteUrl without a scheme does not crash metadata generation', async () => {
    expect(() => buildSiteMetadata({ businessName: 'Graveklar', siteUrl: 'graveklar.no' })).not.toThrow();
  });

  // Rewritten for FIXED R-2: a bare host now reads as the https host it
  // obviously means, and total nonsense degrades to the default origin.
  it('reads a schemeless siteUrl as https, and falls back for an unusable one', () => {
    const bare = buildSiteMetadata({ businessName: 'Graveklar', siteUrl: 'graveklar.no' }, [], { path: '/kontakt' });
    expect(bare.metadataBase?.toString()).toBe('https://graveklar.no/');
    expect(bare.alternates).toEqual({ canonical: 'https://graveklar.no/kontakt' });

    const junk = buildSiteMetadata({ businessName: 'Graveklar', siteUrl: 'ikke en url' });
    expect(junk.metadataBase?.toString()).toBe('https://graveklar.no/');
  });
});

describe('JSON-LD builders', () => {
  it('buildLocalBusinessJsonLd includes optional fields only when present', () => {
    const withExtras = buildLocalBusinessJsonLd({
      businessName: 'Graveklar', serviceArea: 'Bodø', contactPhone: '99999999',
      contactEmail: 'post@graveklar.no', businessAddress: 'Testveien 1', orgNumber: '999888777',
    });
    expect(withExtras).toMatchObject({
      '@type': 'LocalBusiness',
      telephone: '99999999',
      email: 'post@graveklar.no',
      address: { streetAddress: 'Testveien 1', addressCountry: 'NO' },
      identifier: { propertyID: 'orgNumber', value: '999888777' },
    });

    const bare = buildLocalBusinessJsonLd({});
    expect(bare).not.toHaveProperty('telephone');
    expect(bare).not.toHaveProperty('email');
    expect(bare).not.toHaveProperty('address');
    expect(bare).not.toHaveProperty('identifier');
    expect(bare.priceRange).toBe('$$');
    expect(bare.currenciesAccepted).toBe('NOK');
  });

  it('buildWebSiteJsonLd is the minimal WebSite shape', () => {
    const ld = buildWebSiteJsonLd({ businessName: 'Graveklar', siteUrl: 'https://example.no' });
    expect(ld).toMatchObject({ '@type': 'WebSite', name: 'Graveklar', url: 'https://example.no', inLanguage: 'nb-NO' });
  });

  it('buildFaqPageJsonLd is null with no items, else a Question[] mainEntity', () => {
    expect(buildFaqPageJsonLd([])).toBeNull();
    const ld = buildFaqPageJsonLd([{ question: 'Q?', answer: 'A.' }]);
    expect(ld).toMatchObject({
      '@type': 'FAQPage',
      mainEntity: [{ '@type': 'Question', name: 'Q?', acceptedAnswer: { '@type': 'Answer', text: 'A.' } }],
    });
  });

  it('buildAggregateRatingJsonLd is null at count 0 (and negative)', () => {
    expect(buildAggregateRatingJsonLd({}, { count: 0, average: 0 })).toBeNull();
    expect(buildAggregateRatingJsonLd({}, { count: -1, average: 0 })).toBeNull();
  });

  it('buildAggregateRatingJsonLd carries a fixed 1–5 scale', () => {
    const ld = buildAggregateRatingJsonLd({ businessName: 'Graveklar' }, { count: 12, average: 4.7 });
    expect(ld).toMatchObject({
      aggregateRating: { ratingValue: 4.7, reviewCount: 12, bestRating: 5, worstRating: 1 },
    });
  });
});

describe('jsonLdScriptHtml', () => {
  it('escapes every "<" (not just the literal "</script>")', () => {
    const html = jsonLdScriptHtml({ name: '</script><script>alert(1)</script>' });
    expect(html).not.toContain('</script>');
    expect(html).not.toContain('<script>');
    // Only "<" is escaped (to \u003c) — ">" is left alone, which is enough:
    // an inline <script> block only ends at "</script", not at a bare ">".
    expect(html).toBe('{"name":"\\u003c/script>\\u003cscript>alert(1)\\u003c/script>"}');
  });

  it('round-trips through JSON.parse once the escape is reversed', () => {
    const data = { businessName: 'Test <b>navn</b>' };
    const html = jsonLdScriptHtml(data);
    const restored = JSON.parse(html.replace(/\\u003c/g, '<'));
    expect(restored).toEqual(data);
  });
});
