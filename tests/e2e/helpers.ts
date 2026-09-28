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

/** Jupiter call counter samples (one per tick, after the tick ran). */
export type CallSample = { t: number; calls: number };

/** Jupiter calls so far (swap builds + price calls), stamped with the fake clock. */
export function jupiterSample(w: SimWorld): CallSample {
  return { t: w.clock.now().getTime(), calls: w.swap.calls + w.prices.calls };
}

/** Max calls made in any rolling 60 seconds, from per-tick samples of a running counter. */
export function maxCallsPerMinute(samples: CallSample[]): number {
  let max = 0;
  for (let i = 0; i < samples.length; i++) {
    const start = samples[i]!;
    let j = i;
    while (j + 1 < samples.length && samples[j + 1]!.t - start.t < 60_000) j++;
    const before = i > 0 ? samples[i - 1]!.calls : 0;
    max = Math.max(max, samples[j]!.calls - before);
  }
  return max;
}

/**
 * Lets the event loop run queued I/O. The in-memory database, chain and Jupiter mock resolve everything as
 * microtasks, so a long simulation never yields on its own and the test runner's own messages time out.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Runs a world for `seconds`, accruing fees along the curve, measuring Jupiter usage. */
export async function runLaunch(
  w: SimWorld,
  opts: { seconds: number; stepSec?: number; totalFees: bigint; graduateAtSec?: number; onTick?: (t: number) => Promise<void> | void },
): Promise<Meter> {
  const step = opts.stepSec ?? 5;
  const curve = launchCurve(opts.totalFees, opts.seconds, step);
  const samples: CallSample[] = [];
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
    samples.push(jupiterSample(w));
    w.clock.advanceSeconds(step);
    w.prices.step(w.rng);
    if (i % 60 === 59) await yieldToEventLoop();
  }
  return { maxJupiterPerMinute: maxCallsPerMinute(samples), maxHiresPerLoop: maxHires };
}

/** A ledger row as the spend checks need it. */
export type SpendRow = { at: Date; deltaLamports: bigint };

/**
 * The largest net outflow in any rolling window of `windowMs` (the window the spend guard uses: rows with
 * at >= end - windowMs, up to end). Checked at every row time and right after every row leaves the window
 * (a release leaving the window raises the outflow), so no window is missed.
 */
export function maxRollingOutflow(rows: SpendRow[], windowMs: number): { lamports: bigint; endsAt: Date | null } {
  const sorted = [...rows].sort((a, b) => a.at.getTime() - b.at.getTime());
  const times = sorted.map((r) => r.at.getTime());
  const prefix: bigint[] = [0n];
  for (const r of sorted) prefix.push(prefix[prefix.length - 1]! - r.deltaLamports);
  /** first index with time >= x */
  const lower = (x: number) => {
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  let best = 0n;
  let endsAt: Date | null = null;
  const ends = new Set<number>();
  for (const t of times) {
    ends.add(t);
    ends.add(t + windowMs + 1);
  }
  for (const end of ends) {
    const from = lower(end - windowMs);
    const to = lower(end + 1); // rows with time <= end
    const out = prefix[to]! - prefix[from]!;
    if (out > best) {
      best = out;
      endsAt = new Date(end);
    }
  }
  return { lamports: best, endsAt };
}

/** The most rows booked at one instant: with a fake clock, one worker loop books all its hires at one time. */
export function maxAtOneInstant(rows: { at: Date }[]): number {
  const n = new Map<number, number>();
  for (const r of rows) n.set(r.at.getTime(), (n.get(r.at.getTime()) ?? 0) + 1);
  return Math.max(0, ...n.values());
}

function sol(n: number): bigint {
  return BigInt(Math.round(n * 1e9));
}

export interface Phase {
  label: string;
  fromMin: number;
  toMin: number;
  /** creator fees paid into our vaults during this phase */
  sol: number;
  /** decay: front-loaded and falling; bump: rises then falls (a pump); flat: even */
  shape: 'decay' | 'bump' | 'flat';
  /** steepness of a decay (higher = more front-loaded) */
  k?: number;
}

/** Fees per tick for a list of phases; each phase sums EXACTLY to its SOL. */
export function phasedCurve(phases: Phase[], stepSec: number): { fees: bigint[]; phaseAt: (tick: number) => string } {
  const fees: bigint[] = [];
  const labels: string[] = [];
  for (const p of phases) {
    const ticks = Math.round(((p.toMin - p.fromMin) * 60) / stepSec);
    const weights = Array.from({ length: ticks }, (_, i) => {
      const x = (i + 0.5) / ticks;
      if (p.shape === 'decay') return Math.exp(-(p.k ?? 2) * x);
      if (p.shape === 'bump') return Math.sin(Math.PI * x);
      return 1;
    });
    const sum = weights.reduce((a, b) => a + b, 0);
    const total = sol(p.sol);
    const part = weights.map((w) => BigInt(Math.floor((Number(total) * w) / sum)));
    part[0] = part[0]! + (total - part.reduce((a, b) => a + b, 0n));
    fees.push(...part);
    labels.push(...part.map(() => p.label));
  }
  return { fees, phaseAt: (tick) => labels[tick] ?? 'after' };
}
