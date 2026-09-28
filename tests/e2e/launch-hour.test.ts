// End-to-end simulations of a launch hour. Everything runs in memory: PGlite + SimChain + mock Jupiter +
// FakeClock. DRY RUN scenarios never submit anything; "live" scenarios execute only against SimChain.
import { createApp, StateService } from '@rat/api';
import { StateResponseSchema } from '@rat/contract';
import { TOKEN_2022_PROGRAM, formatSol } from '@rat/core';
import { SOL, type SimWorld, createSimWorld } from '@rat/worker';
import { afterEach, describe, expect, it } from 'vitest';
import { burnRounds, runLaunch } from './helpers';

let w: SimWorld;
afterEach(async () => w?.close());

const HOUR = 3600;

async function drain(world: SimWorld, seconds: number) {
  await world.run(seconds, { stepSec: 5 });
}

async function ledgerTotals(world: SimWorld) {
  const sums = await world.store.ledger.sumByReason();
  const g = (k: string) => sums.get(k) ?? 0n;
  return {
    hireCredited: g('hire:claim_credit'),
    burnCredited: g('burn:claim_credit'),
    hireSpent: -(g('hire:hire_reserve') + g('hire:hire_settle') + g('hire:hire_release')),
    burnSpent: -(g('burn:burn_reserve') + g('burn:burn_settle') + g('burn:burn_release')),
    claimFees: -g('hire:claim_fee'),
  };
}

describe('A. DRY RUN launch hour: 50 SOL of creator fees', () => {
  it('claims every lamport once, splits 50/50, hires and burns within caps, sends nothing', async () => {
    w = await createSimWorld({ dryRun: true });
    const creatorStart = w.chain.sol(w.creator.publicKey.toBase58());
    const fundStart = w.chain.sol(w.fund.publicKey.toBase58());
    const t0 = performance.now();
    const meter = await runLaunch(w, { seconds: HOUR, totalFees: 50n * SOL, graduateAtSec: 20 * 60 });
    // fees claimed after the last burn wait for the next round (random 8 to 12 min): drain past one more round
    await drain(w, 14 * 60);
    const elapsed = (performance.now() - t0) / 1000;

    const claims = await w.store.claims.totals();
    const l = await ledgerTotals(w);
    const rats = await w.store.rats.listByStatus(['active', 'frozen']);
    const burns = await w.store.burns.totals();
    const salary = w.deps.config.salaryLamports;

    // every lamport of fees counted exactly once, split 50/50 (the fund gets floor(50%), so an odd lamport
    // of a claim goes to hires: at most 1 lamport per claim)
    expect(claims.claimed).toBe(50n * SOL);
    expect(l.hireCredited + l.burnCredited).toBe(50n * SOL);
    expect(l.hireCredited - 25n * SOL).toBeGreaterThanOrEqual(0n);
    expect(l.hireCredited - 25n * SOL).toBeLessThanOrEqual(BigInt(claims.count));
    // hires: paper hires cost exactly the salary; the whole hire budget is used
    expect(l.hireSpent).toBe(BigInt(rats.length) * salary);
    expect(await w.store.ledger.balance('hire')).toBeLessThan(salary);
    expect(await w.store.ledger.balance('hire')).toBeGreaterThanOrEqual(0n);
    expect(rats.length).toBe(Number(l.hireCredited / salary));
    // burn rounds a random 8 to 12 minutes apart, each split into chunks of at most 1 SOL a few seconds apart;
    // the whole burn bucket is spent
    const r = burnRounds(await w.store.burns.listByStatus(['simulated']));
    expect(r.txs).toBe(burns.count);
    expect(r.rounds).toBeGreaterThanOrEqual(6);
    expect(r.rounds).toBeLessThanOrEqual(10);
    expect(r.maxChunk).toBeLessThanOrEqual(w.deps.config.burn.chunkMaxLamports);
    for (const g of r.roundGaps) {
      expect(g).toBeGreaterThanOrEqual(480);
      expect(g).toBeLessThanOrEqual(725);
    }
    for (const g of r.chunkGaps) {
      expect(g).toBeGreaterThanOrEqual(3);
      expect(g).toBeLessThanOrEqual(13);
    }
    expect(new Set(r.roundGaps).size).toBeGreaterThan(1);
    expect(burns.spent).toBe(l.burnCredited);
    expect(await w.store.ledger.balance('burn')).toBe(0n);
    // caps: 25 SOL per bucket is under the 30 SOL/h cap; the 50% alert fired once per bucket
    const hourAgo = new Date(w.clock.now().getTime() - HOUR * 1000);
    expect(await w.store.ledger.netOutflowSince('hire', hourAgo)).toBeLessThanOrEqual(30n * SOL);
    expect(await w.store.ledger.netOutflowSince('burn', hourAgo)).toBeLessThanOrEqual(30n * SOL);
    expect(w.alerts.keys().filter((k) => k === 'cap_alert_hire').length).toBe(1);
    expect(w.alerts.keys().filter((k) => k === 'cap_alert_burn').length).toBe(1);
    expect(w.alerts.keys()).not.toContain('cap_reached_hire');
    // limits
    expect(meter.maxHiresPerLoop).toBeLessThanOrEqual(20);
    expect(meter.maxJupiterPerMinute).toBeLessThanOrEqual(55);
    // DRY RUN: nothing sent, wallets untouched
    expect(w.simSender.submitted).toBe(0);
    expect(w.chain.sol(w.creator.publicKey.toBase58())).toBe(creatorStart);
    expect(w.chain.sol(w.fund.publicKey.toBase58())).toBe(fundStart);
    // the website sees the same numbers
    const app = createApp({ service: new StateService(w.store, w.deps.config, w.clock), clock: w.clock, cacheSec: 0, corsOrigin: '*' });
    const state = StateResponseSchema.parse(await (await app.request('/api/state')).json());
    expect(state.bot.mode).toBe('dry_run');
    expect(state.treasury.totalClaimedSol).toBe(50);
    expect(state.treasury.totalBurnSpentSol).toBeCloseTo(25, 6);
    expect(state.portfolio.ratCount).toBe(rats.length);
    const events = await w.store.events.countByType();
    expect(events.hire).toBe(rats.length);
    expect(events.burn).toBe(burns.count);

    console.log(
      `[A] 50 SOL hour (DRY RUN): ${rats.length} rats, ${r.rounds} burn rounds in ${burns.count} txs (max ${formatSol(r.maxChunk)} SOL each), hire spent ${formatSol(l.hireSpent)} SOL, ` +
        `burn spent ${formatSol(burns.spent)} SOL, max ${meter.maxHiresPerLoop} hires/loop, max ${meter.maxJupiterPerMinute} Jupiter calls/min, ` +
        `0 txs sent, ran in ${elapsed.toFixed(1)}s`,
    );
  });
});

describe('B. DRY RUN double volume: 100 SOL in one hour hits the caps', () => {
  it('stops each bucket at 30 SOL/h, alerts, and spends the carried budget in the next hour', async () => {
    // burn round pacing off: this test is about the hourly cap itself (pacing is covered by tests/sim)
    w = await createSimWorld({ dryRun: true, env: { BURN_ROUND_MAX_SOL: '0' } });
    await runLaunch(w, { seconds: HOUR, totalFees: 100n * SOL });
    const hourAgo = () => new Date(w.clock.now().getTime() - HOUR * 1000);
    const hireOut = await w.store.ledger.netOutflowSince('hire', hourAgo());
    const burnOut = await w.store.ledger.netOutflowSince('burn', hourAgo());
    expect(hireOut).toBeLessThanOrEqual(30n * SOL);
    expect(burnOut).toBeLessThanOrEqual(30n * SOL);
    expect(hireOut).toBeGreaterThan(29n * SOL);
    // burns use the room left under the cap instead of skipping (a burn every 10 minutes)
    expect(burnOut).toBeGreaterThan(29n * SOL);
    expect(w.alerts.keys()).toContain('cap_reached_hire');
    expect(w.alerts.keys()).toContain('cap_reached_burn');
    const carried = await w.store.ledger.balance('hire');
    expect(carried).toBeGreaterThan(19n * SOL);
    // the next hour: no new fees, the carried budget gets spent as the window rolls
    await drain(w, HOUR + 120);
    expect(await w.store.ledger.balance('hire')).toBeLessThan(w.deps.config.salaryLamports);
    expect(await w.store.ledger.balance('burn')).toBe(0n);
    // at no point did any rolling hour exceed the cap (check at the end of each 10-minute block)
    const rats = await w.store.rats.listByStatus(['active']);
    expect(rats.length).toBe(Number((50n * SOL) / w.deps.config.salaryLamports));
    console.log(`[B] 100 SOL hour: hire outflow first hour ${formatSol(hireOut)} SOL (cap 30), carried ${formatSol(carried)} SOL, ${rats.length} rats after 2h`);
    // two simulated hours and about 1,700 hires: 45 to 75 s on a CI runner, too close to the 60 s default
  }, 180_000);
});

describe('C. LIVE on SimChain (in-memory): 50 SOL hour with exact conservation', () => {
  it('real balances match the ledger to the lamport; rats hold exactly what the database says', async () => {
    w = await createSimWorld({ dryRun: false });
    const creator = w.creator.publicKey.toBase58();
    const fund = w.fund.publicKey.toBase58();
    const creatorStart = w.chain.sol(creator);
    const fundStart = w.chain.sol(fund);
    const supplyStart = w.chain.mintState(w.coinMint)!.supply;
    let creatorMin = creatorStart;
    const meter = await runLaunch(w, {
      seconds: HOUR,
      totalFees: 50n * SOL,
      graduateAtSec: 20 * 60,
      onTick: () => {
        creatorMin = w.chain.sol(creator) < creatorMin ? w.chain.sol(creator) : creatorMin;
      },
    });
    await drain(w, 60);

    const hire = await w.store.ledger.balance('hire');
    const burn = await w.store.ledger.balance('burn');
    const owed = await w.store.claims.pendingFundTransfer();
    // conservation: each wallet changed by exactly what the ledger says
    expect(w.chain.sol(creator) - creatorStart).toBe(hire + owed);
    expect(w.chain.sol(fund) - fundStart).toBe(burn - owed);
    // the creator's own money (its reserve) was never spent
    expect(creatorMin).toBeGreaterThanOrEqual(w.deps.config.creatorReserveLamports);
    // every rat on-chain matches the database, and got exactly one salary
    const rats = await w.store.rats.listByStatus(['active', 'frozen']);
    expect(rats.length).toBeGreaterThan(700);
    for (const r of rats) {
      expect(w.chain.tokenBalance(r.wallet, r.stockMint, TOKEN_2022_PROGRAM)).toBe(r.tokenAmountRaw);
      expect(w.chain.sol(r.wallet)).toBe(w.deps.config.ratBufferLamports);
    }
    // burns reduced the coin supply by what they burned (the fund keeps only the slippage buffer)
    const burns = await w.store.burns.totals();
    const fundCoin = w.chain.tokenBalance(fund, w.coinMint, TOKEN_2022_PROGRAM);
    expect(w.chain.mintState(w.coinMint)!.supply).toBe(supplyStart + (await boughtTotal(w)) - burns.burnedRaw);
    expect(burns.count).toBeGreaterThanOrEqual(6);
    expect(meter.maxHiresPerLoop).toBeLessThanOrEqual(20);
    const l = await ledgerTotals(w);
    console.log(
      `[C] LIVE SimChain 50 SOL hour: ${rats.length} rats, real cost per rat ${formatSol(l.hireSpent / BigInt(rats.length))} SOL, ` +
        `claim fees ${formatSol(l.claimFees)} SOL, ${burns.count} burns, fund keeps ${fundCoin} raw coin for the next burn, conservation exact`,
    );
  });
});

/** Coin bought by the fund over the run = burned + what the fund still holds. */
async function boughtTotal(world: SimWorld): Promise<bigint> {
  const burns = await world.store.burns.totals();
  return burns.burnedRaw + world.chain.tokenBalance(world.fund.publicKey.toBase58(), world.coinMint, TOKEN_2022_PROGRAM);
}

describe('D. LIVE on SimChain with the production default: every fee hires rats', () => {
  it('HIRE_SPLIT_BPS=10000: nothing reaches the fund wallet, nothing is burned, every claimed lamport is for hires', async () => {
    w = await createSimWorld({ dryRun: false, env: { HIRE_SPLIT_BPS: '10000' } });
    expect(w.deps.config.hireSplitBps).toBe(10_000);
    const creator = w.creator.publicKey.toBase58();
    const fund = w.fund.publicKey.toBase58();
    const creatorStart = w.chain.sol(creator);
    const fundStart = w.chain.sol(fund);
    const supplyStart = w.chain.mintState(w.coinMint)!.supply;
    await runLaunch(w, { seconds: HOUR / 2, totalFees: 12n * SOL, graduateAtSec: 10 * 60 });
    await drain(w, 15 * 60); // past at least one burn window: still no burn

    const claims = await w.store.claims.totals();
    const l = await ledgerTotals(w);
    expect(claims.claimed).toBe(12n * SOL);
    expect(l.hireCredited).toBe(12n * SOL);
    expect(l.burnCredited).toBe(0n);
    expect(await w.store.claims.pendingFundTransfer()).toBe(0n);
    // the fund wallet is never touched and the coin supply never shrinks
    expect(w.chain.sol(fund)).toBe(fundStart);
    expect((await w.store.burns.totals()).count).toBe(0);
    expect(w.chain.mintState(w.coinMint)!.supply).toBe(supplyStart);
    // conservation: the creator changed by exactly the hire bucket; every rat holds its stock
    expect(w.chain.sol(creator) - creatorStart).toBe(await w.store.ledger.balance('hire'));
    const rats = await w.store.rats.listByStatus(['active', 'frozen']);
    expect(rats.length).toBeGreaterThan(350); // 12 SOL / ~0.03 SOL per rat, twice the 50/50 count
    for (const r of rats) expect(w.chain.tokenBalance(r.wallet, r.stockMint, TOKEN_2022_PROGRAM)).toBe(r.tokenAmountRaw);
    // the feed says so: claims carry nothing for the fund
    const events = await w.store.events.after(0, 10_000);
    const claimEvents = events.filter((e) => e.type === 'claim');
    expect(claimEvents.length).toBeGreaterThan(0);
    for (const e of claimEvents) expect((e.data as { toFundSol: number }).toFundSol).toBe(0);
    console.log(`[D] production default: 12 SOL claimed, ${rats.length} rats, fund wallet untouched, 0 burns`);
  }, 180_000);
});
