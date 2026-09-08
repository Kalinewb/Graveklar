// Rasterises the brand mark into the static icon set served from the site
// root: /favicon.ico, /icon.svg, /icon-192.png, /icon-512.png,
// /icon-512-maskable.png and /apple-touch-icon.png.
//
// Why static, and why at the root: robots.txt disallows /api for every
// crawler, so the old dynamic /api/icon favicon was unfetchable by
// Googlebot-Image — which is why search results showed the generic globe.
// Root-level files are crawlable, cacheable and what every "add to home
// screen" implementation looks for.
//
// Run after changing the mark or the default accent:  node scripts/generate-icons.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');

// The mark data is a .ts module; pull the two exports out textually so this
// script needs no TypeScript toolchain.
const src = readFileSync(join(root, 'src/lib/graveklar-mark-paths.ts'), 'utf8');
const VIEWBOX = src.match(/GRAVEKLAR_MARK_VIEWBOX\s*=\s*"([^"]+)"/)[1];
const SHAPES = [...src.matchAll(/\{\s*d:\s*"((?:[^"\\]|\\.)*)"\s*(?:,\s*transform:\s*"((?:[^"\\]|\\.)*)"\s*)?,?\s*\}/g)]
  .map((m) => ({ d: m[1], transform: m[2] }));
if (SHAPES.length === 0) throw new Error('no mark paths parsed');

// Accent, in order of preference: --accent=#RRGGBB, the accentColor the admin
// has actually set in the database, then the brand default. The PNGs bake the
// colour in (a .png can't read config at request time), so regenerating them
// is the step that follows an accent change — `npm run icons`.
// /brand-icon.svg stays dynamic and needs no regeneration.
const FALLBACK_ACCENT = '#3D5A3E';
const isHex = (v) => /^#[0-9a-fA-F]{6}$/.test(v ?? '');

async function resolveAccent() {
  const flag = process.argv.find((a) => a.startsWith('--accent='))?.slice(9);
  if (isHex(flag)) return flag;
  try {
    const { PrismaClient } = await import('@prisma/client');
    const db = new PrismaClient();
    const row = await db.appConfig.findUnique({ where: { key: 'accentColor' } });
    await db.$disconnect();
    if (isHex(row?.value?.trim())) return row.value.trim();
  } catch {
    // No database reachable (CI, fresh clone) — the default is fine.
  }
  return FALLBACK_ACCENT;
}

const ACCENT = await resolveAccent();
const CREAM = '#F5F0E6';

// Kept in step with MARK_BBOX in src/lib/brand-icon.ts — the artwork's tight
// content box, so the mark centres on the tile instead of inheriting the dead
// space down the left of its viewBox. `--measure` re-derives it.
const BBOX = { x: 63.21, y: 3.1, w: 415.9, h: 581.81 };

// Mirrors src/lib/brand-icon.ts — see the reasoning there.
const srgbToLinear = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const luminance = (hex) => {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const scaleChannels = (hex, f) =>
  '#' + [0, 2, 4].map((i) => Math.round(parseInt(hex.replace('#', '').slice(i, i + 2), 16) * f)
    .toString(16).padStart(2, '0')).join('');
function markColorFor(accent, against, target = 9) {
  for (let f = 1; f > 0.05; f -= 0.02) {
    const shade = scaleChannels(accent, f);
    if (contrast(shade, against) >= target) return shade;
  }
  return '#1A1410';
}
function iconWeights(size) {
  if (size <= 16) return { markScale: 0.88, stroke: 26 };
  if (size <= 32) return { markScale: 0.82, stroke: 18 };
  if (size <= 48) return { markScale: 0.78, stroke: 14 };
  return { markScale: 0.74, stroke: 10 };
}

// Cream ground, mark in a darkened accent. A dark tile vanished into dark
// browser chrome and read as a blob in a light omnibox, and only the SVG
// favicon can adapt to the viewer's theme — everything generated here is one
// fixed image. The raw accent on cream is 4.1:1, so the mark is darkened
// until it clears 9:1.
const INK = markColorFor(ACCENT, CREAM);

function buildSvg({ size, shape = 'rounded', markScale, stroke }) {
  const w = iconWeights(size);
  const fit = markScale ?? w.markScale;
  const sw = stroke ?? w.stroke;
  const scale = (size * fit) / Math.max(BBOX.w, BBOX.h);
  const dx = (size - BBOX.w * scale) / 2 - BBOX.x * scale;
  const dy = (size - BBOX.h * scale) / 2 - BBOX.y * scale;
  const strokeAttrs = sw
    ? ` stroke="${INK}" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round"`
    : '';
  const paths = SHAPES.map(
    (s) => `<path fill="${INK}"${strokeAttrs} d="${s.d}"${s.transform ? ` transform="${s.transform}"` : ''}/>`,
  ).join('');
  const radius = shape === 'rounded' ? Math.round(size * 0.22) : 0;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${size} ${size}" fill="none">` +
    `<rect width="${size}" height="${size}"${radius ? ` rx="${radius}"` : ''} fill="${CREAM}"/>` +
    `<g transform="translate(${dx.toFixed(2)} ${dy.toFixed(2)}) scale(${scale.toFixed(5)})">${paths}</g>` +
    `</svg>`
  );
}

// `node scripts/generate-icons.mjs --measure` — prints the artwork's content
// box so BBOX above (and MARK_BBOX in brand-icon.ts) can be updated when the
// mark changes.
if (process.argv.includes('--measure')) {
  const [, , vbW, vbH] = VIEWBOX.split(/\s+/).map(Number);
  const N = 2000;
  const H = Math.round((N * vbH) / vbW);
  const probe =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${H}" viewBox="${VIEWBOX}">` +
    SHAPES.map((s) => `<path fill="#000" d="${s.d}"${s.transform ? ` transform="${s.transform}"` : ''}/>`).join('') +
    `</svg>`;
  const { info } = await sharp(Buffer.from(probe)).trim({ threshold: 1 }).toBuffer({ resolveWithObject: true });
  const sx = vbW / N, sy = vbH / H;
  console.log('MARK_BBOX = ' + JSON.stringify({
    x: Number((-info.trimOffsetLeft * sx).toFixed(2)),
    y: Number((-info.trimOffsetTop * sy).toFixed(2)),
    w: Number((info.width * sx).toFixed(2)),
    h: Number((info.height * sy).toFixed(2)),
  }));
  process.exit(0);
}

const png = (svg, size) =>
  sharp(Buffer.from(svg)).resize(size, size, { fit: 'contain' }).png({ compressionLevel: 9 }).toBuffer();

/** Multi-size .ico with PNG payloads (supported since Windows Vista). */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // type: icon
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = header.length + dir.length;
  images.forEach((img, i) => {
    const e = i * 16;
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, e + 0);  // width (0 = 256)
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, e + 1);  // height
    dir.writeUInt8(0, e + 2);              // palette
    dir.writeUInt8(0, e + 3);              // reserved
    dir.writeUInt16LE(1, e + 4);           // colour planes
    dir.writeUInt16LE(32, e + 6);          // bits per pixel
    dir.writeUInt32LE(img.data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += img.data.length;
  });
  return Buffer.concat([header, dir, ...images.map((i) => i.data)]);
}

const out = [];
const write = (name, buf) => { writeFileSync(join(pub, name), buf); out.push(`${name} (${buf.length} B)`); };

// No static .svg here on purpose: /brand-icon.svg serves the same tile from a
// route that reads accentColor live, so a baked copy would only drift.

write('icon-192.png', await png(buildSvg({ size: 192 }), 192));
write('icon-512.png', await png(buildSvg({ size: 512 }), 512));
// Maskable: full-bleed square, mark kept inside the 80 % safe circle.
write('icon-512-maskable.png', await png(buildSvg({ size: 512, shape: 'square', markScale: 0.5 }), 512));
// iOS applies its own rounding and dislikes alpha, so: square, no radius.
write('apple-touch-icon.png', await png(buildSvg({ size: 180, shape: 'square' }), 180));

// Google requires a favicon that is a square multiple of 48px; the smaller
// entries keep browser tabs sharp.
// iconWeights already gives each of these its own scale and stroke weight.
const ico = buildIco(await Promise.all(
  [16, 32, 48].map(async (size) => ({ size, data: await png(buildSvg({ size }), size) })),
));
write('favicon.ico', ico);

console.log(
  `Accent ${ACCENT} -> mark ${INK} on ${CREAM} (${contrast(INK, CREAM).toFixed(1)}:1). Wrote:\n  ` +
  out.join('\n  '),
);
