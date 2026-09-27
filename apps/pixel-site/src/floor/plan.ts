// The office floor, computed from the stock list. Pure and deterministic: same stocks + counts, same floor.
//
// 1. Room list: stock rooms (a big stock gets several rooms of different sizes), break rooms, bathrooms, meeting,
//    copy, server and storage rooms, the CEO corner office, HQ with the furnace, the lobby.
// 2. pack.ts packs them into one square building with thin corridors and shared walls.
// 3. Doors: every room gets one onto a corridor when it touches one; the rest open into a neighbour, until every
//    room is reachable from the lobby. A few extra doors make loops.
// 4. furnish.ts fills each room. The street ring outside has the subway stairs, lamps and smokers.
import type { Cell } from '../iso';
import {
  bathRoom, breakRoom, ceoRoom, copyRoom, Fit, hqRoom, lobbyRoom, meetingRoom, serverRoom, stockRoom, storageRoom, type Builder,
} from './furnish';
import { pack, type Req } from './pack';
import { Rng } from './rng';
import { FLOOR_STYLES, T, idx, type FloorLayout, type FloorStyle, type Room, type RoomKind, type Spot } from './types';

export interface StockInput {
  symbol: string;
  ratCount: number;
}

export interface LayoutOptions {
  /** partners on the roster: sizes the CEO office */
  partners?: number;
}

/** Seats per stock: room to grow, so new hires on this page still find a desk. */
export function capacityFor(ratCount: number): number {
  return Math.max(8, Math.ceil(ratCount * 1.2) + 4);
}

export const STREET_MARGIN = 7;
const CARPETS = [0xffffff, 0xeef1fb, 0xf4efe6, 0xe9f2ec, 0xf1ebf4, 0xe6edf5, 0xf7f1e1];

const ROOM_LOOK: Record<RoomKind, { floor: FloorStyle; tint: number }> = {
  stock: { floor: 'office', tint: 0xffffff },
  hq: { floor: 'warm', tint: 0xf6ecdc },
  ceo: { floor: 'warm', tint: 0xf2d9a4 },
  lobby: { floor: 'warm', tint: 0xefe6d6 },
  break: { floor: 'warm', tint: 0xf3e3c8 },
  bath: { floor: 'tile', tint: 0xdcf1ee },
  server: { floor: 'dark', tint: 0x8a93aa },
  copy: { floor: 'office', tint: 0xe6e8ee },
  meeting: { floor: 'office', tint: 0xe3eaf7 },
  storage: { floor: 'office', tint: 0xd9d0c2 },
};

export function requests(stocks: StockInput[], partners: number, grow: ReadonlyMap<string, number>): Req[] {
  const stockReqs: Req[] = [];
  for (const s of stocks) {
    const rng = new Rng(`stock:${s.symbol}`);
    let cap = Math.ceil(capacityFor(s.ratCount) * (grow.get(s.symbol) ?? 1));
    let n = 0;
    while (cap > 0) {
      let seats = Math.min(cap, rng.range(12, 34));
      if (cap - seats < 8) seats = cap;
      cap -= seats;
      stockReqs.push({ kind: 'stock', symbol: s.symbol, seats, area: Math.ceil(seats * 7) + 16, minSide: 7, key: `${s.symbol}:${n++}` });
    }
  }
  const S = Math.max(1, stockReqs.length);
  const rng = new Rng(`amenities:${S}`);
  const kinds: Array<[RoomKind, number, number, number]> = [
    ['break', Math.max(1, Math.round(S / 5)), 42, 72],
    ['meeting', Math.max(1, Math.round(S / 6)), 36, 60],
    ['bath', Math.max(1, Math.round(S / 7)), 30, 42],
    ['copy', Math.max(1, Math.round(S / 8)), 32, 46],
    ['server', Math.max(1, Math.round(S / 8)), 36, 60],
    ['storage', Math.max(1, Math.round(S / 10)), 20, 32],
  ];
  const amen: Req[] = [];
  for (let round = 0; amen.length < kinds.reduce((s, k) => s + k[1], 0); round++) {
    for (const [kind, count, a0, a1] of kinds) {
      if (round < count) amen.push({ kind, symbol: null, seats: 0, area: rng.range(a0, a1), minSide: 5, key: `${kind}:${round}` });
    }
  }
  const body: Req[] = [];
  const every = Math.max(1, Math.floor(S / Math.max(1, amen.length)) + 1);
  let a = 0;
  stockReqs.forEach((q, k) => {
    body.push(q);
    if ((k + 1) % every === 0 && a < amen.length) body.push(amen[a++]!);
  });
  while (a < amen.length) body.splice(Math.floor(rng.next() * (body.length + 1)), 0, amen[a++]!);
  const ceoSeats = Math.max(4, Math.min(16, partners));
  const ceo: Req = { kind: 'ceo', symbol: null, seats: ceoSeats, area: ceoSeats * 9 + 50, minSide: 8, key: 'ceo' };
  const hq: Req = { kind: 'hq', symbol: null, seats: 0, area: 100, minSide: 9, key: 'hq' };
  const lobby: Req = { kind: 'lobby', symbol: null, seats: 0, area: 64, minSide: 7, key: 'lobby' };
  body.splice(Math.floor(body.length / 2), 0, hq);
  return [ceo, ...body, lobby];
}

const N4: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function buildLayout(stocks: StockInput[], opts: LayoutOptions = {}): FloorLayout {
  // a stock whose rooms came out short of desks gets more room and the floor is rebuilt (same result every time)
  const grow = new Map<string, number>();
  let layout = build(stocks, opts, grow);
  for (let pass = 0; pass < 1; pass++) {
    let short = false;
    for (const s of stocks) {
      const have = (layout.bySymbol.get(s.symbol) ?? []).reduce((n, r) => n + r.seats.length, 0);
      if (have < s.ratCount) {
        grow.set(s.symbol, Math.min(1.5, (s.ratCount + 4) / Math.max(1, have)));
        short = true;
      }
    }
    if (!short) break;
    layout = build(stocks, opts, grow);
  }
  return layout;
}

function build(stocks: StockInput[], opts: LayoutOptions, grow: ReadonlyMap<string, number>): FloorLayout {
  const list = requests(stocks, opts.partners ?? 0, grow);
  const packing = pack(list);
  const M = STREET_MARGIN;
  const BW = packing.side + 2;
  const W = BW + 2 * M;
  const H = BW + 2 * M;
  const N = W * H;
  const B: Builder = {
    W,
    H,
    tile: new Uint8Array(N).fill(T.STREET),
    roomOf: new Int16Array(N).fill(-1),
    blocked: new Uint8Array(N),
    reserved: new Uint8Array(N),
    wallH: new Uint8Array(N),
    props: [],
    seats: [],
    spots: [],
  };
  const floorOf = new Uint8Array(N).fill(FLOOR_STYLES.indexOf('street'));
  const floorTint = new Uint32Array(N).fill(0x454c68);
  const at = (i: number, j: number): number => idx(W, i, j);
  const bi0 = M;
  const bi1 = M + BW; // exclusive
  for (let i = bi0; i < bi1; i++) for (let j = bi0; j < bi1; j++) B.tile[at(i, j)] = T.WALL;

  // rooms
  const rooms: Room[] = packing.placed.map((p, id) => {
    const look = ROOM_LOOK[p.req.kind];
    const tint = p.req.kind === 'stock' ? CARPETS[new Rng(`carpet:${p.req.key}`).int(CARPETS.length)]! : look.tint;
    return {
      id, kind: p.req.kind, symbol: p.req.symbol, i0: p.rect.i0 + M, j0: p.rect.j0 + M, w: p.rect.w, h: p.rect.h,
      floor: look.floor, tint, doors: [], ticker: null, seats: [], spots: [],
    };
  });
  for (const r of rooms) {
    for (let i = r.i0; i < r.i0 + r.w; i++) {
      for (let j = r.j0; j < r.j0 + r.h; j++) {
        const k = at(i, j);
        B.tile[k] = T.ROOM;
        B.roomOf[k] = r.id;
        floorOf[k] = FLOOR_STYLES.indexOf(r.floor);
        floorTint[k] = r.tint;
      }
    }
  }
  const corridorStyle = FLOOR_STYLES.indexOf('office');
  for (const c of packing.corridors) {
    for (let i = c.i0 + M; i < c.i0 + M + c.w; i++) {
      for (let j = c.j0 + M; j < c.j0 + M + c.h; j++) {
        B.tile[at(i, j)] = T.CORRIDOR;
        floorOf[at(i, j)] = corridorStyle;
        floorTint[at(i, j)] = 0xcbd3e0;
      }
    }
  }
  // corridor ends open into the corridor they run into
  for (const c of packing.corridors) {
    const ends: Array<[number, number, number, number]> =
      c.axis === 'i'
        ? [[c.i0 + M, c.j0 + M - 1, 0, -1], [c.i0 + M, c.j0 + M + c.h, 0, 1]]
        : [[c.i0 + M - 1, c.j0 + M, -1, 0], [c.i0 + M + c.w, c.j0 + M, 1, 0]];
    for (const [i, j, di, dj] of ends) {
      if (B.tile[at(i + di, j + dj)] !== T.CORRIDOR) continue;
      for (let k = 0; k < 2; k++) {
        const ci = c.axis === 'i' ? i + k : i;
        const cj = c.axis === 'i' ? j : j + k;
        B.tile[at(ci, cj)] = T.CORRIDOR;
        floorOf[at(ci, cj)] = corridorStyle;
        floorTint[at(ci, cj)] = 0xcbd3e0;
      }
    }
  }
  // wall heights: tall shell at the back, low at the front so the rooms there stay visible
  for (let i = bi0; i < bi1; i++) {
    for (let j = bi0; j < bi1; j++) {
      const k = at(i, j);
      if (B.tile[k] !== T.WALL) continue;
      B.wallH[k] = i === bi1 - 1 || j === bi1 - 1 ? 1 : i === bi0 || j === bi0 ? 3 : 2;
      floorOf[k] = corridorStyle;
      floorTint[k] = 0xcbd3e0;
    }
  }

  // tickers first (doors keep off them)
  const noDoor = new Set<number>();
  for (const r of rooms) {
    if (r.kind !== 'stock') continue;
    const rng = new Rng(`ticker:${r.id}:${r.symbol}`);
    const run = (axis: 'i' | 'j', s: number): boolean => {
      for (let k = 0; k < 7; k++) {
        const c = axis === 'i' ? at(s + k, r.j0 - 1) : at(r.i0 - 1, s + k);
        if (B.tile[c] !== T.WALL) return false;
      }
      return true;
    };
    const options: Array<{ i: number; j: number; axis: 'i' | 'j' }> = [];
    if (r.w >= 8) for (let s = r.i0; s + 7 <= r.i0 + r.w; s++) if (run('i', s)) options.push({ i: s, j: r.j0 - 1, axis: 'i' });
    if (!options.length && r.h >= 8) for (let s = r.j0; s + 7 <= r.j0 + r.h; s++) if (run('j', s)) options.push({ i: r.i0 - 1, j: s, axis: 'j' });
    if (!options.length) continue;
    r.ticker = options[rng.int(Math.min(options.length, 3))]!;
    for (let k = 0; k < 7; k++) noDoor.add(r.ticker.axis === 'i' ? at(r.ticker.i + k, r.ticker.j) : at(r.ticker.i, r.ticker.j + k));
  }

  // regions: rooms by id, corridor pieces by flood fill (10000 + n)
  const region = new Int32Array(N).fill(-1);
  for (let k = 0; k < N; k++) if (B.tile[k] === T.ROOM) region[k] = B.roomOf[k]!;
  let comp = 10000;
  for (let k = 0; k < N; k++) {
    if (B.tile[k] !== T.CORRIDOR || region[k] !== -1) continue;
    const q = [k];
    region[k] = comp;
    for (let h = 0; h < q.length; h++) {
      const c = q[h]!;
      const i = c % W;
      const j = Math.floor(c / W);
      for (const [a, b] of N4) {
        const n = at(i + a, j + b);
        if (B.tile[n] === T.CORRIDOR && region[n] === -1) {
          region[n] = comp;
          q.push(n);
        }
      }
    }
    comp++;
  }
  interface Cand {
    cell: number;
    a: number;
    b: number;
  }
  const cands = new Map<string, Cand[]>();
  for (let i = bi0 + 1; i < bi1 - 1; i++) {
    for (let j = bi0 + 1; j < bi1 - 1; j++) {
      const k = at(i, j);
      if (B.tile[k] !== T.WALL || noDoor.has(k)) continue;
      for (const [a, b] of [[1, 0], [0, 1]] as const) {
        const x = region[at(i - a, j - b)]!;
        const y = region[at(i + a, j + b)]!;
        if (x < 0 || y < 0 || x === y) continue;
        // a straight run of wall on both sides, so doors never sit in corners
        if (B.tile[at(i - b, j - a)] !== T.WALL || B.tile[at(i + b, j + a)] !== T.WALL) continue;
        const key = x < y ? `${x}:${y}` : `${y}:${x}`;
        const list = cands.get(key) ?? [];
        list.push({ cell: k, a: Math.min(x, y), b: Math.max(x, y) });
        cands.set(key, list);
      }
    }
  }
  const rng = new Rng(`doors:${stocks.map((s) => s.symbol).join(',')}:${packing.side}`);
  const links = new Map<number, Set<number>>();
  const link = (x: number, y: number): void => {
    if (!links.has(x)) links.set(x, new Set());
    if (!links.has(y)) links.set(y, new Set());
    links.get(x)!.add(y);
    links.get(y)!.add(x);
  };
  const open = (c: Cand, wide: boolean): void => {
    const doors = [c.cell];
    if (wide) {
      const same = cands.get(`${c.a}:${c.b}`)!.find((o) => o.cell !== c.cell && (Math.abs(o.cell - c.cell) === 1 || Math.abs(o.cell - c.cell) === W));
      if (same) doors.push(same.cell);
    }
    for (const d of doors) {
      if (B.tile[d] === T.DOOR) continue;
      B.tile[d] = T.DOOR;
      B.wallH[d] = 0;
      const cell = { i: d % W, j: Math.floor(d / W) };
      for (const x of [c.a, c.b]) if (x < 10000) rooms[x]!.doors.push(cell);
    }
    link(c.a, c.b);
  };
  const pickCand = (list: Cand[]): Cand => {
    // prefer the middle of a wall run over its ends
    const sorted = [...list].sort((p, q) => p.cell - q.cell);
    const lo = Math.floor(sorted.length * 0.2);
    const hi = Math.max(lo + 1, Math.ceil(sorted.length * 0.8));
    return sorted[lo + rng.int(hi - lo)]!;
  };
  for (const r of rooms) {
    const toCorr = [...cands.entries()].filter(([key]) => {
      const [x, y] = key.split(':').map(Number) as [number, number];
      return (x === r.id && y >= 10000) || (y === r.id && x >= 10000);
    });
    if (!toCorr.length) continue;
    const [, first] = toCorr[rng.int(toCorr.length)]!;
    open(pickCand(first), rng.chance(0.6));
    if (r.w * r.h > 150 && toCorr.length > 1) {
      const other = toCorr.find(([, l]) => l !== first);
      if (other) open(pickCand(other[1]), rng.chance(0.5));
    }
  }
  const lobbyRoom0 = rooms.find((r) => r.kind === 'lobby')!;
  for (let guard = 0; guard < 1000; guard++) {
    const seen = new Set<number>([lobbyRoom0.id]);
    const q = [lobbyRoom0.id];
    for (let h = 0; h < q.length; h++) for (const n of links.get(q[h]!) ?? []) if (!seen.has(n)) (seen.add(n), q.push(n));
    let best: Cand[] | null = null;
    for (const list of cands.values()) {
      const c = list[0]!;
      if (seen.has(c.a) !== seen.has(c.b)) {
        const corridorLink = c.a >= 10000 || c.b >= 10000;
        if (!best || corridorLink) best = list;
        if (corridorLink) break;
      }
    }
    if (!best) break;
    open(pickCand(best), false);
  }
  for (const list of cands.values()) {
    const c = list[0]!;
    if (c.a < 10000 && c.b < 10000 && !links.get(c.a)?.has(c.b) && rng.chance(0.3)) open(pickCand(list), false);
  }

  // main entrance: through the lobby's front wall to the street, subway stairs outside it
  const lobby = lobbyRoom0;
  let spawn: Cell;
  const frontRight = lobby.i0 + lobby.w === bi1 - 1;
  const frontLeft = lobby.j0 + lobby.h === bi1 - 1;
  if (frontRight || !frontLeft) {
    const i = bi1 - 1;
    const j = lobby.j0 + Math.floor(lobby.h / 2);
    for (const jj of [j - 1, j]) {
      B.tile[at(i, jj)] = T.DOOR;
      B.wallH[at(i, jj)] = 0;
      lobby.doors.push({ i, j: jj });
    }
    spawn = { i: i + 4, j: j - 0.5 };
  } else {
    const j = bi1 - 1;
    const i = lobby.i0 + Math.floor(lobby.w / 2);
    for (const ii of [i - 1, i]) {
      B.tile[at(ii, j)] = T.DOOR;
      B.wallH[at(ii, j)] = 0;
      lobby.doors.push({ i: ii, j });
    }
    spawn = { i: i - 0.5, j: j + 4 };
  }

  // furnish
  const hq = rooms.find((r) => r.kind === 'hq')!;
  const ceo = rooms.find((r) => r.kind === 'ceo')!;
  const furnace = { i: hq.i0 + Math.floor(hq.w / 2), j: hq.j0 + Math.floor(hq.h / 2) };
  const marble = FLOOR_STYLES.indexOf('marble');
  for (let i = furnace.i - 3; i <= furnace.i + 2; i++) for (let j = furnace.j - 3; j <= furnace.j + 2; j++) if (B.roomOf[at(i, j)] === hq.id) floorOf[at(i, j)] = marble;
  // the CEO office: gold carpet with a marble rug in the middle
  for (let i = ceo.i0 + 2; i < ceo.i0 + ceo.w - 2; i++) {
    for (let j = ceo.j0 + 2; j < ceo.j0 + ceo.h - 2; j++) {
      floorOf[at(i, j)] = marble;
      floorTint[at(i, j)] = 0xfff0d0;
    }
  }
  const reqOf = new Map(packing.placed.map((p, k) => [k, p.req]));
  for (const r of rooms) {
    const f = new Fit(B, r, new Rng(`room:${r.id}:${r.kind}:${r.symbol ?? ''}:${r.w}x${r.h}`));
    if (r.kind === 'stock') stockRoom(f, reqOf.get(r.id)?.seats ?? 12);
    else if (r.kind === 'break') breakRoom(f);
    else if (r.kind === 'bath') bathRoom(f);
    else if (r.kind === 'server') serverRoom(f);
    else if (r.kind === 'copy') copyRoom(f);
    else if (r.kind === 'meeting') meetingRoom(f);
    else if (r.kind === 'storage') storageRoom(f);
    else if (r.kind === 'ceo') ceoRoom(f, reqOf.get(r.id)?.seats ?? 4);
    else if (r.kind === 'hq') hqRoom(f, furnace);
    else lobbyRoom(f);
  }

  // the street: platform tiles and stairs at the subway, lamps along the building, smokers by the door
  const street = new Rng('street');
  const platform = FLOOR_STYLES.indexOf('platform');
  for (let i = Math.floor(spawn.i) - 2; i <= Math.floor(spawn.i) + 2; i++) {
    for (let j = Math.floor(spawn.j) - 2; j <= Math.floor(spawn.j) + 2; j++) {
      if (i >= 0 && j >= 0 && i < W && j < H && B.tile[at(i, j)] === T.STREET) {
        floorOf[at(i, j)] = platform;
        floorTint[at(i, j)] = 0x9aa1b8;
      }
    }
  }
  for (let k = 4; k < BW - 3; k += 11) {
    for (const [i, j, mirror] of [[bi0 + k, bi0 - 2, false], [bi0 - 2, bi0 + k, true], [bi0 + k, bi1 + 1, false], [bi1 + 1, bi0 + k, true]] as const) {
      if (Math.abs(i - spawn.i) + Math.abs(j - spawn.j) < 5 || B.blocked[at(i, j)]) continue;
      B.props.push({ kind: 'street_lamp', i, j, mirror, dx: 0, dy: 4, glow: 0xffcf7a });
      B.blocked[at(i, j)] = 1;
    }
  }
  const streetSpots: Spot[] = [];
  const nearDoor = lobby.doors[lobby.doors.length - 1]!;
  const out = nearDoor.i === bi1 - 1 ? { a: 1, b: 0 } : { a: 0, b: 1 };
  const side = out.a ? { a: 0, b: 1 } : { a: 1, b: 0 };
  const base = { i: nearDoor.i + out.a * 2 + side.a * 3, j: nearDoor.j + out.b * 2 + side.b * 3 };
  const smoke: Array<[number, number, 'se' | 'nw' | 'ne']> = [
    [base.i, base.j, 'se'],
    [base.i + 1, base.j, 'nw'],
    [base.i, base.j + 1, 'ne'],
  ];
  for (const [i, j, face] of smoke) streetSpots.push({ id: -1, kind: 'smoke', room: -1, cell: { i, j }, pos: { i, j }, face, pose: 'stand' });
  const deco: Array<[string, number, number]> = [
    ['plant', nearDoor.i + out.a * 1 - side.a * 2, nearDoor.j + out.b * 1 - side.b * 2],
    ['plant', nearDoor.i + out.a * 1 + side.a * 2, nearDoor.j + out.b * 1 + side.b * 2],
    ['bin', base.i - side.a * 1 + out.a * 2, base.j - side.b * 1 + out.b * 2],
    ['box_pile', nearDoor.i + out.a * 1 - side.a * 5, nearDoor.j + out.b * 1 - side.b * 5],
  ];
  for (const [kind, i, j] of deco) {
    if (B.blocked[at(i, j)] || B.tile[at(i, j)] !== T.STREET) continue;
    B.props.push({ kind, i, j, mirror: street.chance(0.5), dx: 0, dy: 4 });
    B.blocked[at(i, j)] = 1;
  }
  for (let k = 0; k < Math.round(W / 3); k++) {
    const i = street.int(W);
    const j = street.int(H);
    if (B.tile[at(i, j)] === T.STREET) B.props.push({ kind: street.pick(['cables', 'sticky_floor', 'spill']), i, j, mirror: street.chance(0.5), flat: true, dx: 0, dy: 0 });
  }
  B.props.push({ kind: 'stairs', i: Math.floor(spawn.i), j: Math.floor(spawn.j), mirror: false, flat: true, dx: 0, dy: 24 });

  // walls, doors and the void block walking; everything must be reachable from the subway
  for (let k = 0; k < N; k++) if (B.tile[k] === T.WALL || B.tile[k] === T.VOID) B.blocked[k] = 1;
  const reach = new Uint8Array(N);
  const s0 = at(Math.floor(spawn.i), Math.floor(spawn.j));
  B.blocked[s0] = 0;
  const q = [s0];
  reach[s0] = 1;
  for (let h = 0; h < q.length; h++) {
    const c = q[h]!;
    const i = c % W;
    const j = Math.floor(c / W);
    for (const [a, b] of N4) {
      const ni = i + a;
      const nj = j + b;
      if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      const n = at(ni, nj);
      if (!B.blocked[n] && !reach[n]) {
        reach[n] = 1;
        q.push(n);
      }
    }
  }
  const ok = (c: Cell): boolean => reach[at(c.i, c.j)] === 1;
  const seats = B.seats.filter((s) => ok(s.access));
  seats.forEach((s, k) => (s.id = k));
  const spots = [...B.spots, ...streetSpots].filter((s) => ok(s.cell));
  spots.forEach((s, k) => (s.id = k));
  for (const r of rooms) {
    r.seats = r.seats.filter((s) => ok(s.access));
    r.spots = r.spots.filter((s) => ok(s.cell));
  }

  const bySymbol = new Map<string, Room[]>();
  for (const r of rooms) {
    if (r.kind !== 'stock' || !r.symbol) continue;
    const l = bySymbol.get(r.symbol) ?? [];
    l.push(r);
    bySymbol.set(r.symbol, l);
  }
  const corridor: Cell[] = [];
  for (let k = 0; k < N; k++) if (B.tile[k] === T.CORRIDOR && reach[k]) corridor.push({ i: k % W, j: Math.floor(k / W) });

  return {
    W,
    H,
    tile: B.tile,
    roomOf: B.roomOf,
    blocked: B.blocked,
    wallH: B.wallH,
    floorOf,
    floorTint,
    rooms,
    seats,
    spots,
    props: B.props,
    bySymbol,
    hq,
    ceo,
    lobby,
    spawn: { i: Math.floor(spawn.i), j: Math.floor(spawn.j) },
    furnace,
    building: { i0: bi0, j0: bi0, i1: bi1, j1: bi1 },
    corridor,
  };
}

/** Walkable cells of a room nobody uses (standing room for rats without a desk). */
export function standCells(layout: FloorLayout, room: Room): Cell[] {
  const out: Cell[] = [];
  const used = new Set<string>();
  for (const s of room.seats) used.add(`${s.access.i},${s.access.j}`);
  for (const s of room.spots) used.add(`${s.cell.i},${s.cell.j}`);
  for (let i = room.i0; i < room.i0 + room.w; i++) {
    for (let j = room.j0; j < room.j0 + room.h; j++) {
      if (!layout.blocked[idx(layout.W, i, j)] && !used.has(`${i},${j}`)) out.push({ i, j });
    }
  }
  return out;
}
