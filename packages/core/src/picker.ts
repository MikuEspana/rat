// Stock picker: better performing stocks (24h change rank) get more new hires, with a floor.
import type { Rng } from './ports';

export interface PickCandidate {
  key: string;
  change24hPct: number | null;
}

/**
 * Rank-based weights. Best 24h change gets weight N, worst gets 1, unknown change ranks last.
 * Every candidate gets at least `minWeightBps` (e.g. 500 = 5%). Returns fractions summing to 1.
 */
export function hireWeights(candidates: PickCandidate[], minWeightBps: number): Map<string, number> {
  const out = new Map<string, number>();
  const n = candidates.length;
  if (n === 0) return out;
  const floor = minWeightBps / 10_000;
  if (floor * n >= 1) {
    for (const c of candidates) out.set(c.key, 1 / n);
    return out;
  }
  const sorted = [...candidates].sort((a, b) => {
    const av = a.change24hPct ?? Number.NEGATIVE_INFINITY;
    const bv = b.change24hPct ?? Number.NEGATIVE_INFINITY;
    if (bv !== av) return bv - av;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  const raw = new Map<string, number>();
  sorted.forEach((c, i) => raw.set(c.key, n - i));
  const total = [...raw.values()].reduce((a, b) => a + b, 0);
  const weights = new Map<string, number>();
  for (const [k, v] of raw) weights.set(k, v / total);

  const floored = new Set<string>();
  for (let iter = 0; iter < n; iter++) {
    let changed = false;
    for (const [k, w] of weights) {
      if (!floored.has(k) && w < floor) {
        floored.add(k);
        changed = true;
      }
    }
    if (!changed) break;
    const freeShare = 1 - floor * floored.size;
    const freeRawTotal = [...raw].filter(([k]) => !floored.has(k)).reduce((a, [, v]) => a + v, 0);
    for (const [k, v] of raw) {
      weights.set(k, floored.has(k) ? floor : (v / freeRawTotal) * freeShare);
    }
  }
  for (const c of candidates) out.set(c.key, weights.get(c.key) ?? 0);
  return out;
}

/** Picks one key from a weight map. */
export function pickWeighted(weights: Map<string, number>, rng: Rng): string | null {
  const entries = [...weights].filter(([, w]) => w > 0);
  if (entries.length === 0) return null;
  const total = entries.reduce((a, [, w]) => a + w, 0);
  let r = rng.next() * total;
  for (const [k, w] of entries) {
    r -= w;
    if (r < 0) return k;
  }
  return entries[entries.length - 1]![0];
}
