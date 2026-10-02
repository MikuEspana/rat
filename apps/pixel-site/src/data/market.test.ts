import type { StateResponse } from '@rat/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FetchLike, PUMP_SUPPLY, PublicMarket, publicQuote, type VisibilityLike } from './market';

const MINT = 'CoinWSR111111111111111111111111111111pump';
const jup = (price: number | null): FetchLike => async (url) =>
  url.includes('jup.ag')
    ? { ok: price !== null, json: async () => (price === null ? {} : { [MINT]: { usdPrice: price } }) }
    : { ok: true, json: async () => [{ priceUsd: '0.0000050', marketCap: 5000 }] };
const state = (mint: string | null, marketCapUsd: number | null): StateResponse =>
  ({ coin: { mint, symbol: 'INUVESTOR', priceUsd: marketCapUsd === null ? null : 0.000004, supply: null, marketCapUsd } }) as unknown as StateResponse;

/** A fetch whose feeds can be switched on and off; counts calls per feed. */
interface Feeds {
  jup: number | null;
  dex: number | null;
  calls: { jup: number; dex: number };
  fetch: FetchLike;
}
function feeds(): Feeds {
  const f: Feeds = {
    jup: 0.000004, // null: Jupiter fails
    dex: 0.000005, // null: DexScreener fails
    calls: { jup: 0, dex: 0 },
    fetch: (async (url) => {
      if (url.includes('jup.ag')) {
        f.calls.jup++;
        if (f.jup === null) throw new Error('jupiter down');
        return { ok: true, json: async () => ({ [MINT]: { usdPrice: f.jup } }) };
      }
      f.calls.dex++;
      if (f.dex === null) return { ok: false, json: async () => null };
      return { ok: true, json: async () => [{ priceUsd: String(f.dex), marketCap: Math.round(f.dex! * PUMP_SUPPLY) }] };
    }) as FetchLike,
  };
  return f;
}

function fakeDoc() {
  let fn: () => void = () => {};
  const d = {
    visibilityState: 'visible',
    addEventListener: (_t: 'visibilitychange', f: () => void) => {
      fn = f;
    },
    set(v: 'visible' | 'hidden') {
      d.visibilityState = v;
      fn();
    },
  };
  return d as VisibilityLike & { visibilityState: string; set(v: 'visible' | 'hidden'): void };
}

describe('public quote feeds', () => {
  it('Jupiter first: price x 1 billion', async () => {
    expect(await publicQuote(MINT, jup(0.0000035))).toEqual({
      q: { priceUsd: 0.0000035, marketCapUsd: Math.round(0.0000035 * PUMP_SUPPLY) },
      source: 'jupiter',
    });
  });

  it('Jupiter does not know the coin yet (or fails): DexScreener', async () => {
    expect(await publicQuote(MINT, jup(null))).toEqual({ q: { priceUsd: 0.000005, marketCapUsd: 5000 }, source: 'dexscreener' });
    const jupThrows: FetchLike = async (url) => {
      if (url.includes('jup.ag')) throw new Error('offline');
      return { ok: true, json: async () => [{ priceUsd: '0.0000050', marketCap: 5000 }] };
    };
    expect((await publicQuote(MINT, jupThrows))?.source).toBe('dexscreener');
  });

  it('neither knows it: null', async () => {
    const none: FetchLike = async () => ({ ok: false, json: async () => null });
    expect(await publicQuote(MINT, none)).toBeNull();
  });
});

describe('PublicMarket (header market cap)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('prefers the public feed over the API value, and leaves pre-launch / loading states alone', async () => {
    const f = feeds();
    const m = new PublicMarket({ fetch: f.fetch, doc: null });
    m.start();
    expect(m.fill(state(null, null)).coin.marketCapUsd).toBeNull(); // pre-launch: nothing fetched
    expect(f.calls.jup).toBe(0);
    expect(m.fill(state(MINT, null)).coin.marketCapUsd).toBeNull(); // mint, no value yet: "loading..."
    await m.settled();
    expect(f.calls.jup).toBe(1); // fetched right away when the mint appeared
    expect(m.fill(state(MINT, 7777)).coin.marketCapUsd).toBe(4000); // the public quote wins over the bot's 7777
    expect(m.fill(state(MINT, 7777)).coin.priceUsd).toBe(0.000004);
    m.stop();
  });

  it('uses the API value before the first public quote arrives', () => {
    const f = feeds();
    const m = new PublicMarket({ fetch: f.fetch, doc: null });
    expect(m.fill(state(MINT, 7777)).coin.marketCapUsd).toBe(7777);
  });

  it('sticks with the last good source until it fails', async () => {
    const f = feeds();
    const m = new PublicMarket({ fetch: f.fetch, doc: null });
    m.fill(state(MINT, null));
    f.jup = null; // Jupiter down: DexScreener
    await m.tick();
    expect(m.source).toBe('dexscreener');
    expect(m.fill(state(MINT, null)).coin.marketCapUsd).toBe(5000);
    f.jup = 0.000004; // Jupiter back: still DexScreener, no flip-flop
    f.calls = { jup: 0, dex: 0 };
    await m.tick();
    await m.tick();
    expect(f.calls).toEqual({ jup: 0, dex: 2 });
    expect(m.fill(state(MINT, null)).coin.marketCapUsd).toBe(5000);
    f.dex = null; // DexScreener fails: back to Jupiter, and it sticks
    await m.tick();
    expect(m.source).toBe('jupiter');
    expect(m.fill(state(MINT, null)).coin.marketCapUsd).toBe(4000);
    f.dex = 0.000005;
    f.calls = { jup: 0, dex: 0 };
    await m.tick();
    expect(f.calls).toEqual({ jup: 1, dex: 0 });
  });

  it('uses the API value only when both feeds fail', async () => {
    let t = 0;
    const f = feeds();
    const m = new PublicMarket({ fetch: f.fetch, doc: null, graceMs: 15_000, now: () => t });
    m.fill(state(MINT, 7777));
    f.jup = null;
    f.dex = null;
    await m.tick();
    expect(m.fill(state(MINT, 7777)).coin.marketCapUsd).toBe(7777); // no public quote at all: the API's
    f.jup = 0.000004;
    await m.tick();
    expect(m.fill(state(MINT, 7777)).coin.marketCapUsd).toBe(4000);
    f.jup = null;
    f.dex = null;
    t = 10_000;
    await m.tick();
    expect(m.fill(state(MINT, 7777)).coin.marketCapUsd).toBe(4000); // one blip: keep the last public quote
    t = 16_000;
    await m.tick();
    expect(m.fill(state(MINT, 7777)).coin.marketCapUsd).toBe(7777); // both down for a while: the API's
  });

  it('fetches every 5 s on its own timer, one request in flight, and pushes each quote to the UI', async () => {
    const pending: (() => void)[] = [];
    let calls = 0;
    const slow: FetchLike = (url) => {
      calls++;
      return new Promise((res) => pending.push(() => res(jup(0.000004)(url) as never)));
    };
    const onQuote = vi.fn();
    const m = new PublicMarket({ fetch: slow, doc: null });
    m.start(onQuote);
    m.fill(state(MINT, null));
    expect(calls).toBe(1); // immediately
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toBe(1); // still in flight: no second request
    pending.shift()!();
    await m.settled();
    expect(onQuote).toHaveBeenCalledTimes(1); // pushed as soon as it arrived, not on the next /api/state poll
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2); // the 5 s cadence
    pending.shift()!();
    await m.settled();
    expect(onQuote).toHaveBeenCalledTimes(2);
    m.stop();
  });

  it('pauses while the tab is hidden and fetches right away when it is visible again', async () => {
    const f = feeds();
    const doc = fakeDoc();
    const m = new PublicMarket({ fetch: f.fetch, doc });
    m.start();
    m.fill(state(MINT, null));
    await m.settled();
    expect(f.calls.jup).toBe(1);
    doc.set('hidden');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.calls.jup).toBe(1); // no requests while hidden
    doc.set('visible');
    await m.settled();
    expect(f.calls.jup).toBe(2); // right away
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.calls.jup).toBe(3);
    m.stop();
  });

  it('a tab that starts hidden does not fetch until it is shown', async () => {
    const f = feeds();
    const doc = fakeDoc();
    doc.visibilityState = 'hidden';
    const m = new PublicMarket({ fetch: f.fetch, doc });
    m.start();
    m.fill(state(MINT, null));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.calls.jup).toBe(0);
    expect(m.fill(state(MINT, null)).coin.marketCapUsd).toBeNull(); // "loading..."
    doc.set('visible');
    await m.settled();
    expect(m.fill(state(MINT, null)).coin.marketCapUsd).toBe(4000);
    m.stop();
  });
});
