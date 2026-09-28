// Every rat is one Particle in the shared depth-sorted layer. Rats already on the roster start at their desks;
// a hire spawns at the subway stairs and walks the fixed waypoints to its seat. Seated rats type, slump when their
// stock is down, and pop up to cheer now and then when it is up. Frozen rats go grey and stop. Size follows tier.
import type { Tier } from '@rat/contract';
import type { Atlas, Frame } from '../gfx/atlas';
import { makeParticle, type LayerItem, type SortedLayer } from '../gfx/layer';
import { cellCentre, type Cell } from '../iso';
import { overflowSpot, pathToSeat, type FloorLayout, type Room, type Seat } from '../layout';
import type { RatRecord } from '../data/store';

export type Look = Tier | 'frozen';
export type Mood = 'up' | 'down' | 'flat';
type Mode = 'walk' | 'type' | 'slump' | 'cheer' | 'stand' | 'frozen';
type AnimName = 'walk_se' | 'walk_ne' | 'idle_se' | 'idle_ne' | 'type' | 'slump' | 'cheer';

export const TIER_SCALE: Record<Tier, number> = { intern: 0.88, analyst: 1, associate: 1.08, vp: 1.17, partner: 1.3 };
const FPS: Record<AnimName, number> = { walk_se: 10, walk_ne: 10, idle_se: 5, idle_ne: 5, type: 8, slump: 6, cheer: 11 };
const WALK_SPEED = 2.8; // cells per second

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
  room: Room | null;
  seat: Seat | null;
  spot: Cell;
  path: Cell[];
  seg: number;
  pos: Cell;
  nextCheer: number;
}

function lookOf(rec: RatRecord): Look {
  return rec.facts.status === 'frozen' ? 'frozen' : rec.view.tier;
}

export class RatSystem {
  private agents = new Map<number, Agent>();
  private nextSeat = new Map<string, number>();
  private moods = new Map<string, Mood>();
  private walkers = new Set<Agent>();
  private time = 0;
  onArrive: (id: number) => void = () => {};
  /** a desk got its rat: the world removes that seat's empty chair */
  onSeatTaken: (symbol: string, seatIndex: number) => void = () => {};

  constructor(
    private readonly atlas: Atlas,
    private readonly layout: FloorLayout,
    private readonly layer: SortedLayer,
  ) {}

  get count(): number {
    return this.agents.size;
  }

  get walking(): number {
    return this.walkers.size;
  }

  private frames(look: Look, anim: AnimName): Frame[] {
    return this.atlas.anim(`${look}/${anim}`);
  }

  private claimSeat(rec: RatRecord): { room: Room | null; seat: Seat | null; spot: Cell } {
    const room = this.layout.bySymbol.get(rec.facts.stock) ?? null;
    if (!room) {
      const hq = this.layout.hq;
      return { room: hq, seat: null, spot: { i: hq.i0 + 2 + (rec.facts.id % (hq.w - 4)), j: hq.j0 + hq.h - 1.5 } };
    }
    const k = this.nextSeat.get(room.symbol!) ?? 0;
    this.nextSeat.set(room.symbol!, k + 1);
    const seat = room.seats[k] ?? null;
    if (seat) this.onSeatTaken(room.symbol!, seat.index);
    return { room, seat, spot: seat ? { i: seat.i, j: seat.j } : overflowSpot(room, rec.facts.id) };
  }

  private depthAt(a: Agent): number {
    if (a.mode !== 'walk' && a.seat) return a.seat.deskI + a.seat.deskJ + 1.5;
    return a.pos.i + a.pos.j + 1.25;
  }

  private place(a: Agent): void {
    const c = cellCentre(a.pos.i, a.pos.j);
    a.item.p.x = c.x;
    a.item.p.y = c.y;
    this.layer.moved(a.item, this.depthAt(a));
  }

  private setAnim(a: Agent, anim: AnimName, once: boolean, mirror = a.mirror): void {
    const look = a.look;
    a.anim = anim;
    a.frames = this.frames(look, anim);
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

  private settle(a: Agent): void {
    if (a.look === 'frozen') {
      a.mode = 'frozen';
      a.frames = this.frames('frozen', a.seat ? 'type' : 'idle_se');
      a.frame = 0;
      a.once = true;
      a.mirror = false;
      this.applyFrame(a);
      return;
    }
    if (!a.seat) {
      a.mode = 'stand';
      this.setAnim(a, 'idle_se', false, false);
      return;
    }
    const mood = this.moods.get(a.rec.facts.stock) ?? 'flat';
    if (mood === 'down') {
      a.mode = 'slump';
      this.setAnim(a, 'slump', true, false);
    } else {
      a.mode = 'type';
      this.setAnim(a, 'type', false, false);
    }
    a.nextCheer = this.time + 3 + Math.random() * 18;
  }

  /** Rats on the roster at page load: straight to their desks. Seats go by rat id within each stock. */
  load(recs: RatRecord[]): void {
    const sorted = [...recs].sort((x, y) => x.facts.id - y.facts.id);
    for (const rec of sorted) this.create(rec, false);
    this.layer.sync(true);
  }

  /** A hire: appears at the subway stairs and walks to the next free desk of its stock room. */
  hire(rec: RatRecord): void {
    if (this.agents.has(rec.facts.id)) return;
    this.create(rec, true);
  }

  private create(rec: RatRecord, walk: boolean): void {
    const { room, seat, spot } = this.claimSeat(rec);
    const look = lookOf(rec);
    const start = walk ? { ...this.layout.spawn } : { ...spot };
    const first = this.frames(look, 'type')[0]!;
    const c = cellCentre(start.i, start.j);
    const p = makeParticle(first, c.x, c.y, false, TIER_SCALE[rec.view.tier]);
    const item = this.layer.add(p, 0);
    const a: Agent = {
      id: rec.facts.id, rec, item, look, mode: 'type', anim: 'type', frames: [first], frame: 0, t: 0, once: false,
      mirror: false, room, seat, spot, path: [], seg: 0, pos: start, nextCheer: 0,
    };
    this.agents.set(a.id, a);
    if (walk && room) {
      // no desk (overflow, or a stock added after page load): same route, ending at a standing spot
      const target: Seat = seat ?? { index: -1, deskI: spot.i, deskJ: spot.j, i: spot.i, j: spot.j, aisleJ: spot.j };
      a.path = pathToSeat(this.layout, room, target);
      a.seg = 1;
      a.mode = 'walk';
      this.walkers.add(a);
      this.setAnim(a, 'walk_se', false, false);
    } else {
      this.settle(a);
    }
    this.place(a);
  }

  setMood(symbol: string, mood: Mood): void {
    if (this.moods.get(symbol) === mood) return;
    this.moods.set(symbol, mood);
    for (const a of this.agents.values()) {
      if (a.rec.facts.stock === symbol && (a.mode === 'type' || a.mode === 'slump')) this.settle(a);
    }
  }

  /** Tier or frozen status changed: new suit, new size. */
  refresh(ids: number[]): void {
    for (const id of ids) {
      const a = this.agents.get(id);
      if (!a) continue;
      const look = lookOf(a.rec);
      if (look === a.look) {
        this.applyFrame(a);
        continue;
      }
      a.look = look;
      if (a.mode === 'walk') this.setAnim(a, a.anim, false);
      else this.settle(a);
    }
  }

  update(dt: number): void {
    this.time += dt;
    for (const a of this.walkers) this.walk(a, dt);
    for (const a of this.agents.values()) {
      if (a.mode === 'frozen') continue;
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
          this.settle(a);
          continue;
        } else if (a.mode === 'slump') k = a.frames.length - 3; // hold the slumped pose, scribble keeps moving
        else k = a.frames.length - 1;
      }
      a.frame = k;
      const f = a.frames[k];
      if (f) a.item.p.texture = f.texture;
    }
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
    if (a.seg >= a.path.length) {
      this.walkers.delete(a);
      a.path = [];
      this.settle(a);
      this.onArrive(a.id);
    }
    this.place(a);
  }

  /** The rat under a world point, top-most first. */
  pick(x: number, y: number): number | null {
    let best: Agent | null = null;
    for (const a of this.agents.values()) {
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

  /** Screen positions of up to n seated rats of a stock (burn bags fly from their desks). */
  sample(n: number): Array<{ x: number; y: number }> {
    const all = [...this.agents.values()].filter((a) => a.mode !== 'walk');
    const out: Array<{ x: number; y: number }> = [];
    for (let k = 0; k < n && all.length; k++) {
      const a = all[Math.floor(Math.random() * all.length)]!;
      out.push({ x: a.item.p.x, y: a.item.p.y - 30 });
    }
    return out;
  }
}
