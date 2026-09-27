import { describe, expect, it } from 'vitest';
import { buildLayout, capacityFor, CORRIDOR, overflowSpot, pathToSeat, type Room } from './layout';

const TEN = ['TSLAx', 'MSTRx', 'COINx', 'AMDx', 'NVDAx', 'AAPLx', 'METAx', 'AMZNx', 'GOOGLx', 'SPYx'].map((symbol, k) => ({
  symbol,
  ratCount: 15 + k * 3,
}));

function inside(room: Room, i: number, j: number): boolean {
  return i > room.i0 && i < room.i0 + room.w && j > room.j0 && j < room.j0 + room.h;
}

describe('buildLayout', () => {
  it('puts 10 stocks, HQ and the subway in a 4 x 3 grid of distinct slots', () => {
    const l = buildLayout(TEN);
    expect(l.cols).toBe(4);
    expect(l.rows).toBe(3);
    expect(l.bySymbol.size).toBe(10);
    const slots = new Set(l.rooms.map((r) => `${r.slotA},${r.slotB}`));
    expect(slots.size).toBe(l.rooms.length);
    expect(l.subway.slotA).toBe(3);
    expect(l.subway.slotB).toBe(2);
  });

  it('rooms never overlap and fit their slot', () => {
    const l = buildLayout(TEN);
    for (const a of l.rooms) {
      expect(a.w).toBeLessThanOrEqual(l.slot);
      expect(a.h).toBeLessThanOrEqual(l.slot);
      for (const b of l.rooms) {
        if (a === b) continue;
        const apart = a.i0 + a.w <= b.i0 || b.i0 + b.w <= a.i0 || a.j0 + a.h <= b.j0 || b.j0 + b.h <= a.j0;
        expect(apart).toBe(true);
      }
    }
  });

  it('gives every rat a seat inside its room, with room to grow', () => {
    const l = buildLayout(TEN);
    for (const s of TEN) {
      const room = l.bySymbol.get(s.symbol)!;
      expect(room.seats.length).toBeGreaterThanOrEqual(capacityFor(s.ratCount));
      expect(capacityFor(s.ratCount)).toBeGreaterThan(s.ratCount);
      for (const seat of room.seats) {
        expect(inside(room, seat.i, seat.j)).toBe(true);
        expect(inside(room, seat.deskI, seat.deskJ)).toBe(true);
      }
    }
  });

  it('is deterministic', () => {
    expect(JSON.stringify(buildLayout(TEN).rooms)).toBe(JSON.stringify(buildLayout(TEN).rooms));
  });

  it('scales to 3,000 rats', () => {
    const big = TEN.map((s) => ({ ...s, ratCount: 300 }));
    const l = buildLayout(big);
    const seats = [...l.bySymbol.values()].reduce((a, r) => a + r.seats.length, 0);
    expect(seats).toBeGreaterThanOrEqual(3000);
  });
});

describe('pathToSeat', () => {
  it('walks axis-aligned legs from the stairs to the seat, through corridors only', () => {
    const l = buildLayout(TEN);
    for (const s of TEN) {
      const room = l.bySymbol.get(s.symbol)!;
      for (const seat of [room.seats[0]!, room.seats[room.seats.length - 1]!]) {
        const p = pathToSeat(l, room, seat);
        expect(p[0]).toEqual(l.spawn);
        expect(p[p.length - 1]).toEqual({ i: seat.i, j: seat.j });
        for (let k = 1; k < p.length; k++) {
          const a = p[k - 1]!;
          const b = p[k]!;
          expect(a.i === b.i || a.j === b.j).toBe(true); // no diagonal legs
        }
        // the corridor legs (between the two junctions) never cut through a room
        const q0 = p.findIndex((c) => c.i === l.subway.junction.i && c.j === l.subway.junction.j);
        const q1 = p.findIndex((c) => c.i === room.junction.i && c.j === room.junction.j);
        expect(q0).toBeGreaterThan(0);
        expect(q1).toBeGreaterThanOrEqual(q0);
        for (let k = q0; k < q1; k++) {
          const a = p[k]!;
          const b = p[k + 1]!;
          for (let t = 0; t <= 1; t += 0.05) {
            const i = a.i + (b.i - a.i) * t;
            const j = a.j + (b.j - a.j) * t;
            for (const r of l.rooms) expect(inside(r, i, j)).toBe(false);
          }
        }
      }
    }
    expect(CORRIDOR).toBeGreaterThan(0);
  });
});

describe('overflowSpot', () => {
  it('stands overflow rats inside the room front walkway, same spot for the same rat', () => {
    const l = buildLayout(TEN);
    const room = l.bySymbol.get('NVDAx')!;
    const a = overflowSpot(room, 4242);
    expect(overflowSpot(room, 4242)).toEqual(a);
    expect(a.i).toBeGreaterThan(room.i0);
    expect(a.i).toBeLessThan(room.i0 + room.w);
    expect(a.j).toBeGreaterThan(room.j0 + room.h - 2);
  });
});
