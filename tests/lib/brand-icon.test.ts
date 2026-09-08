import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ACCENT,
  MARK_BBOX,
  TILE_GROUND,
  buildBrandIconSvg,
  buildBrandMarkSvg,
  contrastRatio,
  iconWeights,
  markColorFor,
  normalizeAccent,
} from '@/lib/brand-icon';

// L1 — src/lib/brand-icon.ts. Pure colour/geometry math behind the favicon
// and header mark: no DB, no request.

describe('normalizeAccent', () => {
  it('accepts a well-formed 6-digit hex, case-insensitive', () => {
    expect(normalizeAccent('#AbC123')).toBe('#AbC123');
  });

  it('falls back to DEFAULT_ACCENT for anything malformed', () => {
    for (const bad of [undefined, null, '', 'red', '#12345', '#1234567', '#GGGGGG', 'AbC123', '  ']) {
      expect(normalizeAccent(bad as string | undefined)).toBe(DEFAULT_ACCENT);
    }
  });

  it('trims surrounding whitespace before validating', () => {
    expect(normalizeAccent('  #AbC123  ')).toBe('#AbC123');
  });
});

describe('contrastRatio', () => {
  it('black vs white is the maximum, 21:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  it('a colour against itself is 1:1', () => {
    expect(contrastRatio('#3d5a3e', '#3d5a3e')).toBeCloseTo(1, 5);
  });

  it('is symmetric regardless of argument order', () => {
    expect(contrastRatio('#3d5a3e', '#f5f0e6')).toBeCloseTo(contrastRatio('#f5f0e6', '#3d5a3e'), 10);
  });

  it('the raw default accent against the tile ground is below the 9:1 target markColorFor aims for', () => {
    // Documents WHY markColorFor darkens it at all — the raw value on its
    // own is not yet at the target used for icon line art.
    expect(contrastRatio(DEFAULT_ACCENT, TILE_GROUND)).toBeLessThan(9);
    expect(contrastRatio(DEFAULT_ACCENT, TILE_GROUND)).toBeGreaterThan(1);
  });
});

describe('markColorFor', () => {
  it('darkens the raw accent until it clears the target contrast (default 9:1) against the tile ground', () => {
    const shade = markColorFor(DEFAULT_ACCENT);
    expect(contrastRatio(shade, TILE_GROUND)).toBeGreaterThanOrEqual(9);
  });

  it('returns the accent unscaled when it already clears the target', () => {
    // Black already clears any realistic target against a light ground.
    expect(markColorFor('#000000', TILE_GROUND, 4.5)).toBe('#000000');
  });

  it('a lower target darkens less (or not at all)', () => {
    const loose = markColorFor(DEFAULT_ACCENT, TILE_GROUND, 3);
    const strict = markColorFor(DEFAULT_ACCENT, TILE_GROUND, 15);
    // Darker means numerically smaller channel values.
    expect(parseInt(strict.slice(1), 16)).toBeLessThanOrEqual(parseInt(loose.slice(1), 16));
  });

  it('never returns something other than a 6-digit hex colour', () => {
    for (const accent of ['#3D5A3E', '#FFFFFF', '#123456', '#010101']) {
      const shade = markColorFor(accent);
      expect(shade).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe('iconWeights', () => {
  it('the three documented thresholds (16, 32, 48) and the "else" branch', () => {
    expect(iconWeights(16)).toEqual({ markScale: 0.88, stroke: 26 });
    expect(iconWeights(32)).toEqual({ markScale: 0.82, stroke: 18 });
    expect(iconWeights(48)).toEqual({ markScale: 0.78, stroke: 14 });
    expect(iconWeights(512)).toEqual({ markScale: 0.74, stroke: 10 });
  });

  it('is inclusive at each boundary (<=), not exclusive', () => {
    expect(iconWeights(16)).toEqual(iconWeights(16));
    expect(iconWeights(17)).not.toEqual(iconWeights(16)); // crosses into the next bucket
    expect(iconWeights(33)).not.toEqual(iconWeights(32));
    expect(iconWeights(49)).not.toEqual(iconWeights(48));
  });

  it('monotonically increases stroke weight as size shrinks', () => {
    expect(iconWeights(16).stroke).toBeGreaterThan(iconWeights(32).stroke);
    expect(iconWeights(32).stroke).toBeGreaterThan(iconWeights(48).stroke);
    expect(iconWeights(48).stroke).toBeGreaterThan(iconWeights(512).stroke);
  });
});

describe('buildBrandIconSvg', () => {
  it('produces parseable SVG with a 0 0 size size viewBox', () => {
    const svg = buildBrandIconSvg({ size: 32, accent: DEFAULT_ACCENT });
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="32" height="32" viewBox="0 0 32 32"/);
    expect(svg).toContain('</svg>');
    expect(svg.match(/<svg/g)).toHaveLength(1);
  });

  it('a "rounded" shape gets a rounded-rect background (rx present)', () => {
    const svg = buildBrandIconSvg({ size: 100, accent: DEFAULT_ACCENT, shape: 'rounded' });
    expect(svg).toMatch(/<rect width="100" height="100" rx="22" fill="/);
  });

  it('a "square" shape gets no rx at all', () => {
    const svg = buildBrandIconSvg({ size: 100, accent: DEFAULT_ACCENT, shape: 'square' });
    expect(svg).toMatch(/<rect width="100" height="100" fill="/);
    expect(svg).not.toContain('rx=');
  });

  it('the tile background is always TILE_GROUND, independent of the accent', () => {
    const svg = buildBrandIconSvg({ size: 48, accent: '#ff00ff' });
    expect(svg).toContain(`fill="${TILE_GROUND}"`);
  });

  it('every path is filled with the darkened accent (markColorFor), not the raw accent', () => {
    const svg = buildBrandIconSvg({ size: 32, accent: DEFAULT_ACCENT });
    const ink = markColorFor(DEFAULT_ACCENT);
    expect(svg).toContain(`fill="${ink}"`);
  });

  it('a zero stroke omits the stroke attributes entirely', () => {
    const svg = buildBrandIconSvg({ size: 32, accent: DEFAULT_ACCENT, stroke: 0 });
    expect(svg).not.toContain('stroke-width');
  });

  it('an explicit markScale/stroke override the size-derived defaults', () => {
    const withOverride = buildBrandIconSvg({ size: 32, accent: DEFAULT_ACCENT, markScale: 0.5, stroke: 3 });
    expect(withOverride).toContain('stroke-width="3"');
  });
});

describe('buildBrandMarkSvg', () => {
  it('produces parseable SVG with the MARK_BBOX as its viewBox (no tile)', () => {
    const svg = buildBrandMarkSvg(DEFAULT_ACCENT);
    const expectedOpen =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK_BBOX.x} ${MARK_BBOX.y} ${MARK_BBOX.w} ${MARK_BBOX.h}" fill="none">`;
    expect(svg.startsWith(expectedOpen)).toBe(true);
    expect(svg).toContain('</svg>');
    expect(svg.match(/<svg/g)).toHaveLength(1);
  });

  it('paths are filled with the RAW accent, no darkening (unlike the icon tile)', () => {
    const svg = buildBrandMarkSvg('#ff00ff');
    expect(svg).toContain('fill="#ff00ff"');
  });

  it('has no <rect> background — it is transparent', () => {
    const svg = buildBrandMarkSvg(DEFAULT_ACCENT);
    expect(svg).not.toContain('<rect');
  });

  it('every path element is well-formed and self-closed', () => {
    const svg = buildBrandMarkSvg(DEFAULT_ACCENT);
    const pathCount = (svg.match(/<path /g) ?? []).length;
    const closeCount = (svg.match(/\/>/g) ?? []).length;
    expect(pathCount).toBeGreaterThan(0);
    expect(closeCount).toBe(pathCount);
  });
});
