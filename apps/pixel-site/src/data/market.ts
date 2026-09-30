// The header market cap and price come from public price feeds as soon as the coin has a mint: Jupiter's free price
// API first, DexScreener only when Jupiter fails or has no price. The bot refreshes its own price only every 45 s, so
// mixing the two made the number lag and jump; the API's own numbers are now only a fallback, used before the first
// public quote arrives and when both feeds have been failing for a while.
//
// Rate limits: Jupiter lite-api allows about 60 requests/min per IP, DexScreener about 300/min. One request every 5 s
// per visitor (at most one in flight, none while the tab is hidden) stays well under both.
import type { StateResponse } from '@rat/contract';

/** Every pump.fun coin has 1 billion tokens. */
export const PUMP_SUPPLY = 1_000_000_000;

export interface PublicQuote {
  priceUsd: number;
  marketCapUsd: number;
}
export type FetchLike = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
export type Source = 'jupiter' | 'dexscreener';

const browserFetch: FetchLike = (url) => fetch(url, { cache: 'no-store' });

async function jupiter(mint: string, f: FetchLike): Promise<PublicQuote | null> {
  const r = await f(`https://lite-api.jup.ag/price/v3?ids=${encodeURIComponent(mint)}`);
  if (!r.ok) return null;
  const p = ((await r.json()) as Record<string, { usdPrice?: unknown } | undefined> | null)?.[mint]?.usdPrice;
  return typeof p === 'number' && p > 0 ? { priceUsd: p, marketCapUsd: Math.round(p * PUMP_SUPPLY) } : null;
}

async function dexscreener(mint: string, f: FetchLike): Promise<PublicQuote | null> {
  const r = await f(`https://api.dexscreener.com/tokens/v1/solana/${encodeURIComponent(mint)}`);
  if (!r.ok) return null;
  const pairs = (await r.json()) as { priceUsd?: string; marketCap?: number }[] | null;
  const pair = Array.isArray(pairs) ? pairs[0] : undefined;
  const p = Number(pair?.priceUsd);
  if (!pair || !Number.isFinite(p) || p <= 0) return null;
  const mc = typeof pair.marketCap === 'number' && pair.marketCap > 0 ? pair.marketCap : p * PUMP_SUPPLY;
  return { priceUsd: p, marketCapUsd: Math.round(mc) };
}

const FEEDS: Record<Source, (mint: string, f: FetchLike) => Promise<PublicQuote | null>> = { jupiter, dexscreener };

/** The coin's quote from `first`, else the other feed; null when neither knows it (or both fail). */
export async function publicQuote(
  mint: string,
  f: FetchLike = browserFetch,
  first: Source = 'jupiter',
): Promise<{ q: PublicQuote; source: Source } | null> {
  const order: Source[] = first === 'jupiter' ? ['jupiter', 'dexscreener'] : ['dexscreener', 'jupiter'];
  for (const source of order) {
    try {
      const q = await FEEDS[source](mint, f);
      if (q) return { q, source };
    } catch {
      /* next feed */
    }
  }
  return null;
}

export interface VisibilityLike {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', fn: () => void): void;
}

export interface PublicMarketOptions {
  fetch?: FetchLike;
  /** how often to fetch a public quote while the tab is visible */
  everyMs?: number;
  /** after both feeds fail, keep showing the last public quote this long before falling back to the API's numbers */
  graceMs?: number;
  now?: () => number;
  doc?: VisibilityLike | null;
}

/**
 * The public market cap, on its own timer (independent of the /api/state poll). `fill` overlays the latest public
 * quote on each API state; `onQuote` fires as soon as a new quote arrives so the header updates right away.
 */
export class PublicMarket {
  private readonly f: FetchLike;
  private readonly everyMs: number;
  private readonly graceMs: number;
  private readonly now: () => number;
  private readonly doc: VisibilityLike | null;
  private mint: string | null = null;
  private quote: { mint: string; q: PublicQuote; at: number } | null = null;
  /** the last feed that answered; tried first until it fails (no flip-flopping between feeds) */
  source: Source = 'jupiter';
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private onQuote: () => void = () => {};

  constructor(opts: PublicMarketOptions = {}) {
    this.f = opts.fetch ?? browserFetch;
    this.everyMs = opts.everyMs ?? 5_000;
    this.graceMs = opts.graceMs ?? 15_000;
    this.now = opts.now ?? (() => Date.now());
    this.doc = opts.doc !== undefined ? opts.doc : typeof document === 'undefined' ? null : document;
  }

  /** Starts the timer; paused while the tab is hidden, with a fetch right away when it becomes visible again. */
  start(onQuote: () => void = () => {}): void {
    if (this.started) return;
    this.started = true;
    this.onQuote = onQuote;
    this.doc?.addEventListener('visibilitychange', () => {
      if (this.hidden()) this.pause();
      else this.resume();
    });
    if (!this.hidden()) this.resume();
  }

  /** The state with the public quote in it; the API's own numbers only when there is no usable public quote. */
  fill(s: StateResponse): StateResponse {
    const mint = s.coin.mint;
    if (mint !== this.mint) {
      this.mint = mint;
      if (mint && this.timer) void this.tick(); // the mint just appeared: no need to wait for the next tick
    }
    if (!mint) return s; // before the launch
    const q = this.quote?.mint === mint ? this.quote.q : null;
    return q ? { ...s, coin: { ...s.coin, priceUsd: q.priceUsd, marketCapUsd: q.marketCapUsd } } : s;
  }

  /** One fetch, unless one is already in flight or there is no mint yet. */
  tick(): Promise<void> {
    const mint = this.mint;
    if (this.inFlight) return this.inFlight;
    if (!mint) return Promise.resolve();
    this.inFlight = publicQuote(mint, this.f, this.source)
      .then((r) => {
        if (mint !== this.mint) return; // the mint changed while this was in flight
        if (r) {
          this.source = r.source;
          this.quote = { mint, q: r.q, at: this.now() };
          this.onQuote();
        } else if (this.quote && this.now() - this.quote.at > this.graceMs) {
          this.quote = null; // both feeds down for a while: back to the API's numbers
          this.onQuote();
        }
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** Stops the timer (tests). */
  stop(): void {
    this.pause();
  }

  /** Waits for the fetch in flight (tests). */
  async settled(): Promise<void> {
    while (this.inFlight) await this.inFlight;
  }

  private hidden(): boolean {
    return this.doc?.visibilityState === 'hidden';
  }

  private pause(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private resume(): void {
    this.pause();
    this.timer = setInterval(() => void this.tick(), this.everyMs);
    void this.tick();
  }
}
