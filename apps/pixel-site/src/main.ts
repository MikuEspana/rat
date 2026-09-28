// RAT RACE pixel site: an idle game at night. The company grows with its rat count, from a garage startup to an
// evil empire (floor/plan.ts, floor/growth.ts). Rats are hired by creator fees, walk in from the subway, sit at
// their stock's desks and type, and wander off for coffee. The data comes from the public API (CONTRACT.md), or
// from the in-browser launch simulator (sim/, `?sim` or the static demo build) through the same interface.
import './style.css';
import { Application, Container, UPDATE_PRIORITY } from 'pixi.js';
import type { StateResponse } from '@rat/contract';
import {
  API_BASE, DEBUG_MAX_RATS, DEBUG_RATS, MOOD_THRESHOLD_PCT, POLL_EVENTS_MS, POLL_STATE_MS, SHOW_PERF, SIM, SIM_AUTOSTART, SIM_SCENARIO, SIM_SPEED, STRESS_RATS,
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
import { MoneyFx } from './world/money';
import { RatSystem, type Mood } from './world/rats';
import { Ui } from './ui/ui';
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
  money: MoneyFx;
  /** debug: rebuild the company at N rats */
  setRats?: (n: number) => void;
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
  store.loadRoster(DEBUG_RATS ? padRoster(roster, state, DEBUG_MAX_RATS) : STRESS_RATS ? padRoster(roster, state, STRESS_RATS) : roster);

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
  const money = new MoneyFx(atlas, world);
  const effects = new Effects();
  const camera = new Camera(scene, app.canvas);
  const mount = (): void => {
    sky.setEvil(growth.stage >= 5);
    scene.removeChildren();
    scene.addChild(world.floor, world.main.container, world.overlay, world.lights, effects.container, world.signs, money.container, markers);
    world.setJobFair(rats.lineLength, rats.lineHead());
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
    money.setZoom(camera.zoom);
  };
  const hq = cellCentre(plan.furnace.i, plan.furnace.j);
  camera.centerOn(hq.x, hq.y + 60, window.innerWidth < 700 ? 0.6 : 0.9);
  window.addEventListener('resize', () => camera.apply());

  const ui = new Ui({ store, rats, camera, atlas, markerLayer: markers, simulated: sim !== null });
  ui.setStage(STAGES[growth.stage]!.name, ratCount);

  /** Simulator: glide out to show the whole building when it grows into a new stage. */
  const frameBuilding = (): void => {
    const r = plan.rings[growth.stage]!;
    const pts = [cellCentre(r.i0, r.j0), cellCentre(r.i1, r.j0), cellCentre(r.i0, r.j1), cellCentre(r.i1, r.j1)];
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const w = Math.max(...xs) - Math.min(...xs) + 160;
    const h = Math.max(...ys) - Math.min(...ys) + 220;
    const small = window.innerWidth < 900;
    const zoom = Math.min(1.4, window.innerWidth / w, (window.innerHeight - (small ? 330 : 190)) / h);
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const cy = (Math.max(...ys) + Math.min(...ys)) / 2 - 40;
    camera.flyTo(cx, cy + (small ? 40 : 0) / zoom, zoom, 1200);
  };

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
    money.setWorld(world);
    mount();
    old.destroy();
    applyMoods(store.state ?? state);
    if (!announce) return;
    const lines = events.map(buildLine);
    ui.pushLocal(lines.slice(-12));
    const stage = events.filter((e) => e.kind === 'stage').pop();
    if (stage && stage.kind === 'stage') {
      ui.milestone(STAGES[stage.stage]!.name, `${ratCount.toLocaleString('en-US')} rats and growing`);
      if (sim) frameBuilding();
    }
    ui.setStage(STAGES[growth.stage]!.name, ratCount);
  };

  /**
   * The job-fair line outside: applicants (claimed salaries whose buy has not confirmed yet) and, once the building
   * is full, hired rats waiting for a desk. Its sign, the HUD stat, and a feed line when the building fills or
   * empties out.
   */
  let seatlessWas = rats.seatlessCount;
  const updateLine = (): void => {
    world.setJobFair(rats.lineLength, rats.lineHead());
    ui.setLine(rats.lineLength);
    const n = rats.seatlessCount;
    if (n > 0 && seatlessWas === 0) ui.pushLocal([{ tag: 'LINE', text: 'Every desk is taken: new hires wait in the line outside the lobby, job-fair style, for the next desk.' }]);
    else if (n === 0 && seatlessWas > 0) ui.pushLocal([{ tag: 'LINE', text: 'Every hire in line has a desk again.' }]);
    seatlessWas = n;
  };

  // Money you can see: every claim sends applicants into the line and bills into the Vault; every confirmed hire
  // pulls an applicant in and sends its stock's value into the Vault. Display only, from the same API data.
  let salarySol = 0.03;
  /** stock value one SOL of salary buys (what lands in the Vault), from the latest hire */
  let usdPerSol = 0;
  const knownCosts = [...store.rats.values()].map((r) => r.facts.costUsd).filter((c) => c > 0).sort((a, b) => a - b);
  if (knownCosts.length) usdPerSol = knownCosts[knownCosts.length >> 1]! / salarySol;
  let claimCarry = 0;
  const subway = (): { x: number; y: number } => {
    const sp = plan.rings[growth.stage]!.spawn;
    return cellCentre(sp.i, sp.j);
  };
  const onClaim = (amountSol: number): void => {
    if (DEBUG_RATS) return;
    const sol = amountSol + claimCarry;
    const n = Math.floor(sol / salarySol + 1e-9);
    claimCarry = sol - n * salarySol;
    rats.addApplicants(n, rats.walking < MAX_WALKERS);
    const from = subway();
    money.flyIn([from, { x: from.x + 20, y: from.y }, { x: from.x - 20, y: from.y + 6 }], Math.max(4, Math.min(30, Math.round(amountSol * 8))));
    money.addValue('claim', amountSol * (usdPerSol || 150));
    updateLine();
  };
  let applicantsSynced = false;
  let driftSince: number | null = null;
  /** The line follows the API: claimed SOL not hired yet (waitingSol), one applicant per salary. */
  const syncApplicants = (s: StateResponse): void => {
    if (DEBUG_RATS) return;
    const target = Math.floor(s.treasury.waitingSol / salarySol + 1e-9);
    if (!applicantsSynced) {
      applicantsSynced = true;
      rats.setApplicants(target, false);
      updateLine();
      return;
    }
    // Claims and hires already move the line. waitingSol leaves out the salaries of a hire loop in flight (their
    // hire events are still coming), so only a gap bigger than a loop that lasts over 10 seconds is corrected.
    if (Math.abs(target - rats.applicantCount) <= 25 + target * 0.05) {
      driftSince = null;
      return;
    }
    const now = performance.now();
    driftSince ??= now;
    if (now - driftSince < 10_000) return;
    driftSince = null;
    rats.setApplicants(target, rats.walking < MAX_WALKERS);
    updateLine();
  };
  // on page load the line already holds everyone the API says is waiting
  syncApplicants(state);

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
    let value = 0;
    const desks: Array<{ x: number; y: number }> = [];
    for (const r of hires) {
      // a desk in a pod still under construction: the site clears, the desks pop in with a puff of dust
      const sid = growth.seatOfRat.get(r.facts.id);
      const pod = sid === undefined ? null : world.activatePod(sid);
      if (pod) effects.dust(pod.x, pod.y);
      rats.hire(r, rats.walking < MAX_WALKERS);
      value += r.facts.costUsd;
      const at = rats.positionOf(r.facts.id);
      if (at && desks.length < 24) desks.push({ x: at.x, y: at.y - 30 });
    }
    money.flyIn(desks, desks.length);
    money.addValue('hire', value);
    updateLine();
    ui.setStage(STAGES[growth.stage]!.name, ratCount);
  };
  store.on((e) => {
    if (e.kind === 'hire') {
      if (DEBUG_RATS) return; // the debug slider sets the rat count
      ratCount++;
      batchGrowth.push(...growth.add(e.rat.facts.id, e.rat.facts.stock).events);
      batchHires.push(e.rat);
      if (e.event.data.salarySol > 0) {
        salarySol = e.event.data.salarySol;
        if (e.event.data.costUsd > 0) usdPerSol = e.event.data.costUsd / salarySol;
      }
    } else if (e.kind === 'claim') onClaim(e.event.data.amountSol);
    else if (e.kind === 'feed') flushHires();
    else if (e.kind === 'freeze' || e.kind === 'unfreeze' || e.kind === 'tiers') rats.refresh(e.ratIds);
    else if (e.kind === 'state') {
      updateTickers(world, store.stocks);
      applyMoods(e.state);
      syncApplicants(e.state);
    }
  });

  const perf = new PerfMeter(SHOW_PERF);
  let frameStart = 0;
  let jsMs = 0;
  app.ticker.add((t) => {
    const t0 = performance.now();
    const dt = Math.min(0.1, t.deltaMS / 1000);
    rats.update(dt);
    world.update(dt);
    money.update(dt);
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
  const site: Site = { store, rats, camera, api, layout: plan, growth, ui, money };
  if (sim) {
    site.sim = sim;
    site.simPanel = new SimPanel({
      sim,
      ui,
      speed: SIM_SPEED,
      autostart: SIM_AUTOSTART,
      stage: () => STAGES[growth.stage]!.name,
      line: () => rats.lineLength,
      onLaunch: frameBuilding,
    });
  }

  // debug: ?rats=N shows the company at N rats, with a slider to scrub through the stages
  if (DEBUG_RATS) {
    site.setRats = (n: number): void => {
      const before = new Set(plan.rooms.filter((r) => growth.isBuilt(r)).map((r) => r.id));
      const beforeStage = growth.stage;
      ratCount = Math.max(1, Math.min(DEBUG_MAX_RATS, Math.round(n)));
      recs = replay(ratCount);
      const popIn = new Set(plan.rooms.filter((r) => growth.isBuilt(r) && !before.has(r.id)).map((r) => r.id));
      const old = world;
      world = buildWorld(plan, growth, atlas, store.stocks, popIn.size < 60 ? popIn : new Set());
      rats = new RatSystem(atlas, plan, growth, world.main, world.blocked);
      wireRats();
      applyMoods(store.state ?? state);
      rats.load(recs);
      ui.setRats(rats);
      site.rats = rats;
      site.growth = growth;
      mount();
      old.destroy();
      ui.setStage(STAGES[growth.stage]!.name, ratCount);
      if (growth.stage > beforeStage) ui.milestone(STAGES[growth.stage]!.name, `${ratCount.toLocaleString('en-US')} rats`);
      if (popIn.size < 60) {
        for (const id of [...popIn].slice(0, 16)) {
          const r = plan.rooms[id]!;
          const c = cellCentre(r.i0 + r.w / 2 - 0.5, r.j0 + r.h / 2 - 0.5);
          effects.dust(c.x, c.y, 20);
        }
      }
      if (popIn.size) ui.pushLocal([...popIn].slice(0, 12).map((id) => buildLine({ kind: 'room', room: plan.rooms[id]!, symbol: growth.symbolOf[id] ?? null })));
      history.replaceState(null, '', `?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(location.search)), rats: String(ratCount) })}`);
    };
    ui.debugSlider(ratCount, (n) => site.setRats!(n), STAGES.map((s) => Math.max(1, s.min)).concat(5000, DEBUG_MAX_RATS));
  }
  (window as unknown as { __site?: Site }).__site = site;
  return site;
}

void boot();
