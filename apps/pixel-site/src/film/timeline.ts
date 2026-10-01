// The film's fixed timeline: 128 BPM, 76 beats (19 bars, 35.6 s), 60 fps. Every cut, hit and caption sits on a beat.
export const BPM = 128;
export const BEAT = 60 / BPM; // 0.46875 s
export const FPS = 60;
export const TOTAL_BEATS = 76;
export const TOTAL_FRAMES = Math.round((TOTAL_BEATS * BEAT * FPS));
/** One second of handle before and after a shot rendered alone, in beats. */
export const HANDLE = 1 / BEAT;

export interface Shot {
  n: number;
  id: string;
  b0: number;
  b1: number;
}

export const SHOTS: Shot[] = [
  { n: 1, id: 'hook', b0: 0, b1: 8 },
  { n: 2, id: 'suit-up', b0: 8, b1: 12 },
  { n: 3, id: 'clock-in', b0: 12, b1: 20 },
  { n: 4, id: 'the-team', b0: 20, b1: 28 },
  { n: 5, id: 'the-fund', b0: 28, b1: 40 },
  { n: 6, id: 'expansion', b0: 40, b1: 56 },
  { n: 7, id: 'proof', b0: 56, b1: 64 },
  { n: 8, id: 'end-card', b0: 64, b1: 76 },
];

export interface Caption {
  b0: number;
  b1: number;
  /** one line for 16:9 */
  wide: string;
  /** up to two lines for 9:16 */
  tall: string[];
  at: 'top' | 'bottom';
}

export const CAPTIONS: Caption[] = [
  { b0: 4, b1: 8, wide: 'EVERY FEE HIRES AN INU', tall: ['EVERY FEE', 'HIRES AN INU'], at: 'bottom' },
  { b0: 16, b1: 20, wide: 'EACH INU BUYS A STOCK', tall: ['EACH INU', 'BUYS A STOCK'], at: 'bottom' },
  { b0: 32, b1: 36, wide: 'NOBODY EVER SELLS', tall: ['NOBODY', 'EVER SELLS'], at: 'bottom' },
  { b0: 60, b1: 64, wide: 'EVERY INU IS ON-CHAIN', tall: ['EVERY INU', 'IS ON-CHAIN'], at: 'bottom' },
  { b0: 72, b1: 75, wide: 'EVERY FEE HIRES AN INU', tall: ['EVERY FEE', 'HIRES AN INU'], at: 'top' },
];

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
/** 0..1 progress of b through [a, c] */
export const span = (b: number, a: number, c: number): number => clamp01((b - a) / (c - a));
export const easeInOutCubic = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
export const easeOutCubic = (x: number): number => 1 - (1 - x) ** 3;
export const easeInCubic = (x: number): number => x * x * x;
export const easeInOutQuint = (x: number): number => (x < 0.5 ? 16 * x ** 5 : 1 - (-2 * x + 2) ** 5 / 2);
export const easeOutExpo = (x: number): number => (x >= 1 ? 1 : 1 - 2 ** (-10 * x));
export const easeOutBack = (x: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
};
export const lerp = (a: number, c: number, x: number): number => a + (c - a) * x;

/** Deterministic noise in -1..1 for a frame and a channel (shake). */
export function noise(frame: number, ch: number): number {
  let h = (frame * 374761393 + ch * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (((h ^ (h >>> 16)) >>> 0) / 4294967295) * 2 - 1;
}

/** Frame index of a beat (rounded to the nearest frame). */
export const frameOf = (b: number): number => Math.round(b * BEAT * FPS);
