// The full money check against the chain, shared by the property, resilience and chaos tests (vitest only;
// helpers.ts stays free of vitest so the simulation scripts can import it).
import { solDelta } from '@rat/core';
import type { SimWorld } from '@rat/worker';
import { expect } from 'vitest';
export interface MoneyStart {
  creator: bigint;
  /** creator fees paid into our vaults so far */
  accrued: bigint;
}

export function moneyStart(w: SimWorld): MoneyStart {
  return { creator: w.chain.sol(w.creator.publicKey.toBase58()), accrued: 0n };
}

/**
 * Checks every lamport against the chain (call it once everything has settled):
 * - every lamport that left our vaults is credited exactly once, all of it to the hire bucket
 * - the ledger's hire spend equals what left the creator wallet (plus reservations in flight)
 * - SOL spent never exceeds SOL claimed; only a failed claim's fee can come from the creator's reserve
 * - the creator balance equals the ledger to the lamport; the owner's own SOL was never spent
 * - nothing was ever booked outside the hire bucket
 * - no rat wallet was ever funded twice
 */
export async function checkMoney(w: SimWorld, start: MoneyStart): Promise<void> {
  const creator = w.creator.publicKey.toBase58();
  const attempts = await w.store.db.query.txAttempts.findMany({ where: (a, { eq }) => eq(a.mode, 'live') });
  const rats = await w.store.rats.listByStatus(['hiring', 'active', 'frozen', 'failed']);
  let chainOut = 0n;
  const fundedTimes = new Map<string, number>();
  let botClaimFees = 0n;
  let failedClaimFees = 0n;
  for (const a of attempts) {
    expect(['claim', 'hire'], `unexpected ${a.kind} transaction`).toContain(a.kind);
    const r = w.chain.transaction(a.signature);
    if (!r) continue; // never landed
    if (a.kind === 'hire') {
      const out = -solDelta(r, creator);
      chainOut += out;
      if (!r.err && out > 0n) {
        for (const rat of rats) if (solDelta(r, rat.wallet) > 0n) fundedTimes.set(rat.wallet, (fundedTimes.get(rat.wallet) ?? 0) + 1);
      }
    }
    if (a.kind === 'claim') {
      botClaimFees += r.feeLamports;
      if (r.err) failedClaimFees += r.feeLamports;
    }
  }
  const vaultLeft = (await w.deps.pump.getClaimable(creator)).totalLamports;
  const ledgerOut = await w.store.ledger.netOutflowSince('hire', new Date(0));
  const balance = await w.store.ledger.balance('hire');
  const totals = await w.store.claims.totals();
  const sums = await w.store.ledger.sumByReason();
  let outstanding = 0n;
  // money in flight: a hiring rat's reservation that is still open. A pointer to a closed one (a crash between
  // "release" and "forget it on the rat", cleared at the rat's next attempt, which the kill switch may prevent) is
  // not money in flight: chaos seed 2246.
  for (const rat of rats) {
    if (rat.status === 'hiring' && rat.reserveLedgerId !== null && (await w.store.ledger.isOpen(rat.reserveLedgerId))) outstanding += rat.salaryLamports;
  }

  expect(totals.claimed, 'claimed = what left our vaults').toBe(start.accrued - vaultLeft);
  expect(totals.hireShare, 'the whole claim goes to hires').toBe(totals.claimed);
  expect(sums.get('hire:claim_credit') ?? 0n, 'hire credits = claimed').toBe(totals.claimed);
  expect([...sums.keys()].filter((k) => !k.startsWith('hire:')), 'nothing booked outside the hire bucket').toEqual([]);
  expect(ledgerOut, 'ledger hire spend = creator SOL out').toBe(chainOut + outstanding);
  expect(totals.fee).toBe(botClaimFees - failedClaimFees);
  expect(ledgerOut, 'never spends more than was claimed').toBeLessThanOrEqual(totals.hireShare);
  expect(balance).toBeGreaterThanOrEqual(-failedClaimFees);
  const creatorNow = w.chain.sol(creator);
  expect(creatorNow - start.creator, 'creator wallet = ledger').toBe(balance + outstanding);
  expect(creatorNow).toBeGreaterThanOrEqual(start.creator - failedClaimFees);
  for (const [wallet, n] of fundedTimes) expect(n, `rat ${wallet} funded ${n} times`).toBe(1);
}
