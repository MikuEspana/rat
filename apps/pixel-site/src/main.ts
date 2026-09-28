// RAT RACE pixel site: an idle game at night. The company grows with its rat count, from a garage startup to an
// evil empire (floor/plan.ts, floor/growth.ts). Rats are hired by creator fees, walk in from the subway, sit at
// their stock's desks and type, and wander off for coffee. The data comes from the public API (CONTRACT.md), or
// from the in-browser launch simulator (sim/, `?sim` or the static demo build) through the same interface.
import './style.css';
import { Application, Container, Text, UPDATE_PRIORITY } from 'pixi.js';
import type { StateResponse } from '@rat/contract';
import {
  API_BASE, DEBUG_RATS, MOOD_THRESHOLD_PCT, POLL_EVENTS_MS, POLL_STATE_MS, SHOW_PERF, SIM, SIM_AUTOSTART, SIM_SCENARIO, SIM_SPEED, STRESS_RATS,
  STRESS_WALKERS,
} from './config';
import { Api, type ApiLike } from './data/api';
import { Store, type RatRecord } from './data/store';
import { fakeHire, padRoster } from './data/stress';
import { loadAtlas } from './gfx/atlas';
import { Camera } from './gfx/camera';
import { Sky } from './gfx/sky';
import { cellCentre } from './iso';
import { Growth, type GrowthEvent } from './floor/growth';
import { buildMaster, ROOM_LOOK, STAGES } from './floor/plan';
import type { FloorLayout } from './floor/types';
import { PerfMeter } from './perf';
import { buildWorld, updateTickers, type World } from './world/build';
import { Effects } from './world/effects';
import { RatSystem, type Mood } from './world/rats';
import { Ui } from './ui/ui';
import { sound } from './ui/sound';
import type { NewsStats } from './ui/news';
import { pct, tokens, usd } from './ui/format';
import { setNowSource } from './now';
import { LaunchSim } from './sim/engine';
import { SimPanel } from './sim/panel';
import { SimApi } from './sim/sim-api';
import { SCENARIOS, type ScenarioId } from './sim/scenarios';

/** At most this many rats walk in at once; later hires in a burst (a fast simulation) appear at their desks. */
const MAX_WALKERS = 80;

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
  api: ApiLike;
  layout: FloorLayout;
  growth: Growth;
  ui: Ui;
  /** debug: rebuild the company at N rats */
  setRats?: (n: number) => void;
  /** the establishing shot for the current stage */
  compose?: () => { x: number; y: number; zoom: number };
  /** the launch simulator, when it replaces the API */
  sim?: LaunchSim;
  simPanel?: SimPanel;
}

/** Feed line for something that got built. */
function buildLine(e: GrowthEvent): { tag: string; text: string } {
  if (e.kind === 'stage') {
    const name = STAGES[e.stage]!.name.toLowerCase();
    return { tag: 'STAGE', text: `The company is now ${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name}` };
  }
  const r = e.room;
  if (r.kind === 'stock') return { tag: 'BUILD', text: e.symbol ? `New desk room for ${e.symbol}` : 'New desk room' };
  if (r.kind === 'open') return { tag: 'BUILD', text: 'New open-plan office' };
  return { tag: 'BUILD', text: `${ROOM_LOOK[r.kind].label.charAt(0)}${ROOM_LOOK[r.kind].label.slice(1).toLowerCase()} built` };
}

async function boot(): Promise<Site> {
  setStatus('Loading the building...');
  const app = new Application();
  await app.init({
    resizeTo: window,
    background: '#070a14',
    antialias: false,
    autoDensity: true,
    resolution: Math.min(2, window.devicePixelRatio || 1),
    preference: 'webgl',
  });
  document.getElementById('stage')!.appendChild(app.canvas);

  const sim = SIM ? new LaunchSim(SCENARIOS[(SIM_SCENARIO in SCENARIOS ? SIM_SCENARIO : 'normal') as ScenarioId]) : null;
  if (sim) setNowSource(() => sim.now());
  const api: ApiLike = sim ? new SimApi(sim) : new Api(API_BASE);
  const store = new Store();
  const [atlas, state, roster] = await Promise.all([loadAtlas(), retry('state', () => api.state()), retry('rats', () => api.rats())]);
  store.initState(state);
  store.loadRoster(DEBUG_RATS ? padRoster(roster, state, 5000) : STRESS_RATS ? padRoster(roster, state, STRESS_RATS) : roster);

  // the master plan never changes; the growth state replays the roster in hire (id) order
  const plan = buildMaster();
  const everyone = (): RatRecord[] => [...store.rats.values()].sort((a, b) => a.facts.id - b.facts.id);
  let ratCount = DEBUG_RATS || everyone().length;
  let growth = new Growth(plan);
  const replay = (n: number): RatRecord[] => {
    growth = new Growth(plan);
    const recs = everyone().slice(0, n);
    for (const r of recs) growth.add(r.facts.id, r.facts.stock);
    return recs;
  };
  let recs = replay(ratCount);

  const sky = new Sky();
  sky.resize(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', () => sky.resize(window.innerWidth, window.innerHeight));
  const scene = new Container();
  const markers = new Container();
  app.stage.addChild(sky.sprite, scene);

  let world: World = buildWorld(plan, growth, atlas, store.stocks);
  // (mount() also picks the sky for the stage)
  let rats = new RatSystem(atlas, plan, growth, world.main, world.blocked);
  const effects = new Effects(atlas, world);
  const camera = new Camera(scene, app.canvas);
  const mount = (): void => {
    sky.setEvil(growth.stage >= 5);
    scene.removeChildren();
    scene.addChild(world.backdrop, world.floor, world.under, world.main.container, world.overlay, world.lights, effects.container, world.signs, markers);
    camera.apply();
  };
  const wireRats = (): void => {
    rats.onChair = (seatId, visible) => world.setChair(seatId, visible);
  };
  wireRats();
  const applyMoods = (s: StateResponse): void => {
    for (const st of s.stocks) rats.setMood(st.symbol, moodOf(st.change24hPct, st.status === 'paused'));
  };
  applyMoods(state);
  rats.load(recs);
  mount();

  camera.onChange = () => {
    const v = camera.view();
    world.main.setView(v.x, v.y, v.w, v.h);
    world.setZoom(camera.zoom);
  };
  const hq = cellCentre(plan.furnace.i, plan.furnace.j);
  camera.centerOn(hq.x, hq.y + 60, window.innerWidth < 700 ? 0.6 : 0.9);
  window.addEventListener('resize', () => camera.apply());

  const ui = new Ui({ store, rats, camera, atlas, markerLayer: markers, simulated: sim !== null });
  ui.setStage(STAGES[growth.stage]!.name, ratCount, growth.progress());

  /** Simulator: glide out to show the whole building when it grows into a new stage. */
  /**
   * The establishing shot: the office on the lower-left thirds point, the city's tallest building (placed for this)
   * on the opposite one. Phones keep it centred (too narrow for thirds).
   */
  const composeView = (): { x: number; y: number; zoom: number } => {
    const r = plan.rings[growth.stage]!;
    const pts = [cellCentre(r.i0, r.j0), cellCentre(r.i1, r.j0), cellCentre(r.i0, r.j1), cellCentre(r.i1, r.j1)];
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const w = Math.max(...xs) - Math.min(...xs) + 120;
    const h = Math.max(...ys) - Math.min(...ys) + 160;
    const small = window.innerWidth < 900;
    const W = window.innerWidth;
    const H = window.innerHeight - (small ? 330 : 190);
    const bx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const by = (Math.max(...ys) + Math.min(...ys)) / 2 - 30;
    if (small) {
      const zoom = Math.min(1.4, W / w, H / h);
      return { x: bx, y: by + 40 / zoom, zoom };
    }
    // our tower (corporate floor on) rises behind the back corner: leave room above for it
    const tower = [0, 0, 0, 0.28, 0.5, 0.62][growth.stage]! * (r.i1 - r.i0) * 32;
    const zoom = Math.min(1.4, (W * 0.66) / w, (H * 0.7) / (h + tower * 0.6));
    return { x: bx + (W * 0.12) / zoom, y: by - (H * 0.12) / zoom - tower * 0.3 + 40 / zoom, zoom };
  };
  const frameBuilding = (): void => {
    const v = composeView();
    camera.flyTo(v.x, v.y, v.zoom, 1200);
  };

  let hold = 0;
  let recording = false;
  let missed = 0;
  /** Within 10% of the next stage the site gets ready for it. */
  const updatePrep = (): void => {
    const next = STAGES[growth.stage + 1];
    world.setPrep(!!next && ratCount >= next.min * 0.9);
  };
  updatePrep();
  /** Something got built: rebuild the world, new rooms pop in, tell the feed (and the banner on a new stage). */
  const grew = (events: GrowthEvent[], announce: boolean): void => {
    const rooms = new Set<number>();
    for (const e of events) if (e.kind === 'room') rooms.add(e.room.id);
    if (!rooms.size && !events.some((e) => e.kind === 'stage')) return;
    const old = world;
    world = buildWorld(plan, growth, atlas, store.stocks, rooms);
    if (announce) {
      for (const e of events) {
        if (e.kind !== 'room') continue;
        const c = cellCentre(e.room.i0 + e.room.w / 2 - 0.5, e.room.j0 + e.room.h / 2 - 0.5);
        effects.dust(c.x, c.y, 20);
      }
    }
    rats.rebind(world.main, world.blocked);
    wireRats();
    effects.setWorld(world);
    mount();
    old.destroy();
    applyMoods(store.state ?? state);
    updatePrep();
    if (!announce) return;
    // unlock juice: a beat of stillness, a 2 px shake, a chime (a fanfare for a new stage)
    const newStage = events.some((e) => e.kind === 'stage');
    hold = newStage ? 0.12 : 0.05;
    camera.shake(2, newStage ? 0.45 : 0.25);
    if (newStage) sound.stage();
    else sound.room();
    const lines = events.map(buildLine);
    ui.pushLocal(lines.slice(-12));
    const stage = events.filter((e) => e.kind === 'stage').pop();
    if (stage && stage.kind === 'stage') {
      ui.milestone(STAGES[stage.stage]!.name, `${ratCount.toLocaleString('en-US')} rats and growing`);
      if (sim) frameBuilding();
    }
    ui.setStage(STAGES[growth.stage]!.name, ratCount, growth.progress());
  };

  // Hires arrive in batches (one /api/events poll). The building grows once per batch, then the new rats walk in.
  let batchGrowth: GrowthEvent[] = [];
  let batchHires: RatRecord[] = [];
  const flushHires = (): void => {
    if (!batchHires.length) return;
    const events = batchGrowth;
    const hires = batchHires;
    batchGrowth = [];
    batchHires = [];
    grew(events, true);
    for (const r of hires) {
      // a desk in a pod still under construction: the site clears, the desks pop in with a puff of dust
      const sid = growth.seatOfRat.get(r.facts.id);
      const at = sid === undefined ? null : world.activatePod(sid);
      if (at) effects.dust(at.x, at.y);
      rats.hire(r, rats.walking < MAX_WALKERS);
    }
    sound.hire();
    updatePrep();
    ui.setStage(STAGES[growth.stage]!.name, ratCount, growth.progress());
  };
  store.on((e) => {
    if (e.kind === 'hire') {
      if (DEBUG_RATS) return; // the debug slider sets the rat count
      if (recording) {
        missed++; // picked up when the timelapse puts the company back
        return;
      }
      ratCount++;
      batchGrowth.push(...growth.add(e.rat.facts.id, e.rat.facts.stock).events);
      batchHires.push(e.rat);
    } else if (e.kind === 'feed') flushHires();
    else if (e.kind === 'freeze' || e.kind === 'unfreeze' || e.kind === 'tiers') rats.refresh(e.ratIds);
    else if (e.kind === 'burn') effects.burn(e.event.data.solSpent, rats.sample(12));
    else if (e.kind === 'state') {
      updateTickers(world, store.stocks);
      applyMoods(e.state);
    }
  });

  const perf = new PerfMeter(SHOW_PERF);
  let frameStart = 0;
  let jsMs = 0;
  app.ticker.add((t) => {
    const t0 = performance.now();
    const dt = Math.min(0.1, t.deltaMS / 1000);
    camera.tick(dt);
    if (hold > 0) {
      hold -= dt; // the hit-stop after an unlock: one still beat
      return;
    }
    rats.update(dt);
    world.update(dt);
    effects.update(dt);
    world.main.sync();
    frameStart = t0;
    jsMs = performance.now() - t0;
  });
  // after Pixi has rendered (UTILITY runs after the LOW-priority render): CPU time of the whole frame
  app.ticker.add(
    () => perf.frame(jsMs, performance.now() - frameStart, `${rats.count} rats, ${rats.walking} walking, ${rats.awayCount} away | ${STAGES[growth.stage]!.name} | particles ${world.main.visibleCount}/${world.main.size}`),
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
  setTimeout(() => setInterval(() => void pollEvents(), POLL_EVENTS_MS), POLL_EVENTS_MS / 2);
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
  const site: Site = { store, rats, camera, api, layout: plan, growth, ui, compose: composeView };
  if (sim) {
    site.sim = sim;
    site.simPanel = new SimPanel({
      sim,
      ui,
      speed: SIM_SPEED,
      autostart: SIM_AUTOSTART,
      stage: () => STAGES[growth.stage]!.name,
      onLaunch: frameBuilding,
    });
  }

  /** Rebuild the whole company at n rats (the debug slider and the timelapse). announce: banner, sounds, dust. */
  const rebuildAt = (n: number, announce: boolean): void => {
    const before = new Set(plan.rooms.filter((r) => growth.isBuilt(r)).map((r) => r.id));
    const beforeStage = growth.stage;
    ratCount = Math.max(1, Math.min(Math.max(5000, everyone().length), Math.round(n)));
    recs = replay(ratCount);
    const popIn = new Set(plan.rooms.filter((r) => growth.isBuilt(r) && !before.has(r.id)).map((r) => r.id));
    const old = world;
    world = buildWorld(plan, growth, atlas, store.stocks, announce && popIn.size < 60 ? popIn : new Set());
    rats = new RatSystem(atlas, plan, growth, world.main, world.blocked);
    wireRats();
    applyMoods(store.state ?? state);
    rats.load(recs);
    effects.setWorld(world);
    ui.setRats(rats);
    site.rats = rats;
    site.growth = growth;
    mount();
    old.destroy();
    ui.setStage(STAGES[growth.stage]!.name, ratCount, growth.progress());
    updatePrep();
    if (!announce) return;
    if (growth.stage > beforeStage) {
      ui.milestone(STAGES[growth.stage]!.name, `${ratCount.toLocaleString('en-US')} rats`);
      sound.stage();
      camera.shake(2, 0.45);
    } else if (popIn.size) sound.room();
    if (popIn.size < 60) {
      for (const id of [...popIn].slice(0, 16)) {
        const r = plan.rooms[id]!;
        const c = cellCentre(r.i0 + r.w / 2 - 0.5, r.j0 + r.h / 2 - 0.5);
        effects.dust(c.x, c.y, 20);
      }
    }
    if (popIn.size) ui.pushLocal([...popIn].slice(0, 12).map((id) => buildLine({ kind: 'room', room: plan.rooms[id]!, symbol: growth.symbolOf[id] ?? null })));
  };

  // the news ticker: headlines from the live numbers, the voice darkens with the stage
  const newsStats = (): NewsStats => {
    const st = store.state;
    const stocks = [...store.stocks.values()];
    const top = [...stocks].sort((a, b) => b.ratCount - a.ratCount)[0];
    const worst = [...stocks].filter((x) => x.change24hPct !== null).sort((a, b) => a.change24hPct! - b.change24hPct!)[0];
    let best: RatRecord | null = null;
    for (const r of store.rats.values()) if (!best || r.view.pnlPct > best.view.pnlPct) best = r;
    return {
      stage: growth.stage,
      rats: ratCount,
      frozen: st?.portfolio.frozenCount ?? 0,
      burned: st ? tokens(st.coin.burnedTokens) : '0',
      fund: st ? usd(st.portfolio.valueUsd) : '$0',
      mcap: st?.coin.marketCapUsd != null ? usd(st.coin.marketCapUsd) : 'PRE-LAUNCH',
      price: st?.coin.priceUsd != null ? `$${st.coin.priceUsd}` : '--',
      topStock: top?.symbol ?? 'NOBODY',
      topRats: top?.ratCount ?? 0,
      worstStock: worst?.symbol ?? 'EVERYONE',
      worstPct: worst?.change24hPct != null ? pct(worst.change24hPct) : '--',
      bestRat: best?.view.name.toUpperCase() ?? 'A RAT',
      bestPct: best ? pct(best.view.pnlPct) : '--',
    };
  };
  let newsStage = -1;
  const refreshNews = (): void => {
    newsStage = growth.stage;
    ui.setNews(newsStats());
  };
  refreshNews();
  setInterval(refreshNews, 30_000);
  setInterval(() => {
    if (growth.stage !== newsStage) refreshNews();
  }, 2000);

  // timelapse: replay the company from its first rat to now and record it (one click, a video file for X)
  const caption = new Text({ text: '', style: { fontFamily: 'monospace', fontSize: 26, fontWeight: '700', fill: '#ffd23f', stroke: { color: '#16182c', width: 5 } } });
  caption.position.set(18, 14);
  caption.visible = false;
  app.stage.addChild(caption);
  const recBtn = document.createElement('button');
  recBtn.textContent = 'TIMELAPSE';
  recBtn.title = 'Record the building growing from its first rat to now, as a video';
  ui.tools.append(recBtn);
  recBtn.onclick = () => void timelapse();
  const timelapse = async (): Promise<void> => {
    if (recording) return;
    const canvas = app.canvas as HTMLCanvasElement;
    if (typeof canvas.captureStream !== 'function' || typeof MediaRecorder === 'undefined') {
      recBtn.textContent = 'NO RECORDER';
      return;
    }
    recording = true;
    recBtn.textContent = 'RECORDING...';
    const live = ratCount;
    const types = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
    const mime = types.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
    const rec = new MediaRecorder(canvas.captureStream(30), mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    const stopped = new Promise<void>((r) => (rec.onstop = () => r()));
    caption.visible = true;
    rec.start(250);
    const steps = 36;
    const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    for (let k = 0; k < steps; k++) {
      const n = Math.max(1, Math.round(Math.exp((Math.log(Math.max(2, live)) * k) / (steps - 1))));
      rebuildAt(n, false);
      const v = composeView();
      camera.centerOn(v.x, v.y, v.zoom);
      caption.text = `RAT RACE  ${n.toLocaleString('en-US')} RATS  ${STAGES[growth.stage]!.name}`;
      await wait(k === steps - 1 ? 1800 : 260);
    }
    rec.stop();
    await stopped;
    caption.visible = false;
    rebuildAt(live + missed, false);
    missed = 0;
    recording = false;
    recBtn.textContent = 'TIMELAPSE';
    const blob = new Blob(chunks, { type: mime || 'video/webm' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `rat-race-timelapse.${mime.includes('mp4') ? 'mp4' : 'webm'}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };

  // find my rat from a shared link: ?rat=<id> or ?wallet=<address>
  const q = new URLSearchParams(location.search);
  const deep = q.get('rat') ?? q.get('wallet');
  if (deep) {
    setTimeout(() => {
      const id = ui.find(deep);
      if (id !== null) ui.spotlight(id);
    }, 900);
  }

  // debug: ?rats=N shows the company at N rats, with a slider to scrub through the stages
  if (DEBUG_RATS) {
    site.setRats = (n: number): void => {
      rebuildAt(n, true);
      history.replaceState(null, '', `?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(location.search)), rats: String(ratCount) })}`);
    };
    ui.debugSlider(ratCount, (n) => site.setRats!(n), STAGES.map((s) => Math.max(1, s.min)).concat(5000));
  }
  (window as unknown as { __site?: Site }).__site = site;
  return site;
}

void boot();
