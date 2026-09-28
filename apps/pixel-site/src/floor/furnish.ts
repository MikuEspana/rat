// Fills each room: desks, props, activity spots and clutter. Every room keeps a walkable route from its doors to
// every chair and spot; clutter that would cut one off is taken back out (see Fit.clutter).
import type { Cell } from '../iso';
import { Rng } from './rng';
import { T, idx, type Face, type Prop, type Room, type Seat, type Spot, type SpotKind } from './types';

export interface Builder {
  W: number;
  H: number;
  tile: Uint8Array;
  roomOf: Int16Array;
  blocked: Uint8Array;
  /** cells that must stay walkable: door fronts, chair access cells, spots */
  reserved: Uint8Array;
  wallH: Uint8Array;
  props: Prop[];
  seats: Seat[];
  spots: Spot[];
  /** desk pods numbered across the whole plan */
  nextPod: number;
}

type Off = ReadonlyArray<readonly [number, number]>;
const ONE: Off = [[0, 0]];
const I2: Off = [[0, 0], [-1, 0]];
const SQ2: Off = [[0, 0], [-1, 0], [0, -1], [-1, -1]];

/** Cells a prop covers, relative to its anchor (front) cell, unmirrored. Mirroring swaps i and j. */
export const FOOTPRINT: Record<string, Off> = {
  coffee_counter: I2, whiteboard: I2, filing: I2, filing_printer: I2, filing_plant: I2, sofa: I2, sofa_navy: I2,
  sofa_green: I2, bookshelf: I2, tv_stand: I2, copier: SQ2, exec_desk: SQ2, exec_desk_gold: SQ2, round_table: SQ2,
  box_pile2: SQ2, ping_pong: SQ2, shark_tank: SQ2, foosball: I2, aquarium: I2, copier_jam: I2, vault_door: SQ2,
};

function footprint(kind: string, mirror: boolean): Array<[number, number]> {
  const f = FOOTPRINT[kind] ?? ONE;
  return f.map(([a, b]) => (mirror ? [b, a] : [a, b]));
}

const N4: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export class Fit {
  readonly fronts: Cell[] = [];
  private readonly seatsHere: Seat[] = [];
  private readonly spotsHere: Spot[] = [];
  private readonly wallUsed = new Set<string>();
  private readonly access = new Map<Seat, Cell[]>();
  /** stop adding desks after this many (the rest of the room gets clutter) */
  maxSeats = Infinity;

  constructor(
    readonly B: Builder,
    readonly r: Room,
    readonly rng: Rng,
  ) {
    for (const d of r.doors) {
      for (const [a, b] of N4) {
        const i = d.i + a;
        const j = d.j + b;
        if (this.inside(i, j)) {
          this.fronts.push({ i, j });
          this.reserve(i, j);
          if (this.inside(i + a, j + b)) this.reserve(i + a, j + b);
        }
      }
    }
    // a clear aisle joins every door to the first one, so rats can always pass through the room
    const f0 = this.fronts[0];
    if (f0) {
      for (const f of this.fronts.slice(1)) {
        const viaI = (f.i + f.j + f0.i) % 2 === 0;
        const corner = viaI ? { i: f.i, j: f0.j } : { i: f0.i, j: f.j };
        for (const [a, b] of [[f0, corner], [corner, f]] as const) {
          const n = Math.abs(b.i - a.i) + Math.abs(b.j - a.j);
          for (let t = 0; t <= n; t++) this.reserve(a.i + Math.sign(b.i - a.i) * t, a.j + Math.sign(b.j - a.j) * t);
        }
      }
    }
    if (r.ticker) for (let k = 0; k < 7; k++) this.wallUsed.add(r.ticker.axis === 'i' ? `${r.ticker.i + k},${r.ticker.j}` : `${r.ticker.i},${r.ticker.j + k}`);
  }

  inside(i: number, j: number): boolean {
    const r = this.r;
    return i >= r.i0 && i < r.i0 + r.w && j >= r.j0 && j < r.j0 + r.h;
  }

  /** free for furniture: inside, not blocked, not kept clear */
  free(i: number, j: number): boolean {
    if (!this.inside(i, j)) return false;
    const k = idx(this.B.W, i, j);
    return !this.B.blocked[k] && !this.B.reserved[k];
  }

  walkable(i: number, j: number): boolean {
    return this.inside(i, j) && !this.B.blocked[idx(this.B.W, i, j)];
  }

  reserve(i: number, j: number): void {
    this.B.reserved[idx(this.B.W, i, j)] = 1;
  }

  private setBlocked(cells: ReadonlyArray<readonly [number, number]>, v: 0 | 1): void {
    for (const [i, j] of cells) this.B.blocked[idx(this.B.W, i, j)] = v;
  }

  /** Place a standing prop if its footprint is free. */
  put(kind: string, i: number, j: number, mirror = false, extra: Partial<Prop> = {}): Prop | null {
    const cells = footprint(kind, mirror).map(([a, b]) => [i + a, j + b] as const);
    if (!cells.every(([a, b]) => this.free(a, b))) return null;
    this.setBlocked(cells, 1);
    const n = cells.length;
    const mi = cells.reduce((s, c) => s + c[0], 0) / n - i;
    const mj = cells.reduce((s, c) => s + c[1], 0) / n - j;
    const p: Prop = { kind, i, j, mirror, dx: Math.round((mi - mj) * 16), dy: 4, ...extra };
    this.B.props.push(p);
    return p;
  }

  private unput(p: Prop): void {
    const cells = footprint(p.kind, p.mirror).map(([a, b]) => [p.i + a, p.j + b] as const);
    this.setBlocked(cells, 0);
    const k = this.B.props.lastIndexOf(p);
    if (k >= 0) this.B.props.splice(k, 1);
  }

  /**
   * A whole authored scene (vignettes.ts): props at fixed cells (props marked `on` stand on another prop, `flat` ones
   * lie on the floor), and cells kept for its extras. All or nothing: if anything does not fit or a door, chair or
   * spot would be cut off, it is taken back out.
   */
  scene(items: Array<{ kind: string; i: number; j: number; mirror?: boolean; scale?: number; dx?: number; dy?: number; on?: boolean; flat?: boolean }>, extras: Cell[]): boolean {
    const done: Prop[] = [];
    const loose: Prop[] = [];
    const undo = (): false => {
      for (const p of done) this.unput(p);
      for (const p of loose) this.B.props.splice(this.B.props.lastIndexOf(p), 1);
      this.setBlocked(extras.map((c) => [c.i, c.j] as const), 0);
      return false;
    };
    for (const c of extras) if (!this.free(c.i, c.j)) return false;
    this.setBlocked(extras.map((c) => [c.i, c.j] as const), 1);
    for (const it of items) {
      if (it.on || it.flat) {
        const p: Prop = { kind: it.kind, i: it.i, j: it.j, mirror: !!it.mirror, dx: it.dx ?? 0, dy: it.dy ?? 0, bias: it.on ? 0.3 : 0 };
        if (it.flat) p.flat = true;
        if (it.scale) p.scale = it.scale;
        this.B.props.push(p);
        loose.push(p);
        continue;
      }
      const p = this.put(it.kind, it.i, it.j, !!it.mirror, it.scale ? { scale: it.scale } : {});
      if (!p) return undo();
      if (it.dx) p.dx = (p.dx ?? 0) + it.dx;
      done.push(p);
    }
    if (!this.allReachable()) return undo();
    return true;
  }

  /** A rug (a cells along i by b along j) with its back corner at (i, j); flat, never blocks. */
  rug(kind: string, i: number, j: number, a: number, b: number): void {
    if (!this.inside(i, j) || !this.inside(i + a - 1, j + b - 1)) return;
    const di = a / 2 - 0.5;
    const dj = b / 2 - 0.5;
    this.B.props.push({ kind, i, j, mirror: false, flat: true, dx: Math.round((di - dj) * 16), dy: Math.round((di + dj) * 8), bias: -0.5 });
  }

  /** Worn carpet where rats walk most: dark patches on aisle cells. */
  wear(n: number): void {
    for (let k = 0; k < n; k++) {
      const i = this.r.i0 + this.rng.int(this.r.w);
      const j = this.r.j0 + this.rng.int(this.r.h);
      if (this.walkable(i, j)) this.B.props.push({ kind: `worn_${this.rng.int(3)}`, i, j, mirror: this.rng.chance(0.5), flat: true, dx: this.rng.range(-6, 6), dy: this.rng.range(-3, 3), bias: -0.4 });
    }
  }

  /** Flat floor clutter: never blocks. */
  flat(kind: string, i: number, j: number, mirror = false): void {
    if (!this.inside(i, j)) return;
    this.B.props.push({ kind, i, j, mirror, flat: true, dx: this.rng.range(-6, 6), dy: this.rng.range(-2, 3) });
  }

  /** Something hung on a back wall: 'i' is the back-right wall (row j0 - 1), 'j' the back-left wall (column i0 - 1). */
  mount(kind: string, wall: 'i' | 'j', at: number, span: number, extra: Partial<Prop> = {}): boolean {
    const r = this.r;
    const cells: Array<[number, number]> = [];
    for (let k = 0; k < span; k++) cells.push(wall === 'i' ? [at + k, r.j0 - 1] : [r.i0 - 1, at + k]);
    for (const [i, j] of cells) {
      if (this.B.tile[idx(this.B.W, i, j)] !== T.WALL || this.wallUsed.has(`${i},${j}`)) return false;
      if (wall === 'i' ? i < r.i0 || i >= r.i0 + r.w : j < r.j0 || j >= r.j0 + r.h) return false;
    }
    for (const [i, j] of cells) this.wallUsed.add(`${i},${j}`);
    const [i, j] = cells[0]!;
    this.B.props.push({ kind, i, j, mirror: wall === 'j', wall, ...extra });
    return true;
  }

  /** A random free spot on a back wall. */
  mountAnywhere(kind: string, span: number, extra: Partial<Prop> = {}): boolean {
    const r = this.r;
    for (let t = 0; t < 12; t++) {
      const wall: 'i' | 'j' = this.rng.chance(r.w / (r.w + r.h)) ? 'i' : 'j';
      const len = wall === 'i' ? r.w : r.h;
      if (len < span + 1) continue;
      const at = (wall === 'i' ? r.i0 : r.j0) + this.rng.int(len - span);
      if (this.mount(kind, wall, at, span, extra)) return true;
    }
    return false;
  }

  /**
   * One side of a desk pair. The pair is two desks back to back (monitors meeting in the middle), each with its chair
   * outside: in pair coordinates (a across the desks, b along their long side) the far desk takes (c, r..r+1) with its
   * chair at (c-1, ...) and its rat facing the camera over the monitor; the near desk takes (c+1, ...) with its chair
   * at (c+2, ...) and its rat's back to the camera. axis 'j': a is i, b is j; axis 'i': swapped (sprites mirrored).
   */
  desk(c: number, r: number, axis: 'i' | 'j', side: 'far' | 'near', variant: number, symbol: string | null, pod: number): Seat | null {
    if (this.seatsHere.length >= this.maxSeats) return null;
    const m = (x: number, y: number): Cell => (axis === 'j' ? { i: x, j: y } : { i: y, j: x });
    const far = side === 'far';
    const dc = far ? c : c + 1;
    const cc = far ? c - 1 : c + 2;
    const cells = [m(dc, r), m(dc, r + 1), m(cc, r), m(cc, r + 1)];
    if (!cells.every((x) => this.free(x.i, x.j))) return null;
    this.setBlocked(cells.map((x) => [x.i, x.j] as const), 1);
    const out = far ? cc - 1 : cc + 1;
    const seat: Seat = {
      id: -1,
      room: this.r.id,
      symbol,
      cell: m(cc, r),
      axis,
      view: far ? 'front' : 'back',
      deskAt: m(dc, r + 0.5),
      pos: m(far ? c - 0.8 : c + 1.8, r + 0.5),
      access: m(out, r),
      pod,
      cells,
      dx: 0,
      dy: 0,
      variant,
    };
    this.access.set(seat, [m(out, r), m(out, r + 1), m(cc, r - 1), m(cc, r + 2)]);
    this.seatsHere.push(seat);
    return seat;
  }

  newPod(): number {
    return this.B.nextPod++;
  }

  private dropUnit(s: Seat): void {
    this.setBlocked(s.cells.map((x) => [x.i, x.j] as const), 0);
    this.seatsHere.splice(this.seatsHere.indexOf(s), 1);
  }

  spot(kind: SpotKind, i: number, j: number, face: Face, pose: 'stand' | 'sit' = 'stand', pos?: Cell): Spot | null {
    if (!this.walkable(i, j)) return null;
    const s: Spot = { id: -1, kind, room: this.r.id, cell: { i, j }, pos: pos ?? { i, j }, face, pose };
    this.reserve(i, j);
    this.spotsHere.push(s);
    return s;
  }

  /** Cells reachable from the doors (room-local flood fill). */
  reach(): Uint8Array {
    const { r } = this;
    const seen = new Uint8Array(r.w * r.h);
    const q: number[] = [];
    for (const f of this.fronts.slice(0, 1)) {
      if (!this.walkable(f.i, f.j)) continue;
      const k = (f.j - r.j0) * r.w + (f.i - r.i0);
      if (!seen[k]) {
        seen[k] = 1;
        q.push(k);
      }
    }
    for (let h = 0; h < q.length; h++) {
      const k = q[h]!;
      const i = r.i0 + (k % r.w);
      const j = r.j0 + Math.floor(k / r.w);
      for (const [a, b] of N4) {
        const ni = i + a;
        const nj = j + b;
        if (!this.walkable(ni, nj)) continue;
        const nk = (nj - r.j0) * r.w + (ni - r.i0);
        if (!seen[nk]) {
          seen[nk] = 1;
          q.push(nk);
        }
      }
    }
    return seen;
  }

  private reached(seen: Uint8Array, c: Cell): boolean {
    return this.inside(c.i, c.j) && seen[(c.j - this.r.j0) * this.r.w + (c.i - this.r.i0)] === 1;
  }

  /** Give every chair a reachable access cell; desks that cannot be reached are removed. Drops unreachable spots. */
  settle(): void {
    for (let pass = 0; pass < 8; pass++) {
      const seen = this.reach();
      let dropped = false;
      for (const s of [...this.seatsHere]) {
        const a = (this.access.get(s) ?? [s.access]).find((c) => this.reached(seen, c));
        if (a) s.access = { ...a };
        else {
          this.dropUnit(s);
          dropped = true;
        }
      }
      if (!dropped) break;
    }
    const seen = this.reach();
    for (const s of [...this.spotsHere]) if (!this.reached(seen, s.cell)) this.spotsHere.splice(this.spotsHere.indexOf(s), 1);
    for (const s of this.seatsHere) this.reserve(s.access.i, s.access.j);
  }

  allReachable(): boolean {
    const seen = this.reach();
    return (
      this.fronts.every((f) => this.reached(seen, f)) &&
      this.seatsHere.every((s) => this.reached(seen, s.access)) &&
      this.spotsHere.every((s) => this.reached(seen, s.cell))
    );
  }

  /** Scatter blocking clutter on free cells, keeping every chair and spot reachable. Returns how many landed. */
  clutter(kinds: readonly string[], count: number, nearWall = 0.6): number {
    const { r, rng } = this;
    let placed = 0;
    for (let t = 0; t < count * 6 && placed < count; t++) {
      let i = r.i0 + rng.int(r.w);
      let j = r.j0 + rng.int(r.h);
      if (rng.chance(nearWall)) {
        if (rng.chance(0.5)) j = rng.chance(0.5) ? r.j0 : r.j0 + r.h - 1;
        else i = rng.chance(0.5) ? r.i0 : r.i0 + r.w - 1;
      }
      const kind = rng.pick(kinds);
      const p = this.put(kind, i, j, rng.chance(0.5));
      if (!p) continue;
      if (this.allReachable()) placed++;
      else this.unput(p);
    }
    return placed;
  }

  /** Flat clutter anywhere in the room (cables, spills, dropped notes). */
  litter(kinds: readonly string[], count: number): void {
    for (let k = 0; k < count; k++) this.flat(this.rng.pick(kinds), this.r.i0 + this.rng.int(this.r.w), this.r.j0 + this.rng.int(this.r.h), this.rng.chance(0.5));
  }

  corners(kinds: readonly string[], p = 0.8): void {
    const { r } = this;
    for (const [i, j] of [[r.i0, r.j0], [r.i0 + r.w - 1, r.j0], [r.i0, r.j0 + r.h - 1], [r.i0 + r.w - 1, r.j0 + r.h - 1]] as const) {
      if (this.rng.chance(p)) {
        const pr = this.put(this.rng.pick(kinds), i, j, this.rng.chance(0.5));
        if (pr && !this.allReachable()) this.unput(pr);
      }
    }
  }

  commit(): void {
    for (const s of this.seatsHere) {
      s.id = this.B.seats.length;
      this.B.seats.push(s);
      this.r.seats.push(s);
    }
    for (const s of this.spotsHere) {
      s.id = this.B.spots.length;
      this.B.spots.push(s);
      this.r.spots.push(s);
    }
  }

  get seatCount(): number {
    return this.seatsHere.length;
  }
}

// ------------------------------------------------------------------ desk layouts

/** A pod of n desks (2 to 4) facing each other: pairs along the long side; an odd one out keeps its far desk. */
function podAt(f: Fit, c: number, r: number, axis: 'i' | 'j', n: number, variant: () => number, sym: string | null): number {
  const pod = f.newPod();
  let got = 0;
  for (let k = 0; k < n; k++) {
    const pr = r + 2 * Math.floor(k / 2);
    if (f.desk(c, pr, axis, k % 2 === 0 ? 'far' : 'near', variant(), sym, pod)) got++;
  }
  return got;
}

/** Room cells as pair coordinates (a across, b along) for an axis. */
function frame(f: Fit, axis: 'i' | 'j'): { a0: number; a1: number; b0: number; b1: number; clear: (a: number, b: number) => boolean } {
  const { i0, j0, w, h } = f.r;
  const m = (a: number, b: number): [number, number] => (axis === 'j' ? [a, b] : [b, a]);
  return axis === 'j'
    ? { a0: i0, a1: i0 + w - 1, b0: j0, b1: j0 + h - 1, clear: (a, b) => f.free(...m(a, b)) }
    : { a0: j0, a1: j0 + h - 1, b0: i0, b1: i0 + w - 1, clear: (a, b) => f.free(...m(a, b)) };
}

/**
 * Desk rooms: rows along the two front walls with the rats facing the camera over their monitors, then pods of 2 to
 * 4 facing each other on a grid with aisles all round, all in one direction per room. Back-wall rows (rats facing
 * the wall) only when the room is still short of desks. Rats fill a room pod by pod (growth.ts).
 */
function deskRoom(f: Fit, seats: number, variant: () => number, sym: string | null, opts: { front?: boolean; sizes?: number[] } = {}): void {
  const { w, h } = f.r;
  f.maxSeats = seats;
  const sizes = opts.sizes ?? [2, 3, 4, 4, 4];
  // 1. front walls: a row of camera-facing desks in groups of 2 or 3
  if (opts.front !== false) {
    for (const axis of ['i', 'j'] as const) {
      const F = frame(f, axis);
      if (F.a1 - F.a0 < 6 || F.b1 - F.b0 < 6) continue;
      const c = F.a1; // the desk against the front wall, its chair just inside
      let r = F.b0 + 1;
      while (r + 1 <= F.b1 - (axis === 'j' ? 3 : 1)) {
        const n = f.rng.pick([2, 2, 3]);
        const pod = f.newPod();
        let k = 0;
        for (; k < n && r + 1 <= F.b1 - (axis === 'j' ? 3 : 1); k++, r += 2) f.desk(c, r, axis, 'far', variant(), sym, pod);
        r += 1 + (f.rng.chance(0.3) ? 1 : 0);
      }
    }
  }
  // 2. pods on a grid, aisles round each one
  const axis: 'i' | 'j' = f.rng.chance(w >= h ? 0.35 : 0.65) ? 'j' : 'i';
  const F = frame(f, axis);
  const tryPod = (c: number, r: number, n: number): boolean => {
    const L = n <= 2 ? 2 : 4;
    for (let a = c - 2; a <= c + 3; a++) for (let b = r - 1; b <= r + L; b++) if (!F.clear(a, b)) return false;
    return podAt(f, c, r, axis, n, variant, sym) > 0;
  };
  const grid = (ca: number, rb: number): void => {
    for (let c = ca; c + 3 <= F.a1 - 1; c += 5) {
      for (let r = rb; r + 1 <= F.b1 - 1; r += 5) {
        if (f.seatCount >= seats) return;
        const n = f.rng.pick(sizes);
        if (!tryPod(c, r, n) && n > 2) tryPod(c, r, 2);
      }
    }
  };
  grid(F.a0 + 2, F.b0 + 1);
  f.settle();
  // 3. still short: a shifted grid, then rows facing the back walls
  if (f.seatCount < seats) {
    grid(F.a0 + 3, F.b0 + 3);
    f.settle();
  }
  if (f.seatCount < seats) {
    for (const ax of ['i', 'j'] as const) {
      const G = frame(f, ax);
      const pod = f.newPod();
      for (let r = G.b0 + 2; r + 1 <= G.b1 - 2; r += 2) f.desk(G.a0 - 1, r, ax, 'near', variant(), sym, pod);
    }
    f.settle();
  }
}

const CLUTTER = ['box_s', 'box_s2', 'paper_stack', 'paper_tall', 'bin', 'plant', 'box_half', 'crate_papers', 'box_long', 'papers'];
const BIG_CLUTTER = ['filing', 'filing_printer', 'filing_plant', 'box_pile', 'water_cooler', 'bookshelf', 'box'];
const LITTER = ['cables', 'cable_run', 'cable_loop', 'spill', 'sticky_floor', 'cables'];

export function stockRoom(f: Fit, seats: number): void {
  const { w, h } = f.r;
  const sym = f.r.symbol;
  const clean = f.rng.next();
  const variant = (): number => (f.rng.next() < 0.35 + clean * 0.4 ? 1 : 0);
  deskRoom(f, seats, variant, sym);
  f.wear(Math.round((w * h) / 40));
  const area = w * h;
  f.corners(['plant', 'plant', 'lamp', 'filing_plant', 'water_cooler', 'bin'], 0.7);
  f.clutter(BIG_CLUTTER, Math.round(area / 90) + f.rng.int(2));
  f.clutter(CLUTTER, Math.round(area / 22) + f.rng.int(3));
  f.litter(LITTER, Math.round(area / 16));
  if (f.rng.chance(0.55)) f.mountAnywhere('whiteboard_wall', 3);
  if (f.rng.chance(0.3)) f.mountAnywhere('tv_wall', 3);
  for (let k = f.rng.int(3); k >= 0; k--) f.mountAnywhere(f.rng.chance(0.5) ? 'sticky_wall' : 'sticky_wall2', 2);
  f.commit();
}

type Item = { kind: string; spot?: SpotKind; w?: number };

/** Line props up along the back-right wall (row j0), each with a spot in front. */
function alongBackWall(f: Fit, items: Item[], gap = 0): void {
  const { i0, j0, w } = f.r;
  let u = f.rng.int(2);
  for (const it of items) {
    const width = it.w ?? 1;
    const anchorU = u + width - 1;
    if (anchorU > w - 1) break;
    if (f.put(it.kind, i0 + anchorU, j0, false)) {
      if (it.spot) f.spot(it.spot, i0 + anchorU, j0 + 1, 'ne', 'stand', { i: i0 + anchorU - (width - 1) / 2, j: j0 + 0.9 });
    }
    u = anchorU + 1 + gap;
  }
}

/** Props along the back-left wall (column i0), mirrored to face into the room. */
function alongLeftWall(f: Fit, items: Item[], start = 2, gap = 0): void {
  const { i0, j0, h } = f.r;
  let v = start;
  for (const it of items) {
    const width = it.w ?? 1;
    const anchorV = v + width - 1;
    if (anchorV > h - 1) break;
    if (f.put(it.kind, i0, j0 + anchorV, true)) {
      if (it.spot) f.spot(it.spot, i0 + 1, j0 + anchorV, 'nw', 'stand', { i: i0 + 0.9, j: j0 + anchorV - (width - 1) / 2 });
    }
    v = anchorV + 1 + gap;
  }
}

/** Two or three rats standing face to face. */
function chatGroup(f: Fit): void {
  const { i0, j0, w, h } = f.r;
  for (let t = 0; t < 20; t++) {
    const i = i0 + 1 + f.rng.int(Math.max(1, w - 3));
    const j = j0 + 1 + f.rng.int(Math.max(1, h - 3));
    if (!f.free(i, j) || !f.free(i + 1, j)) continue;
    if (f.rng.chance(0.5)) {
      f.spot('chat', i, j, 'se', 'stand', { i: i + 0.25, j });
      f.spot('chat', i + 1, j, 'nw', 'stand', { i: i + 0.8, j });
      if (f.free(i, j + 1) && f.rng.chance(0.5)) f.spot('chat', i, j + 1, 'ne', 'stand', { i: i + 0.55, j: j + 0.55 });
    } else if (f.free(i, j + 1)) {
      f.spot('chat', i, j, 'sw', 'stand', { i, j: j + 0.25 });
      f.spot('chat', i, j + 1, 'ne', 'stand', { i, j: j + 0.8 });
    }
    return;
  }
}

export function breakRoom(f: Fit): void {
  const items: Item[] = f.rng.shuffle<Item>([
    { kind: 'coffee_counter', spot: 'coffee', w: 2 },
    { kind: 'fridge', spot: 'fridge' },
    { kind: f.rng.chance(0.5) ? 'vending' : 'vending_blue', spot: 'vending' },
    { kind: 'water_cooler', spot: 'cooler' },
  ]);
  items.splice(f.rng.int(2), 0, { kind: 'coffee_machine', spot: 'coffee' });
  alongBackWall(f, items);
  alongLeftWall(f, [{ kind: f.rng.pick(['sofa', 'sofa_navy', 'sofa_green']), w: 2 }, { kind: 'plant' }, { kind: 'vending', spot: 'vending' }], 2, 1);
  const { i0, j0, w, h } = f.r;
  if (w >= 6 && h >= 6) {
    f.rug('rug_green', i0 + Math.floor(w / 2), j0 + Math.floor(h / 2), 2, 2);
    f.put('round_table', i0 + Math.floor(w / 2) + 1, j0 + Math.floor(h / 2) + 1);
  }
  chatGroup(f);
  chatGroup(f);
  if (w * h > 50) chatGroup(f);
  f.settle();
  f.mountAnywhere('tv_wall', 3) || f.put('tv_stand', i0 + w - 1, j0 + h - 1, true);
  f.mountAnywhere('sticky_wall', 2);
  f.corners(['plant', 'bin'], 0.6);
  f.clutter(['bin', 'plant', 'box_s'], 2);
  f.litter(['spill', 'spill', 'sticky_floor', 'cables'], Math.round((w * h) / 18));
  f.commit();
}

export function bathRoom(f: Fit): void {
  const { i0, j0, w, h } = f.r;
  const toilets: Item[] = [];
  for (let u = 0; u < w; u += 2) toilets.push({ kind: 'toilet', spot: 'toilet' });
  alongBackWall(f, toilets, 1);
  const sinks: Item[] = [];
  for (let v = 0; v < h; v += 2) sinks.push({ kind: 'sink', spot: 'sink' });
  alongLeftWall(f, sinks, 2, 1);
  // queue by the door
  const door = f.fronts[0];
  if (door) {
    const di = door.i === i0 ? 1 : door.i === i0 + w - 1 ? -1 : 0;
    const dj = door.j === j0 ? 1 : door.j === j0 + h - 1 ? -1 : 0;
    for (let k = 1; k <= 3; k++) {
      const ci = door.i + di * k + (dj !== 0 ? 1 : 0);
      const cj = door.j + dj * k + (di !== 0 ? 1 : 0);
      f.spot('queue', ci, cj, dj < 0 ? 'ne' : di < 0 ? 'nw' : 'ne');
    }
  }
  f.settle();
  f.corners(['plant', 'bin'], 0.5);
  f.litter(['sticky_floor'], 1);
  f.commit();
}

export function serverRoom(f: Fit): void {
  const { i0, j0, w, h } = f.r;
  const white = f.rng.chance(0.4);
  for (let v = 0; v < h - 1; v += 3) {
    const kind = (v / 3) % 2 === 0 ? (white ? 'server_rack_white' : 'server_rack') : white ? 'server_rack' : 'server_rack_white';
    for (let u = 1; u < w - 1; u++) {
      if (f.rng.chance(0.06)) continue;
      f.put(kind, i0 + u, j0 + v, true, { bias: 0.02, scale: 0.72 });
    }
    const su = 1 + f.rng.int(Math.max(1, w - 2));
    if (f.rng.chance(0.8)) f.spot('server', i0 + su, j0 + v + 1, 'ne', 'stand', { i: i0 + su, j: j0 + v + 0.95 });
  }
  f.settle();
  f.clutter(['box_s', 'box_long', 'bin'], 2);
  f.litter(['cables', 'cable_run', 'cable_loop'], Math.round((w * h) / 5));
  f.commit();
}

export function copyRoom(f: Fit): void {
  const { i0, j0, w, h } = f.r;
  alongBackWall(f, f.rng.shuffle<Item>([
    { kind: 'copier', spot: 'copier', w: 2 },
    { kind: 'filing_printer', spot: 'filing', w: 2 },
    { kind: 'copier', spot: 'copier', w: 2 },
  ]));
  alongLeftWall(f, [{ kind: 'filing', spot: 'filing', w: 2 }, { kind: 'filing_plant', w: 2 }, { kind: 'box_pile' }], 3);
  const pile = f.put('box_pile2', i0 + w - 1, j0 + h - 1, f.rng.chance(0.5));
  if (pile) f.spot('boxes', i0 + w - 3, j0 + h - 1, 'se', 'stand', { i: i0 + w - 2.6, j: j0 + h - 1 });
  f.settle();
  f.clutter(['paper_tall', 'paper_stack', 'box_s', 'crate_papers', 'papers', 'box_half'], Math.round((w * h) / 10));
  f.litter(['sticky_floor', 'cables', 'spill'], 3);
  f.mountAnywhere('sticky_wall', 2);
  f.commit();
}

export function meetingRoom(f: Fit): void {
  const { i0, j0, w, h } = f.r;
  const tables = w * h >= 60 ? 2 : 1;
  if (f.rng.chance(0.5)) f.rug('rug_blue', i0 + Math.floor(w / 2) - 1, j0 + Math.floor(h / 2) - 1, 3, 2);
  else f.rug('rug_purple', i0 + Math.floor(w / 2) - 1, j0 + Math.floor(h / 2) - 1, 2, 3);
  for (let k = 0; k < tables; k++) {
    const ti = i0 + (tables === 1 ? Math.floor(w / 2) : Math.floor(((k + 1) * w) / 3));
    const tj = j0 + Math.floor(h / 2);
    if (!f.put('round_table', ti, tj)) continue;
    // seated around the front sides (the sprites only sit facing away from the camera), standing at the back
    f.spot('meeting', ti + 1, tj - 1, 'nw', 'sit', { i: ti + 0.7, j: tj - 0.55 });
    f.spot('meeting', ti + 1, tj, 'nw', 'sit', { i: ti + 0.7, j: tj + 0.25 });
    f.spot('meeting', ti - 1, tj + 1, 'ne', 'sit', { i: ti - 0.55, j: tj + 0.7 });
    f.spot('meeting', ti, tj + 1, 'ne', 'sit', { i: ti + 0.25, j: tj + 0.7 });
    f.spot('meeting', ti - 2, tj - 1, 'se', 'stand', { i: ti - 1.7, j: tj - 0.6 });
    f.spot('meeting', ti - 1, tj - 2, 'sw', 'stand', { i: ti - 0.6, j: tj - 1.7 });
  }
  if (!f.mount('whiteboard_wall', 'i', i0 + 1, 3)) f.put('whiteboard', i0 + 2, j0, false);
  f.spot('whiteboard', i0 + 2, j0 + 1, 'sw', 'stand', { i: i0 + 2, j: j0 + 0.8 });
  f.settle();
  f.mountAnywhere('tv_wall', 3);
  f.corners(['plant', 'plant', 'lamp'], 0.7);
  f.litter(['sticky_floor', 'cables'], 2);
  f.commit();
}

export function storageRoom(f: Fit): void {
  const { i0, j0, w, h } = f.r;
  f.spot('boxes', i0 + Math.floor(w / 2), j0 + Math.floor(h / 2), 'ne');
  f.settle();
  f.clutter(['box_pile', 'box_pile2', 'box', 'filing', 'crate_papers', 'box_half', 'paper_tall', 'box_long'], Math.round((w * h) / 3), 0.4);
  f.litter(['cables', 'sticky_floor'], 2);
  f.commit();
}

export function ceoRoom(f: Fit, seats: number): void {
  const { i0, j0, w, h } = f.r;
  f.rug('rug_red', i0 + Math.floor(w / 2) - 2, j0 + 3, 3, 2);
  f.put('exec_desk_gold', i0 + Math.floor(w / 2), j0 + 2);
  alongLeftWall(f, [{ kind: 'bookshelf', spot: 'shelf', w: 2 }, { kind: 'plant' }, { kind: 'bookshelf', spot: 'shelf', w: 2 }, { kind: 'lamp' }], 1);
  alongBackWall(f, [{ kind: 'plant' }, { kind: 'bookshelf', spot: 'shelf', w: 2 }], 0);
  f.put(f.rng.pick(['sofa', 'sofa_navy']), i0 + w - 1, j0 + h - 1, true);
  deskRoom(f, seats, () => 2, null, { sizes: [2, 2, 4] });
  f.settle();
  f.mountAnywhere('tv_wall', 3);
  f.corners(['plant', 'lamp', 'water_cooler'], 0.8);
  f.commit();
}

export function lobbyRoom(f: Fit): void {
  const { i0, j0, w, h } = f.r;
  f.rug('rug_sand', i0 + Math.floor(w / 2) - 1, j0 + Math.floor(h / 2) - 1, 3, 3);
  f.put('exec_desk', i0 + Math.floor(w / 2), j0 + 2);
  alongLeftWall(f, [{ kind: 'sofa_navy', w: 2 }, { kind: 'plant' }, { kind: 'sofa_navy', w: 2 }], 1, 1);
  alongBackWall(f, [{ kind: 'plant' }, { kind: 'water_cooler', spot: 'cooler' }], 0);
  for (let k = 0; k < 3; k++) {
    const i = i0 + 1 + f.rng.int(Math.max(1, w - 2));
    const j = j0 + 3 + f.rng.int(Math.max(1, h - 4));
    if (f.free(i, j)) f.spot('lobby', i, j, f.rng.pick(['ne', 'nw', 'se', 'sw'] as const));
  }
  f.settle();
  f.mountAnywhere('tv_wall', 3);
  f.corners(['plant', 'lamp'], 0.9);
  f.commit();
}

/** The founders' garage: the Vault's plaza in the middle (room for the money pile to grow), shared desks, a couch,
 *  boxes. The pile itself is drawn by the world (it follows the portfolio value). */
export function garageRoom(f: Fit, vault: Cell, seats: number): void {
  const { i0, j0, w, h } = f.r;
  for (let i = vault.i - 3; i <= vault.i + 2; i++) for (let j = vault.j - 3; j <= vault.j + 2; j++) if (f.inside(i, j)) f.reserve(i, j);
  // rats stop by to admire the pile
  const ring: Array<[number, number, Face]> = [
    [vault.i + 2, vault.j + 2, 'nw'], [vault.i - 3, vault.j + 2, 'ne'], [vault.i + 2, vault.j - 3, 'nw'],
  ];
  for (const [i, j, face] of ring) f.spot('vault', i, j, face);
  alongBackWall(f, [{ kind: 'coffee_counter', spot: 'coffee', w: 2 }, { kind: 'coffee_machine', spot: 'coffee' }, { kind: 'box_pile' }], 1);
  alongLeftWall(f, [{ kind: 'sofa', w: 2 }, { kind: 'box_pile2', w: 2 }], 2, 1);
  const variant = (): number => (f.rng.chance(0.5) ? 1 : 0);
  deskRoom(f, seats, variant, null, { sizes: [2, 3, 4] });
  f.mountAnywhere('whiteboard_wall', 3);
  f.mountAnywhere('tv_wall', 3);
  f.mountAnywhere('sticky_wall', 2);
  f.corners(['box_pile', 'box', 'plant', 'lamp'], 1);
  f.clutter(['box_s', 'box_s2', 'box_half', 'paper_stack', 'box_long', 'bin'], Math.round((w * h) / 18));
  f.litter(['cables', 'cable_run', 'spill', 'sticky_floor'], Math.round((w * h) / 12));
  f.commit();
}

/** Open-plan office: shared desks for every stock (the small-office stage). */
export function openRoom(f: Fit, seats: number): void {
  stockRoom(f, seats);
}

/** The evil empire's war room: a meeting room with a gold desk and screens everywhere. */
export function warRoom(f: Fit): void {
  const { i0, j0, w, h } = f.r;
  f.put('exec_desk_gold', i0 + Math.floor(w / 2), j0 + 2);
  meetingSeats(f, i0 + Math.floor(w / 2), j0 + Math.floor(h / 2) + 2);
  f.settle();
  for (let k = 0; k < 4; k++) f.mountAnywhere('tv_wall', 3);
  f.corners(['server_rack', 'server_rack', 'lamp'], 1);
  for (const p of f.B.props) if (p.kind.startsWith('server_rack') && p.scale === undefined) p.scale = 0.72;
  f.commit();
}

/** The vault: piles of cash bags and boxes. */
export function vaultRoom(f: Fit): void {
  const { w, h } = f.r;
  // the round steel door in the back corner, left ajar
  f.put('vault_door', f.r.i0 + 1, f.r.j0 + 1, false, { scale: 0.7 });
  f.spot('boxes', f.r.i0 + Math.floor(w / 2), f.r.j0 + Math.floor(h / 2), 'ne');
  f.settle();
  f.clutter(['cashbag', 'cashbag', 'cashbag', 'box_pile', 'box_half', 'filing'], Math.round((w * h) / 3), 0.3);
  f.commit();
}

function meetingSeats(f: Fit, ti: number, tj: number): void {
  if (!f.put('round_table', ti, tj)) return;
  f.spot('meeting', ti + 1, tj - 1, 'nw', 'sit', { i: ti + 0.7, j: tj - 0.55 });
  f.spot('meeting', ti + 1, tj, 'nw', 'sit', { i: ti + 0.7, j: tj + 0.25 });
  f.spot('meeting', ti - 1, tj + 1, 'ne', 'sit', { i: ti - 0.55, j: tj + 0.7 });
  f.spot('meeting', ti, tj + 1, 'ne', 'sit', { i: ti + 0.25, j: tj + 0.7 });
}
