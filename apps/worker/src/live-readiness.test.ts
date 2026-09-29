// Live readiness: the worker refuses to start LIVE with no usable stock, and alerts when the hire budget sits
// idle for 30 minutes (for example stale weekend prices). In memory only.
import { SETTINGS } from '@rat/core';
import { engageKillSwitch } from '@rat/safety';
import { afterEach, describe, expect, it } from 'vitest';
import { runPreflight } from './preflight';
import { DEFAULT_STOCKS, SOL, type SimWorld, createSimWorld } from './sim-world';
import { runClaimStep } from './steps/claim';
import { runHireStep } from './steps/hire';
import { runMintStep } from './steps/mints';
import { runPriceStep } from './steps/prices';

let w: SimWorld;
afterEach(async () => w?.close());

describe('preflight: approved stocks', () => {
  it('refuses to start LIVE with 0 approved stocks and says exactly why', async () => {
    w = await createSimWorld({ dryRun: false, stocks: DEFAULT_STOCKS.map((s) => ({ ...s, approved: false })) });
    const r = await runPreflight(w.deps);
    expect(r.ok).toBe(false);
    const issue = r.issues.find((i) => i.check === 'approved_stocks')!;
    expect(issue.blocking).toBe(true);
    expect(issue.message).toContain('0 of 10 enabled stocks are approved');
    expect(issue.message).toContain('rat stocks-sync');
    expect(issue.message).toContain('TSLAx');
  });

  it('refuses to start LIVE when no approved stock passes the mint check', async () => {
    const stocks = [
      ...DEFAULT_STOCKS.slice(0, 3).map((s) => ({ ...s, approved: true, foreignAuthority: true })),
      ...DEFAULT_STOCKS.slice(3, 7).map((s) => ({ ...s, approved: false })),
    ];
    w = await createSimWorld({ dryRun: false, stocks });
    const r = await runPreflight(w.deps);
    expect(r.ok).toBe(false);
    const issue = r.issues.find((i) => i.check === 'approved_stocks_verified')!;
    expect(issue.blocking).toBe(true);
    expect(issue.message).toMatch(/3 stocks are approved but none passes the mint check/);
    expect(issue.message).toMatch(/mint authority .* does not match expected/);
  });

  it('DRY RUN only warns; one approved, verified stock is enough to start LIVE', async () => {
    w = await createSimWorld({ dryRun: true, stocks: DEFAULT_STOCKS.map((s) => ({ ...s, approved: false })) });
    const dry = await runPreflight(w.deps);
    expect(dry.ok).toBe(true);
    expect(dry.issues.map((i) => [i.check, i.blocking])).toEqual([['approved_stocks', false]]);
    await w.close();
    w = await createSimWorld({ dryRun: false, stocks: DEFAULT_STOCKS.map((s, i) => ({ ...s, approved: i === 0 })) });
    expect(await runPreflight(w.deps)).toEqual({ ok: true, issues: [] });
  });
});

describe('idle hire budget alert', () => {
  async function fundHires(world: SimWorld, feesLamports: bigint) {
    await runPriceStep(world.deps, world.worker.state);
    await runMintStep(world.deps);
    world.accrue({ bondingLamports: feesLamports });
    await runClaimStep(world.deps, world.worker.state);
  }

  it('alerts after 30 minutes of no hires while more than 0.1 SOL waits (stale weekend prices)', async () => {
    w = await createSimWorld({ dryRun: true });
    await fundHires(w, SOL);
    // prices stop updating (weekend): after PRICE_STALE_SEC no stock is eligible
    w.clock.advanceSeconds(16 * 60);
    expect((await runHireStep(w.deps, w.worker.state)).skipped).toBe('no eligible stocks');
    expect(await w.store.settings.get(SETTINGS.hireIdleSince)).toBeTruthy();
    w.clock.advanceSeconds(20 * 60);
    await runHireStep(w.deps, w.worker.state);
    expect(w.alerts.keys()).not.toContain('hire_idle');
    w.clock.advanceSeconds(11 * 60);
    await runHireStep(w.deps, w.worker.state);
    const alert = w.alerts.sent.find((a) => a.key === 'hire_idle')!;
    // the whole 1 SOL claim is hire budget
    expect(alert.text).toMatch(/No rat hired for 31 min while 1 SOL waits in the hire budget/);
    expect(alert.text).toContain('no eligible stocks');
  });

  it('stays quiet at or under 0.1 SOL, and while the kill switch is on', async () => {
    w = await createSimWorld({ dryRun: true });
    await fundHires(w, SOL / 10n); // 0.1 SOL for hires (the whole claim)
    expect(await w.store.ledger.balance('hire')).toBe(SOL / 10n);
    await runHireStep(w.deps, w.worker.state);
    w.clock.advanceSeconds(16 * 60);
    for (let i = 0; i < 3; i++) {
      await runHireStep(w.deps, w.worker.state);
      w.clock.advanceSeconds(20 * 60);
    }
    expect(w.alerts.keys()).not.toContain('hire_idle');
    await w.close();

    w = await createSimWorld({ dryRun: true });
    await fundHires(w, SOL);
    await engageKillSwitch(w.store.settings, 'test');
    for (let i = 0; i < 3; i++) {
      await runHireStep(w.deps, w.worker.state);
      w.clock.advanceSeconds(20 * 60);
    }
    expect(w.alerts.keys()).not.toContain('hire_idle');
  });

  it('a hire resets the idle clock', async () => {
    w = await createSimWorld({ dryRun: true, env: { MAX_HIRES_PER_LOOP: '1' } });
    await fundHires(w, SOL);
    w.clock.advanceSeconds(16 * 60);
    await runHireStep(w.deps, w.worker.state); // stale: idle starts
    w.clock.advanceSeconds(20 * 60);
    await runPriceStep(w.deps, w.worker.state); // prices are back
    expect((await runHireStep(w.deps, w.worker.state)).hired).toBe(1);
    expect(await w.store.settings.get(SETTINGS.hireIdleSince)).toBe('');
    w.clock.advanceSeconds(16 * 60);
    await runHireStep(w.deps, w.worker.state);
    w.clock.advanceSeconds(20 * 60);
    await runHireStep(w.deps, w.worker.state);
    expect(w.alerts.keys()).not.toContain('hire_idle');
  });
});

describe('startup while the RPC is down', () => {
  it('the startup checks wait for the RPC to answer instead of exiting (Railway stops restarting after 10 tries)', async () => {
    const { runPreflightUntilAnswered } = await import('./preflight');
    w = await createSimWorld({ dryRun: false, env: { WATCH_FROM_SLOT: '1000' } });
    let down = 4;
    const reader = w.deps.chain;
    const getSlot = reader.getSlot.bind(reader);
    reader.getSlot = async () => {
      if (down-- > 0) throw new Error('fetch failed: ECONNREFUSED');
      return getSlot();
    };
    const waits: number[] = [];
    const r = await runPreflightUntilAnswered(w.deps, { sleep: async (ms) => void waits.push(ms) });
    expect(r.issues.filter((i) => i.check === 'watch_from_slot')).toEqual([]);
    expect(waits).toEqual([5_000, 10_000, 20_000, 40_000]);
  });
});
