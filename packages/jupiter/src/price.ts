// Price API v3: GET /price/v3?ids=<up to 50 mints>. Tokens without a reliable price are omitted
// (VERIFIED: github.com/jup-ag/docs price/index.mdx). Missing = stale, never zero.
import type { PriceQuote, PriceSource, Pubkey } from '@rat/core';
import type { JupiterHttp } from './http';

export const PRICE_IDS_PER_CALL = 50;

interface PriceV3Entry {
  usdPrice?: number;
  priceChange24h?: number | null;
  decimals?: number;
  blockId?: number;
}

export class JupiterPriceSource implements PriceSource {
  /** number of HTTP calls made (for tests / budget checks) */
  calls = 0;

  constructor(private readonly http: JupiterHttp) {}

  async getPrices(mints: Pubkey[]): Promise<Map<Pubkey, PriceQuote>> {
    const unique = [...new Set(mints)];
    const out = new Map<Pubkey, PriceQuote>();
    for (let i = 0; i < unique.length; i += PRICE_IDS_PER_CALL) {
      const batch = unique.slice(i, i + PRICE_IDS_PER_CALL);
      this.calls++;
      const res = await this.http.get<Record<string, PriceV3Entry | null>>('/price/v3', { ids: batch.join(',') });
      for (const mint of batch) {
        const e = res[mint];
        if (!e || typeof e.usdPrice !== 'number' || !Number.isFinite(e.usdPrice) || e.usdPrice <= 0) continue;
        const change = typeof e.priceChange24h === 'number' && Number.isFinite(e.priceChange24h) ? e.priceChange24h : null;
        out.set(mint, { mint, usdPrice: e.usdPrice, change24hPct: change });
      }
    }
    return out;
  }
}
