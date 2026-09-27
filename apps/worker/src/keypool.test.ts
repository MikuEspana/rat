// Key pool step: runway alert at the current hire rate, low alert, and a background refill that never blocks.
import { afterEach, describe, expect, it } from 'vitest';
import type { KeyRefillerPort } from './deps';
import { SOL, type SimWorld, createSimWorld } from './sim-world';
import { runClaimStep } from './steps/claim';
import { runHireStep } from './steps/hire';
import { runKeypoolStep } from './steps/keypool';
import { runMintStep } from './steps/mints';
import { runPriceStep } from './steps/prices';

let w: SimWorld;
afterEach(async () => w?.close());

async function hireSome(world: SimWorld): Promise<number> {
  await runPriceStep(world.deps, world.worker.state);
  await runMintStep(world.deps);
  world.accrue({ bondingLamports: SOL });
  await runClaimStep(world.deps, world.worker.state);
  return (await runHireStep(world.deps, world.worker.state)).hired;
}

describe('key pool runway', () => {
  it('alerts when the pool lasts less than 2 hours at the current hire rate, not only below the floor', async () => {
    // 60 keys, floor alert at 5: the old "below N keys" alert alone would stay quiet here
    w = await createSimWorld({ ratKeys: 60, env: { KEYPOOL_LOW_ALERT: '5', KEYPOOL_RUNWAY_ALERT_HOURS: '2' } });
    const idle = await runKeypoolStep(w.deps);
    expect(idle.runwayHours).toBeNull();
    expect(w.alerts.keys()).not.toContain('keypool_runway');

    const hired = await hireSome(w);
    expect(hired).toBeGreaterThan(10);
    const r = await runKeypoolStep(w.deps);
    // rats created in the last 30 minutes, doubled
    expect(r.hireRatePerHour).toBe(hired * 2);
    expect(r.available).toBe(60 - hired);
    expect(r.runwayHours!).toBeCloseTo((60 - hired) / (hired * 2), 5);
    expect(r.runwayHours!).toBeLessThan(2);
    expect(w.alerts.keys()).toContain('keypool_runway');
    expect(w.alerts.keys()).not.toContain('keypool_low');
    const text = w.alerts.sent.find((a) => a.key === 'keypool_runway')!.text;
    expect(text).toMatch(/runs out in ~\d+\.\d h/);
    expect(text).toContain('rat keys import-dir');
  });

  it('stays quiet when the pool lasts longer than the runway, and once hiring stops', async () => {
    w = await createSimWorld({ ratKeys: 400, env: { KEYPOOL_LOW_ALERT: '5', KEYPOOL_RUNWAY_ALERT_HOURS: '2' } });
    const hired = await hireSome(w);
    const r = await runKeypoolStep(w.deps);
    expect(r.runwayHours!).toBeGreaterThan(2);
    expect(w.alerts.keys()).not.toContain('keypool_runway');
    expect(hired).toBeGreaterThan(0);
    w.clock.advanceSeconds(31 * 60);
    expect((await runKeypoolStep(w.deps)).runwayHours).toBeNull();
  });

  it('still alerts below the absolute floor', async () => {
    w = await createSimWorld({ ratKeys: 3, env: { KEYPOOL_LOW_ALERT: '500' } });
    await runKeypoolStep(w.deps);
    expect(w.alerts.keys()).toContain('keypool_low');
  });

  it('starts a background refill with the available count and returns without waiting for it', async () => {
    w = await createSimWorld({ ratKeys: 7 });
    let release!: () => void;
    const pending = new Promise<void>((r) => {
      release = r;
    });
    const calls: number[] = [];
    let busy = false;
    const refiller: KeyRefillerPort = {
      get busy() {
        return busy;
      },
      maybeStart(available) {
        calls.push(available);
        busy = true;
        void pending.then(() => {
          busy = false;
        });
        return { started: true, count: 10, grinder: 'solana-keygen' };
      },
      stop: async () => release(),
    };
    w.deps.keyRefiller = refiller;
    const r = await runKeypoolStep(w.deps);
    // the step came back while the batch is still running
    expect(r).toMatchObject({ available: 7, refillStarted: true, grinding: true });
    expect(calls).toEqual([7]);
    release();
  });
});
