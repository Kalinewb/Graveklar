import { GRAVEKLAR_MARK_PATHS } from '@/lib/graveklar-mark-paths';

export const DEFAULT_ACCENT = '#3D5A3E';
/** Brand cream — the icon tile's ground. */
export const TILE_GROUND = '#F5F0E6';

/**
 * Tight content box of the mark inside its 516×596 viewBox, in viewBox units.
 *
 * The exported artwork has ~63 units of dead space down the left, so scaling
 * by the viewBox alone leaves the mark small and visibly off-centre on a tile.
 * Measured by rasterising the mark and trimming; regenerate with
 * `node scripts/generate-icons.mjs --measure` if the artwork ever changes.
 */
export const MARK_BBOX = { x: 63.21, y: 3.1, w: 415.9, h: 581.81 };

export function normalizeAccent(raw: string | undefined | null): string {
  const v = (raw ?? '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v : DEFAULT_ACCENT;
}

const srgbToLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

function relativeLuminance(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const scaleChannels = (hex: string, factor: number) =>
  '#' + [0, 2, 4]
    .map((i) => Math.round(parseInt(hex.replace('#', '').slice(i, i + 2), 16) * factor)
      .toString(16).padStart(2, '0'))
    .join('');

/**
 * Darkest shade of `accent` that still reads as the brand colour while
 * clearing `target` contrast against `against`.
 *
 * The raw accent is a mid-tone brown: against cream it is 4.1:1, which is
 * thin for body text and hopeless for line art a few pixels wide. The first
 * icons shipped exactly that pairing and came out as a smudge.
 */
export function markColorFor(accent: string, against: string = TILE_GROUND, target = 9): string {
  for (let f = 1; f > 0.05; f -= 0.02) {
    const shade = scaleChannels(accent, f);
    if (contrastRatio(shade, against) >= target) return shade;
  }
  return '#1A1410';
}

/**
 * Weight and framing for a given rendered size.
 *
 * The mark is a traced outline drawing, not a solid silhouette, so its
 * strokes are a fraction of a pixel wide once the tile is 32px. Painting each
 * path with a matching stroke on top of its fill thickens the whole drawing
 * uniformly; small sizes need proportionally more of it to survive the
 * downsample, and a little more of the tile to fill.
 */
export function iconWeights(size: number): { markScale: number; stroke: number } {
  if (size <= 16) return { markScale: 0.88, stroke: 26 };
  if (size <= 32) return { markScale: 0.82, stroke: 18 };
  if (size <= 48) return { markScale: 0.78, stroke: 14 };
  return { markScale: 0.74, stroke: 10 };
}

type Shape = 'rounded' | 'square';

interface BuildOptions {
  /** Rendered square edge, in px. */
  size: number;
  accent: string;
  /** `rounded` for favicons and the manifest's regular icon; `square` for
   *  full-bleed maskable and Apple touch icons, which get masked by the OS. */
  shape?: Shape;
  /** Fraction of the tile the mark occupies. Maskable icons need to stay
   *  inside the 80 % safe circle, so they pass a smaller value. Defaults to
   *  the size-appropriate value from `iconWeights`. */
  markScale?: number;
  /** Stroke laid over each path's fill, in the mark's own units, to give the
   *  line art weight. Defaults to the size-appropriate value. */
  stroke?: number;
}

/**
 * The brand mark as a self-contained icon tile.
 *
 * A dark tile disappeared into dark browser chrome and read as a blob in a
 * light omnibox, and only the SVG favicon can adapt to the viewer's theme —
 * the .ico, the PNGs, the manifest icon and whatever a launcher copies are
 * each one fixed image. So the tile is the light one: a cream ground with
 * the mark in a darkened accent, which holds on chrome of either colour and
 * matches how the mark appears on the site itself.
 */
export function buildBrandIconSvg({ size, accent, shape = 'rounded', markScale, stroke }: BuildOptions): string {
  const weights = iconWeights(size);
  const fitScale = markScale ?? weights.markScale;
  const strokeWidth = stroke ?? weights.stroke;

  // Fit the mark's *content* box into `fitScale` of the tile, preserving
  // aspect, then centre it.
  const scale = (size * fitScale) / Math.max(MARK_BBOX.w, MARK_BBOX.h);
  const dx = (size - MARK_BBOX.w * scale) / 2 - MARK_BBOX.x * scale;
  const dy = (size - MARK_BBOX.h * scale) / 2 - MARK_BBOX.y * scale;

  const ink = markColorFor(accent);
  const strokeAttrs = strokeWidth
    ? ` stroke="${ink}" stroke-width="${strokeWidth}" stroke-linejoin="round" stroke-linecap="round"`
    : '';
  const paths = GRAVEKLAR_MARK_PATHS.map(
    (s) => `<path fill="${ink}"${strokeAttrs} d="${s.d}"${s.transform ? ` transform="${s.transform}"` : ''}/>`,
  ).join('');

  const radius = shape === 'rounded' ? Math.round(size * 0.22) : 0;
  const bg = `<rect width="${size}" height="${size}"${radius ? ` rx="${radius}"` : ''} fill="${TILE_GROUND}"/>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${size} ${size}" fill="none">${bg}` +
    `<g transform="translate(${dx.toFixed(2)} ${dy.toFixed(2)}) scale(${scale.toFixed(5)})">${paths}</g>` +
    `</svg>`
  );
}

/**
 * The bare mark — no tile, transparent ground, filled in the accent — for the
 * site header. Served from /brand-mark.svg so it is one cacheable request:
 * inlined, its 93 paths were 79 KB of every HTML response and the single
 * deepest DOM subtree on the page.
 */
export function buildBrandMarkSvg(accent: string): string {
  const paths = GRAVEKLAR_MARK_PATHS.map(
    (s) => `<path fill="${accent}" d="${s.d}"${s.transform ? ` transform="${s.transform}"` : ''}/>`,
  ).join('');
  const { x, y, w, h } = MARK_BBOX;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" fill="none">` +
    paths +
    `</svg>`
  );
}
