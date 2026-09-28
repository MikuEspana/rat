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
}

type Off = ReadonlyArray<readonly [number, number]>;
const ONE: Off = [[0, 0]];
const I2: Off = [[0, 0], [-1, 0]];
const SQ2: Off = [[0, 0], [-1, 0], [0, -1], [-1, -1]];

/** Cells a prop covers, relative to its anchor (front) cell, unmirrored. Mirroring swaps i and j. */
export const FOOTPRINT: Record<string, Off> = {
  coffee_counter: I2, whiteboard: I2, filing: I2, filing_printer: I2, filing_plant: I2, sofa: I2, sofa_navy: I2,
  sofa_green: I2, bookshelf: I2, tv_stand: I2, copier: SQ2, exec_desk: SQ2, exec_desk_gold: SQ2, round_table: SQ2,
  box_pile2: SQ2, furnace: SQ2,
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
   * A desk and its chair. axis 'j': desk cells (si, sj-3..sj-1) in front of the chair, rat faces ne.
   * axis 'i': desk cells (si-3..si-1, sj), rat faces nw (sprites mirrored).
   */
  unit(si: number, sj: number, axis: 'i' | 'j', variant: number, symbol: string | null): Seat | null {
    if (this.seatsHere.length >= this.maxSeats) return null;
    const cells: Array<[number, number]> = [[si, sj]];
    for (let k = 1; k <= 3; k++) cells.push(axis === 'j' ? [si, sj - k] : [si - k, sj]);
    if (!cells.every(([a, b]) => this.free(a, b))) return null;
    this.setBlocked(cells, 1);
    const seat: Seat = {
      id: -1,
      room: this.r.id,
      symbol,
      cell: { i: si, j: sj },
      axis,
      desk: axis === 'j' ? { i: si + 1, j: sj - 1 } : { i: si - 1, j: sj + 1 },
      pos: axis === 'j' ? { i: si + 0.25, j: sj - 0.5 } : { i: si - 0.5, j: sj + 0.25 },
      access: { i: si, j: sj },
      dx: this.rng.range(-3, 3),
      dy: this.rng.range(-2, 2),
      variant,
    };
    this.seatsHere.push(seat);
    return seat;
  }

  private dropUnit(s: Seat): void {
    const cells: Array<[number, number]> = [[s.cell.i, s.cell.j]];
    for (let k = 1; k <= 3; k++) cells.push(s.axis === 'j' ? [s.cell.i, s.cell.j - k] : [s.cell.i - k, s.cell.j]);
    this.setBlocked(cells, 0);
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
        const { i, j } = s.cell;
        const order: Array<[number, number]> = s.axis === 'j' ? [[i, j + 1], [i - 1, j], [i + 1, j]] : [[i + 1, j], [i, j - 1], [i, j + 1]];
        const a = order.find(([ai, aj]) => this.reached(seen, { i: ai, j: aj }));
        if (a) s.access = { i: a[0], j: a[1] };
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

  private allReachable(): boolean {
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

type Area = { u0: number; u1: number; v0: number; v1: number };

function columns(f: Fit, a: Area, variant: () => number, sym: string | null, gap = 0.07): void {
  const { i0, j0 } = f.r;
  for (let u = a.u0; u <= a.u1; u += 3) {
    const phase = f.rng.int(2);
    for (const c of [u, u + 1]) {
      if (c > a.u1) continue;
      for (let v = a.v0 + 3 + phase; v <= a.v1; v += 4) if (!f.rng.chance(gap)) f.unit(i0 + c, j0 + v, 'j', variant(), sym);
    }
  }
}

function rows(f: Fit, a: Area, variant: () => number, sym: string | null, gap = 0.07): void {
  const { i0, j0 } = f.r;
  for (let v = a.v0; v <= a.v1; v += 3) {
    const phase = f.rng.int(2);
    for (const rr of [v, v + 1]) {
      if (rr > a.v1) continue;
      for (let u = a.u0 + 3 + phase; u <= a.u1; u += 4) if (!f.rng.chance(gap)) f.unit(i0 + u, j0 + rr, 'i', variant(), sym);
    }
  }
}

/** Small clusters of 2 or 3 desks dropped wherever they fit, each with its own orientation. */
function pods(f: Fit, a: Area, variant: () => number, sym: string | null, tries: number): void {
  const { i0, j0 } = f.r;
  for (let t = 0; t < tries; t++) {
    const n = f.rng.range(2, 3);
    const axis: 'i' | 'j' = f.rng.chance(0.5) ? 'i' : 'j';
    const bw = axis === 'j' ? n : 4;
    const bh = axis === 'j' ? 4 : n;
    if (a.u1 - a.u0 + 1 < bw + 2 || a.v1 - a.v0 + 1 < bh + 2) continue;
    const u = a.u0 + 1 + f.rng.int(a.u1 - a.u0 - bw);
    const v = a.v0 + 1 + f.rng.int(a.v1 - a.v0 - bh);
    let clear = true;
    for (let x = u - 1; x <= u + bw && clear; x++) for (let y = v - 1; y <= v + bh && clear; y++) if (!f.free(i0 + x, j0 + y)) clear = false;
    if (!clear) continue;
    for (let k = 0; k < n; k++) {
      if (axis === 'j') f.unit(i0 + u + k, j0 + v + 3, 'j', variant(), sym);
      else f.unit(i0 + u + 3, j0 + v + k, 'i', variant(), sym);
    }
  }
}

function perimeter(f: Fit, variant: () => number, sym: string | null): void {
  const { i0, j0, w, h } = f.r;
  const p = f.rng.int(2);
  for (let u = 3 + p; u <= w - 2; u += 4) f.unit(i0 + u, j0, 'i', variant(), sym);
  for (let v = 6 + p; v <= h - 2; v += 4) f.unit(i0, j0 + v, 'j', variant(), sym);
}

const CLUTTER = ['box_s', 'box_s2', 'paper_stack', 'paper_tall', 'bin', 'plant', 'box_half', 'crate_papers', 'box_long', 'papers'];
const BIG_CLUTTER = ['filing', 'filing_printer', 'filing_plant', 'box_pile', 'water_cooler', 'bookshelf', 'box'];
const LITTER = ['cables', 'cable_run', 'cable_loop', 'spill', 'sticky_floor', 'cables'];

export function stockRoom(f: Fit, seats: number): void {
  const { w, h } = f.r;
  f.maxSeats = seats;
  const sym = f.r.symbol;
  const clean = f.rng.next();
  const variant = (): number => (f.rng.next() < 0.35 + clean * 0.4 ? 1 : 0);
  const style = f.rng.pick(['columns', 'rows', 'split', 'perimeter', 'pods', 'mixed'] as const);
  const full: Area = { u0: 1, u1: w - 2, v0: 1, v1: h - 2 };
  if (style === 'columns') columns(f, full, variant, sym);
  else if (style === 'rows') rows(f, full, variant, sym);
  else if (style === 'split') {
    if (w >= h) {
      const m = Math.floor(w / 2);
      columns(f, { ...full, u1: m - 1 }, variant, sym);
      rows(f, { ...full, u0: m + 1 }, variant, sym);
    } else {
      const m = Math.floor(h / 2);
      rows(f, { ...full, v1: m - 1 }, variant, sym);
      columns(f, { ...full, v0: m + 1 }, variant, sym);
    }
  } else if (style === 'perimeter') {
    perimeter(f, variant, sym);
    (f.rng.chance(0.5) ? columns : rows)(f, { u0: 3, u1: w - 3, v0: 3, v1: h - 3 }, variant, sym, 0.12);
  } else if (style === 'pods') {
    pods(f, { u0: 0, u1: w - 1, v0: 0, v1: h - 1 }, variant, sym, 60 + w * h);
  } else {
    perimeter(f, variant, sym);
    pods(f, { u0: 1, u1: w - 1, v0: 1, v1: h - 1 }, variant, sym, 40 + w * h);
  }
  // still short of the target: structured fills in whatever space is left (they keep their own aisles)
  f.settle();
  if (f.seatCount < seats) {
    (w >= h ? columns : rows)(f, full, variant, sym, 0);
    f.settle();
  }
  if (f.seatCount < seats) {
    (w >= h ? rows : columns)(f, full, variant, sym, 0);
    f.settle();
  }
  if (f.seatCount < seats || f.rng.chance(0.3)) {
    pods(f, { u0: 0, u1: w - 1, v0: 0, v1: h - 1 }, variant, sym, 120);
    f.settle();
  }
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
  if (w >= 6 && h >= 6) f.put('round_table', i0 + Math.floor(w / 2) + 1, j0 + Math.floor(h / 2) + 1);
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
      f.put(kind, i0 + u, j0 + v, true, { bias: 0.02 });
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
  f.put('exec_desk_gold', i0 + Math.floor(w / 2), j0 + 2);
  alongLeftWall(f, [{ kind: 'bookshelf', spot: 'shelf', w: 2 }, { kind: 'plant' }, { kind: 'bookshelf', spot: 'shelf', w: 2 }, { kind: 'lamp' }], 1);
  alongBackWall(f, [{ kind: 'plant' }, { kind: 'bookshelf', spot: 'shelf', w: 2 }], 0);
  let placed = 0;
  for (let t = 0; t < 400 && placed < seats; t++) {
    const axis: 'i' | 'j' = f.rng.chance(0.5) ? 'i' : 'j';
    const si = i0 + (axis === 'i' ? 3 : 0) + f.rng.int(Math.max(1, w - (axis === 'i' ? 4 : 1)));
    const sj = j0 + (axis === 'j' ? 3 : 0) + f.rng.int(Math.max(1, h - (axis === 'j' ? 4 : 1)));
    if (f.unit(si, sj, axis, 2, null)) placed++;
  }
  f.put(f.rng.pick(['sofa', 'sofa_navy']), i0 + w - 1, j0 + h - 1, true);
  f.settle();
  f.mountAnywhere('tv_wall', 3);
  f.corners(['plant', 'lamp', 'water_cooler'], 0.8);
  f.commit();
}

export function hqRoom(f: Fit, furnace: Cell): void {
  f.put('furnace', furnace.i, furnace.j, false, { bias: 0.1 });
  const ring: Array<[number, number, Face]> = [
    [furnace.i + 1, furnace.j - 1, 'nw'], [furnace.i - 1, furnace.j + 1, 'ne'], [furnace.i + 1, furnace.j + 1, 'nw'],
    [furnace.i - 2, furnace.j, 'se'], [furnace.i, furnace.j - 2, 'sw'],
  ];
  for (const [i, j, face] of ring) f.spot('furnace', i, j, face);
  f.settle();
  f.clutter(['cashbag', 'cashbag', 'cashbag', 'box_half'], 6, 0.2);
  f.corners(['plant', 'lamp'], 1);
  f.mountAnywhere('tv_wall', 3);
  f.commit();
}

export function lobbyRoom(f: Fit): void {
  const { i0, j0, w, h } = f.r;
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

/** The founders' garage: the furnace in the middle (room around it to grow), shared desks, a couch, boxes. */
export function garageRoom(f: Fit, furnace: Cell, seats: number): void {
  const { i0, j0, w, h } = f.r;
  f.put('furnace', furnace.i, furnace.j, false, { bias: 0.1 });
  for (let i = furnace.i - 3; i <= furnace.i + 2; i++) for (let j = furnace.j - 3; j <= furnace.j + 2; j++) if (f.inside(i, j)) f.reserve(i, j);
  const ring: Array<[number, number, Face]> = [
    [furnace.i + 1, furnace.j + 1, 'nw'], [furnace.i - 2, furnace.j + 1, 'ne'], [furnace.i + 1, furnace.j - 2, 'nw'],
  ];
  for (const [i, j, face] of ring) f.spot('furnace', i, j, face);
  alongBackWall(f, [{ kind: 'coffee_counter', spot: 'coffee', w: 2 }, { kind: 'coffee_machine', spot: 'coffee' }, { kind: 'box_pile' }], 1);
  alongLeftWall(f, [{ kind: 'sofa', w: 2 }, { kind: 'box_pile2', w: 2 }], 2, 1);
  f.maxSeats = seats;
  const variant = (): number => (f.rng.chance(0.5) ? 1 : 0);
  pods(f, { u0: 0, u1: w - 1, v0: 0, v1: h - 1 }, variant, null, 400);
  f.settle();
  if (f.seatCount < seats) {
    columns(f, { u0: 1, u1: w - 2, v0: 1, v1: h - 2 }, variant, null, 0);
    f.settle();
  }
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

/** Wall Street's war room: a meeting room with a gold desk and screens everywhere. */
export function warRoom(f: Fit): void {
  const { i0, j0, w, h } = f.r;
  f.put('exec_desk_gold', i0 + Math.floor(w / 2), j0 + 2);
  meetingSeats(f, i0 + Math.floor(w / 2), j0 + Math.floor(h / 2) + 2);
  f.settle();
  for (let k = 0; k < 4; k++) f.mountAnywhere('tv_wall', 3);
  f.corners(['server_rack', 'server_rack', 'lamp'], 1);
  f.commit();
}

/** The vault: piles of cash bags and boxes. */
export function vaultRoom(f: Fit): void {
  const { w, h } = f.r;
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
