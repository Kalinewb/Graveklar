import { describe, expect, it } from 'vitest';

import { contrastRatio as brandContrastRatio } from '@/lib/brand-icon';
import {
  DARK_TEXT_GROUND,
  LIGHT_TEXT_GROUND,
  buildAccentStyle,
  contrastRatio,
  hexLuminance,
} from '@/lib/accent-style';

// L1 — the accent → CSS custom-property mixing behind the root layout.
//
// FIXED R-3: `buildAccentStyle`, and the `hexLuminance`/`contrastRatio`
// helpers it depends on, used to be module-local in `src/app/layout.tsx` —
// reachable only through `RootLayout`, a React Server Component this repo
// cannot render (no jsdom / @testing-library, see docs/testing.md), and
// `generateMetadata` never calls it. This file therefore had to re-implement
// the whole algorithm from a comment-pinned copy of the source. The logic now
// lives in `src/lib/accent-style.ts` and layout.tsx imports it, so there is one
// copy and the test asserts on the real thing.
//
// Every assertion is still cross-checked against `contrastRatio` from
// `@/lib/brand-icon.ts` — an independent implementation of the same WCAG
// relative-luminance formula — so the sweep is not merely re-checking the
// module's own arithmetic against itself.

/** A small deterministic HSL → hex generator so the 30-accent sweep covers a
 *  real spread of hues/lightness without needing an external colour lib. */
function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

const SWEEP_ACCENTS: string[] = [];
for (let i = 0; i < 30; i++) {
  const hue = (i * 137.5) % 360; // golden-angle spread across the wheel
  const sat = 0.35 + (i % 3) * 0.2; // 0.35 / 0.55 / 0.75
  const light = 0.3 + (i % 5) * 0.1; // 0.3 .. 0.7
  SWEEP_ACCENTS.push(hslToHex(hue, sat, light));
}

describe('buildAccentStyle (src/lib/accent-style.ts — FIXED R-3)', () => {
  it('the two contrastRatio implementations agree (sanity: the module is not grading itself)', () => {
    for (const hex of SWEEP_ACCENTS) {
      expect(contrastRatio(hex, LIGHT_TEXT_GROUND)).toBeCloseTo(brandContrastRatio(hex, LIGHT_TEXT_GROUND), 6);
      expect(contrastRatio(hex, DARK_TEXT_GROUND)).toBeCloseTo(brandContrastRatio(hex, DARK_TEXT_GROUND), 6);
    }
  });

  it('hexLuminance refuses to guess at a malformed hex', () => {
    expect(hexLuminance('#ffffff')).toBeCloseTo(1, 6);
    expect(hexLuminance('#000000')).toBeCloseTo(0, 6);
    expect(hexLuminance('#12345')).toBe(0.5); // neutral, rather than NaN
  });

  it('returns undefined for an invalid or missing accent', () => {
    expect(buildAccentStyle('')).toBeUndefined();
    expect(buildAccentStyle('not-a-hex')).toBeUndefined();
    expect(buildAccentStyle('#12345')).toBeUndefined();
  });

  it('emits every custom property the layout sets on <html>', () => {
    const style = buildAccentStyle('#986a44')!;
    expect(Object.keys(style).sort()).toEqual([
      '--chart-1',
      '--primary',
      '--primary-foreground',
      '--primary-text-dark',
      '--primary-text-light',
      '--ring',
      '--sidebar-primary',
      '--sidebar-primary-foreground',
      '--sidebar-ring',
    ]);
    expect(style['--primary']).toBe('#986a44');
    expect(style['--ring']).toBe('#986a44');
    expect(style['--chart-1']).toBe('#986a44');
  });

  it('a 30-accent sweep: both text colours clear 4.5:1 on the worst-case surface of their theme', () => {
    for (const hex of SWEEP_ACCENTS) {
      const style = buildAccentStyle(hex)!;
      expect(style, hex).toBeDefined();
      expect(brandContrastRatio(style['--primary-text-light'], LIGHT_TEXT_GROUND), `light, accent ${hex}`)
        .toBeGreaterThanOrEqual(4.5);
      expect(brandContrastRatio(style['--primary-text-dark'], DARK_TEXT_GROUND), `dark, accent ${hex}`)
        .toBeGreaterThanOrEqual(4.5);
    }
  });

  // The grounds are the WORST case each side can paint the accent text on, not
  // the page background: the dark theme's tinted panels (--secondary/--muted,
  // #302a22) are lighter than the card, and targeting the card left the brand
  // accent at 4.31:1 once it composited onto the equipment picker's surface —
  // a WCAG AA failure Lighthouse caught on the production build.
  it('the dark text colour clears AA on the TINTED dark surface, not just the card', () => {
    const style = buildAccentStyle('#986a44')!;
    expect(DARK_TEXT_GROUND).toBe('#302a22');
    expect(brandContrastRatio(style['--primary-text-dark'], '#302a22')).toBeGreaterThanOrEqual(4.5);
    // …which means it is lighter than the value the old #201c16 target gave.
    expect(hexLuminance(style['--primary-text-dark'])).toBeGreaterThan(hexLuminance('#a47c5a'));
    // Clearing the lightest dark surface clears the darker ones for free.
    expect(brandContrastRatio(style['--primary-text-dark'], '#201c16')).toBeGreaterThanOrEqual(4.5);
  });

  it('--primary-foreground picks whichever of white/near-black contrasts more with the accent', () => {
    // A very light accent should get the dark foreground; a very dark one
    // the white foreground.
    expect(buildAccentStyle('#f0f0f0')!['--primary-foreground']).toBe('#1a1a1a');
    expect(buildAccentStyle('#101010')!['--primary-foreground']).toBe('#ffffff');
  });

  it('an accent that already clears 4.5:1 on both grounds is left unmixed', () => {
    // Near-black clears 4.5:1 against the light cream ground immediately
    // (the f=0 loop never runs).
    const style = buildAccentStyle('#050505')!;
    expect(style['--primary-text-light']).toBe('#050505');
  });
});
