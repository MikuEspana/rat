// ?film: the hidden film mode (src/film/film.ts). This module is imported first by main.ts, so before any other
// module runs it swaps the page's clocks and randomness for a fixed, seeded timeline: time moves only when the film
// steps a frame, and Math.random is a seeded generator. Two renders of the same frame give the same pixels.
export const FILM = typeof location !== 'undefined' && new URLSearchParams(location.search).has('film');

let nowMs = 0;
let seed = 0x5eed_2026;
const rafQueue: FrameRequestCallback[] = [];

function mulberry32(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

if (FILM) {
  const epoch = Date.UTC(2026, 9, 1, 21, 0, 0); // a fixed night
  performance.now = () => nowMs;
  Date.now = () => epoch + nowMs;
  Math.random = mulberry32;
  window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    rafQueue.push(cb);
    return rafQueue.length;
  };
  window.cancelAnimationFrame = (): void => {};
}

/** The film's clock in ms. */
export function filmNow(): number {
  return nowMs;
}

/** Move the clock to ms and run anything that asked for an animation frame. */
export function setFilmTime(ms: number): void {
  nowMs = ms;
  const cbs = rafQueue.splice(0);
  for (const cb of cbs) cb(nowMs);
}

/** Restart the random sequence (each shot reseeds, so a shot renders the same alone or inside the film). */
export function reseed(s: number): void {
  seed = s | 0;
}
