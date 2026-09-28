// The master plan: every room the company will ever build, in fixed slots, from the founders' garage outwards.
// Pure and deterministic (seeded), and independent of the roster: growth.ts decides which rooms stand.
//
// The garage sits in the middle with the furnace. Each later stage adds a ring around the building: a 2-cell ring
// corridor hugging the old outer wall, then a band of rooms and a new outer wall. The band is four strips (back,
// right, front, left), each packed with shared walls (pack.ts). Ring 1 is open-plan offices; from ring 2 on, desk
// rooms are slots handed to whichever stock needs desks next. Amenities sit next to the ring corridor and open at
// set rat counts. Each ring has a lobby on its front side with the subway outside it.
import type { Cell } from '../iso';
import {
  bathRoom, breakRoom, ceoRoom, copyRoom, Fit, garageRoom, lobbyRoom, meetingRoom, openRoom, serverRoom, stockRoom,
  storageRoom, vaultRoom, warRoom, type Builder,
} from './furnish';
import { packRect, type Req } from './pack';
import { EASTER_EGGS, placeVignette } from './vignettes';
import { Rng } from './rng';
import { CORRIDOR_REGION, FLOOR_STYLES, T, idx, type Actor, type FloorLayout, type FloorStyle, type Ring, type Room, type RoomKind, type Spot } from './types';

export const STAGES: ReadonlyArray<{ name: string; min: number }> = [
  { name: 'GARAGE STARTUP', min: 0 },
  { name: 'SMALL OFFICE', min: 25 },
  { name: 'FULL FLOOR', min: 100 },
  { name: 'CORPORATE FLOOR', min: 500 },
  { name: 'MEGACORP', min: 1500 },
  { name: 'WALL STREET', min: 3000 },
];
/** the plan is drawn for about this many rats (it has a few hundred desks more); beyond its desks new hires line up
 * outside the lobby (queueCells) */
export const PLAN_RATS = 5200;

export function stageOf(ratCount: number): number {
  let s = 0;
  for (let k = 0; k < STAGES.length; k++) if (ratCount >= STAGES[k]!.min) s = k;
  return s;
}

export const STREET_MARGIN = 8;
const GARAGE = 18; // garage interior side
const GARAGE_SEATS = 26;

/** Floor colour per room type, strong enough to read zones from far away. */
export const ROOM_LOOK: Record<RoomKind, { floor: FloorStyle; tint: number; label: string }> = {
  garage: { floor: 'concrete', tint: 0xe4ddd0, label: 'GARAGE' },
  hq: { floor: 'marble', tint: 0xffffff, label: 'HQ' },
  open: { floor: 'carpet', tint: 0xc4d2ee, label: 'OPEN OFFICE' },
  stock: { floor: 'carpet', tint: 0x9fb6ea, label: '' },
  ceo: { floor: 'wood_j', tint: 0xffe2a8, label: 'CEO' },
  lobby: { floor: 'marble', tint: 0xcff2d6, label: 'LOBBY' },
  break: { floor: 'wood_i', tint: 0xffd6a8, label: 'BREAK ROOM' },
  bath: { floor: 'bath', tint: 0x9ff0e6, label: 'WC' },
  server: { floor: 'raised', tint: 0x9db0ee, label: 'SERVERS' },
  copy: { floor: 'vinyl', tint: 0xd4d4de, label: 'COPY' },
  meeting: { floor: 'carpet', tint: 0xcdb2ff, label: 'MEETING' },
  storage: { floor: 'concrete', tint: 0xd8b888, label: 'STORAGE' },
  war: { floor: 'carpet', tint: 0xe86a6a, label: 'WAR ROOM' },
  vault: { floor: 'marble', tint: 0xffdc78, label: 'VAULT' },
};
/** Stock rooms get one of these carpets each (all in the blue family, so desk rooms still read as one zone). */
const STOCK_CARPETS = [0x9fb6ea, 0x8fb0e0, 0xa8c0f0, 0x94a8dc, 0x9cc4e8, 0xb0b8e8];
export const CORRIDOR_TINT = 0xd6dbe4;
export const LOT_TINT = 0x2b3042;
export const STREET_TINT = 0x454c68;

interface RingSpec {
  seats: number;
  seatRange: [number, number];
  amenities: RoomKind[];
}

// ring 1..5; seats are the desks the ring adds (the stage's rat range plus some room)
const RINGS: RingSpec[] = [
  { seats: 84, seatRange: [18, 30], amenities: ['break', 'bath'] },
  { seats: 500, seatRange: [18, 32], amenities: ['break', 'meeting', 'bath', 'server', 'copy', 'break', 'storage', 'meeting'] },
  { seats: 1060, seatRange: [24, 40], amenities: ['ceo', 'break', 'meeting', 'bath', 'server', 'copy', 'break', 'meeting', 'storage', 'bath', 'server', 'break', 'copy'] },
  {
    seats: 1600, seatRange: [26, 44],
    amenities: ['break', 'meeting', 'bath', 'server', 'copy', 'break', 'meeting', 'storage', 'bath', 'server', 'break', 'copy', 'server', 'meeting', 'bath', 'storage'],
  },
  {
    seats: 2300, seatRange: [28, 46],
    amenities: ['war', 'vault', 'break', 'meeting', 'bath', 'server', 'copy', 'break', 'server', 'storage', 'bath', 'meeting', 'break', 'server', 'copy', 'bath', 'vault', 'server', 'break', 'storage'],
  },
];

const AMENITY_AREA: Partial<Record<RoomKind, [number, number]>> = {
  break: [48, 80], meeting: [40, 64], bath: [30, 44], server: [40, 70], copy: [32, 48], storage: [22, 36], ceo: [150, 190],
  war: [110, 150], vault: [60, 90], lobby: [56, 80],
};

function ringRequests(k: number, spec: RingSpec): Req[] {
  const rng = new Rng(`ring:${k}`);
  const desks: Req[] = [];
  let left = spec.seats;
  let n = 0;
  while (left > 0) {
    let seats = Math.min(left, rng.range(spec.seatRange[0], spec.seatRange[1]));
    if (left - seats < spec.seatRange[0] / 2) seats = left;
    left -= seats;
    desks.push({ kind: k === 1 ? 'open' : 'stock', symbol: null, seats, area: Math.ceil(seats * 8.5) + 16, minSide: 7, key: `r${k}:d${n++}` });
  }
  const amen: Req[] = [...spec.amenities, 'lobby' as RoomKind].map((kind, m) => {
    const [a0, a1] = AMENITY_AREA[kind] ?? [40, 60];
    return { kind, symbol: null, seats: kind === 'ceo' ? 12 : 0, area: rng.range(a0, a1), minSide: kind === 'ceo' || kind === 'war' ? 9 : 5, key: `r${k}:a${m}` };
  });
  // spread the amenities between the desk rooms
  const out: Req[] = [];
  const every = Math.max(1, Math.floor(desks.length / Math.max(1, amen.length)));
  let a = 0;
  desks.forEach((d, i) => {
    out.push(d);
    if ((i + 1) % every === 0 && a < amen.length) out.push(amen[a++]!);
  });
  while (a < amen.length) out.splice(rng.int(out.length + 1), 0, amen[a++]!);
  return out;
}

/** Room band depth so the band holds `area` cells around an inner square of side `a`. */
function bandDepth(a: number, area: number): number {
  return Math.max(7, Math.ceil((-(a + 4) + Math.sqrt((a + 4) ** 2 + area)) / 2));
}

export function buildMaster(): FloorLayout {
  // ring geometry, from the garage out
  const reqs = RINGS.map((spec, n) => ringRequests(n + 1, spec));
  const depth: number[] = [];
  let side = GARAGE + 2;
  for (const list of reqs) {
    const area = list.reduce((s, r) => s + r.area, 0) * 1.45;
    const d = bandDepth(side, area);
    depth.push(d);
    side += 2 * (d + 4);
  }
  const M = STREET_MARGIN;
  const W = side + 2 * M;
  const H = W;
  const N = W * H;
  const at = (i: number, j: number): number => idx(W, i, j);
  const B: Builder = {
    W, H,
    tile: new Uint8Array(N).fill(T.STREET),
    roomOf: new Int16Array(N).fill(-1),
    blocked: new Uint8Array(N),
    reserved: new Uint8Array(N),
    wallH: new Uint8Array(N),
    props: [],
    seats: [],
    spots: [],
    nextPod: 0,
  };
  const floorOf = new Uint8Array(N).fill(FLOOR_STYLES.indexOf('asphalt'));
  const floorTint = new Uint32Array(N).fill(STREET_TINT);
  const ringOf = new Uint8Array(N).fill(RINGS.length + 1);
  const rooms: Room[] = [];
  const rings: Ring[] = [];
  const carveRoom = (kind: RoomKind, i0: number, j0: number, w: number, h: number, ring: number): Room => {
    const look = ROOM_LOOK[kind];
    const r: Room = {
      id: rooms.length, kind, symbol: null, i0, j0, w, h, floor: look.floor, tint: look.tint, doors: [], ticker: null, seats: [], spots: [],
      ring, parent: -1, unlockAt: null, order: 0,
    };
    rooms.push(r);
    return r;
  };

  // squares: Q[k] is the outer wall square once ring k stands
  const C = M + (side - (GARAGE + 2)) / 2;
  const Q: Array<{ i0: number; i1: number }> = [{ i0: C, i1: C + GARAGE + 1 }];
  for (let k = 0; k < RINGS.length; k++) {
    const e = depth[k]! + 4;
    Q.push({ i0: Q[k]!.i0 - e, i1: Q[k]!.i1 + e });
  }
  for (let k = Q.length - 1; k >= 0; k--) {
    const q = Q[k]!;
    for (let i = q.i0; i <= q.i1; i++) {
      for (let j = q.i0; j <= q.i1; j++) {
        ringOf[at(i, j)] = k;
        if (k === Q.length - 1) B.tile[at(i, j)] = T.WALL;
      }
    }
  }

  // the garage
  const garage = carveRoom('garage', C + 1, C + 1, GARAGE, GARAGE, 0);
  const placed: Array<{ room: Room; req: Req | null }> = [{ room: garage, req: null }];

  // rings: corridor annulus, then four strips of rooms
  for (let k = 1; k <= RINGS.length; k++) {
    const a0 = Q[k - 1]!.i0;
    const a1 = Q[k - 1]!.i1;
    const b0 = Q[k]!.i0;
    const b1 = Q[k]!.i1;
    for (let i = a0 - 2; i <= a1 + 2; i++) {
      for (let j = a0 - 2; j <= a1 + 2; j++) {
        if (i >= a0 && i <= a1 && j >= a0 && j <= a1) continue;
        B.tile[at(i, j)] = T.CORRIDOR;
        floorOf[at(i, j)] = FLOOR_STYLES.indexOf('vinyl');
        floorTint[at(i, j)] = CORRIDOR_TINT;
      }
    }
    const strips = [
      { i0: b0 + 1, j0: b0 + 1, w: b1 - b0 - 1, h: a0 - 4 - b0 }, // back (low j)
      { i0: a1 + 4, j0: a0 - 2, w: b1 - a1 - 4, h: a1 - a0 + 5 }, // right (high i)
      { i0: b0 + 1, j0: a1 + 4, w: b1 - b0 - 1, h: b1 - a1 - 4 }, // front (high j)
      { i0: b0 + 1, j0: a0 - 2, w: a0 - 4 - b0, h: a1 - a0 + 5 }, // left (low i)
    ];
    const list = reqs[k - 1]!;
    const total = list.reduce((s, r) => s + r.area, 0);
    const stripArea = strips.reduce((s, r) => s + r.w * r.h, 0);
    let from = 0;
    let acc = 0;
    let target = 0;
    strips.forEach((st, n) => {
      target += (st.w * st.h) / stripArea;
      let to = from;
      while (to < list.length && (n === strips.length - 1 || (acc + list[to]!.area) / total <= target + 0.02)) acc += list[to++]!.area;
      const part = list.slice(from, to);
      from = to;
      for (const p of packRect(part, st)) placed.push({ room: carveRoom(p.req.kind, p.rect.i0, p.rect.j0, p.rect.w, p.rect.h, k), req: p.req });
    });
  }

  for (const r of rooms) {
    for (let i = r.i0; i < r.i0 + r.w; i++) {
      for (let j = r.j0; j < r.j0 + r.h; j++) {
        B.tile[at(i, j)] = T.ROOM;
        B.roomOf[at(i, j)] = r.id;
      }
    }
  }

  // doors, one ring at a time (a ring only ever opens onto its own corridor and rooms, so every stage stands alone)
  const doorSides = new Map<number, [number, number]>();
  const regionOf = (k: number): number => (B.tile[k] === T.ROOM ? B.roomOf[k]! : B.tile[k] === T.CORRIDOR ? CORRIDOR_REGION + ringOf[k]! : -1);
  const open = (cells: number[], a: number, b: number): void => {
    for (const d of cells) {
      B.tile[d] = T.DOOR;
      doorSides.set(d, [a, b]);
      const cell = { i: d % W, j: Math.floor(d / W) };
      for (const x of [a, b]) if (x >= 0 && x < CORRIDOR_REGION) rooms[x]!.doors.push(cell);
    }
  };
  for (let k = 1; k <= RINGS.length; k++) {
    const rng = new Rng(`doors:${k}`);
    const cands = new Map<string, Array<{ cell: number; a: number; b: number }>>();
    const q = Q[k]!;
    for (let i = q.i0 + 1; i < q.i1; i++) {
      for (let j = q.i0 + 1; j < q.i1; j++) {
        const c = at(i, j);
        if (B.tile[c] !== T.WALL || ringOf[c] !== k) continue;
        for (const [a, b] of [[1, 0], [0, 1]] as const) {
          const x = regionOf(at(i - a, j - b));
          const y = regionOf(at(i + a, j + b));
          if (x < 0 || y < 0 || x === y) continue;
          const rx = x >= CORRIDOR_REGION ? x - CORRIDOR_REGION : rooms[x]!.ring;
          const ry = y >= CORRIDOR_REGION ? y - CORRIDOR_REGION : rooms[y]!.ring;
          if (rx !== k || ry !== k) continue;
          if (B.tile[at(i - b, j - a)] !== T.WALL || B.tile[at(i + b, j + a)] !== T.WALL) continue;
          const key = `${Math.min(x, y)}:${Math.max(x, y)}`;
          const l = cands.get(key) ?? [];
          l.push({ cell: c, a: Math.min(x, y), b: Math.max(x, y) });
          cands.set(key, l);
        }
      }
    }
    const pick = (l: Array<{ cell: number; a: number; b: number }>): number => {
      const s = [...l].sort((p, r) => p.cell - r.cell);
      const lo = Math.floor(s.length * 0.25);
      const hi = Math.max(lo + 1, Math.ceil(s.length * 0.75));
      return s[lo + rng.int(hi - lo)]!.cell;
    };
    const corridor = CORRIDOR_REGION + k;
    const parentOf = new Map<number, number>();
    for (const [key, l] of cands) {
      const [x, y] = key.split(':').map(Number) as [number, number];
      if (y === corridor) {
        const c = pick(l);
        const wide = l.find((o) => Math.abs(o.cell - c) === 1 || Math.abs(o.cell - c) === W);
        open(wide && rng.chance(0.6) ? [c, wide.cell] : [c], x, y);
        parentOf.set(x, -1);
      }
    }
    // rooms off the corridor open into a neighbour that already connects (that neighbour is their parent)
    for (let guard = 0; guard < 500; guard++) {
      let best: { key: string; x: number; y: number } | null = null;
      for (const [key, l] of cands) {
        const { a, b } = l[0]!;
        if (a >= CORRIDOR_REGION || b >= CORRIDOR_REGION) continue;
        if (parentOf.has(a) !== parentOf.has(b)) {
          best = { key, x: a, y: b };
          break;
        }
      }
      if (!best) break;
      const l = cands.get(best.key)!;
      open([pick(l)], best.x, best.y);
      if (parentOf.has(best.x)) parentOf.set(best.y, best.x);
      else parentOf.set(best.x, best.y);
    }
    for (const r of rooms) if (r.ring === k) r.parent = parentOf.get(r.id) ?? -1;
  }

  // kinds: amenities must open straight onto the corridor; the lobby is the front-most such room on the outer wall
  const stageRange = (k: number): [number, number] => [STAGES[k]!.min, STAGES[k + 1]?.min ?? PLAN_RATS];
  const centre = C + (GARAGE + 2) / 2;
  const angle = (r: Room): number => {
    const a = Math.atan2(r.j0 + r.h / 2 - centre, r.i0 + r.w / 2 - centre) - Math.PI / 4; // 0 = the front corner
    return (a + Math.PI * 4) % (Math.PI * 2);
  };
  const setKind = (r: Room, kind: RoomKind): void => {
    r.kind = kind;
    r.floor = ROOM_LOOK[kind].floor;
    r.tint = ROOM_LOOK[kind].tint;
  };
  for (let k = 1; k <= RINGS.length; k++) {
    const rs = rooms.filter((r) => r.ring === k);
    const q = Q[k]!;
    const front = rs.filter((r) => r.parent === -1 && (r.i0 + r.w === q.i1 || r.j0 + r.h === q.i1));
    const lobby = front.sort((x, y) => y.i0 + y.w + y.j0 + y.h - (x.i0 + x.w + x.j0 + x.h))[0] ?? rs[0]!;
    const byReq = new Map(placed.filter((p) => p.room.ring === k && p.req).map((p) => [p.room.id, p.req!]));
    setKind(lobby, 'lobby');
    const desk: RoomKind = k === 1 ? 'open' : 'stock';
    const free = rs.filter((r) => r !== lobby && r.parent === -1);
    const assigned: Room[] = [];
    for (const kind of RINGS[k - 1]!.amenities) {
      let r = free.find((x) => !assigned.includes(x) && byReq.get(x.id)?.kind === kind);
      r ??= free.filter((x) => !assigned.includes(x) && byReq.get(x.id)?.kind === desk).sort((x, y) => x.w * x.h - y.w * y.h)[0];
      r ??= free.find((x) => !assigned.includes(x));
      if (!r) break;
      setKind(r, kind);
      assigned.push(r);
    }
    for (const r of rs) if (r !== lobby && !assigned.includes(r)) setKind(r, desk);
    // amenities open at even steps through their stage; desk rooms get a build order clockwise from the lobby
    const [lo, hi] = stageRange(k);
    assigned.forEach((r, n) => (r.unlockAt = Math.round(lo + ((n + 1) * (hi - lo)) / (assigned.length + 1))));
    rs.filter((r) => r.kind === desk).sort((x, y) => angle(x) - angle(y)).forEach((r, n) => (r.order = n));
    // the entrance: a double door in the lobby's front wall, the subway 4 cells out
    let entrance: Cell[];
    let spawn: Cell;
    if (lobby.i0 + lobby.w === q.i1) {
      const j = lobby.j0 + Math.floor(lobby.h / 2);
      entrance = [{ i: q.i1, j: j - 1 }, { i: q.i1, j }];
      spawn = { i: q.i1 + 4, j };
    } else {
      const i = lobby.i0 + Math.floor(lobby.w / 2);
      entrance = [{ i: i - 1, j: q.i1 }, { i, j: q.i1 }];
      spawn = { i, j: q.i1 + 4 };
    }
    open(entrance.map((c) => at(c.i, c.j)), lobby.id, -2);
    rings.push({ index: k, i0: q.i0, j0: q.i0, i1: q.i1, j1: q.i1, lobby: lobby.id, spawn, entrance });
  }
  // the garage's front door (onto the street at first, later onto the ring 1 corridor)
  const gd = [{ i: C + GARAGE / 2, j: C + GARAGE + 1 }, { i: C + GARAGE / 2 + 1, j: C + GARAGE + 1 }];
  open(gd.map((c) => at(c.i, c.j)), garage.id, -2);
  rings.unshift({ index: 0, i0: C, j0: C, i1: C + GARAGE + 1, j1: C + GARAGE + 1, lobby: garage.id, spawn: { i: C + GARAGE / 2 + 1, j: C + GARAGE + 5 }, entrance: gd });

  // tickers on desk-room slots, on plain wall runs (after the doors are cut)
  for (const r of rooms) {
    if (r.kind !== 'stock') continue;
    const rng = new Rng(`ticker:${r.id}`);
    const run = (axis: 'i' | 'j', s: number): boolean => {
      for (let k = 0; k < 7; k++) if (B.tile[axis === 'i' ? at(s + k, r.j0 - 1) : at(r.i0 - 1, s + k)] !== T.WALL) return false;
      return true;
    };
    const opts: Array<{ i: number; j: number; axis: 'i' | 'j' }> = [];
    if (r.w >= 8) for (let s = r.i0; s + 7 <= r.i0 + r.w; s++) if (run('i', s)) opts.push({ i: s, j: r.j0 - 1, axis: 'i' });
    if (!opts.length && r.h >= 8) for (let s = r.j0; s + 7 <= r.j0 + r.h; s++) if (run('j', s)) opts.push({ i: r.i0 - 1, j: s, axis: 'j' });
    if (opts.length) r.ticker = opts[rng.int(Math.min(3, opts.length))]!;
  }

  // floors: a look per room type, with a little variety between rooms of the same type
  for (const r of rooms) {
    const rng = new Rng(`floor:${r.id}`);
    if (r.kind === 'stock') r.tint = STOCK_CARPETS[rng.int(STOCK_CARPETS.length)]!;
    if (r.kind === 'break') r.floor = rng.pick(['wood_i', 'wood_j', 'checker'] as const);
    if (r.kind === 'meeting' && rng.chance(0.4)) {
      r.floor = rng.pick(['wood_i', 'wood_j'] as const);
      r.tint = 0xe8d8ff;
    }
    if (r.kind === 'open' && rng.chance(0.3)) r.floor = 'vinyl';
    for (let i = r.i0; i < r.i0 + r.w; i++) {
      for (let j = r.j0; j < r.j0 + r.h; j++) {
        floorOf[at(i, j)] = FLOOR_STYLES.indexOf(r.floor);
        floorTint[at(i, j)] = r.tint;
      }
    }
  }
  const furnace = { i: garage.i0 + GARAGE / 2, j: garage.j0 + GARAGE / 2 };
  for (let i = furnace.i - 3; i <= furnace.i + 2; i++) for (let j = furnace.j - 3; j <= furnace.j + 2; j++) floorOf[at(i, j)] = FLOOR_STYLES.indexOf('marble');
  const ceo = rooms.find((r) => r.kind === 'ceo') ?? garage;
  for (let i = ceo.i0 + 2; i < ceo.i0 + ceo.w - 2; i++) {
    for (let j = ceo.j0 + 2; j < ceo.j0 + ceo.h - 2; j++) {
      floorOf[at(i, j)] = FLOOR_STYLES.indexOf('marble');
      floorTint[at(i, j)] = 0xfff0d0;
    }
  }

  // furnish (deterministic per room)
  const reqOf = new Map(placed.map((p) => [p.room.id, p.req]));
  const deskSeats = (r: Room): number => Math.max(8, Math.min(48, Math.round((r.w * r.h - 16) / 7)));
  const actors: Actor[] = [];
  const usedByRing = new Map<number, Set<string>>();
  for (const r of rooms) {
    const f = new Fit(B, r, new Rng(`room:${r.id}:${r.kind}:${r.w}x${r.h}`));
    // a vignette first (it needs the most room); most amenity rooms get one
    if (r.kind !== 'stock' && r.kind !== 'open' && r.kind !== 'garage' && new Rng(`vig:${r.id}`).chance(0.8)) {
      const used = usedByRing.get(r.ring) ?? new Set<string>();
      usedByRing.set(r.ring, used);
      placeVignette(f, used, actors);
    }
    if (r.kind === 'garage') garageRoom(f, furnace, GARAGE_SEATS);
    else if (r.kind === 'stock') stockRoom(f, deskSeats(r));
    else if (r.kind === 'open') openRoom(f, deskSeats(r));
    else if (r.kind === 'break') breakRoom(f);
    else if (r.kind === 'bath') bathRoom(f);
    else if (r.kind === 'server') serverRoom(f);
    else if (r.kind === 'copy') copyRoom(f);
    else if (r.kind === 'meeting') meetingRoom(f);
    else if (r.kind === 'storage') storageRoom(f);
    else if (r.kind === 'ceo') ceoRoom(f, Math.max(8, reqOf.get(r.id)?.seats ?? 12));
    else if (r.kind === 'war') warRoom(f);
    else if (r.kind === 'vault') vaultRoom(f);
    else lobbyRoom(f);
  }

  // the rare props: one easter egg per ring, in a random room of it with space; the golden rat in the CEO office
  for (let k = 0; k <= RINGS.length; k++) {
    const rng = new Rng(`egg:${k}`);
    const egg = EASTER_EGGS[(k + rng.int(EASTER_EGGS.length)) % EASTER_EGGS.length]!;
    const cands = rng.shuffle(rooms.filter((r) => r.ring === k && r.w >= 5 && r.h >= 5));
    let done = false;
    for (const r of cands) {
      for (let t = 0; t < 30 && !done; t++) {
        const i = r.i0 + 1 + rng.int(r.w - 2);
        const j = r.j0 + 1 + rng.int(r.h - 2);
        const f = new Fit(B, r, rng);
        if (!f.free(i, j) || !f.free(i + 1, j) || !f.free(i, j + 1)) continue;
        const p = f.put(egg, i, j, rng.chance(0.5));
        if (p && !f.allReachable()) {
          B.props.splice(B.props.lastIndexOf(p), 1);
          B.blocked[at(i, j)] = 0;
        } else if (p) done = true;
      }
      if (done) break;
    }
  }

  // street furniture per stage (only the outermost ring's shows): lamps, smokers by the door, the subway stairs
  const streetSpots: Spot[] = [];
  for (const ring of rings) {
    const lo = ring.i0;
    const hi = ring.i1;
    for (let s = lo + 4; s < hi - 3; s += 11) {
      for (const [i, j] of [[s, lo - 2], [lo - 2, s], [s, hi + 2], [hi + 2, s]] as const) {
        if (Math.abs(i - ring.spawn.i) + Math.abs(j - ring.spawn.j) < 5) continue;
        B.props.push({ kind: 'street_lamp', i, j, mirror: false, dx: 0, dy: 4, glow: 0xffcf7a, ring: ring.index });
      }
    }
    const d = ring.entrance[1]!;
    const outI = d.i === hi ? 1 : 0;
    const outJ = outI ? 0 : 1;
    const base = { i: d.i + outI * 2 + outJ * 3, j: d.j + outJ * 2 + outI * 3 };
    for (const [i, j, face] of [[base.i, base.j, 'se'], [base.i + 1, base.j, 'nw'], [base.i, base.j + 1, 'ne']] as const) {
      streetSpots.push({ id: -1, kind: 'smoke', room: -1, cell: { i, j }, pos: { i, j }, face, pose: 'stand', ring: ring.index });
    }
    B.props.push({ kind: 'stairs', i: ring.spawn.i, j: ring.spawn.j, mirror: false, flat: true, dx: 0, dy: 24, ring: ring.index });
  }

  // walls and the void block walking (growth.ts adds what is not built yet)
  for (let k = 0; k < N; k++) if (B.tile[k] === T.WALL || B.tile[k] === T.VOID) B.blocked[k] = 1;
  B.seats.forEach((s, k) => (s.id = k));
  const spots = [...B.spots, ...streetSpots];
  spots.forEach((s, k) => (s.id = k));
  const corridor: Cell[] = [];
  for (let k = 0; k < N; k++) if (B.tile[k] === T.CORRIDOR) corridor.push({ i: k % W, j: Math.floor(k / W) });

  return {
    W, H,
    tile: B.tile, roomOf: B.roomOf, blocked: B.blocked, wallH: B.wallH, floorOf, floorTint,
    rooms, seats: B.seats, spots, props: B.props,
    bySymbol: new Map(),
    hq: garage, ceo, lobby: rooms[rings[rings.length - 1]!.lobby]!, garage,
    spawn: rings[0]!.spawn,
    furnace,
    building: { i0: Q[0]!.i0, j0: Q[0]!.i0, i1: Q[0]!.i1 + 1, j1: Q[0]!.i1 + 1 },
    corridor,
    rings, ringOf, doorSides,
    actors,
  };
}

/** Walkable cells of a room nobody uses (standing room for rats without a desk). */
export function standCells(layout: FloorLayout, room: Room, blocked: Uint8Array = layout.blocked): Cell[] {
  const out: Cell[] = [];
  const used = new Set<string>();
  for (const s of room.seats) used.add(`${s.access.i},${s.access.j}`);
  for (const s of room.spots) used.add(`${s.cell.i},${s.cell.j}`);
  for (let i = room.i0; i < room.i0 + room.w; i++) {
    for (let j = room.j0; j < room.j0 + room.h; j++) {
      if (!blocked[idx(layout.W, i, j)] && !used.has(`${i},${j}`)) out.push({ i, j });
    }
  }
  return out;
}

/** Street lanes of the job-fair line, at these distances from the outer wall (odd, so lamps at 2 stay clear). */
const LINE_LANES = [1, 3, 5, 7];

/**
 * The job-fair line for a stage: street cells in line order, from the head (next to the lobby door) outwards.
 * Rats with no desk stand here. Lane 1 runs along the outer wall all the way around the building, back to the other
 * side of the door; lane 3 runs back the other way, and so on: a line around the block. The walkway from the subway
 * stairs to the door, the smokers' corner, lamps and anything blocked stay clear. Pure and deterministic.
 */
export function queueCells(layout: FloorLayout, stage: number, blocked: Uint8Array = layout.blocked): Cell[] {
  const ring = layout.rings[stage]!;
  const lo = ring.i0;
  const hi = ring.i1;
  const door = ring.entrance[1]!;
  // the door is on the +i face (i = hi) or the +j face (j = hi); u runs along that face
  const onI = ring.entrance[0]!.i === hi && door.i === hi;
  const e = onI ? door.j : door.i;
  const props = new Set<number>();
  for (const p of layout.props) if (p.ring === stage) props.add(idx(layout.W, p.i, p.j));
  const clear = (c: Cell): boolean => {
    if (c.i < 0 || c.j < 0 || c.i >= layout.W || c.j >= layout.H) return false;
    const k = idx(layout.W, c.i, c.j);
    return !blocked[k] && !props.has(k);
  };
  /** the walkway and the smokers' corner (the smokers stand 3 and 4 cells along, on the +u side) */
  const inGap = (c: Cell, d: number): boolean => {
    const front = onI ? c.i === hi + d : c.j === hi + d;
    const u = onI ? c.j : c.i;
    return front && u >= e - 3 && u <= e + 5;
  };
  /** the square at distance d, clockwise in i/j, starting just outside the door */
  const loop = (d: number): Cell[] => {
    const a = lo - d;
    const b = hi + d;
    const cells: Cell[] = [];
    for (let i = a; i < b; i++) cells.push({ i, j: a });
    for (let j = a; j < b; j++) cells.push({ i: b, j });
    for (let i = b; i > a; i--) cells.push({ i, j: b });
    for (let j = b; j > a; j--) cells.push({ i: a, j });
    const s = cells.findIndex((c) => (onI ? c.i === b && c.j === e : c.j === b && c.i === e));
    return [...cells.slice(s), ...cells.slice(0, s)];
  };
  // lane 1 first heads for the far corner (the long side of the front), so the head of the line is by the door
  const probe = loop(1)[1]!;
  const towardLow = (onI ? probe.j : probe.i) < e;
  const longLow = e - lo > hi - e;
  let forward = towardLow === longLow;
  const out: Cell[] = [];
  const seen = new Set<number>();
  const push = (c: Cell): void => {
    const k = idx(layout.W, c.i, c.j);
    if (seen.has(k) || !clear(c)) return;
    seen.add(k);
    out.push(c);
  };
  for (const d of LINE_LANES) {
    const l = loop(d);
    const order = forward ? l : [l[0]!, ...l.slice(1).reverse()];
    const lane = order.filter((c) => !inGap(c, d));
    // the step out from the lane before: one cell between the lanes, on the side where it ended
    if (out.length && lane.length) {
      const last = out[out.length - 1]!;
      const first = lane[0]!;
      push({ i: (last.i + first.i) / 2, j: (last.j + first.j) / 2 });
    }
    for (const c of lane) push(c);
    forward = !forward;
  }
  return out;
}
