import type { CSSProperties, ReactNode } from 'react';
import React from 'react';
import Image from 'next/image';

// Equipment image presentation: the photo is letterboxed inside a styled
// background frame. The vignette effect renders in the frame area around
// the photo. Photo size is controlled per-equipment via the Machine's
// `photoScale` field, not by a global setting.

export interface EquipmentImageEffects {
  bgColor?: string;
  accentColor?: string;
  vignette?: number;
}

export function equipmentContainerStyle(effects: EquipmentImageEffects): CSSProperties {
  const color = effects.bgColor?.trim();
  if (!color) return {};
  return {
    backgroundColor: color,
    backgroundImage: [
      'radial-gradient(circle at 50% 25%, rgba(255,255,255,0.28), transparent 60%)',
      'radial-gradient(circle at 50% 100%, rgba(0,0,0,0.20), transparent 70%)',
    ].join(','),
  };
}

export function EquipmentEffectLayers({
  effects,
}: {
  effects: EquipmentImageEffects;
  rounded?: string;
}): ReactNode {
  const layers: ReactNode[] = [];

  const vignette = clamp(effects.vignette);
  if (vignette > 0) {
    layers.push(
      <div
        key="vignette"
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse at center, transparent 38%, rgba(0,0,0,0.85) 100%)',
          opacity: vignette / 100,
        }}
        aria-hidden
      />
    );
  }

  return <>{layers}</>;
}

function clamp(v: number | undefined): number {
  if (v == null || Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

export function equipmentEffectsFromConfig(
  appConfig: Record<string, string>
): EquipmentImageEffects {
  return {
    bgColor: appConfig['equipmentBgColor'] || '',
    accentColor: appConfig['accentColor'] || '',
    // `imgVignette` was removed from the settings as a niche knob (see
    // app-config-defaults.ts); the read here outlived it and pinned the
    // vignette at 0 with no control to change it (P-12). Callers that want a
    // vignette pass it explicitly.
  };
}

/**
 * Framed equipment photo. `photoScale` (0-100, default 50) is per-equipment
 * and controls how much of the frame the photo occupies — 0 leaves a wide
 * frame visible around it, 100 fills the container.
 */
export function FramedEquipmentImage({
  src,
  alt,
  effects,
  photoScale,
  containerClassName = '',
  rounded = 'rounded-2xl',
  innerRounded = 'rounded-xl',
}: {
  src: string;
  alt: string;
  effects: EquipmentImageEffects;
  photoScale?: number | null;
  containerClassName?: string;
  rounded?: string;
  innerRounded?: string;
}): ReactNode {
  const scale = photoScale == null ? 50 : Math.max(0, Math.min(200, photoScale));
  // Linear: 0 → 20% padding, 100 → 0% padding, >100 → negative padding so
  // the photo extends past the frame (clipped by overflow-hidden).
  const framePct = 20 - scale * 0.2;

  return (
    <div
      className={`relative overflow-hidden shadow-lg ${rounded} ${containerClassName}`}
      style={equipmentContainerStyle(effects)}
    >
      <EquipmentEffectLayers effects={effects} />
      <div
        className="absolute inset-0 z-10"
        style={{ padding: `${framePct}%` }}
      >
        {/* Inner box so `fill` measures the padded area, not the frame.
            An absolutely positioned child of the padded div would span its
            padding box and paint over the frame margin. next/image serves
            the upload resized to what `sizes` says is actually shown — the
            800px machine PNG was going out at full size for a 310px slot —
            and its own width/height reservation removes the layout shift
            an unsized <img> risks. */}
        <div className="relative w-full h-full">
          <Image
            src={src}
            alt={alt}
            fill
            sizes="(min-width: 1024px) 32vw, 85vw"
            className={`object-contain ${innerRounded}`}
            style={{ filter: 'drop-shadow(0 6px 14px rgba(0,0,0,0.25))' }}
          />
        </div>
      </div>
    </div>
  );
}
