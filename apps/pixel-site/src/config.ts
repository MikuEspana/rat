// Runtime configuration. The API base defaults to the mock API (pnpm mock:api on localhost:8787) and is switched
// with VITE_API_BASE at build time, or ?api=<url> in the page URL.
const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);

function num(name: string, fallback: number): number {
  const v = Number(params.get(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const API_BASE = (params.get('api') ?? import.meta.env.VITE_API_BASE ?? 'http://localhost:8787').replace(/\/$/, '');
export const POLL_STATE_MS = 5000; // CONTRACT.md: /api/state every 5 s
export const POLL_EVENTS_MS = 5000; // CONTRACT.md: /api/events every 5 s (the roster is loaded once)
export const STRESS_RATS = num('stress', 0); // debug: pad the roster to this many rats
export const STRESS_WALKERS = num('walkers', 0); // debug: synthetic hires per 10 s
export const SHOW_PERF = params.has('perf');
/** Stock 24h change beyond this counts as up (cheer) or down (slump). */
export const MOOD_THRESHOLD_PCT = 0.25;
