// End-to-end simulations of a launch hour. Everything runs in memory: PGlite + SimChain + mock Jupiter +
// FakeClock. DRY RUN scenarios never submit anything; "live" scenarios execute only against SimChain.
// Every claimed lamport hires rats: the hire bucket is the only spending, capped at 60 SOL per rolling hour.
import { createApp, StateService } from '@rat/api';
import { StateResponseSchema } from '@rat/contract';
import { TOKEN_2022_PROGRAM, formatSol } from '@rat/core';
import { SOL, type SimWorld, createSimWorld } from '@rat/worker';
import { afterEach, describe, expect, it } from 'vitest';
import { type CallSample, jupiterSample, maxAtOneInstant, maxCallsPerMinute, maxRollingOutflow, runLaunch, yieldToEventLoop } from './helpers';

let w: SimWorld;
afterEach(async () => w?.close());

const HOUR = 3600;
const HIRE_SPEND_REASONS = ['hire_reserve', 'hire_settle', 'hire_release'];

async function drain(world: SimWorld, seconds: number, onTick?: () => void) {
  let ticks = 0;
  await world.run(seconds, {
    stepSec: 5,
    onTick: async () => {
      onTick?.();
      if (++ticks % 60 === 0) await yieldToEventLoop();
    },
  });
}

async function ledgerTotals(world: SimWorld) {
  const sums = await world.store.ledger.sumByReason();
  const g = (k: string) => sums.get(k) ?? 0n;
  return {
    hireCredited: g('hire:claim_credit'),
    hireSpent: -(g('hire:hire_reserve') + g('hire:hire_settle') + g('hire:hire_release')),
    claimFees: -g('hire:claim_fee'),
    /** anything booked outside the hire bucket (there must be nothing) */
    otherBuckets: [...sums.keys()].filter((k) => !k.startsWith('hire:')),
  };
}

/** Every hire spend row of this world's mode (reservations, settles, releases), for the rolling-hour checks. */
async function hireSpendRows(world: SimWorld) {
  return world.store.db.query.ledgerEntries.findMany({
    where: (e, { and, eq, inArray }) => and(eq(e.mode, world.store.mode), eq(e.bucket, 'hire'), inArray(e.reason, HIRE_SPEND_REASONS)),
  });
}

describe('A. DRY RUN launch hour: 50 SOL of creator fees', () => {
  it('claims every lamport once, all of it for hires, hires within the cap, sends nothing', async () => {
    w = await createSimWorld({ dryRun: true });
    const cfg = w.deps.config;
    const creatorStart = w.chain.sol(w.creator.publicKey.toBase58());
    const t0 = performance.now();
    const meter = await runLaunch(w, { seconds: HOUR, totalFees: 50n * SOL, graduateAtSec: 20 * 60 });
    // fees claimed in the last loops are hired in the next ones
    await drain(w, 5 * 60);
    const elapsed = (performance.now() - t0) / 1000;

    const claims = await w.store.claims.totals();
    const l = await ledgerTotals(w);
    const rats = await w.store.rats.listByStatus(['active', 'frozen']);
    const salary = cfg.salaryLamports;

    // every lamport of fees counted exactly once, and every one of them credited to hires
    expect(claims.claimed).toBe(50n * SOL);
    expect(claims.hireShare).toBe(claims.claimed);
    expect(l.hireCredited).toBe(50n * SOL);
    expect(l.otherBuckets).toEqual([]);
    // hires: paper hires cost exactly the salary; the whole hire budget is used
    expect(l.hireSpent).toBe(BigInt(rats.length) * salary);
    expect(await w.store.ledger.balance('hire')).toBeLessThan(salary);
    expect(await w.store.ledger.balance('hire')).toBeGreaterThanOrEqual(0n);
    expect(rats.length).toBe(Number(l.hireCredited / salary));
    // cap: 50 SOL is under the 60 SOL/h hire cap in every rolling hour; the 50% alert fired once
    expect(cfg.spendCapLamportsPerHour.hire).toBe(60n * SOL);
    const rolling = maxRollingOutflow(await hireSpendRows(w), HOUR * 1000);
    expect(rolling.lamports).toBeLessThanOrEqual(50n * SOL);
    expect(w.alerts.keys().filter((k) => k === 'cap_alert_hire').length).toBe(1);
    expect(w.alerts.keys()).not.toContain('cap_reached_hire');
    // limits
    expect(meter.maxHiresPerLoop).toBeLessThanOrEqual(cfg.maxHiresPerLoop);
    expect(meter.maxJupiterPerMinute).toBeLessThanOrEqual(cfg.jupiter.maxRpm);
    // DRY RUN: nothing sent, the creator wallet untouched
    expect(w.simSender.submitted).toBe(0);
    expect(w.chain.sol(w.creator.publicKey.toBase58())).toBe(creatorStart);
    // the website sees the same numbers
    const app = createApp({ service: new StateService(w.store, cfg, w.clock), clock: w.clock, cacheSec: 0, corsOrigin: '*' });
    const state = StateResponseSchema.parse(await (await app.request('/api/state')).json());
    expect(state.bot.mode).toBe('dry_run');
    expect(state.treasury.totalClaimedSol).toBe(50);
    expect(state.treasury.totalHiredSol).toBeCloseTo(Number(l.hireSpent) / 1e9, 6);
    expect(state.treasury.waitingSol).toBeLessThan(Number(salary) / 1e9);
    expect(state.portfolio.ratCount).toBe(rats.length);
    const events = await w.store.events.countByType();
    expect(events.hire).toBe(rats.length);
    expect(Object.keys(events).sort()).toEqual(['claim', 'hire']);

    console.log(
      `[A] 50 SOL hour (DRY RUN): ${rats.length} rats, hire spent ${formatSol(l.hireSpent)} SOL, max ${formatSol(rolling.lamports)} SOL in any rolling hour (cap 60), ` +
        `max ${meter.maxHiresPerLoop} hires/loop, max ${meter.maxJupiterPerMinute} Jupiter calls/min, 0 txs sent, ran in ${elapsed.toFixed(1)}s`,
    );
    // about 1,700 paper hires: 70 s alone, over 130 s when the whole suite shares the machine
  }, 360_000);
});

describe('B. DRY RUN double volume: 100 SOL in one hour hits the limits', () => {
  it('with the defaults the 40-call Jupiter budget binds just before the 60 SOL/h cap: never over either, the rest is spent in the next hour', async () => {
    w = await createSimWorld({ dryRun: true });
    const cfg = w.deps.config;
    // the production defaults, not a test override
    expect(cfg.maxHiresPerLoop).toBe(20);
    expect(cfg.intervals.claimSec).toBe(35);
    expect(cfg.spendCapLamportsPerHour.hire).toBe(60n * SOL);
    expect(cfg.jupiter.maxRpm).toBe(40);
    const calls: CallSample[] = [];
    const sample = () => void calls.push(jupiterSample(w));
    const t0 = performance.now();
    const meter = await runLaunch(w, { seconds: HOUR, totalFees: 100n * SOL, onTick: sample });
    const hourAgo = () => new Date(w.clock.now().getTime() - HOUR * 1000);
    const hireOut = await w.store.ledger.netOutflowSince('hire', hourAgo());
    expect(hireOut).toBeLessThanOrEqual(60n * SOL);
    // two 20-hire loops can fall inside one minute, so the Jupiter budget (40 calls a minute) is what holds hiring
    // back, a little before the 60 SOL/h cap
    expect(hireOut).toBeGreaterThan(55n * SOL);
    expect(w.jupiter.maxInWindow).toBe(cfg.jupiter.maxRpm);
    // everything spent so far falls in this first hour: what was claimed and not hired carries over
    const carried = await w.store.ledger.balance('hire');
    expect(carried).toBe((await w.store.claims.totals()).claimed - hireOut);
    expect(carried).toBeGreaterThan(39n * SOL);
    // the next hour: no new fees, the carried budget gets spent as the window rolls
    await drain(w, HOUR + 120, sample);
    const elapsed = (performance.now() - t0) / 1000;
    expect(await w.store.ledger.balance('hire')).toBeLessThan(cfg.salaryLamports);
    const rats = await w.store.rats.listByStatus(['active']);
    expect(rats.length).toBe(Number((100n * SOL) / cfg.salaryLamports));
    // at no point, in either hour, did any rolling hour exceed the cap (checked independently of the guard)
    const rows = await hireSpendRows(w);
    const rolling = maxRollingOutflow(rows, HOUR * 1000);
    expect(rolling.lamports).toBeLessThanOrEqual(60n * SOL);
    expect(rolling.lamports).toBeGreaterThan(55n * SOL);
    // never more than 20 hires in one loop, and the loop limit was reached
    const hiresPerLoop = maxAtOneInstant(rows.filter((r) => r.reason === 'hire_reserve'));
    expect(hiresPerLoop).toBe(cfg.maxHiresPerLoop);
    expect(meter.maxHiresPerLoop).toBe(cfg.maxHiresPerLoop);
    // Jupiter never gets more than 40 calls in any minute (the Free tier allows 60), even at 20 hires per loop
    const jupiterPerMinute = maxCallsPerMinute(calls);
    expect(jupiterPerMinute).toBeLessThanOrEqual(cfg.jupiter.maxRpm);
    expect(w.jupiter.maxInWindow).toBeLessThanOrEqual(cfg.jupiter.maxRpm);
    expect(w.simSender.submitted).toBe(0);
    console.log(
      `[B] 100 SOL hour: hire outflow first hour ${formatSol(hireOut)} SOL (cap 60, Jupiter budget 40/min), max ${formatSol(rolling.lamports)} SOL in any rolling hour over 2h, ` +
        `carried ${formatSol(carried)} SOL, ${rats.length} rats after 2h, max ${hiresPerLoop} hires/loop, max ${jupiterPerMinute} Jupiter calls/min, ran in ${elapsed.toFixed(1)}s`,
    );
    // two simulated hours and about 3,300 hires (twice as many as with the 50/50 split)
  }, 600_000);

  it('the hourly cap itself: at 40 SOL/h (below the Jupiter budget\'s pace) hiring stops at exactly the cap and alerts', async () => {
    w = await createSimWorld({ dryRun: true, env: { SPEND_CAP_SOL_PER_HOUR_HIRE: '40' } });
    const cfg = w.deps.config;
    const calls: CallSample[] = [];
    await runLaunch(w, { seconds: HOUR, totalFees: 60n * SOL, onTick: () => void calls.push(jupiterSample(w)) });
    const hireOut = await w.store.ledger.netOutflowSince('hire', new Date(w.clock.now().getTime() - HOUR * 1000));
    expect(hireOut).toBeLessThanOrEqual(40n * SOL);
    // the cap is really what stopped hiring: less than one salary of room was left
    expect(hireOut).toBeGreaterThan(40n * SOL - cfg.salaryLamports);
    expect(w.alerts.keys()).toContain('cap_reached_hire');
    const rolling = maxRollingOutflow(await hireSpendRows(w), HOUR * 1000);
    expect(rolling.lamports).toBeLessThanOrEqual(40n * SOL);
    expect(maxCallsPerMinute(calls)).toBeLessThanOrEqual(cfg.jupiter.maxRpm);
    expect(w.simSender.submitted).toBe(0);
  }, 600_000);
});

describe('C. LIVE on SimChain (in-memory): 50 SOL hour with exact conservation', () => {
  it('every claimed lamport hires rats; real balances match the ledger to the lamport; rats hold exactly what the database says', async () => {
    w = await createSimWorld({ dryRun: false });
    const creator = w.creator.publicKey.toBase58();
    const creatorStart = w.chain.sol(creator);
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

    const claims = await w.store.claims.totals();
    const l = await ledgerTotals(w);
    expect(claims.claimed).toBe(50n * SOL);
    expect(claims.hireShare).toBe(claims.claimed);
    expect(l.hireCredited).toBe(50n * SOL);
    expect(l.otherBuckets).toEqual([]);
    // conservation: the creator changed by exactly what the ledger says
    const hire = await w.store.ledger.balance('hire');
    expect(w.chain.sol(creator) - creatorStart).toBe(hire);
    // the creator's own money (its reserve) was never spent
    expect(creatorMin).toBeGreaterThanOrEqual(w.deps.config.creatorReserveLamports);
    // every rat on-chain matches the database, and got exactly one salary
    const rats = await w.store.rats.listByStatus(['active', 'frozen']);
    expect(rats.length).toBeGreaterThan(1400); // 50 SOL / ~0.03 SOL per rat
    for (const r of rats) {
      expect(w.chain.tokenBalance(r.wallet, r.stockMint, TOKEN_2022_PROGRAM)).toBe(r.tokenAmountRaw);
      expect(w.chain.sol(r.wallet)).toBe(w.deps.config.ratBufferLamports);
    }
    // nothing buys or burns the coin: its supply never changes
    expect(w.chain.mintState(w.coinMint)!.supply).toBe(supplyStart);
    // the hire cap held in every rolling hour
    expect(maxRollingOutflow(await hireSpendRows(w), HOUR * 1000).lamports).toBeLessThanOrEqual(w.deps.config.spendCapLamportsPerHour.hire);
    expect(meter.maxHiresPerLoop).toBeLessThanOrEqual(w.deps.config.maxHiresPerLoop);
    // the feed: claim events carry the amount and source only
    const events = await w.store.events.after(0, 10_000);
    const claimEvents = events.filter((e) => e.type === 'claim');
    expect(claimEvents.length).toBeGreaterThan(0);
    for (const e of claimEvents) expect(Object.keys(e.data as object).sort()).toEqual(['amountSol', 'source']);
    console.log(
      `[C] LIVE SimChain 50 SOL hour: ${rats.length} rats, real cost per rat ${formatSol(l.hireSpent / BigInt(rats.length))} SOL, ` +
        `claim fees ${formatSol(l.claimFees)} SOL, coin supply unchanged, conservation exact`,
    );
    // about 1,700 hires executed on SimChain: 90 s alone, near 180 s when the whole suite shares the machine
  }, 480_000);
});
