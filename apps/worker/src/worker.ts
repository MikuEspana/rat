// Assembles the steps into the loop:
//   prices (15s) -> mints (35s) -> claim + watch + hire (35s) -> reconcile (35s) -> coin creator check (10 min)
import { redactSecrets } from '@rat/core';
import type { WorkerDeps } from './deps';
import { WorkerState } from './deps';
import { Scheduler } from './scheduler';
import { runClaimStep } from './steps/claim';
import { runHireStep } from './steps/hire';
import { runCoinCheckStep, runMintStep } from './steps/mints';
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
          // A failing claim never skips the wallet watch (the key-leak detector). Hires only run after a
          // successful watch: nothing is spent while the watch is blind. Any failure still fails the task (alerts).
          const errors: string[] = [];
          const step = async <T>(name: string, f: () => Promise<T>): Promise<T | { error: string }> => {
            try {
              return await f();
            } catch (err) {
              const error = redactSecrets((err as Error).message ?? String(err));
              errors.push(`${name}: ${error}`);
              return { error };
            }
          };
          const claim = await step('claim', () => runClaimStep(d, state));
          const watch = await step('watch', () => runWatchStep(d));
          const hire = errors.some((e) => e.startsWith('watch:')) ? { skipped: 'the wallet watch failed' } : await step('hire', () => runHireStep(d, state));
          if (errors.length > 0) throw new Error(errors.join('; '));
          return { claim, watch, hire };
        },
      },
      { name: 'reconcile', everySec: c.intervals.claimSec, run: () => runReconcileStep(d, state) },
      { name: 'coin', everySec: 600, run: () => runCoinCheckStep(d) },
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

  /**
   * Called by the GuardedSender right before every send: renews the lease and says whether we still hold it.
   * A tick can run longer than the lease (many hires waiting for confirmations). If another worker took over
   * in the meantime (for example a redeploy started the new container first), this worker sends nothing more.
   */
  async fence(): Promise<boolean> {
    const now = this.deps.clock.now();
    this.holding = await this.deps.store.locks.acquire('worker', this.deps.holder, now, this.deps.ttlSec ?? 120);
    if (this.holding) this.lastRenew = now.getTime();
    return this.holding;
  }

  async release(): Promise<void> {
    await this.deps.store.locks.release('worker', this.deps.holder);
    this.holding = false;
  }
}
