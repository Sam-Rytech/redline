// Maps a collateral ratio (%) to the needle angle on the tachometer dial.
// Angles are degrees clockwise from 12 o'clock, measured from the dial artwork.
const SCALE: ReadonlyArray<readonly [ratio: number, angle: number]> = [
  [300, -127],
  [250, -54],
  [200, 0],
  [150, 45],
  [125, 74],
  [110, 99],
  [100, 127],
];

export const LIQUIDATION_RATIO = 110;
const MIN_ANGLE = -132;
const MAX_ANGLE = 134;

export function ratioToAngle(ratio: number | null): number {
  if (ratio === null || !Number.isFinite(ratio)) return MIN_ANGLE;
  const first = SCALE[0]!;
  const last = SCALE[SCALE.length - 1]!;
  if (ratio >= first[0]) return MIN_ANGLE;
  if (ratio <= last[0]) return Math.min(MAX_ANGLE, last[1] + (last[0] - ratio) * 0.7);
  for (let i = 0; i < SCALE.length - 1; i++) {
    const [hiR, hiA] = SCALE[i]!;
    const [loR, loA] = SCALE[i + 1]!;
    if (ratio <= hiR && ratio >= loR) {
      const t = (hiR - ratio) / (hiR - loR);
      return hiA + t * (loA - hiA);
    }
  }
  return MIN_ANGLE;
}

/** Position on a straight track, 0 at 300% and 1 at 100%, spaced like the dial so both read alike. */
export function ratioToTrack(ratio: number | null): number {
  const lo = SCALE[0]![1];
  const hi = SCALE[SCALE.length - 1]![1];
  return Math.max(0, Math.min(1, (ratioToAngle(ratio) - lo) / (hi - lo)));
}

/** The shift lamp lights inside this margin above the liquidation ratio. */
export function lampLit(ratio: number | null): boolean {
  return ratio !== null && ratio < LIQUIDATION_RATIO + 15;
}

/** 0 when safe, 1 at liquidation: drives the red glow behind the object. */
export function heat(ratio: number | null): number {
  if (ratio === null) return 0;
  const t = (180 - ratio) / (180 - LIQUIDATION_RATIO);
  return Math.max(0, Math.min(1, t));
}
