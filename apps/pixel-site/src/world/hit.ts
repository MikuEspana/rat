// Click targets for the rats on screen: hired rats (rats.ts) and the set-dressing ones (build.ts) share one hit box.

/** On screen a rat's hit box is never smaller than this (CSS px, half width and half height). */
const MIN_HIT_HALF_W = 14;
const MIN_HIT_HALF_H = 22;

/**
 * How far a world point (x, y) is from the body of a rat drawn with its feet at (px, py) and this scale, in units
 * of its hit box: 1 or less is a hit, 0 is the middle of its body. The box covers the sprite (about 26 by 50 world
 * px at scale 1, from just under the feet to the ears) and never shrinks under MIN_HIT_HALF_* screen px at `zoom`.
 */
export function ratHit(px: number, py: number, scale: number, x: number, y: number, zoom = 1): number {
  const z = Math.max(0.05, zoom);
  const halfW = Math.max(14 * scale, MIN_HIT_HALF_W / z);
  const halfH = Math.max(27 * scale, MIN_HIT_HALF_H / z);
  const cy = py + 4 - 27 * scale;
  return Math.max(Math.abs(x - px) / halfW, Math.abs(y - cy) / halfH);
}
