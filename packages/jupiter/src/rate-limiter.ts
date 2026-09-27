// Sliding-window rate limiter shared by every Jupiter call (price + swap). Jupiter enforces a 60-second
// sliding window per organisation (VERIFIED: github.com/jup-ag/docs portal/rate-limits.mdx).
export interface LimiterTime {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realTime: LimiterTime = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export class SlidingWindowLimiter {
  private readonly stamps: number[] = [];
  private queue: Promise<void> = Promise.resolve();
  private blockedUntil = 0;

  constructor(
    readonly maxPerWindow: number,
    readonly windowMs = 60_000,
    private readonly time: LimiterTime = realTime,
  ) {
    if (maxPerWindow < 1) throw new Error('maxPerWindow must be >= 1');
  }

  /** Resolves when a request may be sent. Calls are served in order. */
  acquire(): Promise<void> {
    const next = this.queue.then(() => this.waitForSlot());
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** After a 429: nobody sends before `epochMs`. */
  blockUntil(epochMs: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, epochMs);
  }

  /** Requests counted in the current window. */
  inWindow(): number {
    this.prune(this.time.now());
    return this.stamps.length;
  }

  private prune(t: number): void {
    while (this.stamps.length > 0 && this.stamps[0]! <= t - this.windowMs) this.stamps.shift();
  }

  private async waitForSlot(): Promise<void> {
    for (;;) {
      const t = this.time.now();
      if (t < this.blockedUntil) {
        await this.time.sleep(this.blockedUntil - t);
        continue;
      }
      this.prune(t);
      if (this.stamps.length < this.maxPerWindow) {
        this.stamps.push(t);
        return;
      }
      await this.time.sleep(this.stamps[0]! + this.windowMs - t + 1);
    }
  }
}
