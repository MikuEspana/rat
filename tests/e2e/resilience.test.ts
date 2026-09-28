// Failure injection, kill switch, stock pause and outside actors during a live SimChain run (in-memory only).
import { TOKEN_2022_PROGRAM } from '@rat/core';
import { collectCreatorFeeV2Ix } from '@rat/pump';
import { engageKillSwitch, releaseKillSwitch } from '@rat/safety';
import { SOL, type SimWorld, createSimWorld, runClaimStep, runHireStep, runMintStep, runPriceStep, runWatchStep } from '@rat/worker';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';
import { runLaunch } from './helpers';
import { checkMoney, moneyStart } from './money-check';

let w: SimWorld;
afterEach(async () => w?.close());

async function conservation(world: SimWorld, creatorStart: bigint) {
  const hire = await world.store.ledger.balance('hire');
  expect(world.chain.sol(world.creator.publicKey.toBase58()) - creatorStart).toBe(hire);
  expect(hire).toBeGreaterThanOrEqual(0n);
  // every claimed lamport is hire budget: nothing is booked anywhere else
  expect([...(await world.store.ledger.sumByReason()).keys()].filter((k) => !k.startsWith('hire:'))).toEqual([]);
}

describe('D. random transaction failures (drop, fail, land-but-timeout, reject)', () => {
  it('never double funds a rat, resolves every hire, keeps the ledger exact', async () => {
    w = await createSimWorld({ dryRun: false, seed: 7 });
    const creatorStart = w.chain.sol(w.creator.publicKey.toBase58());
    // 12% of claim and hire transactions fail in a random way
    w.simSender.setRandomFailures(0.12, w.rng);
    await runLaunch(w, { seconds: 40 * 60, totalFees: 20n * SOL, graduateAtSec: 10 * 60, onTick: () => w.chain.advanceBlocks(10) });
    const injected = w.simSender.randomInjected;
    // failures stop; give the bot time to resolve everything (unknowns expire or confirm, retries run)
    w.simSender.clearFailures();
    await w.run(21 * 60, { stepSec: 5, onTick: () => w.chain.advanceBlocks(10) });

    expect(injected).toBeGreaterThan(30);
    // nothing left in flight: a rat may still wait in `hiring` only when its attempts can no longer land,
    // it holds no reservation, and the hire budget is below one salary (it resumes when fees arrive)
    const waiting = await w.store.rats.listByStatus(['hiring']);
    for (const r of waiting) {
      expect(r.reserveLedgerId).toBeNull();
      for (const a of await w.store.attempts.forRef('rat', String(r.id))) expect(['failed', 'expired']).toContain(a.status);
    }
    if (waiting.length > 0) expect(await w.store.ledger.balance('hire')).toBeLessThan(w.deps.config.salaryLamports);
    const openClaims = await w.store.db.query.claims.findMany({ where: (c, { inArray }) => inArray(c.status, ['pending', 'unknown']) });
    expect(openClaims.length).toBe(0);
    const rats = await w.store.rats.listByStatus(['active']);
    expect(rats.length).toBeGreaterThan(500); // 20 SOL, all of it for hires
    for (const r of rats) {
      expect(w.chain.tokenBalance(r.wallet, r.stockMint, TOKEN_2022_PROGRAM)).toBe(r.tokenAmountRaw);
      // exactly one salary ever reached each rat
      expect(w.chain.sol(r.wallet)).toBe(w.deps.config.ratBufferLamports);
    }
    await conservation(w, creatorStart);
    const claims = await w.store.claims.totals();
    expect(claims.claimed).toBe(20n * SOL);
    expect(claims.hireShare).toBe(claims.claimed);
    const failedRats = await w.store.rats.listByStatus(['failed']);
    console.log(`[D] ${injected} random failures: ${rats.length} rats active, ${failedRats.length} gave up, 0 double funded, all 20 SOL claimed once, ledger exact`);
    // about 35 s alone with the 50/50 split, hires have doubled since; well over 60 s (the default) on a busy machine
  }, 360_000);
});

describe('E. kill switch and stock pause during a live run', () => {
  it('kill switch stops every transaction; a paused stock gets no hires and its rats freeze', async () => {
    w = await createSimWorld({ dryRun: false });
    const coin = w.stockMints.get('COINx')!;
    let submittedAtKill = -1;
    let hiresIntoCoinWhilePaused = 0;
    let paused = false;
    await runLaunch(w, {
      seconds: 50 * 60,
      totalFees: 20n * SOL,
      onTick: async (t) => {
        if (t === 10 * 60) {
          w.chain.updateMint(coin, { paused: true });
          paused = true;
        }
        if (t === 20 * 60) {
          await engageKillSwitch(w.store.settings, 'test');
          submittedAtKill = w.simSender.submitted;
        }
        if (t > 20 * 60 && t < 30 * 60) expect(w.simSender.submitted).toBe(submittedAtKill);
        if (t === 30 * 60) await releaseKillSwitch(w.store.settings);
        if (t === 40 * 60) {
          w.chain.updateMint(coin, { paused: false });
          paused = false;
        }
        if (paused) {
          const recent = await w.store.rats.listByStatus(['active', 'hiring']);
          hiresIntoCoinWhilePaused = recent.filter((r) => r.stockMint === coin && r.status === 'active' && r.hiredAt && r.hiredAt.getTime() > w.clock.now().getTime() - 5_000).length;
          expect(hiresIntoCoinWhilePaused).toBe(0);
        }
      },
    });
    const types = await w.store.events.countByType();
    expect(types.freeze).toBeGreaterThanOrEqual(1);
    expect(types.unfreeze).toBeGreaterThanOrEqual(1);
    expect(w.simSender.submitted).toBeGreaterThan(submittedAtKill);
    expect((await w.store.rats.listByStatus(['frozen'])).length).toBe(0);
    console.log(`[E] kill switch held 10 min with 0 txs; COINx paused 30 min with 0 hires into it; freeze/unfreeze events ${types.freeze}/${types.unfreeze}`);
    // every fee hires rats now (twice the hires of the 50/50 split): 75 s alone, over 120 s on a busy machine
  }, 360_000);
});

describe('F. outside actors during a live run', () => {
  it('external claims are credited to hires in full, random SOL is left unspent, the ledger stays exact', async () => {
    w = await createSimWorld({ dryRun: false });
    const creatorStart = w.chain.sol(w.creator.publicKey.toBase58());
    const stranger = Keypair.generate();
    w.chain.fundAccount(stranger.publicKey.toBase58(), 10n * SOL);
    let gifts = 0n;
    await runLaunch(w, {
      seconds: 30 * 60,
      totalFees: 10n * SOL,
      onTick: async (t) => {
        if (t % 300 === 150) {
          const claim = { kind: 'claim' as const, label: 'x', feePayer: stranger, signers: [], instructions: [collectCreatorFeeV2Ix(w.creator.publicKey.toBase58())], computeUnitLimit: 200_000 };
          await w.simSender.submit(await w.simSender.prepare(claim));
          const gift = { ...claim, instructions: [SystemProgram.transfer({ fromPubkey: stranger.publicKey, toPubkey: w.creator.publicKey, lamports: 1_000_000 })] };
          await w.simSender.submit(await w.simSender.prepare(gift));
          gifts += 1_000_000n;
        }
      },
    });
    await w.run(11 * 60, { stepSec: 5 });
    const claims = await w.store.claims.totals();
    expect(claims.claimed).toBe(10n * SOL);
    expect(claims.hireShare).toBe(claims.claimed);
    // gifts are the only thing the ledger does not explain
    const hire = await w.store.ledger.balance('hire');
    expect(w.chain.sol(w.creator.publicKey.toBase58()) - creatorStart).toBe(hire + gifts);
    const externalRows = await w.store.db.query.claims.findMany({ where: (c, { eq }) => eq(c.source, 'external') });
    const external = externalRows.length;
    expect(external).toBeGreaterThan(0);
    for (const c of externalRows) expect(c.hireShareLamports).toBe(c.claimedLamports);
    expect(w.alerts.keys().filter((k) => k.startsWith('inflow_')).length).toBe(Number(gifts / 1_000_000n));
    console.log(`[F] ${external} external claims booked in full for hires, ${gifts / 1_000_000n} unexplained gifts left unspent, conservation exact`);
  }, 180_000);
});

describe('G. a reservation closed just before a crash is never reused (chaos finding RT-18)', () => {
  it('the rat still points at a released reservation: the next attempt reserves again, so the spend is booked', async () => {
    w = await createSimWorld({ dryRun: false, env: { MAX_HIRES_PER_LOOP: '1' } });
    const start = moneyStart(w);
    await runPriceStep(w.deps, w.worker.state);
    await runMintStep(w.deps);
    await runWatchStep(w.deps);
    w.accrue({ bondingLamports: SOL / 5n });
    start.accrued = SOL / 5n;
    await runClaimStep(w.deps, w.worker.state);
    w.simSender.failNext('drop', 'hire');
    expect((await runHireStep(w.deps, w.worker.state)).hired).toBe(0);
    const [rat] = await w.store.rats.listByStatus(['hiring']);
    const released = (await w.store.db.query.ledgerEntries.findMany({ where: (l, { eq }) => eq(l.reason, 'hire_release') }))[0]!;
    // crash between "release the reservation" and "clear it on the rat": the rat still points at it
    await w.store.rats.update(rat!.id, { reserveLedgerId: released.closesId });
    expect(await w.store.ledger.isOpen(released.closesId!)).toBe(false);
    await runHireStep(w.deps, w.worker.state);
    expect((await w.store.rats.get(rat!.id))?.status).toBe('active');
    for (let i = 0; i < 6; i++) {
      await w.worker.tick();
      w.clock.advanceSeconds(35);
      w.chain.advanceBlocks(90);
    }
    await checkMoney(w, start);
  });
});
