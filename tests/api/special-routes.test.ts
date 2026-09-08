import fs from 'node:fs';
import path from 'node:path';

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { normalizeAccent } from '@/lib/brand-icon';

import { db, ensureSchema, invalidateCaches, machine, resetDb, seedConfigDefaults } from '../helpers/db';
import { call } from '../helpers/route';

// L2 — the special-purpose routes: sitemap.xml, robots.txt, the web app
// manifest, /llms.txt, the three SVG icon routes, and light shape checks on
// GET /api/machines and GET /api/app-config (the latter's public-key
// filtering is asserted in depth by Phase 1d).

let sitemap: typeof import('@/app/sitemap').default;
let robots: typeof import('@/app/robots').default;
let manifest: typeof import('@/app/manifest').default;
let llmsGET: typeof import('@/app/llms.txt/route').GET;
let brandIconGET: typeof import('@/app/brand-icon.svg/route').GET;
let brandMarkGET: typeof import('@/app/brand-mark.svg/route').GET;
let apiIconGET: typeof import('@/app/api/icon/route').GET;
let machinesGET: typeof import('@/app/api/machines/route').GET;
let appConfigGET: typeof import('@/app/api/app-config/route').GET;

beforeAll(async () => {
  await ensureSchema();
  sitemap = (await import('@/app/sitemap')).default;
  robots = (await import('@/app/robots')).default;
  manifest = (await import('@/app/manifest')).default;
  ({ GET: llmsGET } = await import('@/app/llms.txt/route'));
  ({ GET: brandIconGET } = await import('@/app/brand-icon.svg/route'));
  ({ GET: brandMarkGET } = await import('@/app/brand-mark.svg/route'));
  ({ GET: apiIconGET } = await import('@/app/api/icon/route'));
  ({ GET: machinesGET } = await import('@/app/api/machines/route'));
  ({ GET: appConfigGET } = await import('@/app/api/app-config/route'));
});

beforeEach(async () => {
  await resetDb();
  await seedConfigDefaults();
});

describe('sitemap.ts', () => {
  it('the 3 base entries always appear, in priority order', async () => {
    await db.appConfig.update({ where: { key: 'contactFormEnabled' }, data: { value: 'false' } });
    invalidateCaches();
    const entries = await sitemap();
    expect(entries.map((e) => e.url.replace(/^https?:\/\/[^/]+/, ''))).toEqual(['/', '/vilkar', '/personvern']);
  });

  it('/kontakt is included when contactFormEnabled is true (the default)', async () => {
    const entries = await sitemap();
    expect(entries.some((e) => e.url.endsWith('/kontakt'))).toBe(true);
    expect(entries.some((e) => e.url.endsWith('/bedrift'))).toBe(false);
  });

  it('/bedrift is included only when b2bEnabled is true', async () => {
    await db.appConfig.update({ where: { key: 'b2bEnabled' }, data: { value: 'true' } });
    invalidateCaches();
    const entries = await sitemap();
    expect(entries.some((e) => e.url.endsWith('/bedrift'))).toBe(true);
  });

  it("the home entry's lastModified is the newest active machine's updatedAt", async () => {
    const m = await machine();
    await new Promise((r) => setTimeout(r, 5));
    await db.machine.update({ where: { id: m.id }, data: { name: 'Updated name' } }); // bumps updatedAt
    const updated = await db.machine.findUniqueOrThrow({ where: { id: m.id } });

    const entries = await sitemap();
    const home = entries.find((e) => e.url.endsWith('/'))!;
    expect(new Date(home.lastModified as string | Date).getTime()).toBe(updated.updatedAt.getTime());
  });

  it('an inactive-only machine set does not affect the home lastModified (falls back to now)', async () => {
    await machine({ isActive: false });
    const before = Date.now();
    const entries = await sitemap();
    const home = entries.find((e) => e.url.endsWith('/'))!;
    expect(new Date(home.lastModified as string | Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('every URL is built from siteBaseUrl', async () => {
    await db.appConfig.update({ where: { key: 'siteUrl' }, data: { value: 'https://example.no' } });
    invalidateCaches();
    const entries = await sitemap();
    expect(entries.every((e) => e.url.startsWith('https://example.no'))).toBe(true);
  });
});

describe('robots.ts', () => {
  it('disallows /admin /api /sjekkliste /omtale /tilbud and allows / and /api/icon, for every listed agent', async () => {
    const result = await robots();
    const rules = Array.isArray(result.rules) ? result.rules : [result.rules];
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.disallow).toEqual(['/admin', '/api', '/sjekkliste', '/omtale', '/tilbud']);
      expect(rule.allow).toEqual(['/', '/api/icon']);
    }
    const agents = rules.map((r) => r.userAgent);
    expect(agents).toEqual(expect.arrayContaining([
      '*', 'Googlebot', 'Googlebot-Image', 'Bingbot', 'GPTBot', 'ChatGPT-User', 'OAI-SearchBot', 'ClaudeBot', 'PerplexityBot',
    ]));
  });

  it('the sitemap URL is {siteBaseUrl}/sitemap.xml', async () => {
    await db.appConfig.update({ where: { key: 'siteUrl' }, data: { value: 'https://example.no/' } });
    invalidateCaches();
    const result = await robots();
    expect(result.sitemap).toBe('https://example.no/sitemap.xml');
  });
});

describe('manifest.ts', () => {
  it('name/short_name/theme_color come from AppConfig', async () => {
    await db.appConfig.update({ where: { key: 'businessName' }, data: { value: 'Testfirma' } });
    await db.appConfig.update({ where: { key: 'accentColor' }, data: { value: '#123456' } });
    invalidateCaches();
    const result = await manifest();
    expect(result.name).toBe('Testfirma – utstyrsutleie');
    expect(result.short_name).toBe('Testfirma');
    expect(result.theme_color).toBe('#123456');
  });

  it('an invalid accentColor normalizes to the brand default rather than leaking garbage into theme_color', async () => {
    await db.appConfig.update({ where: { key: 'accentColor' }, data: { value: 'not-a-color' } });
    invalidateCaches();
    const result = await manifest();
    expect(result.theme_color).toBe(normalizeAccent('not-a-color'));
    expect(result.theme_color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('lists exactly the three installable icon sizes, and each file exists under public/', async () => {
    const result = await manifest();
    expect(result.icons).toHaveLength(3);
    for (const icon of result.icons!) {
      const filePath = path.join(process.cwd(), 'public', icon.src.replace(/^\//, ''));
      expect(fs.existsSync(filePath), icon.src).toBe(true);
    }
  });

  it('the maskable icon is flagged purpose: maskable, the others any', async () => {
    const result = await manifest();
    const maskable = result.icons!.find((i) => i.purpose === 'maskable');
    expect(maskable?.src).toBe('/icon-512-maskable.png');
    expect(result.icons!.filter((i) => i.purpose === 'any')).toHaveLength(2);
  });
});

describe('GET /llms.txt', () => {
  it('is text/plain with a short-lived cache header', async () => {
    const res = await call(llmsGET, { path: '/llms.txt' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/plain/);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('includes active machine names and formatted prices', async () => {
    await machine({ name: 'Testgraver 1,8t', model: 'TB216' });
    const res = await call(llmsGET, { path: '/llms.txt' });
    expect(res.text).toContain('Testgraver 1,8t TB216');
    expect(res.text).toMatch(/\*\*1 dag\*\*: fra [\d\s ]+ kr/);
  });

  it('excludes inactive machines', async () => {
    await machine({ name: 'Aktiv maskin' });
    await machine({ name: 'Inaktiv maskin', isActive: false });
    const res = await call(llmsGET, { path: '/llms.txt' });
    expect(res.text).toContain('Aktiv maskin');
    expect(res.text).not.toContain('Inaktiv maskin');
  });
});

describe('SVG icon routes', () => {
  it('GET /brand-icon.svg is image/svg+xml, cached, and parseable SVG', async () => {
    const res = await call(brandIconGET, { path: '/brand-icon.svg' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(res.headers.get('cache-control')).toContain('public, max-age=3600');
    expect(res.text.startsWith('<svg')).toBe(true);
    expect(res.text).toContain('</svg>');
  });

  it('GET /brand-mark.svg is image/svg+xml, cached, and parseable SVG', async () => {
    const res = await call(brandMarkGET, { path: '/brand-mark.svg' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(res.headers.get('cache-control')).toContain('public, max-age=3600');
    expect(res.text.startsWith('<svg')).toBe(true);
  });

  it('GET /api/icon (legacy path) matches /brand-icon.svg\'s shape', async () => {
    const res = await call(apiIconGET, { path: '/api/icon' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(res.text.startsWith('<svg')).toBe(true);
  });

  it('reflects the configured accentColor into the mark colour', async () => {
    await db.appConfig.update({ where: { key: 'accentColor' }, data: { value: '#3D5A3E' } });
    invalidateCaches();
    const withAccent = await call(brandMarkGET, { path: '/brand-mark.svg' });
    await db.appConfig.update({ where: { key: 'accentColor' }, data: { value: '#5A3D3D' } });
    invalidateCaches();
    const withOtherAccent = await call(brandMarkGET, { path: '/brand-mark.svg' });
    expect(withAccent.text).not.toBe(withOtherAccent.text);
  });
});

describe('GET /api/machines', () => {
  it('returns only active machines, ordered by sortOrder then createdAt', async () => {
    await machine({ name: 'Inactive', isActive: false });
    const second = await machine({ name: 'Second', sortOrder: 20 });
    const first = await machine({ name: 'First', sortOrder: 10 });
    const res = await call(machinesGET, { path: '/api/machines' });
    expect(res.status).toBe(200);
    expect(res.json.machines.map((m: { id: string }) => m.id)).toEqual([first.id, second.id]);
  });
});

describe('GET /api/app-config (light shape check — depth in Phase 1d)', () => {
  it('exposes a known public key and withholds a known private one', async () => {
    const res = await call(appConfigGET, { path: '/api/app-config' });
    expect(res.status).toBe(200);
    expect(res.json).toHaveProperty('businessName');
    expect(res.json).not.toHaveProperty('smtpPass');
    expect(res.json).not.toHaveProperty('adminPasswordHash');
  });
});
