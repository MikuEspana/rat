// Property test (fast-check), end to end: random launches (fee bursts on the bonding curve and PumpSwap,
// strangers claiming our vault, 0 to 40% of claim/hire/burn transactions failing in random ways, both hire
// modes) run by the real worker in live mode on SimChain. After everything settles, every lamport is checked
// against the chain: SOL spent never exceeds SOL claimed, and the ledger matches what really moved, exactly.
import { type Bucket, solDelta } from '@rat/core';
import { collectCreatorFeeV2Ix } from '@rat/pump';
import { SOL, type SimWorld, createSimWorld } from '@rat/worker';
import { Keypair } from '@solana/web3.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

interface Burst {
  bonding: bigint;
  amm: bigint;
  /** a stranger triggers the claim of our vault (anyone can) */
  external: boolean;
  failRate: number;
  /** loops (35 s each) before the next burst */
  loops: number;
}

const burst: fc.Arbitrary<Burst> = fc.record({
  bonding: fc.oneof(fc.bigInt({ min: 0n, max: 2n * SOL }), fc.bigInt({ min: 0n, max: SOL / 20n })),
  amm: fc.bigInt({ min: 0n, max: SOL }),
  external: fc.boolean(),
  failRate: fc.double({ min: 0, max: 0.4, noNaN: true }),
  loops: fc.integer({ min: 1, max: 8 }),
});

const LOOP_SEC = 35;

async function loop(w: SimWorld, n: number, check: () => void): Promise<void> {
  for (let i = 0; i < n; i++) {
    await w.worker.tick();
    check();
    w.clock.advanceSeconds(LOOP_SEC);
    w.chain.advanceBlocks(90); // ~35 s of blocks: unconfirmed transactions eventually expire
    w.prices.step(w.rng);
  }
}

async function scenario(plan: { seed: number; hireMode: 'single' | 'two_step'; bursts: Burst[] }): Promise<void> {
  const w = await createSimWorld({ dryRun: false, seed: plan.seed, env: { HIRE_MODE: plan.hireMode, MAX_HIRES_PER_LOOP: '6' } });
  try {
    const creator = w.creator.publicKey.toBase58();
    const fund = w.fund.publicKey.toBase58();
    const creatorStart = w.chain.sol(creator);
    const fundStart = w.chain.sol(fund);
    const stranger = Keypair.generate();
    w.chain.fundAccount(stranger.publicKey.toBase58(), SOL);
    let accrued = 0n;
    // after every loop, not just at the end: the fund only ever burns SOL that has actually arrived in it
    const check = () => expect(w.chain.sol(fund)).toBeGreaterThanOrEqual(fundStart);

    await loop(w, 1, check); // prices, mint checks, watch cursor
    for (const b of plan.bursts) {
      w.accrue({ bondingLamports: b.bonding, ammLamports: b.amm });
      accrued += b.bonding + b.amm;
      if (b.external && b.bonding > 0n) {
        const req = { kind: 'claim' as const, label: 'stranger', feePayer: stranger, signers: [], instructions: [collectCreatorFeeV2Ix(creator)], computeUnitLimit: 200_000 };
        await w.simSender.submit(await w.simSender.prepare(req));
      }
      w.simSender.clearFailures();
      if (b.failRate > 0) w.simSender.setRandomFailures(b.failRate, w.rng);
      await loop(w, b.loops, check);
    }
    // the network calms down: everything in flight lands or expires, rounds finish, owed shares get forwarded
    w.simSender.clearFailures();
    await loop(w, 40, check);

    // ---- what really happened on-chain
    const attempts = await w.store.db.query.txAttempts.findMany({ where: (a, { eq }) => eq(a.mode, 'live') });
    const chainOut: Record<Bucket, bigint> = { hire: 0n, burn: 0n };
    let botClaimFees = 0n;
    let failedClaimFees = 0n;
    for (const a of attempts) {
      const r = w.chain.transaction(a.signature);
      if (!r) continue; // never landed
      if (a.kind === 'hire') chainOut.hire += -solDelta(r, creator);
      if (a.kind === 'burn') chainOut.burn += -solDelta(r, fund);
      if (a.kind === 'claim') {
        botClaimFees += r.feeLamports;
        if (r.err) failedClaimFees += r.feeLamports;
      }
    }
    const vaultLeft = (await w.deps.pump.getClaimable(creator)).totalLamports;

    // ---- what the ledger says
    const epoch = new Date(0);
    const ledgerOut = { hire: await w.store.ledger.netOutflowSince('hire', epoch), burn: await w.store.ledger.netOutflowSince('burn', epoch) };
    const balance = { hire: await w.store.ledger.balance('hire'), burn: await w.store.ledger.balance('burn') };
    const totals = await w.store.claims.totals();
    const owed = await w.store.claims.pendingFundTransfer();
    const outstanding = { hire: 0n, burn: 0n };
    for (const rat of await w.store.rats.listByStatus(['hiring'])) if (rat.reserveLedgerId !== null) outstanding.hire += rat.salaryLamports;
    for (const b of await w.store.burns.listByStatus(['pending', 'unknown'])) if (b.reserveLedgerId !== null) outstanding.burn += b.reservedLamports;

    // 1. every lamport that left our vaults (bot claims + strangers' claims) is credited exactly once
    expect(totals.claimed).toBe(accrued - vaultLeft);
    expect(totals.hireShare + totals.fundShare).toBe(totals.claimed);
    // 2. the ledger books exactly what left the paying wallet, per bucket (plus reservations still in flight)
    expect(ledgerOut.hire).toBe(chainOut.hire + outstanding.hire);
    expect(ledgerOut.burn).toBe(chainOut.burn + outstanding.burn);
    expect(totals.fee).toBe(botClaimFees - failedClaimFees);
    // 3. SOL spent never exceeds SOL claimed. Only a failed claim's network fee can come from the creator reserve.
    expect(ledgerOut.hire).toBeLessThanOrEqual(totals.hireShare);
    expect(ledgerOut.burn).toBeLessThanOrEqual(totals.fundShare);
    expect(balance.hire).toBeGreaterThanOrEqual(-failedClaimFees);
    expect(balance.burn).toBeGreaterThanOrEqual(0n);
    // 4. the wallets agree with the ledger to the lamport, and the owner's own SOL was never spent
    const creatorNow = w.chain.sol(creator);
    const fundNow = w.chain.sol(fund);
    expect(creatorNow - creatorStart).toBe(balance.hire + outstanding.hire + owed);
    expect(fundNow - fundStart).toBe(balance.burn + outstanding.burn - owed);
    expect(creatorNow).toBeGreaterThanOrEqual(creatorStart - failedClaimFees);
    expect(fundNow).toBeGreaterThanOrEqual(fundStart);
  } finally {
    await w.close();
  }
}

describe('property: end-to-end money invariants (fast-check, live on SimChain)', () => {
  it('regression (found by this property): a stranger\'s claim credited in the same loop as a burn round did not make the fund burn its own SOL', () =>
    scenario({
      seed: 2,
      hireMode: 'two_step',
      bursts: [
        { bonding: 357_779_902n, amm: 862_296_837n, external: true, failRate: 0, loops: 7 },
        { bonding: 19_714_160n, amm: 528_262_657n, external: true, failRate: 0, loops: 7 },
      ],
    }), 120_000);

  it('random launches with random failures: spent never exceeds claimed, ledger equals chain to the lamport', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          seed: fc.integer({ min: 1, max: 1_000_000 }),
          hireMode: fc.constantFrom<'single' | 'two_step'>('single', 'two_step'),
          bursts: fc.array(burst, { minLength: 1, maxLength: 5 }),
        }),
        scenario,
      ),
      { numRuns: 12, endOnFailure: true },
    );
  }, 600_000);
});
