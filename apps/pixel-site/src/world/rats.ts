// Every rat is one Particle in the shared depth-sorted layer. Rats on the roster start at their desks (partners in
// the CEO office while it has room); a hire comes up the subway stairs and walks to a free desk of its stock.
// Seated rats type, slump when their stock is down and jump up to cheer when it is up. A few percent are always up
// and about: coffee, the water cooler, a chat, the bathroom queue, the copier, a meeting, a stroll down the
// corridor, fetching a box, a smoke outside, a nap at the desk. Frozen rats go grey and stop. Size follows tier.
// The job-fair line outside the lobby, around the block: hired rats with no desk (the building is full) at the
// front, then applicants. Every claim sends applicants (one per salary) up the subway stairs and into the line at
// once; each confirmed hire turns the applicant at the front into the new rat, who walks in to its desk (early on
// that is straight from the subway). The line moves up as they go.
import { computeRatView, type Tier } from '@rat/contract';
import { ACCESSORIES, type Accessory, type Atlas, type Frame } from '../gfx/atlas';
import { makeParticle, type LayerItem, type SortedLayer } from '../gfx/layer';
import { cellCentre, type Cell } from '../iso';
import { Paths } from '../floor/path';
import type { Growth } from '../floor/growth';
import { hash32 } from '../floor/rng';
import { queueCells } from '../floor/plan';
import type { Face, FloorLayout, Seat, Spot } from '../floor/types';
import type { RatRecord } from '../data/store';

export type Look = Tier | 'frozen';
export type Mood = 'up' | 'down' | 'flat';
type Mode = 'walk' | 'type' | 'slump' | 'cheer' | 'stand' | 'sit' | 'nap' | 'frozen';
type AnimName = 'walk_se' | 'walk_ne' | 'idle_se' | 'idle_ne' | 'type' | 'slump' | 'cheer' | 'sit_front' | 'sit_back' | 'sulk_front' | 'sulk_back';

/** at most this many applicants are drawn (the HUD counts all of them) */
export const APPLICANT_CAP = 2000;

/** A candidate waiting for its buy: no wallet or stock yet, in an intern's suit. */
function applicantRecord(id: number): RatRecord {
  const facts = {
    id,
    name: 'Applicant',
    wallet: '',
    stock: '',
    stockMint: '',
    status: 'active' as const,
    avatarSeed: '',
    hiredAt: new Date(0).toISOString(),
    hireTx: null,
    tokenAmount: '0',
    costUsd: 0,
  };
  return { facts, view: { ...computeRatView(facts, null), tier: 'intern' }, estimated: true };
}

export const TIER_SCALE: Record<Tier, number> = { intern: 0.88, analyst: 1, associate: 1.08, vp: 1.17, partner: 1.3 };
const FPS: Record<AnimName, number> = { walk_se: 10, walk_ne: 10, idle_se: 5, idle_ne: 5, type: 8, slump: 6, cheer: 11, sit_front: 4, sit_back: 4, sulk_front: 3, sulk_back: 3 };
const FURS = ['grey', 'brown', 'white', 'black'] as const;
const WALK_SPEED = 2.8; // cells per second
/** share of rats away from their desk at any moment */
const AWAY_SHARE = 0.07;

interface Trip {
  kind: 'spot' | 'stroll' | 'box' | 'move';
  spot: Spot | null;
  /** the way back (reversed way out) */
  back: Cell[];
  stay: number;
}

interface Agent {
  id: number;
  rec: RatRecord;
  item: LayerItem;
  /** accessory overlay (glasses, headphones, a hat), follows the rat frame for frame */
  acc: LayerItem | null;
  accKind: Accessory | null;
  accFrames: Frame[];
  /** fur colour from the avatar seed */
  fur: string;
  /** a coffee mug on the desk (from the avatar seed), left there while the rat is away */
  hasMug: boolean;
  mug: LayerItem | null;
  look: Look;
  mode: Mode;
  anim: AnimName;
  frames: Frame[];
  frame: number;
  t: number;
  once: boolean;
  mirror: boolean;
  seat: Seat | null;
  /** standing place for a rat without a desk */
  home: Cell;
  /** place in the job-fair line (-1: has a desk) */
  qi: number;
  pos: Cell;
  path: Cell[];
  seg: number;
  trip: Trip | null;
  phase: 'out' | 'at' | 'back' | null;
  until: number;
  box: LayerItem | null;
  nextCheer: number;
  seated: boolean;
}

function lookOf(rec: RatRecord): Look {
  return rec.facts.status === 'frozen' ? 'frozen' : rec.view.tier;
}

/** Fur and accessory from the rat's avatar seed: the same rat always looks the same. */
function styleOf(rec: RatRecord): { fur: string; acc: Accessory | null; mug: boolean } {
  const h = hash32(`look:${rec.facts.avatarSeed ?? rec.facts.id}`);
  const r = h % 10;
  const fur = FURS[r < 4 ? 0 : r < 6 ? 1 : r < 8 ? 2 : 3]!;
  const a = (h >>> 8) % 100;
  const acc = a < 40 ? null : ACCESSORIES[Math.floor(((a - 40) / 60) * ACCESSORIES.length)]!;
  return { fur, acc, mug: (h >>> 16) % 4 === 0 };
}

function faceAnim(face: Face): { anim: AnimName; mirror: boolean } {
  if (face === 'se') return { anim: 'idle_se', mirror: false };
  if (face === 'sw') return { anim: 'idle_se', mirror: true };
  if (face === 'ne') return { anim: 'idle_ne', mirror: false };
  return { anim: 'idle_ne', mirror: true };
}

export class RatSystem {
  private agents = new Map<number, Agent>();
  private list: Agent[] = [];
  private moods = new Map<string, Mood>();
  private walkers = new Set<Agent>();
  /** CEO office desks in use (partners), by seat id */
  private ceoOwner = new Map<number, number>();
  private ceoSeats: Seat[] = [];
  private spots: Spot[] = [];
  private spawn: Cell;
  private taken = new Set<number>(); // spot ids in use
  private strollCells: Cell[];
  private spotsByKind = new Map<string, Spot[]>();
  /** spots by 24-cell neighbourhood, so errands stay local */
  private spotGrid = new Map<string, Spot[]>();
  /** the job-fair line: street cells from the lobby door outwards, and the rats in it (by id) */
  private line: Cell[] = [];
  private lineAt = new Map<number, number>();
  private lineStage = -1;
  private queue: Agent[] = [];
  /** hired rats at the front of the line (the rest of it are applicants) */
  private realInLine = 0;
  /** applicants beyond APPLICANT_CAP: counted, not drawn */
  private hiddenApplicants = 0;
  private applicantSeq = 0;
  private lineDirty = false;
  private paths: Paths;
  private time = 0;
  private tripClock = 0;
  private away = 0;
  private boxFrame: Frame;
  private mugFrame: Frame;
  onArrive: (id: number) => void = () => {};
  /** show or hide the empty chair at a seat */
  onChair: (seatId: number, visible: boolean) => void = () => {};

  constructor(
    private readonly atlas: Atlas,
    private readonly layout: FloorLayout,
    private readonly growth: Growth,
    private layer: SortedLayer,
    private blocked: Uint8Array,
  ) {
    this.paths = new Paths(layout, 64, blocked);
    this.spawn = layout.rings[growth.stage]!.spawn;
    this.strollCells = [];
    this.boxFrame = atlas.frame('world:box_s');
    this.mugFrame = atlas.frame('world:mug');
    this.index();
  }

  /** What rats can use right now: spots in built rooms, the current street, built corridors, the CEO office.
   * Returns true when the job-fair line moved (a new stage). */
  private index(): boolean {
    const L = this.layout;
    const g = this.growth;
    this.spawn = L.rings[g.stage]!.spawn;
    const moved = g.stage !== this.lineStage;
    if (moved) {
      this.lineStage = g.stage;
      this.line = queueCells(L, g.stage, this.blocked);
      this.lineAt = new Map(this.line.map((c, k) => [c.j * L.W + c.i, k]));
    }
    this.ceoSeats = L.ceo.kind === 'ceo' && g.isBuilt(L.ceo) ? [...L.ceo.seats] : [];
    this.spots = L.spots.filter((s) => (s.room >= 0 ? g.built[s.room] === 1 : s.ring === g.stage));
    this.spotsByKind.clear();
    this.spotGrid.clear();
    const corridor = L.corridor.filter((c) => !this.blocked[c.j * L.W + c.i]);
    this.strollCells = [];
    for (let k = 0; k < 40 && corridor.length; k++) this.strollCells.push(corridor[hash32(`stroll:${k}`) % corridor.length]!);
    for (const s of this.spots) {
      const l = this.spotsByKind.get(s.kind) ?? [];
      l.push(s);
      this.spotsByKind.set(s.kind, l);
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          const key = `${Math.floor(s.cell.i / 24) + di},${Math.floor(s.cell.j / 24) + dj}`;
          const g = this.spotGrid.get(key) ?? [];
          g.push(s);
          this.spotGrid.set(key, g);
        }
      }
    }
    return moved;
  }

  /** The world was rebuilt (a room went up): move every rat onto the new layer and walk mask. */
  rebind(layer: SortedLayer, blocked: Uint8Array): void {
    this.layer = layer;
    this.blocked = blocked;
    this.paths = new Paths(this.layout, 64, blocked);
    const lineMoved = this.index();
    for (const a of this.list) {
      a.item = layer.add(a.item.p, this.depthOf(a));
      if (a.acc) a.acc = layer.add(a.acc.p, this.depthOf(a) + 0.002);
      if (a.mug && a.seat) a.mug = layer.add(a.mug.p, a.seat.deskAt.i + a.seat.deskAt.j + 1.02);
      if (a.box) a.box = layer.add(a.box.p, this.depthOf(a) + 0.01);
      if (a.seat && !a.seated) this.onChair(a.seat.id, true);
    }
    // rats that just got a desk in a new room walk over to it (out of the job-fair line, mostly)
    let left = 0;
    for (const id of this.growth.moved.splice(0)) {
      const a = this.agents.get(id);
      const sid = this.growth.seatOfRat.get(id);
      if (!a || sid === undefined || a.trip || (a.mode === 'walk' && a.qi < 0)) continue;
      const seat = this.layout.seats[sid]!;
      if (a.qi >= 0) {
        this.queue.splice(this.queue.indexOf(a), 1);
        this.realInLine--;
        a.qi = -1;
        left++;
      }
      const from = { i: Math.round(a.pos.i), j: Math.round(a.pos.j) };
      const route = this.paths.route(from, seat.access);
      a.seat = seat;
      a.home = seat.access;
      if (route) this.walkTo(a, [a.pos, ...route, seat.pos], { kind: 'move', spot: null, back: [], stay: 0 });
      else this.sit(a);
    }
    if (lineMoved || left) this.reflow(!lineMoved);
    layer.sync(true);
  }

  /** Everyone in the job-fair line outside: hired rats with no desk plus applicants (drawn or not). */
  get lineLength(): number {
    return this.queue.length + this.hiddenApplicants;
  }

  /** Hired rats with no desk (the building is full). */
  get seatlessCount(): number {
    return this.realInLine;
  }

  /** Applicants: claimed salaries whose buy has not confirmed yet. */
  get applicantCount(): number {
    return this.queue.length - this.realInLine + this.hiddenApplicants;
  }

  /** Adds or removes applicants (at the back of the line) until there are `n`. */
  setApplicants(n: number, walk: boolean): void {
    const diff = Math.max(0, Math.round(n)) - this.applicantCount;
    if (diff > 0) this.addApplicants(diff, walk);
    else if (diff < 0) this.removeApplicants(-diff);
  }

  /** New applicants come up the subway stairs and join the back of the line (walk false: they appear there). */
  addApplicants(n: number, walk: boolean): void {
    for (let k = 0; k < n; k++) {
      if (this.queue.length - this.realInLine >= APPLICANT_CAP) {
        this.hiddenApplicants += n - k;
        return;
      }
      this.createApplicant(walk && k < 60);
    }
  }

  /** Applicants leave from the back of the line (the ones not drawn go first). */
  removeApplicants(n: number): void {
    const hidden = Math.min(n, this.hiddenApplicants);
    this.hiddenApplicants -= hidden;
    for (let k = hidden; k < n && this.queue.length > this.realInLine; k++) this.dropAgent(this.queue.pop()!);
  }

  private createApplicant(walk: boolean): void {
    const rec = applicantRecord(-++this.applicantSeq);
    const qi = this.queue.length;
    const home = this.lineCell(qi);
    const fur = styleOf(rec).fur;
    const first = this.frames({ look: 'intern', fur }, 'idle_se')[0]!;
    const start = walk ? { ...this.spawn } : { ...home };
    const c = cellCentre(start.i, start.j);
    const item = this.layer.add(makeParticle(first, c.x, c.y, false, TIER_SCALE.intern), 0);
    const a: Agent = {
      id: rec.facts.id, rec, item, acc: null, accKind: null, accFrames: [], fur, hasMug: false, mug: null, look: 'intern', mode: 'stand', anim: 'idle_se', frames: [first], frame: 0, t: 0, once: false, mirror: false,
      seat: null, home, qi, pos: start, path: [], seg: 0, trip: null, phase: null, until: 0, box: null, nextCheer: 0, seated: false,
    };
    this.agents.set(a.id, a);
    this.list.push(a);
    this.queue.push(a);
    const back = walk ? this.paths.route(home, this.spawn) : null;
    if (back) this.walkTo(a, back.reverse(), null);
    else this.standInLine(a, false);
    this.place(a);
  }

  /** Takes a particle off the floor for good (an applicant who left the line). */
  private dropAgent(a: Agent): void {
    this.walkers.delete(a);
    this.agents.delete(a.id);
    const k = this.list.indexOf(a);
    if (k >= 0) this.list.splice(k, 1);
    this.layer.remove(a.item);
    if (a.acc) this.layer.remove(a.acc);
  }

  /** The way in for a rat standing outside: along the line to its head, to the door, then to its desk. */
  private walkIn(a: Agent, seat: Seat): void {
    const ring = this.layout.rings[this.growth.stage]!;
    const door = ring.entrance[1]!;
    const onI = ring.entrance[0]!.i === ring.i1 && door.i === ring.i1;
    const front = onI ? { i: door.i + 1, j: door.j } : { i: door.i, j: door.j + 1 };
    const here = { i: Math.round(a.pos.i), j: Math.round(a.pos.j) };
    const at = this.lineAt.get(here.j * this.layout.W + here.i);
    let outside: Cell[] | null = null;
    if (at !== undefined && at <= 60) outside = [...this.line.slice(0, at).reverse()];
    else outside = this.paths.route(here, front);
    const inside = this.paths.route(seat.access, door);
    a.seat = seat;
    a.home = seat.access;
    a.qi = -1;
    if (!outside || !inside) {
      this.sit(a);
      return;
    }
    this.walkTo(a, [a.pos, ...outside, front, ...inside.reverse(), seat.pos], null);
  }

  /** Where the line starts (by the lobby door), null while nobody is waiting. */
  lineHead(): Cell | null {
    return this.queue.length ? this.lineCell(0) : null;
  }

  /** Place p of the line (a line longer than the street doubles up from the head). */
  private lineCell(p: number): Cell {
    const n = this.line.length;
    return n ? this.line[p % n]! : { ...this.spawn };
  }

  /** Which way a rat in the line looks: at the rat in front of it, or at the door for the one at the front. */
  private lineFace(p: number): Face {
    const here = this.lineCell(p);
    const ring = this.layout.rings[this.growth.stage]!;
    const ahead = p > 0 && p < this.line.length ? this.lineCell(p - 1) : ring.entrance[1]!;
    const di = ahead.i - here.i;
    const dj = ahead.j - here.j;
    return Math.abs(di) >= Math.abs(dj) ? (di >= 0 ? 'se' : 'nw') : dj >= 0 ? 'sw' : 'ne';
  }

  /** The line moved up (someone got a desk) or moved out (a new stage): everyone takes their new place. */
  private reflow(walk: boolean): void {
    this.lineDirty = false;
    let walking = 0;
    this.queue.forEach((a, p) => {
      const cell = this.lineCell(p);
      if (a.qi === p && a.home.i === cell.i && a.home.j === cell.j) return;
      a.qi = p;
      a.home = cell;
      if (a.mode === 'walk') return; // on arrival it steps along to its new place
      this.standInLine(a, walk && walking++ < 300);
    });
  }

  /** No desk: stand in the job-fair line, stepping along it first if the line moved up meanwhile. */
  private standInLine(a: Agent, walk = true): void {
    a.seated = false;
    const here = { i: Math.round(a.pos.i), j: Math.round(a.pos.j) };
    if (here.i !== a.home.i || here.j !== a.home.j) {
      // the line moved up a few places: step along it; anything else (a new stage, a big jump) just moves over
      const from = this.lineAt.get(here.j * this.layout.W + here.i);
      const to = a.qi % Math.max(1, this.line.length);
      if (walk && a.look !== 'frozen' && from !== undefined && from > to && from - to <= 40) {
        this.walkTo(a, [a.pos, ...this.line.slice(to, from).reverse()], null);
        return;
      }
      a.pos = { ...a.home };
    }
    a.mode = a.look === 'frozen' ? 'frozen' : 'stand';
    const f = faceAnim(this.lineFace(a.qi));
    this.setAnim(a, f.anim, a.look === 'frozen', f.mirror);
    this.place(a);
  }

  get count(): number {
    return this.agents.size;
  }

  get walking(): number {
    return this.walkers.size;
  }

  get awayCount(): number {
    return this.away;
  }

  private frames(a: { look: Look; fur: string }, anim: AnimName): Frame[] {
    const key = a.look === 'frozen' || a.fur === 'grey' ? a.look : `${a.look}.${a.fur}`;
    return this.atlas.anim(`${key}/${anim}`);
  }

  private freeCeo(): Seat | null {
    for (const s of this.ceoSeats) if (!this.ceoOwner.has(s.id)) return s;
    return null;
  }

  /** Home desk from the growth state; partners take a CEO office desk while one is free. */
  private claim(rec: RatRecord): Seat | null {
    if (rec.view.tier === 'partner' && rec.facts.status !== 'frozen') {
      const s = this.freeCeo();
      if (s) {
        this.ceoOwner.set(s.id, rec.facts.id);
        return s;
      }
    }
    const sid = this.growth.seatOfRat.get(rec.facts.id);
    return sid === undefined ? null : this.layout.seats[sid]!;
  }

  private homeSeat(a: Agent): Seat | null {
    const sid = this.growth.seatOfRat.get(a.id);
    return sid === undefined ? null : this.layout.seats[sid]!;
  }

  private depthOf(a: Agent): number {
    if (a.seated && a.seat) return a.seat.pos.i + a.seat.pos.j + 1;
    return a.pos.i + a.pos.j + 1.25;
  }

  private place(a: Agent): void {
    const c = cellCentre(a.pos.i, a.pos.j);
    const s = a.seated && a.seat ? a.seat : null;
    a.item.p.x = c.x + (s ? s.dx : 0);
    a.item.p.y = c.y + (s ? s.dy : 0);
    this.layer.moved(a.item, this.depthOf(a));
    if (a.acc) {
      a.acc.p.x = a.item.p.x;
      a.acc.p.y = a.item.p.y;
      this.layer.moved(a.acc, this.depthOf(a) + 0.002);
    }
    if (a.box) {
      a.box.p.x = a.item.p.x + (a.mirror ? -5 : 5);
      a.box.p.y = a.item.p.y - 14 * TIER_SCALE[a.rec.view.tier];
      this.layer.moved(a.box, this.depthOf(a) + 0.01);
    }
  }

  private setAnim(a: Agent, anim: AnimName, once: boolean, mirror = a.mirror): void {
    a.anim = anim;
    a.frames = this.frames(a, anim);
    a.accFrames = a.accKind && a.look !== 'frozen' ? this.atlas.anim(`acc/${a.accKind}/${anim}`) : [];
    a.frame = once ? 0 : Math.floor(Math.random() * a.frames.length);
    a.t = Math.random() / FPS[anim];
    a.once = once;
    a.mirror = mirror;
    this.applyFrame(a);
  }

  private applyFrame(a: Agent): void {
    const f = a.frames[a.frame] ?? a.frames[0]!;
    const p = a.item.p;
    p.texture = f.texture;
    p.anchorX = f.anchorX;
    p.anchorY = f.anchorY;
    const s = TIER_SCALE[a.rec.view.tier];
    p.scaleX = a.mirror ? -s : s;
    p.scaleY = s;
    if (a.acc) {
      const g = a.accFrames[a.frame];
      const q = a.acc.p;
      q.alpha = g ? 1 : 0;
      if (g) {
        q.texture = g.texture;
        q.anchorX = g.anchorX;
        q.anchorY = g.anchorY;
      }
      q.scaleX = p.scaleX;
      q.scaleY = s;
    }
  }

  /** Sit down at the desk and work (or sulk, or freeze). */
  private sit(a: Agent): void {
    const seat = a.seat;
    if (!seat) {
      this.standInLine(a);
      return;
    }
    if (!a.seated) this.onChair(seat.id, false);
    a.seated = true;
    a.pos = { ...seat.pos };
    const front = seat.view === 'front';
    const mirror = front ? seat.axis === 'i' : seat.axis === 'j';
    const sit: AnimName = front ? 'sit_front' : 'sit_back';
    const sulk: AnimName = front ? 'sulk_front' : 'sulk_back';
    if (a.look === 'frozen') {
      a.mode = 'frozen';
      this.setAnim(a, sit, true, mirror);
      a.frame = 0;
      this.applyFrame(a);
    } else if (this.moods.get(a.rec.facts.stock) === 'down') {
      a.mode = 'slump';
      this.setAnim(a, sulk, false, mirror);
    } else {
      a.mode = 'type';
      this.setAnim(a, sit, false, mirror);
    }
    a.nextCheer = this.time + 3 + Math.random() * 18;
    this.place(a);
    if (a.hasMug) this.putMug(a, seat);
  }

  /** The rat's mug stands at one end of its desk. */
  private putMug(a: Agent, seat: Seat): void {
    const c = cellCentre(seat.deskAt.i, seat.deskAt.j);
    const x = c.x + (seat.axis === 'j' ? -10 : 10);
    const y = c.y + 5 - 14;
    const depth = seat.deskAt.i + seat.deskAt.j + 1.02;
    if (!a.mug) a.mug = this.layer.add(makeParticle(this.mugFrame, x, y, seat.axis === 'i', 0.32), depth);
    a.mug.p.x = x;
    a.mug.p.y = y;
    this.layer.moved(a.mug, depth);
  }

  private standUp(a: Agent): void {
    if (a.seated && a.seat) this.onChair(a.seat.id, true);
    a.seated = false;
  }

  /** Rats on the roster at page load: straight to their desks. Partners first, so they get the corner office. */
  load(recs: RatRecord[]): void {
    const sorted = [...recs].sort((x, y) => (x.view.tier === 'partner' ? 0 : 1) - (y.view.tier === 'partner' ? 0 : 1) || x.facts.id - y.facts.id);
    for (const rec of sorted) this.create(rec, false);
    // the line goes by hire order (partners were placed first)
    this.queue.sort((x, y) => x.id - y.id);
    this.realInLine = this.queue.length;
    this.reflow(false);
    this.layer.sync(true);
  }

  /**
   * A confirmed hire. The applicant at the front of the line becomes this rat: it walks in to its desk (or, with
   * the building full, keeps its place in line). With no applicant waiting it comes up the subway stairs.
   * walk false: it appears at its desk.
   */
  hire(rec: RatRecord, walk = true): void {
    if (this.agents.has(rec.facts.id)) return;
    const app = this.queue[this.realInLine];
    if (!app || app.id >= 0) {
      if (this.hiddenApplicants > 0) this.hiddenApplicants--;
      this.create(rec, walk);
      return;
    }
    // the applicant becomes the rat, in place
    this.agents.delete(app.id);
    app.id = rec.facts.id;
    app.rec = rec;
    app.look = lookOf(rec);
    // and gets its own looks: fur, accessory, mug
    const style = styleOf(rec);
    app.fur = style.fur;
    app.hasMug = style.mug;
    app.accKind = style.acc;
    if (style.acc && !app.acc) app.acc = this.layer.add(makeParticle(app.frames[0]!, app.item.p.x, app.item.p.y, false, TIER_SCALE[rec.view.tier]), this.depthOf(app) + 0.002);
    this.agents.set(app.id, app);
    if (this.hiddenApplicants > 0) {
      // one more applicant steps into view at the back
      this.hiddenApplicants--;
      this.createApplicant(false);
    }
    const seat = this.claim(rec);
    if (!seat) {
      // the building is full: a hired rat in line, right where it stands
      this.realInLine++;
      this.setAnim(app, app.anim, false, app.mirror);
      return;
    }
    this.queue.splice(this.realInLine, 1);
    this.lineDirty = true;
    if (walk) this.walkIn(app, seat);
    else {
      this.walkers.delete(app);
      app.seat = seat;
      app.home = seat.access;
      app.qi = -1;
      app.path = [];
      this.sit(app);
    }
  }

  private create(rec: RatRecord, walk: boolean): void {
    const seat = this.claim(rec);
    const qi = seat ? -1 : this.realInLine;
    const home = seat ? seat.pos : this.lineCell(qi);
    const look = lookOf(rec);
    const style = styleOf(rec);
    const first = this.frames({ look, fur: style.fur }, 'idle_se')[0]!;
    const start = walk ? { ...this.spawn } : { ...home };
    const c = cellCentre(start.i, start.j);
    const item = this.layer.add(makeParticle(first, c.x, c.y, false, TIER_SCALE[rec.view.tier]), 0);
    const acc = style.acc ? this.layer.add(makeParticle(first, c.x, c.y, false, TIER_SCALE[rec.view.tier]), 0.001) : null;
    const a: Agent = {
      id: rec.facts.id, rec, item, acc, accKind: style.acc, accFrames: [], fur: style.fur, hasMug: style.mug, mug: null, look, mode: 'type', anim: 'type', frames: [first], frame: 0, t: 0, once: false, mirror: false,
      seat, home: seat ? seat.access : home, qi, pos: start, path: [], seg: 0, trip: null, phase: null, until: 0, box: null,
      nextCheer: 0, seated: false,
    };
    this.agents.set(a.id, a);
    this.list.push(a);
    if (!seat) {
      // hired rats with no desk stand at the front of the line, ahead of the applicants
      this.queue.splice(this.realInLine, 0, a);
      this.realInLine++;
      this.lineDirty = true;
    }
    if (walk) {
      const target = seat ? seat.access : home;
      const back = this.paths.route(target, this.spawn);
      const route = back ? back.reverse() : [start, target];
      this.walkTo(a, seat ? [...route, seat.pos] : route, null);
    } else {
      this.sit(a);
    }
    this.place(a);
  }

  private walkTo(a: Agent, path: Cell[], trip: Trip | null): void {
    this.standUp(a);
    a.path = path;
    a.seg = 1;
    a.mode = 'walk';
    a.trip = trip;
    this.walkers.add(a);
    this.setAnim(a, 'walk_se', false, false);
  }

  setMood(symbol: string, mood: Mood): void {
    if (this.moods.get(symbol) === mood) return;
    this.moods.set(symbol, mood);
    for (const a of this.list) {
      if (a.rec.facts.stock === symbol && a.seated && (a.mode === 'type' || a.mode === 'slump')) this.sit(a);
    }
  }

  /** Tier or frozen status changed: new suit, new size, maybe a new office. */
  refresh(ids: number[]): void {
    for (const id of ids) {
      const a = this.agents.get(id);
      if (!a) continue;
      const look = lookOf(a.rec);
      const changed = look !== a.look;
      a.look = look;
      if (look === 'frozen') {
        if (a.mode === 'walk') this.walkers.delete(a);
        if (a.phase !== null) this.away--;
        if (a.trip?.spot) this.taken.delete(a.trip.spot.id);
        a.trip = null;
        a.phase = null;
        this.dropBox(a);
        if (a.seated) this.sit(a);
        else {
          a.mode = 'frozen';
          this.setAnim(a, 'idle_se', true, a.mirror);
        }
        continue;
      }
      if (a.mode === 'frozen' && a.qi >= 0) {
        // thawed in the line: back to waiting
        this.standInLine(a, false);
        continue;
      }
      if (a.mode === 'frozen' && !a.seated && a.seat) {
        // thawed away from the desk: walk back
        const here = { i: Math.round(a.pos.i), j: Math.round(a.pos.j) };
        const route = this.paths.route(here, a.seat.access);
        if (route) {
          this.walkTo(a, [a.pos, ...route, a.seat.pos], null);
          continue;
        }
      }
      if (a.seated) {
        if (!this.relocate(a)) this.sit(a);
      } else if (changed || a.mode !== 'walk') this.applyFrame(a);
      else this.setAnim(a, a.anim, false);
    }
  }

  /** Promoted to partner: move into the corner office if a desk is free there. Demoted: back to the stock's rooms. */
  private relocate(a: Agent): boolean {
    if (!a.seat || a.look === 'frozen') return false;
    const inCeo = this.ceoOwner.get(a.seat.id) === a.id;
    const partner = a.rec.view.tier === 'partner';
    let next: Seat | null = null;
    if (partner && !inCeo) next = this.freeCeo();
    else if (!partner && inCeo) next = this.homeSeat(a);
    if (!next) return false;
    const route = this.paths.route(a.seat.access, next.access);
    if (!route) return false;
    const from = a.seat;
    this.standUp(a);
    if (inCeo) this.ceoOwner.delete(from.id);
    if (partner) this.ceoOwner.set(next.id, a.id);
    a.seat = next;
    a.home = next.access;
    this.walkTo(a, [from.pos, ...route, next.pos], { kind: 'move', spot: null, back: [], stay: 0 });
    return true;
  }

  private dropBox(a: Agent): void {
    if (!a.box) return;
    this.layer.remove(a.box);
    a.box = null;
  }

  /** Send a few seated rats off on an errand, keeping about AWAY_SHARE of them up and about. */
  private startTrips(): void {
    const target = Math.max(4, Math.min(260, Math.round(this.list.length * AWAY_SHARE)));
    const before = this.paths.computed;
    for (let tries = 0; tries < 8 && this.away < target && this.paths.computed === before; tries++) {
      const a = this.list[Math.floor(Math.random() * this.list.length)];
      if (!a || !a.seated || !a.seat || (a.mode !== 'type' && a.mode !== 'slump')) continue;
      const r = Math.random();
      if (r < 0.1) {
        // nap at the desk
        a.mode = 'nap';
        this.setAnim(a, a.seat.view === 'front' ? 'sulk_front' : 'sulk_back', false, a.seat.view === 'front' ? a.seat.axis === 'i' : a.seat.axis === 'j');
        a.until = this.time + 12 + Math.random() * 20;
        continue;
      }
      let spot: Spot | null = null;
      let targetCell: Cell | null = null;
      let kind: Trip['kind'] = 'spot';
      let stay = 5 + Math.random() * 14;
      if (r < 0.24 && this.strollCells.length) {
        kind = 'stroll';
        targetCell = this.strollCells[Math.floor(Math.random() * this.strollCells.length)]!;
        stay = 0.3 + Math.random() * 1.5;
      } else if (r < 0.34 && this.spotsByKind.get('boxes')?.length) {
        kind = 'box';
        spot = this.nearestFree(a, this.spotsByKind.get('boxes')!, 3, true);
        stay = 1.2 + Math.random();
      } else {
        const near = this.spotGrid.get(`${Math.floor(a.seat.access.i / 24)},${Math.floor(a.seat.access.j / 24)}`);
        spot = this.nearestFree(a, near && near.length > 3 ? near : this.spots, 6, false);
      }
      if (spot) targetCell = spot.cell;
      if (!targetCell) continue;
      const route = this.paths.route(a.seat.access, targetCell);
      if (!route) continue;
      const out = [a.seat.pos, ...route];
      if (spot) out.push(spot.pos);
      if (spot) this.taken.add(spot.id);
      this.away++;
      a.phase = 'out';
      this.walkTo(a, out, { kind, spot, back: [...out].reverse(), stay });
    }
  }

  /** Of a few random free spots, the closest one (errands stay mostly local). */
  private nearestFree(a: Agent, spots: Spot[], samples: number, shared: boolean): Spot | null {
    let best: Spot | null = null;
    let bestD = Infinity;
    const from = a.seat ? a.seat.access : a.pos;
    for (let k = 0; k < samples; k++) {
      const s = spots[Math.floor(Math.random() * spots.length)];
      if (!s || (!shared && this.taken.has(s.id))) continue;
      const d = Math.abs(s.cell.i - from.i) + Math.abs(s.cell.j - from.j);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  update(dt: number): void {
    this.time += dt;
    if (this.lineDirty) this.reflow(true);
    this.tripClock -= dt;
    if (this.tripClock <= 0) {
      this.tripClock = 0.2;
      this.startTrips();
    }
    for (const a of this.walkers) this.walk(a, dt);
    for (const a of this.list) {
      if (a.mode === 'frozen') continue;
      if (a.phase === 'at' && this.time >= a.until) {
        this.leave(a);
        continue;
      }
      if (a.mode === 'nap' && this.time >= a.until) {
        this.sit(a);
        continue;
      }
      if (a.mode === 'type' && this.moods.get(a.rec.facts.stock) === 'up' && this.time >= a.nextCheer) {
        a.mode = 'cheer';
        this.setAnim(a, 'cheer', true, false);
        continue;
      }
      a.t += dt;
      const step = 1 / FPS[a.anim];
      if (a.t < step) continue;
      a.t -= step;
      let k = a.frame + 1;
      if (k >= a.frames.length) {
        if (!a.once) k = 0;
        else if (a.mode === 'cheer') {
          this.sit(a);
          continue;
        } else if (a.mode === 'slump' || a.mode === 'nap') k = a.frames.length - 3; // hold the slumped pose
        else k = a.frames.length - 1;
      }
      a.frame = k;
      this.applyFrame(a);
    }
  }

  /** Done at the spot: head back (with a box, if that was the errand). */
  private leave(a: Agent): void {
    const trip = a.trip;
    if (!trip) return;
    if (trip.spot) this.taken.delete(trip.spot.id);
    a.phase = 'back';
    if (trip.kind === 'box' && !a.box) a.box = this.layer.add(makeParticle(this.boxFrame, a.item.p.x, a.item.p.y), this.depthOf(a) + 0.01);
    this.walkTo(a, trip.back, trip);
  }

  private arrive(a: Agent): void {
    const trip = a.trip;
    this.walkers.delete(a);
    a.path = [];
    if (a.phase === 'out' && trip) {
      a.phase = 'at';
      a.until = this.time + trip.stay;
      const spot = trip.spot;
      if (spot?.pose === 'sit') {
        a.mode = 'sit';
        this.setAnim(a, 'type', false, spot.face === 'nw');
      } else {
        a.mode = 'stand';
        const f = faceAnim(spot?.face ?? (['se', 'sw', 'ne', 'nw'] as const)[Math.floor(Math.random() * 4)]!);
        this.setAnim(a, f.anim, false, f.mirror);
      }
      this.place(a);
      return;
    }
    if (a.phase === 'back') {
      a.phase = null;
      this.away--;
      this.dropBox(a);
    }
    a.trip = null;
    this.sit(a);
    this.onArrive(a.id);
  }

  private walk(a: Agent, dt: number): void {
    let left = WALK_SPEED * dt;
    while (left > 0 && a.seg < a.path.length) {
      const to = a.path[a.seg]!;
      const di = to.i - a.pos.i;
      const dj = to.j - a.pos.j;
      const d = Math.abs(di) + Math.abs(dj);
      const dir = Math.abs(di) >= Math.abs(dj) ? (di >= 0 ? 'se' : 'nw') : dj >= 0 ? 'sw' : 'ne';
      const anim: AnimName = dir === 'se' || dir === 'sw' ? 'walk_se' : 'walk_ne';
      const mirror = dir === 'sw' || dir === 'nw';
      if (anim !== a.anim || mirror !== a.mirror) this.setAnim(a, anim, false, mirror);
      if (d <= left) {
        a.pos = { ...to };
        a.seg++;
        left -= d;
      } else {
        a.pos = { i: a.pos.i + (di / d) * left, j: a.pos.j + (dj / d) * left };
        left = 0;
      }
    }
    if (a.seg >= a.path.length) this.arrive(a);
    else this.place(a);
  }

  /** The rat under a world point, top-most first. */
  pick(x: number, y: number): number | null {
    let best: Agent | null = null;
    for (const a of this.list) {
      const p = a.item.p;
      const s = TIER_SCALE[a.rec.view.tier];
      if (Math.abs(x - p.x) > 13 * s || y > p.y + 2 || y < p.y - 48 * s) continue;
      if (a.id < 0) continue; // applicants have no card yet
      if (!best || a.item.depth > best.item.depth) best = a;
    }
    return best ? best.id : null;
  }

  positionOf(id: number): { x: number; y: number } | null {
    const a = this.agents.get(id);
    return a ? { x: a.item.p.x, y: a.item.p.y } : null;
  }
}
