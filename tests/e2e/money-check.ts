// The full money check against the chain, shared by the property, resilience and chaos tests (vitest only;
// helpers.ts stays free of vitest so the simulation scripts can import it).
import { solDelta } from '@rat/core';
import type { SimWorld } from '@rat/worker';
import { expect } from 'vitest';
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
