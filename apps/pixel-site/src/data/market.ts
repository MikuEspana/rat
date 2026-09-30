// Right after the launch the API already has the coin's mint (rat announce-ca) but no price until the bot runs the
// coin, a minute or three later. Meanwhile the browser reads the market cap from public price feeds: Jupiter's free
// price API first, then DexScreener. The API's own numbers win as soon as it has them.
import type { StateResponse } from '@rat/contract';

/** Every pump.fun coin has 1 billion tokens. */
export const PUMP_SUPPLY = 1_000_000_000;

export interface PublicQuote {
  priceUsd: number;
  marketCapUsd: number;
}
export type FetchLike = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

const browserFetch: FetchLike = (url) => fetch(url, { cache: 'no-store' });

/** The coin's price and market cap from Jupiter, else DexScreener; null when neither knows it yet. */
export async function publicQuote(mint: string, f: FetchLike = browserFetch): Promise<PublicQuote | null> {
  try {
    const r = await f(`https://lite-api.jup.ag/price/v3?ids=${encodeURIComponent(mint)}`);
    if (r.ok) {
      const p = ((await r.json()) as Record<string, { usdPrice?: unknown } | undefined> | null)?.[mint]?.usdPrice;
      if (typeof p === 'number' && p > 0) return { priceUsd: p, marketCapUsd: Math.round(p * PUMP_SUPPLY) };
    }
  } catch {
    /* next feed */
  }
  try {
    const r = await f(`https://api.dexscreener.com/tokens/v1/solana/${encodeURIComponent(mint)}`);
    if (r.ok) {
      const pairs = (await r.json()) as { priceUsd?: string; marketCap?: number }[] | null;
      const pair = Array.isArray(pairs) ? pairs[0] : undefined;
      const p = Number(pair?.priceUsd);
      if (pair && Number.isFinite(p) && p > 0) {
        const mc = typeof pair.marketCap === 'number' && pair.marketCap > 0 ? pair.marketCap : p * PUMP_SUPPLY;
        return { priceUsd: p, marketCapUsd: Math.round(mc) };
      }
    }
  } catch {
    /* none */
  }
  return null;
}

/** Fills in the public market cap while the API has the coin's mint but no market cap yet. */
export class PublicMarket {
  private quote: { mint: string; q: PublicQuote } | null = null;
  private lastAt = Number.NEGATIVE_INFINITY;
  private busy = false;

  constructor(
    private readonly f: FetchLike = browserFetch,
    private readonly everyMs = 10_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The state, with the last public quote in it when the API has none; fetches a new one in the background when due. */
  fill(s: StateResponse): StateResponse {
    const mint = s.coin.mint;
    if (!mint || s.coin.marketCapUsd !== null) return s; // before the launch, or the API's own numbers
    if (!this.busy && this.now() - this.lastAt >= this.everyMs) {
      this.busy = true;
      this.lastAt = this.now();
      void publicQuote(mint, this.f)
        .then((q) => {
          if (q) this.quote = { mint, q };
        })
        .finally(() => {
          this.busy = false;
        });
    }
    const q = this.quote?.mint === mint ? this.quote.q : null;
    return q ? { ...s, coin: { ...s.coin, priceUsd: q.priceUsd, marketCapUsd: q.marketCapUsd } } : s;
  }

  /** Waits for the fetch in flight (tests). */
  async settled(): Promise<void> {
    while (this.busy) await new Promise((r) => setTimeout(r, 1));
  }
}
