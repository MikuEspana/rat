// Packs every room of the floor into one building with no gaps: a recursive split of a square (a slicing floor
// plan). The top few splits leave a 2-cell corridor between walls; deeper splits are a single shared wall, so most
// rooms touch their neighbours. The order of the room list decides where rooms land: the first room ends up in the
// back corner, the last in the front corner, and HQ is pinned to the centre (see pack()).
import type { RoomKind } from './types';

export interface Req {
  kind: RoomKind;
  symbol: string | null;
  seats: number;
  /** target interior area in cells */
  area: number;
  minSide: number;
  key: string;
}

export interface Rect {
  i0: number;
  j0: number;
  w: number;
  h: number;
}

export interface Placed {
  req: Req;
  rect: Rect;
}

export interface CorridorRect extends Rect {
  /** 'i': the corridor is a line of constant i (runs along j); 'j': runs along i */
  axis: 'i' | 'j';
}

export interface Packing {
  side: number;
  placed: Placed[];
  corridors: CorridorRect[];
}

export const CORRIDOR_W = 2;
const MIN_PART = 5;

function areaOf(list: readonly Req[]): number {
  let s = 0;
  for (const r of list) s += r.area;
  return s;
}

/** Index that splits the list into two runs of about equal area (order kept). */
export function balancedSplit(list: readonly Req[]): number {
  const total = areaOf(list);
  let acc = 0;
  let best = 1;
  let bestErr = Infinity;
  for (let k = 1; k < list.length; k++) {
    acc += list[k - 1]!.area;
    const e = Math.abs(acc - total / 2);
    if (e < bestErr) {
      bestErr = e;
      best = k;
    }
  }
  return best;
}

/** How bad a rectangle is for what goes in it: rooms want to be near square, groups tolerate more. */
function shapeCost([w, h]: [number, number], list: readonly Req[]): number {
  const lo = Math.min(w, h);
  const aspect = Math.max(w, h) / Math.max(1, lo);
  if (list.length === 1) {
    const q = list[0]!;
    return (lo < q.minSide ? 50 : 0) + Math.max(0, aspect - 1.4) ** 2 * 6 + Math.max(0, (w * h) / q.area - 1.5) * 3;
  }
  return Math.max(0, aspect - 2.2) ** 2 * 1.5;
}

function split(list: Req[], r: Rect, depth: number, lastCorr: 'i' | 'j' | null, out: Packing, corridors = true): void {
  if (list.length === 1) {
    out.placed.push({ req: list[0]!, rect: r });
    return;
  }
  // HQ sits at the building centre: in the first two splits it is made the last room of the first half, so it
  // lands in the corner of the first quadrant that touches both main corridors.
  let items = list;
  let k: number;
  let forced: number | null = null;
  const hqAt = items.findIndex((q) => q.kind === 'hq');
  if (hqAt >= 0 && depth <= 1 && items.length > 2) {
    const rest = items.filter((_, n) => n !== hqAt);
    k = balancedSplit(rest);
    items = [...rest.slice(0, k), items[hqAt]!, ...rest.slice(k)];
    forced = k + 1;
  }
  const len = (ax: 'i' | 'j'): number => (ax === 'i' ? r.w : r.h);
  const span = (ax: 'i' | 'j'): number => (ax === 'i' ? r.h : r.w);
  const longer: 'i' | 'j' = r.w >= r.h ? 'i' : 'j';
  // corridors: the first two splits always, big blocks below that; each corridor crosses its parent
  const options: Array<{ axis: 'i' | 'j'; corr: boolean }> = [];
  if (corridors && depth <= 3) {
    const want = lastCorr === null ? longer : lastCorr === 'i' ? 'j' : 'i';
    if ((depth <= 1 || span(want) >= 44) && len(want) >= 2 * MIN_PART + CORRIDOR_W + 2) options.push({ axis: want, corr: true });
  }
  if (!options.length) options.push({ axis: 'i', corr: false }, { axis: 'j', corr: false });
  const ks = forced !== null ? [forced] : Array.from({ length: items.length - 1 }, (_, n) => n + 1);
  const total = areaOf(items);
  let best: { axis: 'i' | 'j'; corr: boolean; k: number; a: number; score: number } | null = null;
  for (const o of options) {
    const t = o.corr ? CORRIDOR_W + 2 : 1;
    const avail = len(o.axis) - t;
    let acc = 0;
    for (let k = 1; k < items.length; k++) {
      acc += items[k - 1]!.area;
      if (!ks.includes(k)) continue;
      const frac = acc / total;
      let a = Math.round(avail * frac);
      a = Math.max(1, Math.min(Math.max(Math.min(MIN_PART, avail - 1), Math.min(a, avail - MIN_PART)), avail - 1));
      const dims = (side: number): [number, number] => (o.axis === 'i' ? [side, r.h] : [r.w, side]);
      const score =
        shapeCost(dims(a), items.slice(0, k)) + shapeCost(dims(avail - a), items.slice(k)) + Math.abs(frac - 0.5) * 0.8;
      if (!best || score < best.score) best = { axis: o.axis, corr: o.corr, k, a, score };
    }
  }
  const { axis, corr, k: kk, a } = best!;
  k = kk;
  const A = items.slice(0, k);
  const B = items.slice(k);
  const t = corr ? CORRIDOR_W + 2 : 1;
  let RA: Rect;
  let RB: Rect;
  if (axis === 'i') {
    RA = { i0: r.i0, j0: r.j0, w: a, h: r.h };
    RB = { i0: r.i0 + a + t, j0: r.j0, w: r.w - a - t, h: r.h };
    if (corr) out.corridors.push({ i0: r.i0 + a + 1, j0: r.j0, w: CORRIDOR_W, h: r.h, axis: 'i' });
  } else {
    RA = { i0: r.i0, j0: r.j0, w: r.w, h: a };
    RB = { i0: r.i0, j0: r.j0 + a + t, w: r.w, h: r.h - a - t };
    if (corr) out.corridors.push({ i0: r.i0, j0: r.j0 + a + 1, w: r.w, h: CORRIDOR_W, axis: 'j' });
  }
  const next = corr ? axis : lastCorr;
  split(A, RA, depth + 1, next, out, corridors);
  split(B, RB, depth + 1, next, out, corridors);
}

/** Pack into a square building interior [1, side] x [1, side]; grows the square until every room fits. */
export function pack(list: Req[], fixedSide?: number): Packing {
  const total = areaOf(list);
  let side = fixedSide ?? Math.max(24, Math.ceil(Math.sqrt(total * 1.12)));
  if (fixedSide) {
    const out: Packing = { side, placed: [], corridors: [] };
    split(list, { i0: 1, j0: 1, w: side, h: side }, 0, null, out);
    return out;
  }
  let last: Packing | null = null;
  for (let n = 0; n < 80; n++, side++) {
    const out: Packing = { side, placed: [], corridors: [] };
    split(list, { i0: 1, j0: 1, w: side, h: side }, 0, null, out);
    last = out;
    // a room or two a little under size is fine (their desks still fill); anything badly off grows the building
    const off = out.placed.filter((p) => Math.min(p.rect.w, p.rect.h) < p.req.minSide || p.rect.w * p.rect.h < p.req.area * 0.9);
    const bad = off.some((p) => Math.min(p.rect.w, p.rect.h) < p.req.minSide - 1 || p.rect.w * p.rect.h < p.req.area * 0.75);
    if (!bad && off.length <= Math.max(1, Math.round(out.placed.length * 0.06))) return out;
  }
  return last!;
}

/** Pack a list into a fixed rectangle with shared walls only (no corridors). */
export function packRect(list: Req[], rect: Rect): Placed[] {
  const out: Packing = { side: 0, placed: [], corridors: [] };
  if (list.length) split(list, rect, 4, null, out, false);
  return out.placed;
}
