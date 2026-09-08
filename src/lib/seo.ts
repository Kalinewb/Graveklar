import type { Metadata } from 'next';

export interface SeoMachine {
  name: string;
  model?: string | null;
  category?: string | null;
}

export function parseSeoKeywords(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw.split(',').map((k) => k.trim()).filter(Boolean);
}

/** Auto-generated fallback when admin has not set keywords manually. */
export function buildDefaultKeywords(cfg: Record<string, string>, machines: SeoMachine[] = []): string[] {
  const words = new Set<string>();
  const name = (cfg['businessName'] || '').trim();
  const area = (cfg['serviceArea'] || '').trim();

  if (name) words.add(name.toLowerCase());
  if (area) {
    words.add(area.toLowerCase());
    words.add(`utleie ${area.toLowerCase()}`);
    words.add(`leie utstyr ${area.toLowerCase()}`);
    words.add(`maskinutleie ${area.toLowerCase()}`);
  }

  for (const term of [
    'utstyr utleie',
    'maskinutleie',
    'minigraver leie',
    'gravemaskin leie',
    'leie gravemaskin',
    'anleggsutstyr leie',
    'utleie gravemaskin',
  ]) {
    words.add(term);
  }

  for (const m of machines) {
    if (m.name) words.add(m.name.toLowerCase());
    if (m.category) words.add(m.category.toLowerCase());
    if (m.model) words.add(`${m.name} ${m.model}`.toLowerCase());
  }

  return [...words].slice(0, 24);
}

export function resolveSeoKeywords(cfg: Record<string, string>, machines: SeoMachine[] = []): string[] {
  const manual = parseSeoKeywords(cfg['seoKeywords']);
  return manual.length > 0 ? manual : buildDefaultKeywords(cfg, machines);
}

export function buildSeoTitle(cfg: Record<string, string>): string {
  const override = cfg['seoTitle']?.trim();
  if (override) return override;
  const name = cfg['businessName'] || 'Graveklar';
  const area = cfg['serviceArea'] || '';
  return area ? `${name} | Utstyrsutleie i ${area}` : `${name} | Utstyrsutleie`;
}

/** Google truncates a snippet around here; anything longer is wasted. */
const MAX_DESCRIPTION_CHARS = 160;
/** …and anything shorter than this is not a snippet at all. The hero tagline
 *  is written for a headline, not for a search result: "Alt inkludert." shipped
 *  as the site's whole <meta name="description"> until finding W-7. Below this
 *  floor we fall through to the generated sentence instead. */
const MIN_TAGLINE_CHARS = 50;

export function buildSeoDescription(cfg: Record<string, string>, machines: SeoMachine[] = []): string {
  const override = cfg['seoDescription']?.trim();
  if (override) return override.slice(0, MAX_DESCRIPTION_CHARS);

  const tagline = cfg['heroTagline']?.trim();
  if (tagline && tagline.length >= MIN_TAGLINE_CHARS && tagline.length <= MAX_DESCRIPTION_CHARS) return tagline;

  const name = cfg['businessName'] || 'Graveklar';
  const area = cfg['serviceArea'] || '';
  const equipment = machines
    .slice(0, 2)
    .map((m) => m.name)
    .filter(Boolean)
    .join(' og ');
  const equipPart = equipment ? `${equipment} og annet utstyr` : 'minigraver og anleggsutstyr';
  const areaPart = area ? ` i ${area}` : '';

  return `${name} – leie av ${equipPart}${areaPart}. Fastpris inkl. levering, drivstoff og forsikring. Book online.`.slice(
    0,
    MAX_DESCRIPTION_CHARS
  );
}

const DEFAULT_SITE_URL = 'https://graveklar.no';

/** True for a value `new URL()` can parse on its own. */
function isAbsoluteUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

let warnedAboutSiteUrl = false;

/**
 * The site's origin, always parseable. An admin who saves `siteUrl` without a
 * scheme ("graveklar.no" — leaving off the https:// is a very plausible typo)
 * used to crash `new URL()` inside `buildSiteMetadata`, and every page's
 * `generateMetadata()` calls that with no try/catch anywhere in the chain, so
 * one typo 500'd the whole site (finding R-2). A schemeless host is now read
 * as the https host it obviously means, and anything still unparseable falls
 * back to the default origin with a single warning.
 */
export function siteBaseUrl(cfg: Record<string, string>): string {
  const raw = (cfg['siteUrl'] || '').trim().replace(/\/+$/, '');
  if (!raw) return DEFAULT_SITE_URL;
  if (isAbsoluteUrl(raw)) return raw;
  // Protocol-relative ("//host") and bare hosts ("graveklar.no") both mean
  // "this host, over https".
  const candidate = `https://${raw.replace(/^\/+/, '')}`;
  if (isAbsoluteUrl(candidate)) return candidate;
  if (!warnedAboutSiteUrl) {
    warnedAboutSiteUrl = true;
    console.warn(`[seo] siteUrl "${raw}" is not a usable URL — falling back to ${DEFAULT_SITE_URL}`);
  }
  return DEFAULT_SITE_URL;
}

export function absoluteUrl(cfg: Record<string, string>, path: string): string {
  const base = siteBaseUrl(cfg);
  if (path.startsWith('http')) return path;
  // A protocol-relative link ("//cdn.example.com/x.jpg") points at another
  // host on the current scheme. It starts with "/", so the old code prepended
  // our own origin to it and handed crawlers "https://graveklar.no//cdn…"
  // (finding R-1). Resolve it against the base's scheme instead.
  if (path.startsWith('//')) return `${new URL(base).protocol}${path}`;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

export function resolveOgImage(cfg: Record<string, string>): string {
  const img = cfg['heroImageUrl'] || '/hero.jpg';
  if (img.startsWith('http')) return img;
  return absoluteUrl(cfg, img);
}

export function buildSiteMetadata(
  cfg: Record<string, string>,
  machines: SeoMachine[] = [],
  opts?: { path?: string; title?: string; description?: string; noIndex?: boolean }
): Metadata {
  const title = opts?.title ?? buildSeoTitle(cfg);
  const description = opts?.description ?? buildSeoDescription(cfg, machines);
  const keywords = resolveSeoKeywords(cfg, machines);
  const siteUrl = siteBaseUrl(cfg);
  const ogImage = resolveOgImage(cfg);
  const canonical = opts?.path ? absoluteUrl(cfg, opts.path) : siteUrl;

  return {
    title,
    description,
    keywords,
    ...(opts?.noIndex
      ? { robots: { index: false, follow: false } }
      : { alternates: { canonical } }),
    // `siteBaseUrl` guarantees this parses (R-2).
    metadataBase: new URL(siteUrl),
    openGraph: {
      title,
      description,
      type: 'website',
      url: canonical,
      siteName: cfg['businessName'] || 'Graveklar',
      images: [{ url: ogImage, width: 1200, height: 630, alt: title }],
      locale: 'nb_NO',
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [ogImage],
    },
  };
}

export function buildLocalBusinessJsonLd(cfg: Record<string, string>, machines: SeoMachine[] = []) {
  const name = cfg['businessName'] || 'Graveklar';
  const url = siteBaseUrl(cfg);
  const area = cfg['serviceArea'] || 'Bodø og Salten';
  const keywords = resolveSeoKeywords(cfg, machines);
  const description = buildSeoDescription(cfg, machines);

  return {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name,
    url,
    image: resolveOgImage(cfg),
    ...(cfg['contactPhone'] ? { telephone: cfg['contactPhone'] } : {}),
    ...(cfg['contactEmail'] ? { email: cfg['contactEmail'] } : {}),
    description,
    ...(keywords.length > 0 ? { keywords: keywords.join(', ') } : {}),
    ...(keywords.length > 0 ? { knowsAbout: keywords.slice(0, 12) } : {}),
    areaServed: { '@type': 'Place', name: area },
    ...(cfg['businessAddress']
      ? {
          address: {
            '@type': 'PostalAddress',
            streetAddress: cfg['businessAddress'],
            addressLocality: area,
            addressCountry: 'NO',
          },
        }
      : {}),
    // schema.org expects a tier indicator here, not a currency code.
    priceRange: '$$',
    paymentAccepted: 'Credit Card',
    currenciesAccepted: 'NOK',
    ...(cfg['orgNumber']
      ? {
          identifier: {
            '@type': 'PropertyValue',
            propertyID: 'orgNumber',
            value: cfg['orgNumber'],
          },
        }
      : {}),
  };
}

export function buildWebSiteJsonLd(cfg: Record<string, string>) {
  const name = cfg['businessName'] || 'Graveklar';
  const url = siteBaseUrl(cfg);
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name,
    url,
    inLanguage: 'nb-NO',
    description: buildSeoDescription(cfg),
  };
}

export function buildFaqPageJsonLd(items: { question: string; answer: string }[]) {
  if (items.length === 0) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: item.answer,
      },
    })),
  };
}

export function buildAggregateRatingJsonLd(
  cfg: Record<string, string>,
  aggregate: { count: number; average: number }
) {
  if (aggregate.count <= 0) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: cfg['businessName'] || 'Graveklar',
    url: siteBaseUrl(cfg),
    aggregateRating: {
      '@type': 'AggregateRating',
      ratingValue: aggregate.average,
      reviewCount: aggregate.count,
      bestRating: 5,
      worstRating: 1,
    },
  };
}

export function jsonLdScriptHtml(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
