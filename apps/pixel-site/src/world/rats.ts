// Every rat is one Particle in the shared depth-sorted layer. Rats on the roster start at their desks (partners in
// the CEO office while it has room); a hire comes up the subway stairs and walks to a free desk of its stock.
// Seated rats type, slump when their stock is down and jump up to cheer when it is up. A few percent are always up
// and about: coffee, the water cooler, a chat, the bathroom queue, the copier, a meeting, a stroll down the
// corridor, fetching a box, a smoke outside, a nap at the desk. Frozen rats go grey and stop. Size follows tier.
import type { Tier } from '@rat/contract';
import type { Atlas, Frame } from '../gfx/atlas';
import { makeParticle, type LayerItem, type SortedLayer } from '../gfx/layer';
import { cellCentre, type Cell } from '../iso';
import { Paths } from '../floor/path';
import type { Growth } from '../floor/growth';
import { hash32 } from '../floor/rng';
import { standCells } from '../floor/plan';
import type { Face, FloorLayout, Seat, Spot } from '../floor/types';
import type { RatRecord } from '../data/store';

export type Look = Tier | 'frozen';
export type Mood = 'up' | 'down' | 'flat';
type Mode = 'walk' | 'type' | 'slump' | 'cheer' | 'stand' | 'sit' | 'nap' | 'frozen';
type AnimName = 'walk_se' | 'walk_ne' | 'idle_se' | 'idle_ne' | 'type' | 'slump' | 'cheer';

export const TIER_SCALE: Record<Tier, number> = { intern: 0.88, analyst: 1, associate: 1.08, vp: 1.17, partner: 1.3 };
const FPS: Record<AnimName, number> = { walk_se: 10, walk_ne: 10, idle_se: 5, idle_ne: 5, type: 8, slump: 6, cheer: 11 };
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
  private stand = new Map<number, Cell[]>();
  private paths: Paths;
  private time = 0;
  private tripClock = 0;
  private away = 0;
  private boxFrame: Frame;
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
    this.index();
  }

  /** What rats can use right now: spots in built rooms, the current street, built corridors, the CEO office. */
  private index(): void {
    const L = this.layout;
    const g = this.growth;
    this.spawn = L.rings[g.stage]!.spawn;
    this.ceoSeats = L.ceo.kind === 'ceo' && g.isBuilt(L.ceo) ? [...L.ceo.seats] : [];
    this.spots = L.spots.filter((s) => (s.room >= 0 ? g.built[s.room] === 1 : s.ring === g.stage));
    this.spotsByKind.clear();
    this.spotGrid.clear();
    this.stand.clear();
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
  }

  /** The world was rebuilt (a room went up): move every rat onto the new layer and walk mask. */
  rebind(layer: SortedLayer, blocked: Uint8Array): void {
    this.layer = layer;
    this.blocked = blocked;
    this.paths = new Paths(this.layout, 64, blocked);
    this.index();
    for (const a of this.list) {
      a.item = layer.add(a.item.p, this.depthOf(a));
      if (a.box) a.box = layer.add(a.box.p, this.depthOf(a) + 0.01);
      if (a.seat && !a.seated) this.onChair(a.seat.id, true);
    }
    // rats that just got a desk in a new room walk over to it
    for (const id of this.growth.moved.splice(0)) {
      const a = this.agents.get(id);
      const sid = this.growth.seatOfRat.get(id);
      if (!a || sid === undefined || a.trip || a.mode === 'walk') continue;
      const seat = this.layout.seats[sid]!;
      const from = { i: Math.round(a.pos.i), j: Math.round(a.pos.j) };
      const route = this.paths.route(from, seat.access);
      a.seat = seat;
      if (route) this.walkTo(a, [a.pos, ...route, seat.pos], { kind: 'move', spot: null, back: [], stay: 0 });
      else this.sit(a);
    }
    layer.sync(true);
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

  private frames(look: Look, anim: AnimName): Frame[] {
    return this.atlas.anim(`${look}/${anim}`);
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

  private homeFor(rec: RatRecord): Cell {
    const room = this.layout.hq;
    let cells = this.stand.get(room.id);
    if (!cells) this.stand.set(room.id, (cells = standCells(this.layout, room, this.blocked)));
    return cells.length ? cells[hash32(`home:${rec.facts.id}`) % cells.length]! : { i: room.i0 + 1, j: room.j0 + 1 };
  }

  private depthOf(a: Agent): number {
    if (a.seated && a.seat) return a.seat.cell.i + a.seat.cell.j + 1.5;
    return a.pos.i + a.pos.j + 1.25;
  }

  private place(a: Agent): void {
    const c = cellCentre(a.pos.i, a.pos.j);
    const s = a.seated && a.seat ? a.seat : null;
    a.item.p.x = c.x + (s ? s.dx : 0);
    a.item.p.y = c.y + (s ? s.dy : 0);
    this.layer.moved(a.item, this.depthOf(a));
    if (a.box) {
      a.box.p.x = a.item.p.x + (a.mirror ? -5 : 5);
      a.box.p.y = a.item.p.y - 14 * TIER_SCALE[a.rec.view.tier];
      this.layer.moved(a.box, this.depthOf(a) + 0.01);
    }
  }

  private setAnim(a: Agent, anim: AnimName, once: boolean, mirror = a.mirror): void {
    a.anim = anim;
    a.frames = this.frames(a.look, anim);
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
  }

  /** Sit down at the desk and work (or sulk, or freeze). */
  private sit(a: Agent): void {
    const seat = a.seat;
    if (!seat) {
      a.seated = false;
      a.mode = a.look === 'frozen' ? 'frozen' : 'stand';
      this.setAnim(a, 'idle_se', a.look === 'frozen', false);
      return;
    }
    if (!a.seated) this.onChair(seat.id, false);
    a.seated = true;
    a.pos = { ...seat.pos };
    const mirror = seat.axis === 'i';
    if (a.look === 'frozen') {
      a.mode = 'frozen';
      this.setAnim(a, 'type', true, mirror);
      a.frame = 0;
      this.applyFrame(a);
    } else if (this.moods.get(a.rec.facts.stock) === 'down') {
      a.mode = 'slump';
      this.setAnim(a, 'slump', true, mirror);
    } else {
      a.mode = 'type';
      this.setAnim(a, 'type', false, mirror);
    }
    a.nextCheer = this.time + 3 + Math.random() * 18;
    this.place(a);
  }

  private standUp(a: Agent): void {
    if (a.seated && a.seat) this.onChair(a.seat.id, true);
    a.seated = false;
  }

  /** Rats on the roster at page load: straight to their desks. Partners first, so they get the corner office. */
  load(recs: RatRecord[]): void {
    const sorted = [...recs].sort((x, y) => (x.view.tier === 'partner' ? 0 : 1) - (y.view.tier === 'partner' ? 0 : 1) || x.facts.id - y.facts.id);
    for (const rec of sorted) this.create(rec, false);
    this.layer.sync(true);
  }

  /** A hire: comes up the subway stairs and walks to the next free desk of its stock. */
  hire(rec: RatRecord): void {
    if (this.agents.has(rec.facts.id)) return;
    this.create(rec, true);
  }

  private create(rec: RatRecord, walk: boolean): void {
    const seat = this.claim(rec);
    const home = seat ? seat.pos : this.homeFor(rec);
    const look = lookOf(rec);
    const first = this.frames(look, 'type')[0]!;
    const start = walk ? { ...this.spawn } : { ...home };
    const c = cellCentre(start.i, start.j);
    const item = this.layer.add(makeParticle(first, c.x, c.y, false, TIER_SCALE[rec.view.tier]), 0);
    const a: Agent = {
      id: rec.facts.id, rec, item, look, mode: 'type', anim: 'type', frames: [first], frame: 0, t: 0, once: false, mirror: false,
      seat, home: seat ? seat.access : home, pos: start, path: [], seg: 0, trip: null, phase: null, until: 0, box: null,
      nextCheer: 0, seated: false,
    };
    this.agents.set(a.id, a);
    this.list.push(a);
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
        this.setAnim(a, 'slump', true, a.seat.axis === 'i');
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
      const f = a.frames[k];
      if (f) a.item.p.texture = f.texture;
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
      if (!best || a.item.depth > best.item.depth) best = a;
    }
    return best ? best.id : null;
  }

  positionOf(id: number): { x: number; y: number } | null {
    const a = this.agents.get(id);
    return a ? { x: a.item.p.x, y: a.item.p.y } : null;
  }

  /** Screen positions of up to n seated rats (burn bags fly from their desks). */
  sample(n: number): Array<{ x: number; y: number }> {
    const out: Array<{ x: number; y: number }> = [];
    for (let k = 0; k < n * 4 && out.length < n && this.list.length; k++) {
      const a = this.list[Math.floor(Math.random() * this.list.length)]!;
      if (a.seated) out.push({ x: a.item.p.x, y: a.item.p.y - 30 });
    }
    return out;
  }
}
