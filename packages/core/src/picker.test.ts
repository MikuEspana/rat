import { describe, expect, it } from 'vitest';
import { SeededRng } from './clock';
import { hireWeights, pickWeighted } from './picker';

describe('hireWeights', () => {
  it('ranks by 24h change and respects the floor', () => {
    const w = hireWeights(
      [
        { key: 'A', change24hPct: 6 },
        { key: 'B', change24hPct: -4 },
        { key: 'C', change24hPct: 2 },
        { key: 'D', change24hPct: null },
      ],
      500,
    );
    const total = [...w.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
    expect(w.get('A')!).toBeGreaterThan(w.get('C')!);
    expect(w.get('C')!).toBeGreaterThan(w.get('B')!);
    expect(w.get('B')!).toBeGreaterThan(w.get('D')!);
    for (const v of w.values()) expect(v).toBeGreaterThanOrEqual(0.05 - 1e-12);
  });

  it('applies the 5% floor with many stocks', () => {
    const cands = Array.from({ length: 12 }, (_, i) => ({ key: `S${i}`, change24hPct: i }));
    const w = hireWeights(cands, 500);
    const total = [...w.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
    for (const v of w.values()) expect(v).toBeGreaterThanOrEqual(0.05 - 1e-12);
    expect(w.get('S11')!).toBeGreaterThan(w.get('S0')!);
  });

  it('falls back to equal weights when the floor cannot hold', () => {
    const cands = Array.from({ length: 25 }, (_, i) => ({ key: `S${i}`, change24hPct: i }));
    const w = hireWeights(cands, 500);
    for (const v of w.values()) expect(v).toBeCloseTo(1 / 25, 10);
  });

  it('returns empty for no candidates', () => {
    expect(hireWeights([], 500).size).toBe(0);
    expect(pickWeighted(new Map(), new SeededRng(1))).toBeNull();
  });
});

describe('pickWeighted', () => {
  it('follows the weights over many draws (seeded)', () => {
    const rng = new SeededRng(7);
    const w = new Map([
      ['A', 0.7],
      ['B', 0.2],
      ['C', 0.1],
    ]);
    const counts: Record<string, number> = { A: 0, B: 0, C: 0 };
    for (let i = 0; i < 10_000; i++) counts[pickWeighted(w, rng)!]!++;
    expect(counts.A! / 10_000).toBeCloseTo(0.7, 1);
    expect(counts.B! / 10_000).toBeCloseTo(0.2, 1);
    expect(counts.C! / 10_000).toBeCloseTo(0.1, 1);
  });

  it('is deterministic for a seed', () => {
    const w = new Map([
      ['A', 0.5],
      ['B', 0.5],
    ]);
    const a = Array.from({ length: 20 }, () => 0).map(((r) => () => pickWeighted(w, r))(new SeededRng(3)));
    const b = Array.from({ length: 20 }, () => 0).map(((r) => () => pickWeighted(w, r))(new SeededRng(3)));
    expect(a).toEqual(b);
  });
});
