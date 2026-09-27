import { NATIVE_SOL_MINT, TOKEN_2022_PROGRAM, formatSol, lamportsToSol, sumBig } from '@rat/core';
import { collectCreatorFeeV2Ix } from '@rat/pump';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';
import { SOL, type SimWorld, createSimWorld } from './sim-world';
import { runBurnStep } from './steps/burn';
import { runClaimStep } from './steps/claim';
import { runHireStep } from './steps/hire';
import { runMintStep } from './steps/mints';
import { runPriceStep } from './steps/prices';
import { runReconcileStep } from './steps/reconcile';
import { runWatchStep } from './steps/watch';

let w: SimWorld;
afterEach(async () => w?.close());

async function prime(world: SimWorld) {
  await runPriceStep(world.deps, world.worker.state);
  await runMintStep(world.deps);
}

describe('live mode on SimChain (in-memory only)', () => {
  it('claims both vaults, splits 50/50 exactly, forwards the fund share in the same tx', async () => {
    w = await createSimWorld({ dryRun: false });
    await prime(w);
    w.accrue({ bondingLamports: SOL, ammLamports: SOL / 2n });
    const fundBefore = w.chain.sol(w.fund.publicKey.toBase58());
    const r = await runClaimStep(w.deps, w.worker.state);
    expect(r).toMatchObject({ status: 'claimed', claimedLamports: (3n * SOL) / 2n });
    expect(w.chain.sol(w.fund.publicKey.toBase58()) - fundBefore).toBe((3n * SOL) / 4n);
    const claimTx = (await w.store.claims.totals());
    expect(claimTx.claimed).toBe((3n * SOL) / 2n);
    expect(await w.store.ledger.balance('burn')).toBe((3n * SOL) / 4n);
    expect(await w.store.ledger.balance('hire')).toBe((3n * SOL) / 4n - claimTx.fee);
    expect(await w.store.claims.pendingFundTransfer()).toBe(0n);
    expect((await w.store.events.latest(5))[0]?.type).toBe('claim');
  });

  it('hires rats with the hire bucket only, each rat holds its stock on-chain', async () => {
    w = await createSimWorld({ dryRun: false, creatorSol: SOL / 10n });
    await prime(w);
    w.accrue({ bondingLamports: (SOL * 6n) / 10n });
    await runClaimStep(w.deps, w.worker.state);
    const budget = await w.store.ledger.balance('hire');
    const r = await runHireStep(w.deps, w.worker.state);
    // real cost per rat is a bit under the salary (overhead allowance), so the savings can fund an extra rat
    expect(r.hired).toBeGreaterThanOrEqual(Number(budget / w.deps.config.salaryLamports));
    const rats = await w.store.rats.listByStatus(['active']);
    expect(rats.length).toBe(r.hired);
    for (const rat of rats) {
      const onChain = w.chain.tokenBalance(rat.wallet, rat.stockMint, TOKEN_2022_PROGRAM);
      expect(onChain).toBe(rat.tokenAmountRaw);
      expect(w.chain.sol(rat.wallet)).toBe(w.deps.config.ratBufferLamports);
      expect(rat.costUsd).toBeGreaterThan(0);
    }
    // the creator never dipped below its reserve: its own money was not spent
    expect(w.chain.sol(w.creator.publicKey.toBase58())).toBeGreaterThanOrEqual(w.deps.config.creatorReserveLamports);
    expect(await w.store.ledger.balance('hire')).toBeGreaterThanOrEqual(0n);
    expect(await w.store.ledger.balance('hire')).toBeLessThan(w.deps.config.salaryLamports);
  });

  it('buys and burns with the burn bucket, skips under 0.01 SOL', async () => {
    w = await createSimWorld({ dryRun: false });
    await prime(w);
    expect((await runBurnStep(w.deps, w.worker.state)).status).toBe('skipped');
    w.accrue({ bondingLamports: SOL });
    await runClaimStep(w.deps, w.worker.state);
    const supplyBefore = w.chain.mintState(w.coinMint)!.supply;
    const r = await runBurnStep(w.deps, w.worker.state);
    expect(r.status).toBe('burned');
    // the mock swap mints what it sells; the fund keeps (out - minOut) for the next burn
    const leftover = w.chain.tokenBalance(w.fund.publicKey.toBase58(), w.coinMint, TOKEN_2022_PROGRAM);
    expect(w.chain.mintState(w.coinMint)!.supply).toBe(supplyBefore + leftover);
    expect(r.burnedRaw).toBeGreaterThan(0n);
    expect(leftover).toBeLessThan(r.burnedRaw / 60n); // 1.5% slippage buffer
    // next burn burns the leftover too
    w.accrue({ bondingLamports: SOL });
    await runClaimStep(w.deps, w.worker.state);
    const r2 = await runBurnStep(w.deps, w.worker.state);
    expect(r2.burnedRaw).toBeGreaterThan(leftover);
    const left = await w.store.ledger.balance('burn');
    expect(left).toBeGreaterThanOrEqual(0n);
    expect(left).toBeLessThan(w.deps.config.hireOverheadEstLamports);
    console.log(`burned ${r.burnedRaw} raw coin for ${formatSol(r.spentLamports)} SOL`);
  });
});

describe('wallet watch (owner decision #7)', () => {
  it('books an external claim of our vault 50/50, forwards the fund share on our next claim, alerts on other inflows', async () => {
    w = await createSimWorld({ dryRun: false });
    await prime(w);
    await runWatchStep(w.deps); // first run sets the cursor
    // someone else triggers our claim
    const stranger = Keypair.generate();
    w.chain.fundAccount(stranger.publicKey.toBase58(), SOL);
    w.accrue({ bondingLamports: 2n * SOL });
    const req = { kind: 'claim' as const, label: 'x', feePayer: stranger, signers: [], instructions: [collectCreatorFeeV2Ix(w.creator.publicKey.toBase58())], computeUnitLimit: 200_000 };
    expect((await w.simSender.submit(await w.simSender.prepare(req))).status).toBe('confirmed');
    // and someone sends random SOL to the creator
    const gift = { ...req, instructions: [SystemProgram.transfer({ fromPubkey: stranger.publicKey, toPubkey: w.creator.publicKey, lamports: 5_000_000 })] };
    await w.simSender.submit(await w.simSender.prepare(gift));

    const res = await runWatchStep(w.deps);
    expect(res).toMatchObject({ externalClaims: 1, unexplainedInflows: 1, unknownSigned: 0 });
    expect(await w.store.ledger.balance('hire')).toBe(SOL);
    expect(await w.store.ledger.balance('burn')).toBe(SOL);
    expect(await w.store.claims.pendingFundTransfer()).toBe(SOL);
    expect(w.alerts.keys().some((k) => k.startsWith('inflow_'))).toBe(true);
    // running the watch again books nothing twice
    expect(await runWatchStep(w.deps)).toMatchObject({ externalClaims: 0, unexplainedInflows: 0 });

    const fundBefore = w.chain.sol(w.fund.publicKey.toBase58());
    const claim = await runClaimStep(w.deps, w.worker.state);
    expect(claim.status).toBe('claimed');
    expect(w.chain.sol(w.fund.publicKey.toBase58()) - fundBefore).toBe(SOL);
    expect(await w.store.claims.pendingFundTransfer()).toBe(0n);
    // the unexplained 0.005 SOL was never credited
    expect(await w.store.ledger.balance('hire')).toBeLessThan(SOL);
  });

  it('a transaction signed by our creator that the bot did not send trips the kill switch', async () => {
    w = await createSimWorld({ dryRun: false });
    await prime(w);
    await runWatchStep(w.deps);
    const thief = Keypair.generate().publicKey;
    const req = { kind: 'claim' as const, label: 'x', feePayer: w.creator, signers: [], instructions: [SystemProgram.transfer({ fromPubkey: w.creator.publicKey, toPubkey: thief, lamports: 1_000_000 })], computeUnitLimit: 200_000 };
    await w.simSender.submit(await w.simSender.prepare(req));
    expect((await runWatchStep(w.deps)).unknownSigned).toBe(1);
    expect((await w.deps.killSwitch.status()).on).toBe(true);
    w.accrue({ bondingLamports: SOL });
    expect((await runClaimStep(w.deps, w.worker.state)).status).toBe('skipped');
  });
});

describe('wallet watch with RPC indexing lag', () => {
  it('a claim whose record is not visible yet is booked on a later loop, exactly once', async () => {
    w = await createSimWorld({ dryRun: false });
    await prime(w);
    await runWatchStep(w.deps);
    const stranger = Keypair.generate();
    w.chain.fundAccount(stranger.publicKey.toBase58(), SOL);
    w.accrue({ bondingLamports: SOL });
    const req = { kind: 'claim' as const, label: 'x', feePayer: stranger, signers: [], instructions: [collectCreatorFeeV2Ix(w.creator.publicKey.toBase58())], computeUnitLimit: 200_000 };
    await w.simSender.submit(await w.simSender.prepare(req));
    // the record is not indexed yet on the first look
    const real = w.reader.getTransactionRecord.bind(w.reader);
    let lag = true;
    w.reader.getTransactionRecord = async (sig: string) => (lag ? null : real(sig));
    expect((await runWatchStep(w.deps)).externalClaims).toBe(0);
    lag = false;
    expect((await runWatchStep(w.deps)).externalClaims).toBe(1);
    expect((await runWatchStep(w.deps)).externalClaims).toBe(0);
    expect(await w.store.ledger.balance('hire')).toBe(SOL / 2n);
  });
});

describe('hire state machine', () => {
  async function funded(world: SimWorld, sol = SOL / 2n) {
    await prime(world);
    world.accrue({ bondingLamports: sol });
    await runClaimStep(world.deps, world.worker.state);
  }

  it('restart mid-hire (landed but confirmation lost) never double funds', async () => {
    w = await createSimWorld({ dryRun: false, env: { MAX_HIRES_PER_LOOP: '1' } });
    await funded(w);
    w.simSender.failNext('land_timeout', 'hire');
    const r1 = await runHireStep(w.deps, w.worker.state);
    expect(r1).toMatchObject({ attempted: 1, hired: 0 });
    const [rat] = await w.store.rats.listByStatus(['hiring']);
    expect(rat).toBeDefined();
    const tokensAfterFirst = w.chain.tokenBalance(rat!.wallet, rat!.stockMint, TOKEN_2022_PROGRAM);
    expect(tokensAfterFirst).toBeGreaterThan(0n);
    // new worker process (fresh memory) picks it up
    const { createWorker } = await import('./worker');
    const again = createWorker(w.deps);
    const r2 = await runHireStep(w.deps, again.state);
    expect(r2.retried).toBe(1);
    const active = await w.store.rats.get(rat!.id);
    expect(active?.status).toBe('active');
    expect(w.chain.tokenBalance(rat!.wallet, rat!.stockMint, TOKEN_2022_PROGRAM)).toBe(tokensAfterFirst);
    expect(w.chain.sol(rat!.wallet)).toBe(w.deps.config.ratBufferLamports);
    const hireTxs = (await w.store.attempts.forRef('rat', String(rat!.id))).length;
    expect(hireTxs).toBe(1);
  });

  it('a dropped hire expires, its reservation is released, and the next loop retries', async () => {
    w = await createSimWorld({ dryRun: false, env: { MAX_HIRES_PER_LOOP: '1' } });
    await funded(w);
    const before = await w.store.ledger.balance('hire');
    w.simSender.failNext('drop', 'hire');
    const r1 = await runHireStep(w.deps, w.worker.state);
    expect(r1.hired).toBe(0);
    expect(await w.store.ledger.balance('hire')).toBe(before);
    const [rat] = await w.store.rats.listByStatus(['hiring']);
    const r2 = await runHireStep(w.deps, w.worker.state);
    expect(r2.hired).toBe(1);
    expect((await w.store.rats.get(rat!.id))?.status).toBe('active');
  });

  it('never hires into paused, unverified or (live) unapproved stocks', async () => {
    w = await createSimWorld({
      dryRun: false,
      stocks: [
        { symbol: 'GOODx', priceUsd: 100, change24hPct: 1 },
        { symbol: 'GOOD2x', priceUsd: 100, change24hPct: 1 },
        { symbol: 'GOOD3x', priceUsd: 100, change24hPct: 1 },
        { symbol: 'PAUSEDx', priceUsd: 100, change24hPct: 50 },
        { symbol: 'FAKEx', priceUsd: 100, change24hPct: 50, foreignAuthority: true },
        { symbol: 'LEGACYx', priceUsd: 100, change24hPct: 50, legacyProgram: true },
        { symbol: 'NOPEx', priceUsd: 100, change24hPct: 50, approved: false },
      ],
    });
    w.chain.updateMint(w.stockMints.get('PAUSEDx')!, { paused: true });
    await funded(w, 2n * SOL);
    const mintRes = await runMintStep(w.deps);
    expect(mintRes.rejected.map((x) => x.split(':')[0])).toEqual(expect.arrayContaining(['FAKEx', 'LEGACYx']));
    expect(mintRes.paused).toEqual(['PAUSEDx']);
    await runHireStep(w.deps, w.worker.state);
    const rats = await w.store.rats.listByStatus(['active', 'hiring']);
    expect(rats.length).toBeGreaterThan(0);
    const bad = new Set(['PAUSEDx', 'FAKEx', 'LEGACYx', 'NOPEx'].map((s) => w.stockMints.get(s)));
    for (const r of rats) expect(bad.has(r.stockMint)).toBe(false);
  });

  it('pausing a stock freezes its rats (one event), resuming unfreezes them', async () => {
    w = await createSimWorld({ dryRun: false });
    await funded(w);
    await runHireStep(w.deps, w.worker.state);
    const target = (await w.store.rats.listByStatus(['active']))[0]!.stockMint;
    const count = (await w.store.rats.listByStatus(['active'])).filter((r) => r.stockMint === target).length;
    w.chain.updateMint(target, { paused: true });
    await runMintStep(w.deps);
    expect((await w.store.rats.listByStatus(['frozen'])).length).toBe(count);
    const ev = (await w.store.events.latest(1))[0]!;
    expect(ev.type).toBe('freeze');
    expect(ev.data).toMatchObject({ scope: 'stock', ratCount: count, reason: 'stock_paused' });
    w.chain.updateMint(target, { paused: false });
    await runMintStep(w.deps);
    expect((await w.store.rats.listByStatus(['frozen'])).length).toBe(0);
    expect((await w.store.events.latest(1))[0]!.type).toBe('unfreeze');
  });

  it('reconcile freezes a rat whose tokens were moved by the issuer', async () => {
    w = await createSimWorld({ dryRun: false });
    await funded(w);
    await runHireStep(w.deps, w.worker.state);
    const rat = (await w.store.rats.listByStatus(['active']))[0]!;
    const { ataAddress } = await import('@rat/chain/sim');
    w.chain.seizeTokens(ataAddress(rat.wallet, rat.stockMint, TOKEN_2022_PROGRAM), 1n);
    const r = await runReconcileStep(w.deps, w.worker.state);
    expect(r.frozen).toBe(1);
    expect((await w.store.rats.get(rat.id))?.freezeReason).toBe('balance_mismatch');
    expect(w.alerts.keys()).toContain(`rat_balance_${rat.id}`);
  });

  it('caps hires per loop and respects the kill switch', async () => {
    w = await createSimWorld({ dryRun: false, env: { MAX_HIRES_PER_LOOP: '3' } });
    await funded(w, 2n * SOL);
    expect((await runHireStep(w.deps, w.worker.state)).attempted).toBe(3);
    const { engageKillSwitch } = await import('@rat/safety');
    await engageKillSwitch(w.store.settings, 'test');
    const before = w.simSender.submitted;
    expect((await runHireStep(w.deps, w.worker.state)).skipped).toBe('kill_switch');
    expect((await runBurnStep(w.deps, w.worker.state)).status).toBe('skipped');
    expect(w.simSender.submitted).toBe(before);
  });

  it('two-step hire mode (fallback flag) funds then buys', async () => {
    w = await createSimWorld({ dryRun: false, env: { HIRE_MODE: 'two_step', MAX_HIRES_PER_LOOP: '2' } });
    await funded(w);
    const r = await runHireStep(w.deps, w.worker.state);
    expect(r.hired).toBe(2);
    for (const rat of await w.store.rats.listByStatus(['active'])) {
      expect(rat.funded).toBe(true);
      expect(w.chain.tokenBalance(rat.wallet, rat.stockMint, TOKEN_2022_PROGRAM)).toBe(rat.tokenAmountRaw);
      expect(w.chain.sol(rat.wallet)).toBeGreaterThanOrEqual(w.deps.config.ratBufferLamports);
    }
  });
});

describe('DRY RUN (paper)', () => {
  it('claims, hires and burns on paper: nothing on-chain changes except what the world did', async () => {
    w = await createSimWorld({ dryRun: true });
    await prime(w);
    w.accrue({ bondingLamports: SOL });
    const creatorBefore = w.chain.sol(w.creator.publicKey.toBase58());
    const fundBefore = w.chain.sol(w.fund.publicKey.toBase58());
    const c = await runClaimStep(w.deps, w.worker.state);
    expect(c).toMatchObject({ status: 'paper', claimedLamports: SOL });
    // the same fees are not counted twice on the next loop
    expect((await runClaimStep(w.deps, w.worker.state)).status).toBe('skipped');
    const h = await runHireStep(w.deps, w.worker.state);
    expect(h.hired).toBe(16);
    const b = await runBurnStep(w.deps, w.worker.state);
    expect(b.status).toBe('paper');
    expect(w.simSender.submitted).toBe(0);
    expect(w.chain.sol(w.creator.publicKey.toBase58())).toBe(creatorBefore);
    expect(w.chain.sol(w.fund.publicKey.toBase58())).toBe(fundBefore);
    const rats = await w.store.rats.listByStatus(['active']);
    for (const r of rats) expect(w.chain.tokenBalance(r.wallet, r.stockMint, TOKEN_2022_PROGRAM)).toBe(0n);
    expect(await w.store.forMode('live').ledger.balance('hire')).toBe(0n);
    const types = await w.store.events.countByType();
    expect(types).toMatchObject({ claim: 1, hire: 16, burn: 1 });
    // fees that keep accruing are counted once more
    w.accrue({ bondingLamports: SOL / 10n });
    expect((await runClaimStep(w.deps, w.worker.state)).claimedLamports).toBe(SOL / 10n);
    console.log(`paper: ${lamportsToSol(sumBig([SOL, SOL / 10n]))} SOL claimed, ${rats.length} rats`);
  });
});

describe('scheduler and single worker', () => {
  it('runs each loop at its interval, never overlapping, with heartbeats', async () => {
    w = await createSimWorld({ dryRun: true, env: { DRY_RUN_FAKE_CLAIM_SOL_PER_HOUR: '1' } });
    const counts = new Map<string, number>();
    for (let t = 0; t < 1200; t += 5) {
      const ran = await w.worker.tick();
      for (const k of ran.keys()) counts.set(k, (counts.get(k) ?? 0) + 1);
      w.clock.advanceSeconds(5);
    }
    expect(counts.get('prices')).toBe(80);
    expect(counts.get('claim')).toBe(Math.ceil(1200 / 35));
    expect(counts.get('burn')).toBe(2);
    const beats = await w.store.heartbeats.all();
    expect(beats.map((b) => b.loop).sort()).toEqual(['burn', 'claim', 'keypool', 'mints', 'prices', 'reconcile']);
    expect(beats.every((b) => b.lastError === null)).toBe(true);
  });

  it('a second worker never ticks while the first holds the lease', async () => {
    w = await createSimWorld({ dryRun: true });
    const { LockedRunner, createWorker } = await import('./worker');
    const a = new LockedRunner(w.worker, { store: w.store, clock: w.clock, holder: 'A' });
    const b = new LockedRunner(createWorker(w.deps), { store: w.store, clock: w.clock, holder: 'B', ttlSec: 120 });
    expect(await a.tryTick()).toBe(true);
    expect(await b.tryTick()).toBe(false);
    w.clock.advanceSeconds(60);
    expect(await a.tryTick()).toBe(true);
    expect(await b.tryTick()).toBe(false);
    // A dies (stops renewing); after the lease expires B takes over
    w.clock.advanceSeconds(200);
    expect(await b.tryTick()).toBe(true);
    expect(await a.tryTick()).toBe(false);
  });
});

describe('claim reconciliation', () => {
  it('a claim whose confirmation was lost is credited exactly once later', async () => {
    w = await createSimWorld({ dryRun: false });
    await prime(w);
    w.accrue({ bondingLamports: SOL });
    w.simSender.failNext('land_timeout', 'claim');
    expect((await runClaimStep(w.deps, w.worker.state)).status).toBe('pending');
    expect(await w.store.ledger.balance('hire')).toBe(0n);
    await runClaimStep(w.deps, w.worker.state);
    expect(await w.store.ledger.balance('burn')).toBe(SOL / 2n);
    await runClaimStep(w.deps, w.worker.state);
    expect(await w.store.ledger.balance('burn')).toBe(SOL / 2n);
    expect((await w.store.claims.totals()).claimed).toBe(SOL);
  });
});
