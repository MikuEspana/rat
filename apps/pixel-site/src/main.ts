// WALL STREET RATS pixel site: an idle game at night. The company grows with the SOL claimed, from a garage startup
// to Wall Street (floor/plan.ts, floor/growth.ts, floor/stage-source.ts), and its rooms, desks and landmarks with the
// rats hired. Rats are hired by creator fees, walk in from the subway, sit at
// their stock's desks and type, and wander off for coffee. The data comes from the public API (CONTRACT.md), or
// from the in-browser launch simulator (sim/, `?sim` or the static demo build) through the same interface.
import './style.css';
import { Application, Container, Text, UPDATE_PRIORITY } from 'pixi.js';
import type { StateResponse } from '@rat/contract';
import {
  API_BASE, API_CHOSEN, DEBUG_MAX_RATS, DEBUG_RATS, DEBUG_SOL, MOOD_THRESHOLD_PCT, POLL_EVENTS_MS, POLL_STATE_MS, SHOW_PERF, SIM, SIM_AUTOSTART, SIM_SCENARIO, SIM_SPEED,
  STRESS_RATS, STRESS_WALKERS,
} from './config';
import { Api, type ApiLike } from './data/api';
import { Store, type RatRecord } from './data/store';
import { fakeHire, padRoster } from './data/stress';
import { loadAtlas } from './gfx/atlas';
import { Camera } from './gfx/camera';
import { Sky } from './gfx/sky';
import { cellCentre, screenToCell } from './iso';
import { Growth, type GrowthEvent } from './floor/growth';
import { buildMaster, ROOM_LOOK, solForRats, STAGES } from './floor/plan';
import { stageSourceSol } from './floor/stage-source';
import { LANDMARKS, unlocked } from './floor/landmarks';
import { idx, type FloorLayout } from './floor/types';
import { PerfMeter } from './perf';
import { buildWorld, updateTickers, type World } from './world/build';
import { Effects } from './world/effects';
import { VaultView } from './world/vault';
import { SewerView } from './world/sewer';
import { SPAWN_STAGES, spawnStageOf } from './floor/sewer';
import { VAULT_STAGES, vaultStageOf } from './floor/vault';
import { lookKey, RatSystem, type Mood } from './world/rats';
import { solAmount, stageLine } from './ui/format';
import { Ui } from './ui/ui';
import { sound } from './ui/sound';
import type { NewsStats } from './ui/news';
import { pct, usd } from './ui/format';
import { setNowSource } from './now';
import { LaunchSim } from './sim/engine';
import { SimPanel } from './sim/panel';
import { SimApi } from './sim/sim-api';
import { SCENARIOS, type ScenarioId } from './sim/scenarios';

/** At most this many rats walk in at once; later hires in a burst (a fast simulation) appear at their desks. */
const MAX_WALKERS = 80;

const statusEl = document.getElementById('status') as HTMLDivElement;

function setStatus(text: string | null, detail = ''): void {
  statusEl.hidden = text === null;
  if (text !== null) statusEl.textContent = text;
  statusEl.title = detail;
}

async function retry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      // the public sees a calm line; the detail is in the console and on hover
      console.warn(`API ${API_BASE} (${what}): ${(e as Error).message}`);
      setStatus('Connecting to the trading floor... retrying on its own.', `${API_BASE}: ${(e as Error).message}`);
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
  /** play a landmark's reveal (debug and screenshots) */
  reveal?: (id: string) => void;
  /** where a landmark (or the annex) stands, for screenshots */
  focus?: (id: string) => { x: number; y: number; h: number } | null;
  skipReveal?: () => void;
  /** the launch simulator, when it replaces the API */
  sim?: LaunchSim;
  /** the Vault's money pile (screenshots and debugging) */
  vault?: VaultView;
  /** the sewer rats come out of */
  sewer?: SewerView;
  simPanel?: SimPanel;
  /**
   * Layout checks and screenshots: where the Vault's pile, the JOB FAIR sign and every rat drawn in the job-fair line
   * are on screen, and the roadmap panel (CSS px).
   */
  onScreen?: () => { vault: ScreenBox; sign: ScreenBox | null; line: ScreenBox[]; roadmap: ScreenBox };
}

interface ScreenBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Feed line for something that got built. */
function buildLine(e: GrowthEvent): { tag: string; text: string } {
  if (e.kind === 'stage') {
    const st = STAGES[e.stage]!;
    return { tag: 'STAGE', text: stageLine(st.name, e.stage === STAGES.length - 1, st.sol) };
  }
  const r = e.room;
  if (r.kind === 'stock') return { tag: 'BUILD', text: e.symbol ? `New desk room for ${e.symbol}` : 'New desk room' };
  if (r.kind === 'open') return { tag: 'BUILD', text: 'New open-plan office' };
  return { tag: 'BUILD', text: `${ROOM_LOOK[r.kind].label.charAt(0)}${ROOM_LOOK[r.kind].label.slice(1).toLowerCase()} built` };
}

async function boot(): Promise<Site> {
  setStatus('WALL STREET RATS: loading the building...');
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

  // the master plan never changes; the growth state opens the stages the SOL claimed has reached, then replays the
  // roster in hire (id) order. The stage goes by SOL (floor/stage-source.ts); ?rats= (debug) maps its rat count to
  // the SOL that shows its old stage, or pins ?sol=.
  const plan = buildMaster();
  const everyone = (): RatRecord[] => [...store.rats.values()].sort((a, b) => a.facts.id - b.facts.id);
  let ratCount = DEBUG_RATS || everyone().length;
  let liveSol = stageSourceSol(state.treasury, { rehearsal: API_CHOSEN });
  const solAt = (n: number): number => (DEBUG_RATS ? DEBUG_SOL ?? solForRats(n) : liveSol);
  let growth = new Growth(plan);
  const replay = (n: number, sol = solAt(n)): RatRecord[] => {
    growth = new Growth(plan);
    growth.setSol(sol);
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
  let rats = new RatSystem(atlas, plan, growth, world.main, world.blocked, world.line);
  const effects = new Effects();
  // the Vault: the money pile in the middle of the building shows the Wall Street Rats portfolio (?vault=USD pins a value)
  const vault = new VaultView(atlas, world.vault);
  const VAULT_PIN = new URLSearchParams(location.search).get('vault');
  const PNL_PIN = new URLSearchParams(location.search).get('vaultpnl');
  const vaultValue = (s: StateResponse): number => (VAULT_PIN !== null ? Number(VAULT_PIN) || 0 : s.portfolio.valueUsd);
  const vaultPnl = (s: StateResponse): number => (PNL_PIN !== null ? Number(PNL_PIN) || 0 : s.portfolio.pnlPct);
  vault.set(vaultValue(state), vaultPnl(state), false);
  // the sewer new rats come out of, in front of the lobby: it grows with the hires
  const sewer = new SewerView(atlas);
  let spawnStage = spawnStageOf(ratCount);
  sewer.attach(world.main, world.sewer, world.sewerDoor);
  const camera = new Camera(scene, app.canvas);
  // the room under the mouse shows its name whatever the zoom (zoomed out only landmarks and key rooms are named)
  let hoverId: number | null = null;
  let hoverWorld: World | null = null;
  app.canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    const box = app.canvas.getBoundingClientRect();
    const w = camera.toWorld(e.clientX - box.left, e.clientY - box.top);
    const c = screenToCell(w.x, w.y);
    const i = Math.floor(c.i);
    const j = Math.floor(c.j);
    const rid = i >= 0 && j >= 0 && i < plan.W && j < plan.H ? plan.roomOf[idx(plan.W, i, j)]! : -1;
    const id = rid >= 0 && growth.isBuilt(plan.rooms[rid]!) ? rid : null;
    if (id === hoverId && hoverWorld === world) return;
    hoverId = id;
    hoverWorld = world;
    world.hoverRoom(id);
  });
  const mount = (): void => {
    sky.setEvil(growth.stage >= 5);
    scene.removeChildren();
    scene.addChild(world.backdrop, world.floor, sewer.flat, world.under, world.main.container, world.overlay, world.lights, effects.container, vault.fx, sewer.fx, world.signs, markers);
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
    world.parallax(v.x + v.w / 2, v.y + v.h / 2);
  };
  const hq = cellCentre(plan.vault.i, plan.vault.j);
  camera.centerOn(hq.x, hq.y + 60, window.innerWidth < 700 ? 0.6 : 0.9);
  window.addEventListener('resize', () => camera.apply());

  const ui = new Ui({ store, rats, camera, atlas, markerLayer: markers, simulated: sim !== null });
  ui.vaultHit = (x, y) => vault.hit(x, y);
  // founders, lobby applicants, crews and street extras are clickable too (world is rebuilt: read it at click time)
  ui.extraHit = (x, y, z) => world.pickExtra(x, y, z);
  ui.vaultStage = (v) => VAULT_STAGES[vaultStageOf(v)]!.name;
  /** the stage chip's bars and the roadmap */
  const showStage = (): void => ui.setStage(growth.stage, ratCount, growth.sol, growth.progress());
  showStage();

  /** Simulator: glide out to show the whole building when it grows into a new stage. */
  /**
   * The establishing shot: the office on the lower-left thirds point, the city's tallest building (placed for this)
   * on the opposite one. Phones keep it centred (too narrow for thirds), in the rows the panels leave free, so the
   * Vault in the middle shows between the HUD and the feed.
   */
  const freeBand = (): { top: number; bottom: number } => {
    let top = 0;
    let bottom = window.innerHeight;
    for (const [sel, over] of [['.hud', true], ['.sim-panel', true], ['.feed', false], ['.board', false], ['.roadmap', false]] as const) {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      if (!r || r.height === 0) continue;
      if (over) top = Math.max(top, r.bottom);
      else bottom = Math.min(bottom, r.top);
    }
    return { top, bottom };
  };
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
      const band = freeBand();
      const mid = band.bottom - band.top > 60 ? (band.top + band.bottom) / 2 : window.innerHeight / 2 - 40;
      return { x: bx, y: by + (window.innerHeight / 2 - mid) / zoom, zoom };
    }
    // our tower rises behind the back corner: leave room above the building for it and its name
    const tower = world.crown ? Math.max(0, Math.min(...ys) - (world.crown.y - 60)) : 0;
    const zoom = Math.min(1.4, (W * 0.66) / w, (H * 0.7) / (h + tower));
    return { x: bx + (W * 0.12) / zoom, y: by - (H * 0.12) / zoom - tower * 0.5 + 40 / zoom, zoom };
  };
  const frameBuilding = (): void => {
    const v = composeView();
    camera.flyTo(v.x, v.y, v.zoom, 1200);
  };

  let hold = 0;
  let recording = false;
  let missed = 0;
  // landmark unlocks: one set piece per milestone. When one unlocks the world is rebuilt with it (it drops in) and
  // the camera flies to it, holds on it with a banner, then eases back. Skip it with a click or a key; it never
  // grabs the camera from a viewer who is dragging (they just get the banner).
  let landmarksOn = unlocked(ratCount);
  interface Reveal {
    title: string;
    sub: string;
    kicker: string;
    focus: () => { x: number; y: number; h: number } | null;
  }
  const landmarkReveal = (id: string): Reveal => {
    const def = LANDMARKS.find((l) => l.id === id)!;
    return { title: def.name, sub: `${def.at.toLocaleString('en-US')} rats`, kicker: 'UNLOCKED', focus: () => world.landmarkFocus(id) };
  };
  const vaultReveal = (stage: number): Reveal => ({
    title: `THE VAULT: ${VAULT_STAGES[stage]!.name}`,
    sub: `${usd(vault.value)} in the Wall Street Rats portfolio`,
    kicker: 'VAULT UPGRADE',
    focus: () => vault.focus(),
  });
  const sewerReveal = (stage: number): Reveal => ({
    title: `THE SEWER: ${SPAWN_STAGES[stage]!.name}`,
    sub: `${SPAWN_STAGES[stage]!.min.toLocaleString('en-US')} rats hired`,
    kicker: 'SPAWN UPGRADE',
    focus: () => sewer.focus(),
  });
  const reveals: Reveal[] = [];
  let revealing = false;
  let skipReveal: (() => void) | null = null;
  const revealNext = (): void => {
    const rv = reveals.shift();
    if (!rv) {
      revealing = false;
      return;
    }
    revealing = true;
    const at = rv.focus();
    const done = (): void => {
      skipReveal = null;
      setTimeout(revealNext, 400);
    };
    sound.stage();
    if (!at || camera.userBusy) {
      ui.milestone(rv.title, rv.sub, rv.kicker, 3600);
      setTimeout(done, 3600);
      return;
    }
    const back = camera.centre();
    // frame the whole set piece a little below the middle, clear of the banner and the panels
    const W = app.screen.width;
    const H = app.screen.height;
    const z = Math.max(0.3, Math.min(1.9, (H * 0.5) / at.h, (W * 0.45) / at.h));
    camera.flyTo(at.x + (W * 0.04) / z, at.y - (H * 0.09) / z, z, 1300);
    const timers: number[] = [];
    const finish = (): void => {
      timers.forEach((t) => clearTimeout(t));
      window.removeEventListener('pointerdown', finish, true);
      window.removeEventListener('keydown', finish, true);
      if (!camera.userBusy) camera.flyTo(back.x, back.y, back.zoom, 1200);
      done();
    };
    skipReveal = finish;
    timers.push(
      window.setTimeout(() => {
        ui.milestone(rv.title, rv.sub, rv.kicker, 3600);
        effects.dust(at.x, at.y + 30, 26);
        camera.shake(2, 0.3);
      }, 1300),
      window.setTimeout(finish, 1300 + 3600),
    );
    setTimeout(() => {
      window.addEventListener('pointerdown', finish, true);
      window.addEventListener('keydown', finish, true);
    }, 50);
  };
  /** Rebuild when a landmark unlocks and queue its reveal. Returns true when the world was rebuilt. */
  const checkLandmarks = (announce: boolean): boolean => {
    const now = unlocked(ratCount);
    const fresh = new Set([...now].filter((id) => !landmarksOn.has(id)));
    landmarksOn = now;
    const sewerUp = spawnStageOf(ratCount) > spawnStage;
    if (!fresh.size && !sewerUp) return false;
    const old = world;
    world = buildWorld(plan, growth, atlas, store.stocks, new Set(), announce ? fresh : new Set());
    rats.rebind(world.main, world.blocked, world.line);
    wireRats();
    vault.setAnchor(world.vault);
    sewer.attach(world.main, world.sewer, world.sewerDoor);
    mount();
    old.destroy();
    applyMoods(store.state ?? state);
    updatePrep();
    if (sewerUp) spawnStage = spawnStageOf(ratCount);
    if (announce) {
      reveals.push(...LANDMARKS.filter((l) => fresh.has(l.id)).map((l) => landmarkReveal(l.id)));
      if (sewerUp) reveals.push(sewerReveal(spawnStage));
      if (!revealing) revealNext();
    }
    return true;
  };

  /** Within 10% of the next stage's SOL the site gets ready for it. */
  const updatePrep = (): void => {
    const next = STAGES[growth.stage + 1];
    world.setPrep(!!next && growth.sol >= next.sol * 0.9);
  };
  updatePrep();
  /** Something got built: rebuild the world, new rooms pop in, tell the feed (and the banner on a new stage). */
  const grew = (events: GrowthEvent[], announce: boolean): void => {
    const rooms = new Set<number>();
    for (const e of events) if (e.kind === 'room') rooms.add(e.room.id);
    if (!rooms.size && !events.some((e) => e.kind === 'stage')) return;
    const old = world;
    const now = unlocked(ratCount);
    const fresh = new Set([...now].filter((id) => !landmarksOn.has(id)));
    landmarksOn = now;
    // a new stage: the office takes the lots next door, so what stood there is demolished first (shake, sink, dust)
    if (announce && events.some((e) => e.kind === 'stage')) {
      const r = plan.rings[growth.stage]!;
      effects.demolish(old.cityParts(r.i0 - 2, r.j0 - 2, r.i1 + 2, r.j1 + 2));
    }
    world = buildWorld(plan, growth, atlas, store.stocks, rooms, announce ? fresh : new Set());
    if (announce && fresh.size) {
      reveals.push(...LANDMARKS.filter((l) => fresh.has(l.id)).map((l) => landmarkReveal(l.id)));
      if (!revealing) setTimeout(revealNext, 900);
    }
    if (announce) {
      for (const e of events) {
        if (e.kind !== 'room') continue;
        const c = cellCentre(e.room.i0 + e.room.w / 2 - 0.5, e.room.j0 + e.room.h / 2 - 0.5);
        effects.dust(c.x, c.y, 20);
      }
    }
    rats.rebind(world.main, world.blocked, world.line);
    wireRats();
    vault.setAnchor(world.vault);
    sewer.attach(world.main, world.sewer, world.sewerDoor);
    mount();
    old.destroy();
    applyMoods(store.state ?? state);
    updatePrep();
    if (!announce) return;
    // a room that is the first of its strip opens a new wing
    const WING = ['NORTH', 'EAST', 'SOUTH', 'WEST'];
    for (const e of events) {
      if (e.kind !== 'room' || e.room.ring < 1) continue;
      const r = e.room;
      if (plan.rooms.some((x) => x.id !== r.id && x.ring === r.ring && x.strip === r.strip && growth.built[x.id])) continue;
      ui.pushLocal([{ tag: 'BUILD', text: `The ${WING[r.strip] ?? ''} wing opens: the office takes the lots next door` }]);
    }
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
      ui.milestone(STAGES[stage.stage]!.name, `${solAmount(STAGES[stage.stage]!.sol)} SOL claimed`);
      if (sim) frameBuilding();
    }
    showStage();
  };

  /** New SOL claimed (every state poll): open any stage it reached, move the stage bar and the roadmap along. */
  const updateStage = (s: StateResponse): void => {
    if (DEBUG_RATS || recording) return; // the debug slider sets the stage; a timelapse puts it back when it ends
    liveSol = stageSourceSol(s.treasury, { rehearsal: API_CHOSEN });
    const opened = growth.setSol(liveSol);
    if (opened.length) grew(opened, true);
    showStage();
    updatePrep();
  };

  /**
   * The job-fair line outside: applicants (claimed salaries whose buy has not confirmed yet) and, once the building
   * is full, hired rats waiting for a desk. Its sign, the HUD stat, and a feed line when the building fills or
   * empties out.
   */
  let seatlessWas = rats.seatlessCount;
  const updateLine = (): void => {
    world.setJobFair(rats.lineLength, rats.lineHead());
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
    // the applicants come up out of the sewer: a few per claim climb out on screen and walk round to the back of the
    // line; in a rush the rest are already standing in it
    const shown = rats.walking < MAX_WALKERS && sewer.waiting < 12 ? Math.min(n, 6) : 0;
    for (let k = 0; k < shown; k++) {
      sewer.enqueue('intern', () => {
        rats.addApplicants(1, true);
        updateLine();
      });
    }
    if (n > shown) rats.addApplicants(n - shown, false);
    const from = subway();
    vault.claim(from, amountSol * (usdPerSol || 150), Math.max(4, Math.min(30, Math.round(amountSol * 8))));
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
    for (const r of hires) {
      // a desk in a pod still under construction: the site clears, the desks pop in with a puff of dust
      const sid = growth.seatOfRat.get(r.facts.id);
      const pod = sid === undefined ? null : world.activatePod(sid);
      if (pod) effects.dust(pod.x, pod.y);
      // the applicant at the front of the job-fair line walks in; with nobody waiting, the new rat comes up out of
      // the sewer (a line of them in a burst) and walks to its desk; a long queue skips the show
      if (rats.applicantAhead) rats.hire(r, rats.walking < MAX_WALKERS);
      else if (rats.walking < MAX_WALKERS && sewer.waiting < 12) sewer.enqueue(lookKey(r), () => rats.hire(r, true));
      else rats.hire(r, false);
    }
    updateLine();
    sound.hire();
    updatePrep();
    checkLandmarks(true);
    showStage();
  };
  // every hire sends its money flying from where the rat came in into the Vault; a burst rains bills from above
  const recentHires: number[] = [];
  let lastRain = -1e9;
  const moneyIn = (usdIn: number): void => {
    const c = sewer.exit();
    vault.hire({ x: c.x, y: c.y - 16 }, usdIn);
    const now = performance.now();
    recentHires.push(now);
    while (recentHires.length && recentHires[0]! < now - 3000) recentHires.shift();
    if (recentHires.length >= 4 && now - lastRain > 4000) {
      lastRain = now;
      vault.rain(22);
    }
  };
  store.on((e) => {
    if (e.kind === 'hire') {
      moneyIn(e.rat.facts.costUsd);
      if (DEBUG_RATS) return; // the debug slider sets the rat count
      if (recording) {
        missed++; // picked up when the timelapse puts the company back
        return;
      }
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
      // the pile follows the portfolio; a new stage gets its upgrade and its reveal
      const up = vault.set(vaultValue(e.state), vaultPnl(e.state), true);
      if (up) {
        const b = vault.focus();
        effects.dust(b.x, b.y + b.h / 2 - 60, 30);
        reveals.push(vaultReveal(up.to));
        if (!revealing) revealNext();
      }
      syncApplicants(e.state);
      updateStage(e.state);
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
    vault.update(dt);
    sewer.update(dt);
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
      console.warn(`API ${API_BASE} (state): ${(e as Error).message}`);
      setStatus('Reconnecting to the trading floor... the numbers resume on their own.', `${API_BASE}: ${(e as Error).message}`);
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
  const site: Site = { store, rats, camera, api, layout: plan, growth, ui, compose: composeView, vault, sewer };
  site.reveal = (id: string): void => {
    reveals.push(id === 'vault' ? vaultReveal(Math.max(0, vault.stage)) : id === 'sewer' ? sewerReveal(spawnStage) : landmarkReveal(id));
    if (!revealing) revealNext();
  };
  site.skipReveal = (): void => skipReveal?.();
  site.focus = (id: string) => world.landmarkFocus(id);
  site.onScreen = () => {
    const at = (x: number, y: number, w: number, h: number): ScreenBox => ({ x: x * camera.zoom + camera.x, y: y * camera.zoom + camera.y, w: w * camera.zoom, h: h * camera.zoom });
    const v = vault.box();
    const panel = ui.roadmap.el.getBoundingClientRect();
    return {
      vault: at(v.x - v.w / 2, v.y - v.h, v.w, v.h),
      sign: world.jobFairBox(),
      // a rat's whole sprite frame (68 px, feet at 84%), scaled for an intern
      line: rats.linePositions().map((p) => at(p.x - 30, p.y - 50, 60, 60)),
      roadmap: { x: panel.x, y: panel.y, w: panel.width, h: panel.height },
    };
  };
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

  /**
   * Rebuild the whole company at n rats and this much SOL claimed (the debug slider and the timelapse). announce:
   * banner, sounds, dust.
   */
  const rebuildAt = (n: number, announce: boolean, sol?: number): void => {
    const before = new Set(plan.rooms.filter((r) => growth.isBuilt(r)).map((r) => r.id));
    const beforeStage = growth.stage;
    ratCount = Math.max(1, Math.min(Math.max(5000, everyone().length), Math.round(n)));
    recs = replay(ratCount, sol ?? solAt(ratCount));
    const popIn = new Set(plan.rooms.filter((r) => growth.isBuilt(r) && !before.has(r.id)).map((r) => r.id));
    const old = world;
    const nowOn = unlocked(ratCount);
    const freshOn = new Set([...nowOn].filter((id) => !landmarksOn.has(id)));
    landmarksOn = nowOn;
    spawnStage = spawnStageOf(n);
    world = buildWorld(plan, growth, atlas, store.stocks, announce && popIn.size < 60 ? popIn : new Set(), announce ? freshOn : new Set());
    rats = new RatSystem(atlas, plan, growth, world.main, world.blocked, world.line);
    wireRats();
    applyMoods(store.state ?? state);
    rats.load(recs);
    vault.setAnchor(world.vault);
    sewer.attach(world.main, world.sewer, world.sewerDoor);
    ui.setRats(rats);
    site.rats = rats;
    site.growth = growth;
    mount();
    old.destroy();
    showStage();
    updatePrep();
    if (!announce) return;
    if (growth.stage > beforeStage) {
      ui.milestone(STAGES[growth.stage]!.name, `${solAmount(STAGES[growth.stage]!.sol)} SOL claimed`);
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
    if (freshOn.size && freshOn.size <= 2) {
      reveals.push(...LANDMARKS.filter((l) => freshOn.has(l.id)).map((l) => landmarkReveal(l.id)));
      if (!revealing) setTimeout(revealNext, 700);
    }
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
      // the SOL claimed along the way is not kept: the timelapse grows it with the rats, to today's at the end
      rebuildAt(n, false, DEBUG_RATS ? undefined : (liveSol * n) / Math.max(1, live));
      const v = composeView();
      camera.centerOn(v.x, v.y, v.zoom);
      caption.text = `WALL STREET RATS  ${n.toLocaleString('en-US')} RATS  ${STAGES[growth.stage]!.name}`;
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
    a.download = `wall-street-rats-timelapse.${mime.includes('mp4') ? 'mp4' : 'webm'}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };

  // a shared link to a rat: ?rat=<id> or ?wallet=<address>
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
    ui.debugSlider(ratCount, (n) => site.setRats!(n), STAGES.map((s) => Math.max(1, s.rats)).concat(5000, DEBUG_MAX_RATS));
  }
  (window as unknown as { __site?: Site }).__site = site;
  return site;
}

void boot();
