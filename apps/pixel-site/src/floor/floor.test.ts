import { describe, expect, it } from 'vitest';
import { Paths } from './path';
import { buildLayout, capacityFor } from './plan';
import { T, idx, type FloorLayout } from './types';

const MOCK = [
  ['TSLAx', 61], ['MSTRx', 49], ['COINx', 30], ['AMDx', 34], ['NVDAx', 43],
  ['AAPLx', 34], ['METAx', 24], ['AMZNx', 30], ['GOOGLx', 40], ['SPYx', 32],
].map(([symbol, ratCount]) => ({ symbol: symbol as string, ratCount: ratCount as number }));

function reachable(L: FloorLayout): Uint8Array {
  const seen = new Uint8Array(L.W * L.H);
  const s = idx(L.W, L.spawn.i, L.spawn.j);
  const q = [s];
  seen[s] = 1;
  for (let h = 0; h < q.length; h++) {
    const c = q[h]!;
    const i = c % L.W;
    for (const n of [i + 1 < L.W ? c + 1 : -1, i > 0 ? c - 1 : -1, c + L.W, c - L.W]) {
      if (n < 0 || n >= seen.length || seen[n] || L.blocked[n]) continue;
      seen[n] = 1;
      q.push(n);
    }
  }
  return seen;
}

describe('floor plan', () => {
  const L = buildLayout(MOCK, { partners: 6 });

  it('is deterministic', () => {
    const again = buildLayout(MOCK, { partners: 6 });
    expect(again.W).toBe(L.W);
    expect(again.seats.length).toBe(L.seats.length);
    expect(again.props.length).toBe(L.props.length);
    expect(Buffer.from(again.tile).equals(Buffer.from(L.tile))).toBe(true);
  });

  it('gives every stock enough desks and a ticker on each of its rooms', () => {
    for (const s of MOCK) {
      const rooms = L.bySymbol.get(s.symbol) ?? [];
      expect(rooms.length).toBeGreaterThan(0);
      const seats = rooms.reduce((n, r) => n + r.seats.length, 0);
      expect(seats).toBeGreaterThanOrEqual(s.ratCount);
      for (const r of rooms) expect(r.ticker).not.toBeNull();
    }
    expect(capacityFor(10)).toBeGreaterThan(10);
  });

  it('has every kind of room, HQ near the middle and the CEO office holding desks', () => {
    const kinds = new Set(L.rooms.map((r) => r.kind));
    for (const k of ['stock', 'hq', 'ceo', 'lobby', 'break', 'bath', 'server', 'copy', 'meeting', 'storage'] as const) expect(kinds.has(k)).toBe(true);
    const b = L.building;
    const mid = (b.i0 + b.i1) / 2;
    const side = b.i1 - b.i0;
    expect(Math.abs(L.hq.i0 + L.hq.w / 2 - mid)).toBeLessThan(side * 0.25);
    expect(Math.abs(L.hq.j0 + L.hq.h / 2 - mid)).toBeLessThan(side * 0.25);
    expect(L.hq.w * L.hq.h).toBeLessThanOrEqual(260); // it used to fill a whole 28x28 slot
    expect(L.ceo.seats.length).toBeGreaterThanOrEqual(4);
  });

  it('is packed: rooms do not overlap and fill most of the building', () => {
    const owner = new Int16Array(L.W * L.H).fill(-1);
    let roomCells = 0;
    for (const r of L.rooms) {
      for (let i = r.i0; i < r.i0 + r.w; i++) {
        for (let j = r.j0; j < r.j0 + r.h; j++) {
          expect(owner[idx(L.W, i, j)]).toBe(-1);
          owner[idx(L.W, i, j)] = r.id;
          roomCells++;
        }
      }
      expect(Math.max(r.w, r.h) / Math.min(r.w, r.h)).toBeLessThan(6);
    }
    const b = L.building;
    expect(roomCells / ((b.i1 - b.i0) * (b.j1 - b.j0))).toBeGreaterThan(0.6);
  });

  it('keeps every chair, spot and corridor reachable from the subway', () => {
    const seen = reachable(L);
    for (const s of L.seats) expect(seen[idx(L.W, s.access.i, s.access.j)]).toBe(1);
    for (const s of L.spots) expect(seen[idx(L.W, s.cell.i, s.cell.j)]).toBe(1);
    for (const c of L.corridor) expect(seen[idx(L.W, c.i, c.j)]).toBe(1);
    expect(L.spots.length).toBeGreaterThan(40);
    expect(new Set(L.spots.map((s) => s.kind)).size).toBeGreaterThan(10);
  });

  it('routes along walkable cells in straight legs', () => {
    const paths = new Paths(L);
    for (const s of L.seats.filter((_, k) => k % 17 === 0)) {
      const r = paths.route(L.spawn, s.access);
      expect(r).not.toBeNull();
      const pts = r!;
      expect(pts[0]).toEqual(L.spawn);
      expect(pts[pts.length - 1]).toEqual(s.access);
      for (let k = 1; k < pts.length; k++) {
        const a = pts[k - 1]!;
        const b = pts[k]!;
        expect(a.i === b.i || a.j === b.j).toBe(true);
        const steps = Math.abs(b.i - a.i) + Math.abs(b.j - a.j);
        for (let t = 0; t <= steps; t++) {
          const i = a.i + Math.sign(b.i - a.i) * t;
          const j = a.j + Math.sign(b.j - a.j) * t;
          expect(L.blocked[idx(L.W, i, j)]).toBe(0);
        }
      }
    }
    // a short errand uses the windowed search and still arrives
    const spot = L.spots[0]!;
    const near = L.seats.reduce((best, s) => (Math.abs(s.access.i - spot.cell.i) + Math.abs(s.access.j - spot.cell.j) < Math.abs(best.access.i - spot.cell.i) + Math.abs(best.access.j - spot.cell.j) ? s : best));
    expect(paths.route(near.access, spot.cell)?.at(-1)).toEqual(spot.cell);
  });

  it('opens doors only in walls and keeps the entrance on the street', () => {
    for (const r of L.rooms) expect(r.doors.length).toBeGreaterThan(0);
    const doors = L.lobby.doors.filter((d) => d.i === L.building.i1 - 1 || d.j === L.building.j1 - 1);
    expect(doors.length).toBeGreaterThanOrEqual(2);
    expect(L.tile[idx(L.W, L.spawn.i, L.spawn.j)]).toBe(T.STREET);
  });

  it('scales to 3,000 rats', () => {
    const big = buildLayout(MOCK.map((s) => ({ ...s, ratCount: s.ratCount * 8 })), { partners: 40 });
    const need = MOCK.reduce((n, s) => n + s.ratCount * 8, 0);
    expect(need).toBeGreaterThan(3000);
    expect(big.seats.length).toBeGreaterThanOrEqual(need);
    expect(big.W).toBeLessThan(340);
  });
});
