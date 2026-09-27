// Shared helpers for the end-to-end simulations (in-memory only).
import { SOL, type SimWorld } from '@rat/worker';

/**
 * Launch-shaped fee curve: most fees in the first minutes, decaying after. Returns lamports per tick
 * that sum EXACTLY to `total` over `seconds`. Graduation to PumpSwap at `graduateAtSec`.
 */
export function launchCurve(total: bigint, seconds: number, stepSec: number): bigint[] {
  const ticks = Math.floor(seconds / stepSec);
  const weights = Array.from({ length: ticks }, (_, i) => Math.exp(-(i * stepSec) / (40 * 60)));
  const sum = weights.reduce((a, b) => a + b, 0);
  const out = weights.map((w) => BigInt(Math.floor((Number(total) * w) / sum)));
  const diff = total - out.reduce((a, b) => a + b, 0n);
  out[0] = out[0]! + diff;
  return out;
}

export interface Meter {
  /** max Jupiter calls (swap builds + price calls) seen in any rolling 60 seconds */
  maxJupiterPerMinute: number;
  maxHiresPerLoop: number;
}

/** Runs a world for `seconds`, accruing fees along the curve, measuring Jupiter usage. */
export async function runLaunch(
  w: SimWorld,
  opts: { seconds: number; stepSec?: number; totalFees: bigint; graduateAtSec?: number; onTick?: (t: number) => Promise<void> | void },
): Promise<Meter> {
  const step = opts.stepSec ?? 5;
  const curve = launchCurve(opts.totalFees, opts.seconds, step);
  const samples: { t: number; calls: number }[] = [];
  let maxHires = 0;
  for (let i = 0; i < curve.length; i++) {
    const t = i * step;
    const fees = curve[i]!;
    if (opts.graduateAtSec !== undefined && t >= opts.graduateAtSec) w.accrue({ ammLamports: fees });
    else w.accrue({ bondingLamports: fees });
    const ran = await w.worker.tick();
    const claim = ran.get('claim') as { hire?: { attempted: number; retried: number } } | undefined;
    if (claim?.hire) maxHires = Math.max(maxHires, claim.hire.attempted + claim.hire.retried);
    await opts.onTick?.(t);
    samples.push({ t: w.clock.now().getTime(), calls: w.swap.calls + w.prices.calls });
    w.clock.advanceSeconds(step);
    w.prices.step(w.rng);
  }
  let maxPerMinute = 0;
  for (let i = 0; i < samples.length; i++) {
    const start = samples[i]!;
    let j = i;
    while (j + 1 < samples.length && samples[j + 1]!.t - start.t < 60_000) j++;
    const before = i > 0 ? samples[i - 1]!.calls : 0;
    maxPerMinute = Math.max(maxPerMinute, samples[j]!.calls - before);
  }
  return { maxJupiterPerMinute: maxPerMinute, maxHiresPerLoop: maxHires };
}

export function sol(n: number): bigint {
  return BigInt(Math.round(n * 1e9));
}

export { SOL };

export interface BurnRounds {
  rounds: number;
  txs: number;
  /** largest single burn transaction (lamports reserved) */
  maxChunk: bigint;
  /** seconds from the last chunk of a round to the first chunk of the next (the random delay) */
  roundGaps: number[];
  /** seconds between chunks of the same round */
  chunkGaps: number[];
}

/** Groups burn rows (oldest first) into rounds: chunks less than a minute apart belong to one round. */
export function burnRounds(rows: { at: Date; reservedLamports: bigint }[]): BurnRounds {
  const sorted = [...rows].sort((a, b) => a.at.getTime() - b.at.getTime());
  let rounds = 0;
  const roundGaps: number[] = [];
  const chunkGaps: number[] = [];
  let maxChunk = 0n;
  sorted.forEach((b, i) => {
    if (b.reservedLamports > maxChunk) maxChunk = b.reservedLamports;
    const gap = i > 0 ? (b.at.getTime() - sorted[i - 1]!.at.getTime()) / 1000 : Number.POSITIVE_INFINITY;
    if (gap < 60) chunkGaps.push(gap);
    else {
      rounds++;
      if (i > 0) roundGaps.push(gap);
    }
  });
  return { rounds, txs: sorted.length, maxChunk, roundGaps, chunkGaps };
}
