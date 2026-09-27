// Tick-based scheduler. `tick()` runs every task that is due, one after another (loops never overlap).
// Production calls tick() about once a second; tests and the simulation drive it with a FakeClock.
import { type Clock, type Logger, redactSecrets } from '@rat/core';
import type { Store } from '@rat/db';

export interface Task {
  name: string;
  everySec: number;
  run: () => Promise<unknown>;
  /** overrides everySec per run (jittered schedules): gets the run's result, or undefined when it threw */
  nextDelaySec?: (out: unknown) => number;
}

export class Scheduler {
  private readonly nextAt = new Map<string, number>();
  private readonly failures = new Map<string, number>();

  constructor(
    private readonly tasks: Task[],
    private readonly deps: { clock: Clock; store: Store; log: Logger; onRepeatedFailure?: (task: string, err: string, count: number) => Promise<void> },
  ) {}

  /** Runs due tasks in order. Returns the names that ran and their results. */
  async tick(): Promise<Map<string, unknown>> {
    const ran = new Map<string, unknown>();
    for (const t of this.tasks) {
      const now = this.deps.clock.now();
      const due = this.nextAt.get(t.name) ?? 0;
      if (now.getTime() < due) continue;
      const startedAt = now.getTime();
      this.nextAt.set(t.name, startedAt + t.everySec * 1000);
      let out: unknown;
      try {
        out = await t.run();
        ran.set(t.name, out);
        this.failures.set(t.name, 0);
        await this.deps.store.heartbeats.beat(t.name, this.deps.clock.now(), { ok: true });
      } catch (err) {
        const msg = redactSecrets((err as Error).message ?? String(err));
        ran.set(t.name, { error: msg });
        const n = (this.failures.get(t.name) ?? 0) + 1;
        this.failures.set(t.name, n);
        this.deps.log.error({ err, task: t.name }, 'task failed');
        await this.deps.store.heartbeats.beat(t.name, this.deps.clock.now(), { ok: false, error: msg });
        if (n >= 3) await this.deps.onRepeatedFailure?.(t.name, msg, n);
      }
      if (t.nextDelaySec) this.nextAt.set(t.name, startedAt + t.nextDelaySec(out) * 1000);
    }
    return ran;
  }

  /** Forces a task to run on the next tick. */
  due(name: string): void {
    this.nextAt.set(name, 0);
  }
}
