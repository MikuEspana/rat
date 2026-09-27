// Assembles the steps into the loop:
//   prices (15s) -> mints (35s) -> claim + watch + hire (35s) -> burn (10 min) -> reconcile (35s) -> key pool (60s)
import type { WorkerDeps } from './deps';
import { WorkerState } from './deps';
import { Scheduler } from './scheduler';
import { runBurnStep } from './steps/burn';
import { runClaimStep } from './steps/claim';
import { runHireStep } from './steps/hire';
import { runKeypoolStep } from './steps/keypool';
import { runMintStep } from './steps/mints';
import { runPriceStep } from './steps/prices';
import { runReconcileStep } from './steps/reconcile';
import { runWatchStep } from './steps/watch';

export interface Worker {
  state: WorkerState;
  scheduler: Scheduler;
  tick(): Promise<Map<string, unknown>>;
}

export function createWorker(d: WorkerDeps): Worker {
  const state = new WorkerState();
  const c = d.config;
  const scheduler = new Scheduler(
    [
      { name: 'prices', everySec: c.intervals.priceSec, run: () => runPriceStep(d, state) },
      { name: 'mints', everySec: c.intervals.freezeSec, run: () => runMintStep(d) },
      {
        name: 'claim',
        everySec: c.intervals.claimSec,
        run: async () => {
          const claim = await runClaimStep(d, state);
          const watch = await runWatchStep(d);
          const hire = await runHireStep(d, state);
          return { claim, watch, hire };
        },
      },
      { name: 'burn', everySec: c.intervals.burnSec, run: () => runBurnStep(d, state) },
      { name: 'reconcile', everySec: c.intervals.claimSec, run: () => runReconcileStep(d, state) },
      { name: 'keypool', everySec: 60, run: () => runKeypoolStep(d) },
    ],
    {
      clock: d.clock,
      store: d.store,
      log: d.log,
      onRepeatedFailure: (task, err, n) => d.alerts.send('warn', `task_failing_${task}`, `${task} failed ${n} times in a row: ${err}`),
    },
  );
  return { state, scheduler, tick: () => scheduler.tick() };
}

/** Runs worker ticks only while holding the single-worker lease (two workers never run at once). */
export class LockedRunner {
  private lastRenew = 0;
  private holding = false;

  constructor(
    private readonly worker: Worker,
    private readonly deps: { store: WorkerDeps['store']; clock: WorkerDeps['clock']; holder: string; ttlSec?: number; renewEverySec?: number },
  ) {}

  get isHolder(): boolean {
    return this.holding;
  }

  /** Returns false when another worker holds the lock. */
  async tryTick(): Promise<boolean> {
    const now = this.deps.clock.now();
    const renewMs = (this.deps.renewEverySec ?? 15) * 1000;
    if (!this.holding || now.getTime() - this.lastRenew >= renewMs) {
      this.holding = await this.deps.store.locks.acquire('worker', this.deps.holder, now, this.deps.ttlSec ?? 120);
      if (this.holding) this.lastRenew = now.getTime();
    }
    if (!this.holding) return false;
    await this.worker.tick();
    return true;
  }

  async release(): Promise<void> {
    await this.deps.store.locks.release('worker', this.deps.holder);
    this.holding = false;
  }
}
