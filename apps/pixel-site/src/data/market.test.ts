import type { StateResponse } from '@rat/contract';
import { describe, expect, it } from 'vitest';
import { type FetchLike, PUMP_SUPPLY, PublicMarket, publicQuote } from './market';

const MINT = 'CoinWSR111111111111111111111111111111pump';
const jup = (price: number | null): FetchLike => async (url) =>
  url.includes('jup.ag')
    ? { ok: price !== null, json: async () => (price === null ? {} : { [MINT]: { usdPrice: price } }) }
    : { ok: true, json: async () => [{ priceUsd: '0.0000050', marketCap: 5000 }] };
const state = (mint: string | null, marketCapUsd: number | null): StateResponse =>
  ({ coin: { mint, symbol: 'WSR', priceUsd: marketCapUsd === null ? null : 0.000004, supply: null, marketCapUsd } }) as unknown as StateResponse;

describe('the market cap right after the launch (public feeds)', () => {
  it('Jupiter first: price x 1 billion', async () => {
    expect(await publicQuote(MINT, jup(0.0000035))).toEqual({ priceUsd: 0.0000035, marketCapUsd: Math.round(0.0000035 * PUMP_SUPPLY) });
  });

  it('Jupiter does not know the coin yet (or fails): DexScreener', async () => {
    expect(await publicQuote(MINT, jup(null))).toEqual({ priceUsd: 0.000005, marketCapUsd: 5000 });
    const jupThrows: FetchLike = async (url) => {
      if (url.includes('jup.ag')) throw new Error('offline');
      return { ok: true, json: async () => [{ priceUsd: '0.0000050', marketCap: 5000 }] };
    };
    expect(await publicQuote(MINT, jupThrows)).toEqual({ priceUsd: 0.000005, marketCapUsd: 5000 });
  });

  it('neither knows it: null', async () => {
    const none: FetchLike = async () => ({ ok: false, json: async () => null });
    expect(await publicQuote(MINT, none)).toBeNull();
  });

  it('fills the state only while the API has a mint but no market cap', async () => {
    let calls = 0;
    const f: FetchLike = async (url) => {
      calls++;
      return jup(0.000004)(url);
    };
    let t = 0;
    const m = new PublicMarket(f, 10_000, () => t);
    expect(m.fill(state(null, null)).coin.marketCapUsd).toBeNull(); // before the launch: nothing fetched
    expect(calls).toBe(0);
    m.fill(state(MINT, null));
    await m.settled();
    expect(m.fill(state(MINT, null)).coin.marketCapUsd).toBe(4000);
    expect(calls).toBe(1); // at most one fetch every 10 s
    t = 10_000;
    m.fill(state(MINT, null));
    await m.settled();
    expect(calls).toBe(2);
    expect(m.fill(state(MINT, 7777)).coin.marketCapUsd).toBe(7777); // the API's own number wins, no fetch
    expect(calls).toBe(2);
  });
});
