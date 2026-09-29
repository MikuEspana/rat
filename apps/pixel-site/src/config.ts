// Runtime configuration. The API base defaults to the mock API (pnpm mock:api on localhost:8787) and is switched
// with VITE_API_BASE at build time, or ?api=<url> in the page URL.
const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);

function num(name: string, fallback: number): number {
  const v = Number(params.get(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const API_BASE = (params.get('api') ?? import.meta.env.VITE_API_BASE ?? 'http://localhost:8787').replace(/\/$/, '');
/**
 * The in-browser launch simulator replaces the API: `?sim` in the page URL, or VITE_SIM=1 at build time (the static
 * demo, which has no server). `?api=<url>` always wins.
 */
export const SIM = !params.has('api') && (params.has('sim') || import.meta.env.VITE_SIM === '1');
export const SIM_SCENARIO = params.get('scenario') ?? 'normal';
export const SIM_SPEED = num('speed', 60);
/** start the launch right away (Reset and the scenario picker reload the page with this) */
export const SIM_AUTOSTART = params.get('autostart') === '1';
// CONTRACT.md: /api/state and /api/events every 5 s (the roster is loaded once). The simulator runs up to 300x
// faster, so the site polls it (in memory, no network) four times a second.
export const POLL_STATE_MS = SIM ? 250 : 5000;
export const POLL_EVENTS_MS = SIM ? 250 : 5000;
export const STRESS_RATS = num('stress', 0); // debug: pad the roster to this many rats
export const STRESS_WALKERS = num('walkers', 0); // debug: synthetic hires per 10 s
export const SHOW_PERF = params.has('perf');
/** debug: the most rats ?rats= can show (past about 5,800 the building is full and the rest line up outside) */
export const DEBUG_MAX_RATS = 7000;
/** debug: run the idle game at exactly this many rats (1 to DEBUG_MAX_RATS), with a slider to scrub through the stages */
export const DEBUG_RATS = params.has('rats') ? Math.max(1, Math.min(DEBUG_MAX_RATS, Math.round(num('rats', 1)))) : 0;
/**
 * debug, with ?rats= only: pin the SOL claimed that the stage goes by (?rats=800&sol=0.3). Without it the debug rat
 * count maps to the SOL that shows the stage it used to (plan.ts solForRats), so the slider still scrubs every stage.
 */
export const DEBUG_SOL = DEBUG_RATS && params.has('sol') ? Math.max(0, Number(params.get('sol')) || 0) : null;
/** Stock 24h change beyond this counts as up (cheer) or down (slump). */
export const MOOD_THRESHOLD_PCT = 0.25;
