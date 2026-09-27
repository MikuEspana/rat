// The office floor, computed from the stock list. Pure and deterministic: same stocks + counts, same floor.
//
// Rooms sit in a grid of equal slots with corridors between them. HQ (the furnace) takes a middle slot, the subway
// entrance the front corner slot, stock rooms the slots nearest HQ. Each room hugs the front corner of its slot, so
// its open front edges face the corridors and its two back walls face away from the camera.

import type { Cell } from './iso';

export const DESK_PITCH = 3; // cells between desks along i and between rows along j
export const BACK_MARGIN = 3; // keeps rats clear of the wall ticker
export const FRONT_MARGIN = 2; // walkway at the open front of a room
export const CORRIDOR = 4; // corridor width in cells
export const SEAT_OFFSET: Cell = { i: -0.75, j: 0.5 }; // seated rat relative to its desk cell (tuned on the sprites)
export const HQ_SIZE = 16;
export const SUBWAY_SIZE = 12;

export type RoomKind = 'stock' | 'hq' | 'subway' | 'lounge';
export type DecorKind = 'plant' | 'lamp' | 'bin' | 'papers' | 'cables';

export interface Seat {
  index: number;
  deskI: number;
  deskJ: number;
  /** seat position (where the rat's chair stands) */
  i: number;
  j: number;
  /** walkway row in front of this seat's desk row */
  aisleJ: number;
}

export interface Decor {
  kind: DecorKind;
  i: number;
  j: number;
  mirror: boolean;
}

export interface Room {
  kind: RoomKind;
  symbol: string | null;
  slotA: number;
  slotB: number;
  i0: number;
  j0: number;
  w: number;
  h: number;
  seats: Seat[];
  decor: Decor[];
  /** corridor junction at the room's front corner: every path enters and leaves a room here */
  junction: Cell;
  /** cell range along the back wall (j = j0 - 1) where the wall ticker hangs */
  tickerI: number | null;
}

export interface FloorLayout {
  cols: number;
  rows: number;
  slot: number;
  rooms: Room[];
  bySymbol: Map<string, Room>;
  hq: Room;
  subway: Room;
  /** where new rats appear (top of the subway stairs) */
  spawn: Cell;
  /** furnace position in HQ */
  furnace: Cell;
  /** whole-number scale for the furnace, so it keeps its pixels and still reads in a big HQ */
  furnaceScale: number;
  bounds: { i0: number; j0: number; i1: number; j1: number };
}

export interface StockInput {
  symbol: string;
  ratCount: number;
}

/** Seats per stock room: room to grow, so new hires on this page still find a desk. */
export function capacityFor(ratCount: number): number {
  return Math.max(12, Math.ceil(ratCount * 1.3) + 6);
}

export function roomGrid(capacity: number): { cols: number; rows: number } {
  const cols = Math.max(2, Math.ceil(Math.sqrt(capacity)));
  const rows = Math.max(2, Math.ceil(capacity / cols));
  return { cols, rows };
}

function stockRoomSize(capacity: number): { w: number; h: number; cols: number; rows: number } {
  const { cols, rows } = roomGrid(capacity);
  return { w: BACK_MARGIN + cols * DESK_PITCH + FRONT_MARGIN, h: BACK_MARGIN + rows * DESK_PITCH + FRONT_MARGIN, cols, rows };
}

/** Small deterministic hash for decor placement. */
export function hash32(s: string): number {
  let h = 2166136261;
  for (let k = 0; k < s.length; k++) {
    h ^= s.charCodeAt(k);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function decorFor(room: Room): Decor[] {
  const out: Decor[] = [];
  const h = hash32(`${room.kind}:${room.symbol ?? ''}:${room.slotA}:${room.slotB}`);
  const { i0, j0, w, h: rh } = room;
  if (room.kind === 'stock') {
    out.push({ kind: 'plant', i: i0 + 0.2, j: j0 + 0.4, mirror: false });
    out.push({ kind: 'plant', i: i0 + 0.3, j: j0 + rh - 1.2, mirror: (h & 1) === 1 });
    out.push({ kind: 'lamp', i: i0 + w - 1.2, j: j0 + 0.3, mirror: false });
    out.push({ kind: 'bin', i: i0 + 1.1, j: j0 + rh - 0.4 - (h % 3), mirror: false });
    out.push({ kind: 'papers', i: i0 + w - 0.6, j: j0 + 1.6 + (h % 2), mirror: (h & 2) === 2 });
    out.push({ kind: 'cables', i: i0 + w - 1.4, j: j0 + rh - 0.6, mirror: false });
  } else if (room.kind === 'hq') {
    const ci = i0 + w / 2;
    const cj = j0 + rh / 2;
    const q = Math.max(3, Math.floor(w / 6)) + 0.6; // plaza corners, matches the marble plaza in world/build.ts
    out.push({ kind: 'plant', i: ci - q, j: cj - q, mirror: false });
    out.push({ kind: 'plant', i: ci + q - 1, j: cj - q, mirror: true });
    out.push({ kind: 'plant', i: ci - q, j: cj + q - 1, mirror: false });
    out.push({ kind: 'plant', i: ci + q - 1, j: cj + q - 1, mirror: true });
    out.push({ kind: 'lamp', i: i0 + 0.6, j: j0 + 0.4, mirror: false });
    out.push({ kind: 'lamp', i: i0 + w - 1.0, j: j0 + rh - 1.0, mirror: true });
    out.push({ kind: 'papers', i: i0 + 1.2, j: j0 + rh - 1.4, mirror: false });
  } else if (room.kind === 'subway') {
    const ci = i0 + w / 2;
    const cj = j0 + rh / 2;
    out.push({ kind: 'plant', i: ci - 4.2, j: cj - 4.2, mirror: false });
    out.push({ kind: 'plant', i: ci + 3.4, j: cj - 4.2, mirror: true });
    out.push({ kind: 'bin', i: ci - 4.2, j: cj + 3.2, mirror: false });
  } else if (room.kind === 'lounge') {
    out.push({ kind: 'plant', i: i0 + w / 2 - 1, j: j0 + rh / 2 - 1, mirror: false });
    out.push({ kind: 'plant', i: i0 + w / 2 + 1, j: j0 + rh / 2 + 1, mirror: true });
    out.push({ kind: 'papers', i: i0 + w / 2 + 1.5, j: j0 + rh / 2 - 1.5, mirror: false });
  }
  return out;
}

export function buildLayout(stocks: StockInput[]): FloorLayout {
  const n = stocks.length;
  const cols = Math.max(2, Math.ceil(Math.sqrt(n + 2)));
  const rows = Math.max(2, Math.ceil((n + 2) / cols));
  const sizes = stocks.map((s) => stockRoomSize(capacityFor(s.ratCount)));
  const slot = Math.max(HQ_SIZE, SUBWAY_SIZE, ...sizes.map((s) => Math.max(s.w, s.h)));
  const pitch = slot + CORRIDOR;

  const hqA = Math.floor((cols - 1) / 2);
  const hqB = Math.floor((rows - 1) / 2);
  const subA = cols - 1;
  const subB = rows - 1;
  const free: Array<{ a: number; b: number }> = [];
  for (let a = 0; a < cols; a++) {
    for (let b = 0; b < rows; b++) {
      if ((a === hqA && b === hqB) || (a === subA && b === subB)) continue;
      free.push({ a, b });
    }
  }
  free.sort((p, q) => Math.hypot(p.a - hqA, p.b - hqB) - Math.hypot(q.a - hqA, q.b - hqB) || p.a - q.a || p.b - q.b);

  const junctionOf = (a: number, b: number): Cell => ({ i: a * pitch + slot + CORRIDOR / 2, j: b * pitch + slot + CORRIDOR / 2 });
  const place = (kind: RoomKind, symbol: string | null, a: number, b: number, w: number, h: number): Room => ({
    kind,
    symbol,
    slotA: a,
    slotB: b,
    i0: a * pitch + slot - w,
    j0: b * pitch + slot - h,
    w,
    h,
    seats: [],
    decor: [],
    junction: junctionOf(a, b),
    tickerI: null,
  });

  const rooms: Room[] = [];
  const bySymbol = new Map<string, Room>();
  stocks.forEach((s, k) => {
    const spot = free[k];
    const size = sizes[k];
    if (!spot || !size) return;
    const room = place('stock', s.symbol, spot.a, spot.b, size.w, size.h);
    let index = 0;
    for (let r = 0; r < size.rows; r++) {
      for (let c = 0; c < size.cols; c++) {
        const deskI = room.i0 + BACK_MARGIN + c * DESK_PITCH + 1;
        const deskJ = room.j0 + BACK_MARGIN + r * DESK_PITCH;
        room.seats.push({
          index: index++,
          deskI,
          deskJ,
          i: deskI + SEAT_OFFSET.i,
          j: deskJ + SEAT_OFFSET.j,
          aisleJ: deskJ + 1.6,
        });
      }
    }
    // fill order is a fixed shuffle, so a half-full room looks evenly busy instead of full at the back
    room.seats.sort((x, y) => hash32(`${s.symbol}:${x.deskI}:${x.deskJ}`) - hash32(`${s.symbol}:${y.deskI}:${y.deskJ}`));
    room.seats.forEach((seat, k) => (seat.index = k));
    room.tickerI = room.i0;
    rooms.push(room);
    bySymbol.set(s.symbol, room);
  });
  for (let k = stocks.length; k < free.length; k++) {
    const spot = free[k];
    if (spot) rooms.push(place('lounge', null, spot.a, spot.b, Math.min(slot, 10), Math.min(slot, 10)));
  }
  const hq = place('hq', null, hqA, hqB, slot, slot); // HQ fills its slot
  const subwaySize = Math.min(slot, SUBWAY_SIZE + Math.floor((slot - SUBWAY_SIZE) / 3));
  const subway = place('subway', null, subA, subB, subwaySize, subwaySize);
  rooms.push(hq, subway);
  for (const r of rooms) r.decor = decorFor(r);

  return {
    cols,
    rows,
    slot,
    rooms,
    bySymbol,
    hq,
    subway,
    spawn: { i: subway.i0 + subwaySize / 2, j: subway.j0 + subwaySize / 2 },
    furnace: { i: hq.i0 + slot / 2, j: hq.j0 + slot / 2 },
    furnaceScale: Math.max(1, Math.floor(slot / 20)),
    bounds: { i0: -2, j0: -2, i1: cols * pitch, j1: rows * pitch },
  };
}

/**
 * Waypoints from the subway stairs to a seat, walking only on corridor lines and room aisles:
 * stairs -> subway junction -> along the front corridor to the target column -> along that column's corridor to
 * the target junction -> along the room's front walkway to the seat's aisle -> down the aisle -> into the seat.
 */
export function pathToSeat(layout: FloorLayout, room: Room, seat: Seat): Cell[] {
  const s = layout.spawn;
  const q0 = layout.subway.junction;
  const q1 = room.junction;
  const pts: Cell[] = [
    { i: s.i, j: s.j },
    { i: q0.i - CORRIDOR / 2 - 0.5, j: s.j },
    { i: q0.i, j: s.j },
    { i: q0.i, j: q0.j },
    { i: q1.i, j: q0.j },
    { i: q1.i, j: q1.j },
    { i: q1.i, j: seat.aisleJ },
    { i: seat.i, j: seat.aisleJ },
    { i: seat.i, j: seat.j },
  ];
  // drop zero-length legs
  return pts.filter((p, k) => {
    const prev = pts[k - 1];
    return !prev || Math.abs(prev.i - p.i) > 1e-6 || Math.abs(prev.j - p.j) > 1e-6;
  });
}

/** Standing spot for rats beyond a room's capacity: the front walkway, packed, deterministic by rat id. */
export function overflowSpot(room: Room, ratId: number): Cell {
  const h = hash32(`overflow:${ratId}`);
  const span = Math.max(1, room.w - 2);
  return { i: room.i0 + 1 + (h % span) + ((h >>> 8) % 100) / 100, j: room.j0 + room.h - 1 + ((h >>> 16) % 100) / 120 };
}
