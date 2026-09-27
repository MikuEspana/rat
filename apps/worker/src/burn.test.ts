// Burns vs MEV: random 8 to 12 minute rounds, chunks of at most 1 SOL a few seconds apart, 1.5% slippage,
// failed chunks carry the rest over, optional Jito tip. All in memory (SimChain, mock Jupiter).
import { SYSTEM_ACCOUNT_RENT } from '@rat/chain/sim';
import { SETTINGS, TOKEN_2022_PROGRAM } from '@rat/core';
import { engageKillSwitch } from '@rat/safety';
import { Keypair } from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';
import { SOL, type SimWorld, createSimWorld } from './sim-world';
import { type BurnResult, runBurnStep } from './steps/burn';
import { runClaimStep } from './steps/claim';
import { runMintStep } from './steps/mints';
import { runPriceStep } from './steps/prices';

let w: SimWorld;
afterEach(async () => w?.close());

/** Claims fees so that the burn bucket holds `burnSol` (the claim splits 50/50). */
async function fillBurnBucket(world: SimWorld, burnLamports: bigint): Promise<void> {
  await runPriceStep(world.deps, world.worker.state);
  await runMintStep(world.deps);
  world.accrue({ bondingLamports: 2n * burnLamports });
  await runClaimStep(world.deps, world.worker.state);
  expect(await world.store.ledger.balance('burn')).toBe(burnLamports);
}

/** Runs burn chunks the way the scheduler does (waiting nextInSec between them) until the round ends. */
async function runRound(world: SimWorld): Promise<BurnResult[]> {
  const out: BurnResult[] = [];
  for (;;) {
    const r = await runBurnStep(world.deps, world.worker.state);
    out.push(r);
    if (!world.worker.state.burnRound) return out;
    world.clock.advance(Math.ceil(r.nextInSec! * 1000));
  }
}

const coinRequests = (world: SimWorld) => world.swap.requests.filter((r) => r.outputMint === world.coinMint);

describe('burn schedule', () => {
  it('rounds start a random 8 to 12 minutes apart, never on a fixed schedule', async () => {
    w = await createSimWorld({ dryRun: true });
    const delays: number[] = [];
    for (let i = 0; i < 60; i++) delays.push((await runBurnStep(w.deps, w.worker.state)).nextInSec!);
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(480);
      expect(d).toBeLessThanOrEqual(720);
    }
    expect(new Set(delays.map((d) => Math.round(d))).size).toBeGreaterThan(40);
    expect(Math.min(...delays)).toBeLessThan(510);
    expect(Math.max(...delays)).toBeGreaterThan(690);
  });

  it('the scheduler follows the random delays (1 second ticks)', async () => {
    w = await createSimWorld({ dryRun: true });
    const starts: number[] = [];
    let last: string | null = null;
    await w.run(3 * 3600, {
      stepSec: 5,
      onTick: async () => {
        const at = await w.store.settings.get(SETTINGS.lastBurnRunAt);
        if (at && at !== last) {
          starts.push(new Date(at).getTime());
          last = at;
        }
      },
    });
    const gaps = starts.slice(1).map((t, i) => (t - starts[i]!) / 1000);
    expect(gaps.length).toBeGreaterThanOrEqual(14);
    for (const g of gaps) {
      expect(g).toBeGreaterThanOrEqual(480);
      expect(g).toBeLessThanOrEqual(725); // + one 5 s tick
    }
    expect(new Set(gaps).size).toBeGreaterThan(5);
  });
});

describe('burn chunks', () => {
  it('splits a 3.5 SOL burn into 4 chunks of 0.875 SOL, 3 to 8 seconds apart (paper)', async () => {
    w = await createSimWorld({ dryRun: true });
    await fillBurnBucket(w, (7n * SOL) / 2n);
    const results = await runRound(w);
    expect(results.map((r) => r.status)).toEqual(['paper', 'paper', 'paper', 'paper']);
    expect(results.map((r) => r.chunk)).toEqual([1, 2, 3, 4].map((index) => ({ index, of: 4 })));
    for (const r of results.slice(0, 3)) {
      expect(r.nextInSec!).toBeGreaterThanOrEqual(3);
      expect(r.nextInSec!).toBeLessThanOrEqual(8);
    }
    // the last chunk schedules the next round instead
    expect(results[3]!.nextInSec!).toBeGreaterThanOrEqual(480);
    const rows = await w.store.burns.listByStatus(['simulated']);
    expect(rows.map((b) => b.reservedLamports)).toEqual(Array(4).fill((7n * SOL) / 8n));
    expect(await w.store.ledger.balance('burn')).toBe(0n);
    expect((await w.store.events.countByType()).burn).toBe(4);
    const gaps = rows.slice(1).map((b, i) => (b.at.getTime() - rows[i]!.at.getTime()) / 1000);
    for (const g of gaps) {
      expect(g).toBeGreaterThanOrEqual(3);
      expect(g).toBeLessThanOrEqual(8);
    }
  });

  it('a burn under the chunk size is one transaction', async () => {
    w = await createSimWorld({ dryRun: true });
    await fillBurnBucket(w, SOL / 2n);
    const results = await runRound(w);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: 'paper', chunk: { index: 1, of: 1 } });
  });

  it('live: every chunk <= 1 SOL, coin bought at 1.5% slippage, balances match the ledger to the lamport', async () => {
    w = await createSimWorld({ dryRun: false });
    const fund = w.fund.publicKey.toBase58();
    const fundStart = w.chain.sol(fund);
    const supplyStart = w.chain.mintState(w.coinMint)!.supply;
    await fillBurnBucket(w, (5n * SOL) / 2n);
    const results = await runRound(w);
    expect(results.map((r) => r.status)).toEqual(['burned', 'burned', 'burned']);
    const rows = await w.store.burns.listByStatus(['confirmed']);
    expect(rows).toHaveLength(3);
    for (const b of rows) expect(b.reservedLamports).toBeLessThanOrEqual(SOL);
    for (const req of coinRequests(w)) expect(req.slippageBps).toBe(150);
    // conservation: the fund changed by exactly (burn bucket - owed); only claimed money was spent
    const owed = await w.store.claims.pendingFundTransfer();
    expect(w.chain.sol(fund) - fundStart).toBe((await w.store.ledger.balance('burn')) - owed);
    // what the fund keeps is only the 1.5% slippage buffer of the last chunk (burned in the next round)
    const burned = results.reduce((a, r) => a + r.burnedRaw, 0n);
    const kept = w.chain.tokenBalance(fund, w.coinMint, TOKEN_2022_PROGRAM);
    expect(kept).toBeLessThan(results[2]!.burnedRaw / 60n);
    expect(w.chain.mintState(w.coinMint)!.supply).toBe(supplyStart + burned + kept - burned);
  });

  it('SLIPPAGE_BPS_COIN is configurable', async () => {
    w = await createSimWorld({ dryRun: true, env: { SLIPPAGE_BPS_COIN: '80' } });
    await fillBurnBucket(w, SOL / 2n);
    await runRound(w);
    expect(coinRequests(w).map((r) => r.slippageBps)).toEqual([80]);
  });

  it('a failed chunk ends the round; the rest carries over to the next round', async () => {
    w = await createSimWorld({ dryRun: false });
    await fillBurnBucket(w, (5n * SOL) / 2n);
    const first = await runBurnStep(w.deps, w.worker.state);
    expect(first.status).toBe('burned');
    w.clock.advance(Math.ceil(first.nextInSec! * 1000));
    w.simSender.failNext('reject', 'burn');
    const second = await runBurnStep(w.deps, w.worker.state);
    expect(second.status).toBe('failed');
    expect(w.worker.state.burnRound).toBeNull();
    expect(second.nextInSec!).toBeGreaterThanOrEqual(480);
    const left = await w.store.ledger.balance('burn');
    expect(left).toBeGreaterThan((3n * SOL) / 2n);
    w.clock.advance(Math.ceil(second.nextInSec! * 1000));
    const next = await runRound(w);
    expect(next.map((r) => r.status)).toEqual(['burned', 'burned']);
    expect(await w.store.ledger.balance('burn')).toBeLessThan(w.deps.config.minBurnLamports);
  });

  it('the kill switch stops the remaining chunks of a round', async () => {
    w = await createSimWorld({ dryRun: false });
    await fillBurnBucket(w, 3n * SOL);
    const first = await runBurnStep(w.deps, w.worker.state);
    expect(first).toMatchObject({ status: 'burned', chunk: { index: 1, of: 3 } });
    await engageKillSwitch(w.store.settings, 'test');
    w.clock.advance(Math.ceil(first.nextInSec! * 1000));
    const second = await runBurnStep(w.deps, w.worker.state);
    expect(second).toMatchObject({ status: 'skipped', reason: 'kill_switch' });
    expect(w.worker.state.burnRound).toBeNull();
    expect(await w.store.burns.listByStatus(['confirmed'])).toHaveLength(1);
  });

  it('publishes only the earliest start of the next round, never the random time', async () => {
    w = await createSimWorld({ dryRun: true });
    const r = await runBurnStep(w.deps, w.worker.state);
    const opens = await w.store.settings.get(SETTINGS.burnWindowOpensAt);
    expect(opens).toBe(new Date(w.clock.now().getTime() + 480_000).toISOString());
    expect(r.nextInSec!).toBeGreaterThanOrEqual(480);
  });
});

describe('Jito (BURN_SEND_VIA=jito)', () => {
  it('each burn tx tips a Jito tip account from the chunk; balances still match the ledger exactly', async () => {
    w = await createSimWorld({ dryRun: false, env: { BURN_SEND_VIA: 'jito', JITO_TIP_SOL: '0.0001' } });
    const tip = Keypair.generate().publicKey.toBase58();
    // real tip accounts already exist (rent paid); a transfer into them can be any size
    w.chain.fundAccount(tip, SYSTEM_ACCOUNT_RENT);
    w.deps.jitoTipAccounts = async () => [tip];
    const fund = w.fund.publicKey.toBase58();
    const fundStart = w.chain.sol(fund);
    await fillBurnBucket(w, (5n * SOL) / 2n);
    const results = await runRound(w);
    expect(results.map((r) => r.status)).toEqual(['burned', 'burned', 'burned']);
    expect(w.chain.sol(tip) - SYSTEM_ACCOUNT_RENT).toBe(3n * 100_000n);
    for (const b of await w.store.burns.listByStatus(['confirmed'])) {
      const rec = w.chain.transaction(b.sig!)!;
      const last = rec.instructions.filter((ix) => !ix.inner).at(-1)!;
      expect(last.accounts).toEqual([fund, tip]);
    }
    const owed = await w.store.claims.pendingFundTransfer();
    expect(w.chain.sol(fund) - fundStart).toBe((await w.store.ledger.balance('burn')) - owed);
  });

  it('no tip accounts: the burn is skipped (no public send), the budget stays', async () => {
    w = await createSimWorld({ dryRun: false, env: { BURN_SEND_VIA: 'jito' } });
    w.deps.jitoTipAccounts = async () => {
      throw new Error('block engine down');
    };
    await fillBurnBucket(w, SOL / 2n);
    const sent = w.simSender.submitted;
    const r = await runBurnStep(w.deps, w.worker.state);
    expect(r).toMatchObject({ status: 'failed', reason: 'jito unavailable' });
    expect(w.simSender.submitted).toBe(sent);
    expect(await w.store.ledger.balance('burn')).toBe(SOL / 2n);
    expect(w.alerts.keys()).toContain('burn_jito_unavailable');
  });
});
