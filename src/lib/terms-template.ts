import { createHash } from 'crypto';
import { loadAppConfig } from '@/lib/app-config';
import { getCancelFreeLabel } from '@/lib/cancellation';
import { db } from '@/lib/db';

// Whitelisted template variables for the terms-of-conditions renderer.
// Adding a new variable requires editing this file — unknown {{tokens}}
// render as [mangler verdi] and log a warning, never throw.

export type TermsContext = Record<string, string>;

const TOKEN_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Build the variable context for terms rendering. Reads live AppConfig +
 * PricingConfig values, plus computes a few derived ones (cancellation
 * window label, etc.). Safe to call from anywhere.
 */
export async function buildTermsContext(): Promise<TermsContext> {
  const appCfg = await loadAppConfig();
  const pricingRows = await db.pricingConfig.findMany();
  const pricing: Record<string, number> = {};
  for (const row of pricingRows) pricing[row.key] = row.value;

  return {
    businessName: appCfg['businessName'] || 'Graveklar',
    orgNumber: appCfg['orgNumber'] || '',
    contactEmail: appCfg['contactEmail'] || '',
    contactPhone: appCfg['contactPhone'] || '',
    serviceArea: appCfg['serviceArea'] || '',
    siteUrl: appCfg['siteUrl'] || '',
    cancelFreeLabel: getCancelFreeLabel(appCfg),
    cancelLatePercent: appCfg['cancelLatePercent'] || '50',
    cancelSameDayPercent: appCfg['cancelSameDayPercent'] || '100',
    deliveryIncludedKm: String(pricing['deliveryIncludedKm'] ?? 30),
    deliveryPerKm: String(pricing['deliveryPerKm'] ?? 25),
    minDeliveryFee: String(pricing['minDeliveryFee'] ?? 0),
    maxDeliveryRadius: String(pricing['maxDeliveryRadius'] ?? 150),
    // Hourly rates + included hours — exposed so the terms always quote the
    // same numbers the booking form shows. Prior incident: terms hardcoded
    // 179/199 while admin had raised these to 390/500, creating a
    // contract/marketing discrepancy.
    preOrderHourRate: String(pricing['preOrderHourRate'] ?? 179),
    overtimeRate: String(pricing['overtimeRate'] ?? 199),
    dayIncludedHours: String(pricing['dayIncludedHours'] ?? 10),
    weekendIncludedHours: String(pricing['weekendIncludedHours'] ?? 20),
    weekIncludedHours: String(pricing['weekIncludedHours'] ?? 56),
    // Configurable via AppConfig (group='booking') — was previously
    // hardcoded so the contract silently drifted from admin reality.
    egenandel: appCfg['egenandel'] || '5000',
    minAge: appCfg['minAge'] || '21',
  };
}

/**
 * Render a single template string against the variable context.
 *
 *   - `{{token}}` → ctx[token] when present.
 *   - Unknown token → `[mangler verdi: token]` and pushed onto `missing`.
 *   - Production never throws on missing — admin will see the placeholder
 *     in the rendered output and can fix.
 */
export function renderTermsString(
  template: string,
  ctx: TermsContext
): { output: string; missing: string[] } {
  const missing: string[] = [];
  const output = template.replace(TOKEN_RE, (_, key: string) => {
    if (key in ctx && ctx[key] !== '') return ctx[key];
    missing.push(key);
    return `[mangler verdi: ${key}]`;
  });
  if (missing.length > 0) {
    console.warn('[terms-template] missing tokens', { tokens: missing });
  }
  return { output, missing };
}

/**
 * Hash a (template + resolved context) so the AcceptedContract row has a
 * stable, queryable version stamp. If the admin edits a TermsSection after
 * a booking, the hash for that booking's frozen contract stays the same.
 */
export function termsVersionHash(input: { sections: { title: string; content: string }[]; ctx: TermsContext }): string {
  const h = createHash('sha256');
  // Deterministic serialization: stable key order, no nondeterministic JSON.
  for (const s of input.sections) {
    h.update('\n§§\n');
    h.update(s.title);
    h.update('\n');
    h.update(s.content);
  }
  h.update('\n§§ctx§§\n');
  for (const key of Object.keys(input.ctx).sort()) {
    h.update(key);
    h.update('=');
    h.update(input.ctx[key]);
    h.update('\n');
  }
  return h.digest('hex');
}

/**
 * Render the full TOC into HTML + capture metadata. Used at booking
 * confirmation time to freeze the contract.
 */
export interface RenderedTerms {
  html: string;
  sections: { title: string; content: string }[];
  ctx: TermsContext;
  termsVersionHash: string;
  missingTokens: string[];
}

export async function renderAcceptedTerms(
  audience: 'consumer' | 'business' = 'consumer'
): Promise<RenderedTerms> {
  // Lazy-seed: if the relevant TermsSection set is empty (fresh install or
  // after an inadvertent wipe), populate it with the defaults before
  // rendering. Both seeders are idempotent.
  const { ensureDefaultTermsSeeded, ensureDefaultBusinessTermsSeeded } = await import('@/lib/terms-defaults');
  if (audience === 'business') await ensureDefaultBusinessTermsSeeded();
  else await ensureDefaultTermsSeeded();

  const [ctx, sections] = await Promise.all([
    buildTermsContext(),
    db.termsSection.findMany({
      where: { isActive: true, audience },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    }),
  ]);

  const allMissing = new Set<string>();
  const renderedSections = sections.map((s) => {
    const titleRender = renderTermsString(s.title, ctx);
    const contentRender = renderTermsString(s.content, ctx);
    titleRender.missing.forEach((t) => allMissing.add(t));
    contentRender.missing.forEach((t) => allMissing.add(t));
    return { title: titleRender.output, content: contentRender.output };
  });

  // Pure server-side HTML build — no React, no JSX. Just standard tags so
  // the frozen output is portable and renders identically wherever it's
  // served.
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;')
     .replace(/</g, '&lt;')
     .replace(/>/g, '&gt;');

  const inner = renderedSections
    .map(
      (s, idx) => `
      <section style="margin-bottom:1.5rem;">
        <h2 style="font-size:14px;font-weight:600;margin:0 0 0.5rem 0;color:#111;">${idx + 1}. ${escape(s.title)}</h2>
        <div style="font-size:13px;line-height:1.55;color:#333;white-space:pre-wrap;">${escape(s.content)}</div>
      </section>`
    )
    .join('');

  const business = ctx.businessName || 'Graveklar';
  const footer = `${escape(business)}${ctx.orgNumber ? ` · Org.nr ${escape(ctx.orgNumber)}` : ''}`;

  const html = `<!DOCTYPE html>
<html lang="nb">
<head>
<meta charset="utf-8" />
<title>Leievilkår – ${escape(business)}</title>
</head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#fff;color:#111;max-width:720px;margin:0 auto;padding:2rem 1.5rem;">
  <h1 style="font-size:20px;font-weight:700;margin:0 0 0.25rem 0;">Leievilkår</h1>
  <p style="font-size:12px;color:#666;margin:0 0 1.5rem 0;">${footer}</p>
  ${inner}
  <p style="font-size:11px;color:#888;margin-top:2rem;border-top:1px solid #ddd;padding-top:0.75rem;">
    Disse vilkårene er utarbeidet i samsvar med Forbrukertilsynets standardvilkår og er bindende fra det øyeblikk leietakeren bekrefter bookingen.
  </p>
</body>
</html>`;

  const hash = termsVersionHash({ sections: renderedSections, ctx });
  return {
    html,
    sections: renderedSections,
    ctx,
    termsVersionHash: hash,
    missingTokens: Array.from(allMissing),
  };
}
