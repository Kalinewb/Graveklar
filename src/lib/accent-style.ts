/**
 * The accent colour → CSS custom-property mixing used by the root layout.
 *
 * Extracted from `src/app/layout.tsx`, where it was module-local and reachable
 * only through `RootLayout` — a Server Component this repo cannot render in a
 * test (no jsdom), so the logic had to be re-implemented in the test file to be
 * checked at all (finding R-3). It lives here so there is exactly one copy and
 * `tests/lib/accent-style.test.ts` can import it.
 */

/**
 * The DARKEST light-theme surface the accent is ever used as text on: the page
 * background / sidebar (`--background`, `--sidebar` in globals.css). Cards are
 * white, so clearing this clears every lighter surface too.
 */
export const LIGHT_TEXT_GROUND = '#f5f0e6';

/**
 * The LIGHTEST dark-theme surface the accent is ever used as text on:
 * `--secondary` / `--muted` (#302a22) — the tinted panels the equipment picker
 * and other chips paint. It is NOT the card (#201c16): targeting the card left
 * the accent text at 4.31:1 once it composited onto the tinted surface, which
 * fails WCAG AA (Lighthouse, phase 4). Clearing the lightest dark surface
 * clears the card and the page background as well.
 */
export const DARK_TEXT_GROUND = '#302a22';

/** WCAG AA for normal-size text. */
const AA_CONTRAST = 4.5;

export function hexLuminance(hex: string): number {
  const h = hex.replace('#', '');
  if (h.length !== 6) return 0.5;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const toLinear = (c: number) => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [hexLuminance(a), hexLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The CSS custom properties a given accent hex implies, or `undefined` when the
 * accent is missing or not a 6-digit hex (the caller then renders no override
 * and globals.css keeps its own values).
 */
export function buildAccentStyle(hex: string): Record<string, string> | undefined {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return undefined;
  // Whichever of white / near-black contrasts more with the accent. The
  // previous fixed cream on the warm brown accent was 4.13:1 — under the
  // 4.5:1 AA floor, so every primary button, the "Mest populær" badge and
  // the active machine pill failed Lighthouse's contrast audit. White on the
  // same brown is 4.69:1.
  const fg = contrastRatio(hex, '#ffffff') >= contrastRatio(hex, '#1a1a1a') ? '#ffffff' : '#1a1a1a';
  // Accent used as *text*. The accent itself is tuned as a fill; as small
  // text on the beige ground it is 4.13:1, and on the tinted dark panel
  // 3.6:1 — both under AA. Darken it for the light theme and lighten it for
  // the dark one until each clears 4.5:1 against the WORST-CASE surface that
  // side can paint it on (the two grounds above); globals.css maps the pair
  // to a single --primary-text and picks the side that matches the theme.
  const channels = [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16));
  const mix = (toward: number, f: number) => '#' + channels.map((c) =>
    Math.round(c + (toward - c) * f).toString(16).padStart(2, '0')).join('');
  let textLight = hex;
  for (let f = 0; f < 0.95 && contrastRatio(textLight, LIGHT_TEXT_GROUND) < AA_CONTRAST; f += 0.02) textLight = mix(0, f);
  let textDark = hex;
  for (let f = 0; f < 0.95 && contrastRatio(textDark, DARK_TEXT_GROUND) < AA_CONTRAST; f += 0.02) textDark = mix(255, f);
  return {
    '--primary': hex,
    '--primary-text-light': textLight,
    '--primary-text-dark': textDark,
    '--primary-foreground': fg,
    '--ring': hex,
    '--chart-1': hex,
    '--sidebar-primary': hex,
    '--sidebar-primary-foreground': fg,
    '--sidebar-ring': hex,
  };
}
