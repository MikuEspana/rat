// Worker-down watchdog. Every alert comes from the worker itself, so a dead worker (crash loop, restarts
// exhausted, out of memory) would be silent. The admin service watches the worker's loop heartbeats and sends a
// Telegram alert when they stop, again every 30 minutes while it stays down, and once when it is back.
import type { Clock } from '@rat/core';
import type { Store } from '@rat/db';

/** no loop for this long = the worker is down (its loops run every 15 to 35 seconds) */
export const WORKER_STALE_SEC = 180;
const REPEAT_MS = 30 * 60_000;

export type WatchdogState = 'never_ran' | 'ok' | 'down';

export async function newestLoop(store: Store, clock: Clock): Promise<{ loop: string; ageSec: number } | null> {
  let newest: { loop: string; at: number } | null = null;
  for (const h of await store.heartbeats.all()) {
    const at = h.lastRunAt?.getTime();
    if (at !== undefined && (!newest || at > newest.at)) newest = { loop: h.loop, at };
  }
  return newest ? { loop: newest.loop, ageSec: Math.round((clock.now().getTime() - newest.at) / 1000) } : null;
}

export class Watchdog {
  private downSince: number | null = null;
  private lastAlertAt = 0;

  constructor(
    private readonly deps: { store: Store; clock: Clock; alert: (text: string) => Promise<void>; staleSec?: number },
  ) {}

  async check(): Promise<WatchdogState> {
    const newest = await newestLoop(this.deps.store, this.deps.clock);
    if (!newest) return 'never_ran';
    const now = this.deps.clock.now().getTime();
    if (newest.ageSec > (this.deps.staleSec ?? WORKER_STALE_SEC)) {
      if (this.downSince === null) this.downSince = now;
      if (now - this.lastAlertAt >= REPEAT_MS) {
        this.lastAlertAt = now;
        await this.deps.alert(
          `WORKER DOWN: no loop has run for ${Math.round(newest.ageSec / 60)} min (last: ${newest.loop}). Claims and hires have stopped. Check the worker on Railway (restarts may be used up) and its logs.`,
        );
      }
      return 'down';
    }
    if (this.downSince !== null) {
      await this.deps.alert(`Worker is back: loops are running again (down for about ${Math.round((now - this.downSince) / 60_000)} min).`);
      this.downSince = null;
      this.lastAlertAt = 0;
    }
    return 'ok';
  }
}
