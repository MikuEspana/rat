// Shared helpers for the end-to-end simulations (in-memory only).
import { solDelta } from '@rat/core';
import { SOL, type SimWorld } from '@rat/worker';
import { expect } from 'vitest';

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

export interface MoneyStart {
  creator: bigint;
  fund: bigint;
  /** creator fees paid into our vaults so far */
  accrued: bigint;
}

export function moneyStart(w: SimWorld): MoneyStart {
  return { creator: w.chain.sol(w.creator.publicKey.toBase58()), fund: w.chain.sol(w.fund.publicKey.toBase58()), accrued: 0n };
}

/**
 * Checks every lamport against the chain (call it once everything has settled):
 * - every lamport that left our vaults is credited exactly once
 * - the ledger's hire / burn spend equals what left the creator / fund wallets (plus reservations in flight)
 * - SOL spent never exceeds SOL claimed; only a failed claim's fee can come from the creator's reserve
 * - creator and fund balances equal the ledger to the lamport; the owner's own SOL was never spent
 * - no rat wallet was ever funded twice
 */
export async function checkMoney(w: SimWorld, start: MoneyStart): Promise<void> {
  const creator = w.creator.publicKey.toBase58();
  const fund = w.fund.publicKey.toBase58();
  const attempts = await w.store.db.query.txAttempts.findMany({ where: (a, { eq }) => eq(a.mode, 'live') });
  const rats = await w.store.rats.listByStatus(['hiring', 'active', 'frozen', 'failed']);
  const chainOut = { hire: 0n, burn: 0n };
  const fundedTimes = new Map<string, number>();
  let botClaimFees = 0n;
  let failedClaimFees = 0n;
  for (const a of attempts) {
    const r = w.chain.transaction(a.signature);
    if (!r) continue; // never landed
    if (a.kind === 'hire') {
      const out = -solDelta(r, creator);
      chainOut.hire += out;
      if (!r.err && out > 0n) {
        for (const rat of rats) if (solDelta(r, rat.wallet) > 0n) fundedTimes.set(rat.wallet, (fundedTimes.get(rat.wallet) ?? 0) + 1);
      }
    }
    if (a.kind === 'burn') chainOut.burn += -solDelta(r, fund);
    if (a.kind === 'claim') {
      botClaimFees += r.feeLamports;
      if (r.err) failedClaimFees += r.feeLamports;
    }
  }
  const vaultLeft = (await w.deps.pump.getClaimable(creator)).totalLamports;
  const epoch = new Date(0);
  const ledgerOut = { hire: await w.store.ledger.netOutflowSince('hire', epoch), burn: await w.store.ledger.netOutflowSince('burn', epoch) };
  const balance = { hire: await w.store.ledger.balance('hire'), burn: await w.store.ledger.balance('burn') };
  const totals = await w.store.claims.totals();
  const owed = await w.store.claims.pendingFundTransfer();
  const outstanding = { hire: 0n, burn: 0n };
  for (const rat of rats) if (rat.status === 'hiring' && rat.reserveLedgerId !== null) outstanding.hire += rat.salaryLamports;
  for (const b of await w.store.burns.listByStatus(['pending', 'unknown'])) if (b.reserveLedgerId !== null) outstanding.burn += b.reservedLamports;

  expect(totals.claimed, 'claimed = what left our vaults').toBe(start.accrued - vaultLeft);
  expect(totals.hireShare + totals.fundShare).toBe(totals.claimed);
  expect(ledgerOut.hire, 'ledger hire spend = creator SOL out').toBe(chainOut.hire + outstanding.hire);
  expect(ledgerOut.burn, 'ledger burn spend = fund SOL out').toBe(chainOut.burn + outstanding.burn);
  expect(totals.fee).toBe(botClaimFees - failedClaimFees);
  expect(ledgerOut.hire).toBeLessThanOrEqual(totals.hireShare);
  expect(ledgerOut.burn).toBeLessThanOrEqual(totals.fundShare);
  expect(balance.hire).toBeGreaterThanOrEqual(-failedClaimFees);
  expect(balance.burn).toBeGreaterThanOrEqual(0n);
  const creatorNow = w.chain.sol(creator);
  const fundNow = w.chain.sol(fund);
  expect(creatorNow - start.creator, 'creator wallet = ledger').toBe(balance.hire + outstanding.hire + owed);
  expect(fundNow - start.fund, 'fund wallet = ledger').toBe(balance.burn + outstanding.burn - owed);
  expect(creatorNow).toBeGreaterThanOrEqual(start.creator - failedClaimFees);
  expect(fundNow).toBeGreaterThanOrEqual(start.fund);
  for (const [wallet, n] of fundedTimes) expect(n, `rat ${wallet} funded ${n} times`).toBe(1);
}
