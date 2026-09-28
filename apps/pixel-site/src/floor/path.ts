// Walking routes on the floor grid. A route to a target comes from a breadth-first distance field around that
// target (cached, so the coffee machine's field serves every rat that wants coffee). Walking down the field and
// keeping the current heading while it still leads downhill gives long straight legs with few turns, which suits
// sprites that only walk along the four grid directions.
import type { Cell } from '../iso';
import type { FloorLayout } from './types';

const UNSEEN = 0xffff;

export class Paths {
  private readonly fields = new Map<number, Uint16Array>();
  private readonly order: number[] = [];
  computed = 0;

  constructor(
    private readonly L: FloorLayout,
    private readonly cacheSize = 96,
  ) {}

  private walkable(k: number): boolean {
    return this.L.blocked[k] === 0;
  }

  /** Distance (in steps) from every cell to `target`. */
  field(target: Cell): Uint16Array {
    const { W, H } = this.L;
    const t = target.j * W + target.i;
    const hit = this.fields.get(t);
    if (hit) return hit;
    const f = new Uint16Array(W * H).fill(UNSEEN);
    const q = new Int32Array(W * H);
    let head = 0;
    let tail = 0;
    f[t] = 0;
    q[tail++] = t;
    while (head < tail) {
      const c = q[head++]!;
      const d = f[c]! + 1;
      const i = c % W;
      if (i + 1 < W && f[c + 1] === UNSEEN && this.walkable(c + 1)) (f[c + 1] = d), (q[tail++] = c + 1);
      if (i > 0 && f[c - 1] === UNSEEN && this.walkable(c - 1)) (f[c - 1] = d), (q[tail++] = c - 1);
      if (c + W < W * H && f[c + W] === UNSEEN && this.walkable(c + W)) (f[c + W] = d), (q[tail++] = c + W);
      if (c - W >= 0 && f[c - W] === UNSEEN && this.walkable(c - W)) (f[c - W] = d), (q[tail++] = c - W);
    }
    this.computed++;
    this.fields.set(t, f);
    this.order.push(t);
    if (this.order.length > this.cacheSize) this.fields.delete(this.order.shift()!);
    return f;
  }

  /**
   * Distance field limited to a window around two cells: cheap for short errands. Cells outside stay UNSEEN, so a
   * route that would have to leave the window fails and the caller falls back to the full field.
   */
  private windowField(a: Cell, b: Cell, margin: number): Uint16Array | null {
    const { W, H } = this.L;
    const i0 = Math.max(0, Math.min(a.i, b.i) - margin);
    const i1 = Math.min(W - 1, Math.max(a.i, b.i) + margin);
    const j0 = Math.max(0, Math.min(a.j, b.j) - margin);
    const j1 = Math.min(H - 1, Math.max(a.j, b.j) + margin);
    const f = this.scratch ?? (this.scratch = new Uint16Array(W * H));
    const q = this.queue ?? (this.queue = new Int32Array(W * H));
    for (let j = j0; j <= j1; j++) f.fill(UNSEEN, j * W + i0, j * W + i1 + 1);
    const t = b.j * W + b.i;
    let head = 0;
    let tail = 0;
    f[t] = 0;
    q[tail++] = t;
    const goal = a.j * W + a.i;
    while (head < tail) {
      const c = q[head++]!;
      if (c === goal) break;
      const d = f[c]! + 1;
      const i = c % W;
      const j = (c - i) / W;
      if (i < i1 && f[c + 1] === UNSEEN && this.walkable(c + 1)) (f[c + 1] = d), (q[tail++] = c + 1);
      if (i > i0 && f[c - 1] === UNSEEN && this.walkable(c - 1)) (f[c - 1] = d), (q[tail++] = c - 1);
      if (j < j1 && f[c + W] === UNSEEN && this.walkable(c + W)) (f[c + W] = d), (q[tail++] = c + W);
      if (j > j0 && f[c - W] === UNSEEN && this.walkable(c - W)) (f[c - W] = d), (q[tail++] = c - W);
    }
    if (f[goal] === UNSEEN) return null;
    // everything outside the window must read as unseen for the walk below
    this.window = { i0, i1, j0, j1 };
    return f;
  }

  private scratch: Uint16Array | null = null;
  private queue: Int32Array | null = null;
  private window: { i0: number; i1: number; j0: number; j1: number } | null = null;

  /** Cells from `from` to `to` (both included), as turning points only. Null when there is no way through. */
  route(from: Cell, to: Cell): Cell[] | null {
    const near = Math.abs(from.i - to.i) + Math.abs(from.j - to.j) < 90;
    if (near && !this.fields.has(to.j * this.L.W + to.i)) {
      const f = this.windowField(from, to, 10);
      if (f) {
        const out = this.descend(f, from, to, this.window);
        this.window = null;
        if (out) return out;
      }
    }
    return this.descend(this.field(to), from, to, null);
  }

  private descend(f: Uint16Array, from: Cell, to: Cell, win: { i0: number; i1: number; j0: number; j1: number } | null): Cell[] | null {
    const { W } = this.L;
    const inWin = (n: number): boolean => {
      if (!win) return true;
      const i = n % W;
      const j = (n - i) / W;
      return i >= win.i0 && i <= win.i1 && j >= win.j0 && j <= win.j1;
    };
    let c = from.j * W + from.i;
    if (f[c] === UNSEEN) return null;
    const pts: Cell[] = [{ i: from.i, j: from.j }];
    let dir = -1;
    const steps = [1, -1, W, -W];
    for (let guard = 0; f[c]! > 0 && guard < 100000; guard++) {
      const want = f[c]! - 1;
      let next = -1;
      let nd = -1;
      if (dir >= 0 && inWin(c + steps[dir]!) && f[c + steps[dir]!] === want) {
        next = c + steps[dir]!;
        nd = dir;
      } else {
        for (let k = 0; k < 4; k++) {
          const n = c + steps[k]!;
          if (n < 0 || n >= f.length) continue;
          if ((k === 0 && n % W === 0) || (k === 1 && c % W === 0) || !inWin(n)) continue;
          if (f[n] === want) {
            next = n;
            nd = k;
            break;
          }
        }
      }
      if (next < 0) return null;
      if (nd !== dir && dir >= 0) pts.push({ i: c % W, j: Math.floor(c / W) });
      dir = nd;
      c = next;
    }
    pts.push({ i: to.i, j: to.j });
    return pts;
  }
}
