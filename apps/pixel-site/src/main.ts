// RAT RACE pixel site: an isometric office floor. Rats are hired by creator fees, walk in from the subway, sit at
// their stock's desks and type. The data comes from the public API (CONTRACT.md).
import './style.css';
import { Application, Container, UPDATE_PRIORITY } from 'pixi.js';
import type { StateResponse } from '@rat/contract';
import { API_BASE, MOOD_THRESHOLD_PCT, POLL_EVENTS_MS, POLL_STATE_MS, SHOW_PERF, STRESS_RATS, STRESS_WALKERS } from './config';
import { Api } from './data/api';
import { Store } from './data/store';
import { fakeHire, padRoster } from './data/stress';
import { loadAtlas } from './gfx/atlas';
import { Camera } from './gfx/camera';
import { cellCentre } from './iso';
import { buildLayout, type FloorLayout } from './layout';
import { PerfMeter } from './perf';
import { buildWorld, updateTickers } from './world/build';
import { Effects } from './world/effects';
import { RatSystem, type Mood } from './world/rats';

const statusEl = document.getElementById('status') as HTMLDivElement;

function setStatus(text: string | null): void {
  statusEl.hidden = text === null;
  if (text !== null) statusEl.textContent = text;
}

async function retry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      setStatus(`Waiting for the API at ${API_BASE} (${what}: ${(e as Error).message}). Retrying...`);
      await new Promise((r) => setTimeout(r, Math.min(10_000, 1500 * attempt)));
    }
  }
}

function moodOf(change: number | null, paused: boolean): Mood {
  if (paused || change === null) return 'flat';
  if (change > MOOD_THRESHOLD_PCT) return 'up';
  if (change < -MOOD_THRESHOLD_PCT) return 'down';
  return 'flat';
}

export interface Site {
  store: Store;
  rats: RatSystem;
  camera: Camera;
  api: Api;
  layout: FloorLayout;
}

async function boot(): Promise<Site> {
  setStatus('Loading the floor...');
  const app = new Application();
  await app.init({
    resizeTo: window,
    background: '#dfe6ee',
    antialias: false,
    autoDensity: true,
    resolution: Math.min(2, window.devicePixelRatio || 1),
    preference: 'webgl',
  });
  document.getElementById('stage')!.appendChild(app.canvas);

  const api = new Api(API_BASE);
  const store = new Store();
  const [atlas, state, roster] = await Promise.all([loadAtlas(), retry('state', () => api.state()), retry('rats', () => api.rats())]);
  store.initState(state);
  store.loadRoster(STRESS_RATS ? padRoster(roster, state, STRESS_RATS) : roster);

  const counts = new Map<string, number>();
  for (const r of store.rats.values()) counts.set(r.facts.stock, (counts.get(r.facts.stock) ?? 0) + 1);
  const layout = buildLayout(state.stocks.map((s) => ({ symbol: s.symbol, ratCount: counts.get(s.symbol) ?? 0 })));
  const world = buildWorld(layout, atlas, store.stocks);
  const rats = new RatSystem(atlas, layout, world.main);
  rats.onSeatTaken = (symbol, index) => {
    const chair = world.chairs.get(`${symbol}:${index}`);
    if (chair) {
      world.main.remove(chair);
      world.chairs.delete(`${symbol}:${index}`);
    }
  };
  const applyMoods = (s: StateResponse): void => {
    for (const st of s.stocks) rats.setMood(st.symbol, moodOf(st.change24hPct, st.status === 'paused'));
  };
  applyMoods(state);
  rats.load([...store.rats.values()]);
  const effects = new Effects(atlas, world);

  const scene = new Container();
  scene.addChild(world.floor, world.main.container, world.overlay, world.lights, effects.container);
  app.stage.addChild(scene);

  const camera = new Camera(scene, app.canvas);
  camera.onChange = () => {
    const v = camera.view();
    world.main.setView(v.x, v.y, v.w, v.h);
  };
  const hq = cellCentre(layout.furnace.i, layout.furnace.j);
  camera.centerOn(hq.x, hq.y + 60, window.innerWidth < 700 ? 0.6 : 0.9);
  window.addEventListener('resize', () => camera.apply());

  store.on((e) => {
    if (e.kind === 'hire') rats.hire(e.rat);
    else if (e.kind === 'freeze' || e.kind === 'unfreeze' || e.kind === 'tiers') rats.refresh(e.ratIds);
    else if (e.kind === 'burn') effects.burn(e.event.data.solSpent, rats.sample(12));
    else if (e.kind === 'state') {
      updateTickers(world, store.stocks);
      applyMoods(e.state);
    }
  });

  const perf = new PerfMeter(SHOW_PERF);
  app.ticker.add((t) => {
    const t0 = performance.now();
    const dt = Math.min(0.1, t.deltaMS / 1000);
    rats.update(dt);
    effects.update(dt);
    world.main.sync();
    frameStart = t0;
    jsMs = performance.now() - t0;
  });
  // after Pixi has rendered (UTILITY runs after the LOW-priority render): CPU time of the whole frame
  let frameStart = 0;
  let jsMs = 0;
  app.ticker.add(
    () => perf.frame(jsMs, performance.now() - frameStart, `${rats.count} rats, ${rats.walking} walking | particles ${world.main.visibleCount}/${world.main.size}`),
    undefined,
    UPDATE_PRIORITY.UTILITY,
  );

  // follow the API: /api/state and /api/events every 5 s. The roster is never re-polled.
  const pollState = async (): Promise<void> => {
    try {
      store.applyState(await api.state());
      setStatus(null);
    } catch (e) {
      setStatus(`API unreachable at ${API_BASE}: ${(e as Error).message}. Retrying...`);
    }
  };
  const pollEvents = async (): Promise<void> => {
    try {
      const res = await api.events(store.lastEventId);
      store.applyEvents(res.events);
    } catch {
      /* state poll reports connectivity */
    }
  };
  setInterval(() => void pollState(), POLL_STATE_MS);
  setTimeout(() => setInterval(() => void pollEvents(), POLL_EVENTS_MS), 2500);
  void pollEvents();
  if (STRESS_WALKERS) {
    setInterval(() => {
      if (!store.state) return;
      for (let k = 0; k < STRESS_WALKERS; k++) {
        const e = fakeHire(store.state, store.lastEventId);
        if (e) store.applyEvents([e]);
      }
    }, 10_000);
  }

  setStatus(null);
  const site: Site = { store, rats, camera, api, layout };
  (window as unknown as { __site?: Site }).__site = site;
  return site;
}

void boot();
