// The worker's Jupiter budget: a hard cap on calls per rolling minute (JUPITER_MAX_RPM, at most 40), shared by
// every Jupiter call the worker makes (prices, swap builds, retries). We stay on Jupiter's Free tier: 60 requests
// per 60-second sliding window per organisation (VERIFIED: github.com/jup-ag/docs portal/rate-limits.mdx), so 40
// leaves 20 for the CLI and scripts on the same key.
//
// It is a bucket of tokens where each token comes back 60 s after it was spent. That is the same sliding window
// Jupiter counts with, so the worker can never make more than the cap in ANY 60 seconds (a refill-rate bucket
// could burst past it). Taking a token never waits: when the budget is empty the caller skips this round (a hire
// waits for the next loop), so nothing ever retries in a tight loop.
//
// On a 429 every caller stops: 5 s, then 10, 20, 40 ... up to 5 minutes (or Jupiter's x-ratelimit-reset if
// later), and the owner is alerted. The first successful call resets the backoff.
import type { CallBudget, PriceQuote, PriceSource, Pubkey, SwapBuild, SwapBuildRequest, SwapBuilder } from '@rat/core';
import { JupiterError } from './http';

export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 300_000;

export interface RateLimitedInfo {
  /** 429s in a row */
  streak: number;
  /** nobody calls Jupiter for this long */
  waitMs: number;
}

export interface JupiterBudgetOptions {
  windowMs?: number;
  /** count the whole budget as spent at start: a restarting (or crash-looping) worker never bursts */
  startEmpty?: boolean;
  onRateLimited?: (info: RateLimitedInfo) => void;
}

/** Why a Jupiter call was not made (the caller waits and tries again later; it is not a failure). */
export class JupiterBudgetError extends Error {
  constructor(readonly reason: 'empty' | 'rate_limited') {
    super(reason === 'empty' ? 'Jupiter budget empty: waiting for the next minute' : 'Jupiter rate limited (429): backing off');
    this.name = 'JupiterBudgetError';
  }
}

export class JupiterBudget implements CallBudget {
  private readonly stamps: number[] = [];
  private readonly windowMs: number;
  private blockedUntil = 0;
  private streak = 0;
  /** calls made, and the most in any window (for reports and tests) */
  taken = 0;
  maxInWindow = 0;

  constructor(
    readonly perMinute: number,
    private readonly now: () => number,
    private readonly opts: JupiterBudgetOptions = {},
  ) {
    if (perMinute < 1) throw new Error('the Jupiter budget must allow at least 1 call a minute');
    this.windowMs = opts.windowMs ?? 60_000;
    if (opts.startEmpty) for (let k = 0; k < perMinute; k++) this.stamps.push(now());
  }

  private prune(t: number): void {
    while (this.stamps.length > 0 && this.stamps[0]! <= t - this.windowMs) this.stamps.shift();
  }

  /** Calls that can be made right now (0 while backing off after a 429). */
  available(): number {
    const t = this.now();
    if (t < this.blockedUntil) return 0;
    this.prune(t);
    return this.perMinute - this.stamps.length;
  }

  /** Takes a token if there is one. Never waits. */
  tryTake(): boolean {
    if (this.available() <= 0) return false;
    this.stamps.push(this.now());
    this.taken++;
    this.maxInWindow = Math.max(this.maxInWindow, this.stamps.length);
    return true;
  }

  /** A call went through: the backoff starts over. */
  succeeded(): void {
    this.streak = 0;
  }

  /** Jupiter answered 429: every caller stops for an exponentially growing time. Returns the wait. */
  rateLimited(resetAtMs?: number): RateLimitedInfo {
    this.streak++;
    const t = this.now();
    const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (this.streak - 1));
    this.blockedUntil = Math.max(this.blockedUntil, t + backoff, resetAtMs ?? 0);
    const info = { streak: this.streak, waitMs: this.blockedUntil - t };
    this.opts.onRateLimited?.(info);
    return info;
  }

  /** Runs one Jupiter call on one token: throws JupiterBudgetError instead of calling when there is none. */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.tryTake()) throw new JupiterBudgetError(this.now() < this.blockedUntil ? 'rate_limited' : 'empty');
    try {
      const out = await fn();
      this.succeeded();
      return out;
    } catch (err) {
      if (err instanceof JupiterError && err.status === 429) {
        this.rateLimited(err.resetAtMs);
        throw new JupiterBudgetError('rate_limited');
      }
      throw err;
    }
  }
}

/** Every build takes one budget token. */
export class BudgetedSwapBuilder implements SwapBuilder {
  constructor(
    private readonly inner: SwapBuilder,
    private readonly budget: JupiterBudget,
  ) {}

  build(req: SwapBuildRequest): Promise<SwapBuild> {
    return this.budget.call(() => this.inner.build(req));
  }
}

/** Price API v3 takes up to 50 ids per request. */
export const PRICE_BATCH = 50;

/** Every price call takes one budget token: all mints in ONE batched request. */
export class BudgetedPriceSource implements PriceSource {
  constructor(
    private readonly inner: PriceSource,
    private readonly budget: JupiterBudget,
  ) {}

  async getPrices(mints: Pubkey[]): Promise<Map<Pubkey, PriceQuote>> {
    if (mints.length > PRICE_BATCH) throw new Error(`${mints.length} mints need more than one Price API request (at most ${PRICE_BATCH})`);
    return this.budget.call(() => this.inner.getPrices(mints));
  }
}
