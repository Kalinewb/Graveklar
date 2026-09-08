#!/usr/bin/env node
// Captures full-page screenshots of every important screen so we can hand
// them off to claude.ai for design critique. Uses the system chromium via
// puppeteer-core — no 150 MB browser download.
//
// Usage:
//   npm run shots                  # capture everything
//   npm run shots -- --only main   # main-preview only
//   npm run shots -- --only admin  # admin-preview only
//   npm run shots -- --base http://localhost:3000  # override base URL

import puppeteer from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1] ?? true]);
    return acc;
  }, [])
);

const BASE = args.base || process.env.SHOTS_BASE || 'http://localhost:3000';
const ONLY = args.only || null;
const OUT = path.resolve('design-shots');

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, dpr: 2 },
  { name: 'mobile', width: 390, height: 844, dpr: 3 },
];

// Curated list. Each entry → one full-page screenshot per viewport.
// Group is folder name so the claude.ai chat can compare related shots.
const SHOTS = [
  // Real homepage — the thing being redesigned
  { group: 'home',          name: '01-default',           url: '/' },
  { group: 'home',          name: '02-pricing-tabs',      url: '/#priser' },
  { group: 'home',          name: '03-equipment-section', url: '/#utstyr' },
  { group: 'home',          name: '04-booking-form',      url: '/#booking' },
  { group: 'home',          name: '05-delivery',          url: '/#levering' },

  // Main-preview — the alternative we built last session
  { group: 'main-preview',  name: '01-default-day',       url: '/main-preview' },
  { group: 'main-preview',  name: '02-weekend-selected',  url: '/main-preview?type=weekend' },
  { group: 'main-preview',  name: '03-date-picked',       url: '/main-preview?type=day&date=2026-06-04' },
  { group: 'main-preview',  name: '04-kovaco-tab',        url: '/main-preview?mach=kovaco' },
  { group: 'main-preview',  name: '05-pickup-warning',    url: '/main-preview?delivery=pickup' },
  { group: 'main-preview',  name: '06-discount-applied',  url: '/main-preview?code=TEST10' },
  { group: 'main-preview',  name: '07-discount-rejected', url: '/main-preview?code=NOPE' },
  { group: 'main-preview',  name: '08-far-delivery',      url: '/main-preview?km=60' },
  { group: 'main-preview',  name: '09-payment-step',      url: '/main-preview?type=weekend&date=2026-06-05&payment=1#payment' },

  // Admin-preview — the alt admin we built
  { group: 'admin-preview', name: '01-calendar',          url: '/admin-preview?tab=calendar' },
  { group: 'admin-preview', name: '02-calendar-week-sel', url: '/admin-preview?tab=calendar&mode=week' },
  { group: 'admin-preview', name: '03-pricing',           url: '/admin-preview?tab=pricing' },
  { group: 'admin-preview', name: '04-machines',          url: '/admin-preview?tab=machines' },
  { group: 'admin-preview', name: '05-content',           url: '/admin-preview?tab=content' },
  { group: 'admin-preview', name: '06-checklists',        url: '/admin-preview?tab=checklists' },
  { group: 'admin-preview', name: '07-activity',          url: '/admin-preview?tab=activity' },
  { group: 'admin-preview', name: '08-settings-business', url: '/admin-preview?tab=settings&group=business' },
  { group: 'admin-preview', name: '09-settings-booking',  url: '/admin-preview?tab=settings&group=booking' },
  { group: 'admin-preview', name: '10-settings-stripe',   url: '/admin-preview?tab=settings&group=stripe' },
  { group: 'admin-preview', name: '11-settings-theme',    url: '/admin-preview?tab=settings&group=theme' },
  { group: 'admin-preview', name: '12-booking-detail',    url: '/admin-preview?tab=calendar&detail=GK-2026-0143' },
  { group: 'admin-preview', name: '13-form-machine',      url: '/admin-preview?tab=machines&form=machine' },
  { group: 'admin-preview', name: '14-form-faq',          url: '/admin-preview?tab=content&form=faq' },
  { group: 'admin-preview', name: '15-notifications',     url: '/admin-preview?notifications=1' },
];

const filtered = ONLY ? SHOTS.filter((s) => s.group.includes(ONLY)) : SHOTS;

async function main() {
  await mkdir(OUT, { recursive: true });
  console.log(`→ ${filtered.length} URL(s) × ${VIEWPORTS.length} viewport(s) = ${filtered.length * VIEWPORTS.length} shots`);
  console.log(`→ Base: ${BASE}`);
  console.log(`→ Output: ${OUT}`);

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_BIN || '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    for (const shot of filtered) {
      const groupDir = path.join(OUT, shot.group);
      await mkdir(groupDir, { recursive: true });

      for (const vp of VIEWPORTS) {
        const page = await browser.newPage();
        await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr });
        const url = BASE + shot.url;
        try {
          await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
          // Give CSS animations / fonts a beat to settle.
          await new Promise((r) => setTimeout(r, 400));
          const filename = `${shot.name}.${vp.name}.png`;
          const filepath = path.join(groupDir, filename);
          await page.screenshot({ path: filepath, fullPage: true, type: 'png' });
          const stat = await import('node:fs').then((m) => m.promises.stat(filepath));
          const kb = Math.round(stat.size / 1024);
          console.log(`  ✓ ${shot.group}/${filename}  (${vp.width}×${vp.height}, ${kb} KB)`);
        } catch (err) {
          console.log(`  ✗ ${shot.group}/${shot.name}.${vp.name}  — ${err.message}`);
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  console.log('\nDone. Drop the .png files into a claude.ai chat with the prompt in design-shots/REVIEW-PROMPT.md');
}

main().catch((e) => { console.error(e); process.exit(1); });
