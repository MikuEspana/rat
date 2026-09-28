import { describe, expect, it } from 'vitest';
import { Growth } from './growth';
import { Paths } from './path';
import { buildMaster, queueCells, STAGES, stageOf } from './plan';
import { idx, type FloorLayout } from './types';

const SYMBOLS = ['TSLAx', 'MSTRx', 'COINx', 'AMDx', 'NVDAx', 'AAPLx', 'METAx', 'AMZNx', 'GOOGLx', 'SPYx'];
const stockOf = (id: number): string => SYMBOLS[(id * 7 + (id >> 3)) % SYMBOLS.length]!;

function grow(plan: FloorLayout, n: number): Growth {
  const g = new Growth(plan);
  for (let id = 1; id <= n; id++) g.add(id, stockOf(id));
  return g;
}

function reach(plan: FloorLayout, blocked: Uint8Array, from: { i: number; j: number }): Uint8Array {
  const seen = new Uint8Array(plan.W * plan.H);
  const s = idx(plan.W, from.i, from.j);
  const q = [s];
  seen[s] = 1;
  for (let h = 0; h < q.length; h++) {
    const c = q[h]!;
    const i = c % plan.W;
    for (const n of [i + 1 < plan.W ? c + 1 : -1, i > 0 ? c - 1 : -1, c + plan.W, c - plan.W]) {
      if (n < 0 || n >= seen.length || seen[n] || blocked[n]) continue;
      seen[n] = 1;
      q.push(n);
    }
  }
  return seen;
}

describe('master plan', () => {
  const plan = buildMaster();

  it('is deterministic', () => {
    const again = buildMaster();
    expect(again.W).toBe(plan.W);
    expect(again.seats.length).toBe(plan.seats.length);
    expect(Buffer.from(again.tile).equals(Buffer.from(plan.tile))).toBe(true);
  });

  it('has a garage and one ring per later stage, each bigger, each with a lobby and amenities off its corridor', () => {
    expect(plan.rings.length).toBe(STAGES.length);
    expect(plan.garage.kind).toBe('garage');
    for (let k = 1; k < plan.rings.length; k++) {
      const r = plan.rings[k]!;
      expect(r.i1 - r.i0).toBeGreaterThan(plan.rings[k - 1]!.i1 - plan.rings[k - 1]!.i0);
      expect(plan.rooms[r.lobby]!.kind).toBe('lobby');
      for (const room of plan.rooms.filter((x) => x.ring === k && x.unlockAt !== null)) expect(room.parent).toBe(-1);
    }
    const kinds = new Set(plan.rooms.map((r) => r.kind));
    for (const k of ['open', 'stock', 'break', 'bath', 'server', 'copy', 'meeting', 'storage', 'ceo', 'war', 'vault'] as const) expect(kinds.has(k)).toBe(true);
    expect(plan.seats.length).toBeGreaterThan(5000);
  });
});

describe('growth (the idle game)', () => {
  const plan = buildMaster();
  const sizes = [1, 10, 25, 60, 100, 300, 500, 1000, 1500, 2200, 3000, 4200, 5000];
  const states = new Map(sizes.map((n) => [n, grow(plan, n)]));

  it('follows the stage thresholds', () => {
    for (const [n, g] of states) expect(g.stage).toBe(stageOf(n));
    expect(stageOf(24)).toBe(0);
    expect(stageOf(25)).toBe(1);
    expect(stageOf(3000)).toBe(5);
  });

  it('only ever grows: a room built at N is still built at every larger N', () => {
    for (let k = 1; k < sizes.length; k++) {
      const a = states.get(sizes[k - 1]!)!;
      const b = states.get(sizes[k]!)!;
      for (let r = 0; r < plan.rooms.length; r++) if (a.built[r]) expect(b.built[r]).toBe(1);
      for (let r = 0; r < plan.rooms.length; r++) if (a.symbolOf[r]) expect(b.symbolOf[r]).toBe(a.symbolOf[r]);
    }
  });

  it('is deterministic', () => {
    const again = grow(plan, 1000);
    const g = states.get(1000)!;
    expect(Buffer.from(again.built).equals(Buffer.from(g.built))).toBe(true);
    expect(again.symbolOf).toEqual(g.symbolOf);
  });

  it('gives every rat a desk, in its own stock room once stocks get rooms, reachable from the subway', () => {
    for (const [n, g] of states) {
      expect(g.seatOfRat.size).toBe(n);
      const blocked = g.blocked();
      const spawn = plan.rings[g.stage]!.spawn;
      expect(blocked[idx(plan.W, spawn.i, spawn.j)]).toBe(0);
      const seen = reach(plan, blocked, spawn);
      for (const [rat, sid] of g.seatOfRat) {
        const s = plan.seats[sid]!;
        expect(seen[idx(plan.W, s.access.i, s.access.j)]).toBe(1);
        const room = plan.rooms[s.room]!;
        if (room.kind === 'stock') expect(g.symbolOf[room.id]).toBe(stockOf(rat));
      }
    }
  });

  it('builds amenities at their rat counts and nothing beyond the current stage', () => {
    for (const [n, g] of states) {
      for (const r of plan.rooms) {
        if (g.built[r.id]) expect(r.ring).toBeLessThanOrEqual(g.stage);
        if (r.unlockAt !== null && r.unlockAt <= n && r.ring <= g.stage) expect(g.built[r.id]).toBe(1);
      }
    }
  });

  it('routes along walkable cells in straight legs', () => {
    const g = states.get(1000)!;
    const blocked = g.blocked();
    const paths = new Paths(plan, 64, blocked);
    const spawn = plan.rings[g.stage]!.spawn;
    let checked = 0;
    for (const sid of [...g.seatOfRat.values()].filter((_, k) => k % 97 === 0)) {
      const s = plan.seats[sid]!;
      const r = paths.route(spawn, s.access);
      expect(r).not.toBeNull();
      const pts = r!;
      for (let k = 1; k < pts.length; k++) {
        const a = pts[k - 1]!;
        const b = pts[k]!;
        expect(a.i === b.i || a.j === b.j).toBe(true);
        const steps = Math.abs(b.i - a.i) + Math.abs(b.j - a.j);
        for (let t = 0; t <= steps; t++) expect(blocked[idx(plan.W, a.i + Math.sign(b.i - a.i) * t, a.j + Math.sign(b.j - a.j) * t)]).toBe(0);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
  });
});

describe('the job-fair line outside', () => {
  const plan = buildMaster();

  it('starts by the lobby door, runs around the block on the street, one rat per cell, walkable and reachable', () => {
    for (let stage = 0; stage < STAGES.length; stage++) {
      const g = new Growth(plan);
      for (let id = 1; g.stage < stage; id++) g.add(id, stockOf(id));
      const blocked = g.blocked();
      const line = queueCells(plan, stage, blocked);
      const ring = plan.rings[stage]!;
      const door = ring.entrance[1]!;
      // long enough for thousands of rats on the last stage
      expect(line.length).toBeGreaterThan(stage === STAGES.length - 1 ? 4000 : 300);
      // the head is right by the door
      expect(Math.abs(line[0]!.i - door.i) + Math.abs(line[0]!.j - door.j)).toBeLessThanOrEqual(6);
      const seen = reach(plan, blocked, ring.spawn);
      const keys = new Set<number>();
      for (const c of line) {
        const k = idx(plan.W, c.i, c.j);
        expect(keys.has(k)).toBe(false);
        keys.add(k);
        expect(blocked[k]).toBe(0);
        expect(seen[k]).toBe(1);
        // outside the building, on the street
        expect(c.i < ring.i0 || c.i > ring.i1 || c.j < ring.j0 || c.j > ring.j1).toBe(true);
        // the way from the subway stairs to the door stays clear
        expect(Math.abs(c.i - door.i) <= 1 && Math.abs(c.j - door.j) <= 4 && c.i === door.i).toBe(false);
      }
      expect(keys.has(idx(plan.W, ring.spawn.i, ring.spawn.j))).toBe(false);
      // a line, not a crowd: each place is next to the one before it
      let gaps = 0;
      for (let k = 1; k < line.length; k++) if (Math.abs(line[k]!.i - line[k - 1]!.i) + Math.abs(line[k]!.j - line[k - 1]!.j) > 2) gaps++;
      expect(gaps).toBeLessThan(line.length / 50);
    }
  });

  it('is deterministic', () => {
    expect(queueCells(plan, 5)).toEqual(queueCells(plan, 5));
  });

  it('rats without a desk wait, and get one when the next ring opens; past the last ring the line only grows', () => {
    const g = new Growth(plan);
    // a lopsided launch (a few stocks get most hires): their rooms fill up before the next stage opens
    let seed = 7;
    const pick = (): string => SYMBOLS[Math.min(9, Math.floor(-Math.log(1 - (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 3))]!;
    let peak = 0;
    for (let id = 1; id <= 499; id++) {
      g.add(id, pick());
      peak = Math.max(peak, g.waitingCount);
    }
    expect(peak).toBeGreaterThan(0);
    const before = g.waitingCount;
    g.add(500, pick()); // the corporate floor: ring 3 opens and new desk rooms go up for them
    expect(g.waitingCount).toBeLessThan(before);
    expect(g.waitingCount).toBe(0);
    const full = grow(plan, 7000);
    expect(full.waitingCount).toBeGreaterThan(500);
    expect(full.seatOfRat.size + full.waitingCount).toBe(7000);
  });
});
