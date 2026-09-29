// Prices: ONE batched Jupiter Price v3 call per loop (every 45 s) for every stock + SOL + the coin.
// Missing prices keep the last value and age into "stale" (never zero). The call takes one token of the Jupiter
// budget; with none left (or while backing off after a 429) this round is skipped and the last prices stay.
import { NATIVE_SOL_MINT, SETTINGS } from '@rat/core';
import { JupiterBudgetError } from '@rat/jupiter';
import type { WorkerDeps, WorkerState } from '../deps';

const HISTORY_EVERY_MS = 60_000;

export async function runPriceStep(d: WorkerDeps, s: WorkerState): Promise<{ priced: number; missing: string[]; skipped?: string }> {
  const stocks = (await d.store.stocks.list()).filter((x) => x.enabled);
  const mints = [...stocks.map((x) => x.mint), NATIVE_SOL_MINT];
  if (d.config.coinMint) mints.push(d.config.coinMint);
  let quotes: Awaited<ReturnType<typeof d.prices.getPrices>>;
  try {
    quotes = await d.prices.getPrices(mints);
  } catch (err) {
    if (err instanceof JupiterBudgetError) return { priced: 0, missing: [], skipped: err.message };
    throw err;
  }
  const now = d.clock.now();
  const history: { mint: string; priceUsd: number; at: Date }[] = [];
  const missing: string[] = [];
  for (const st of stocks) {
    const q = quotes.get(st.mint);
    if (!q) {
      missing.push(st.symbol);
      continue;
    }
    await d.store.stocks.setPrice(st.mint, q.usdPrice, q.change24hPct, now);
    const last = s.lastPriceHistoryAt.get(st.mint) ?? 0;
    if (now.getTime() - last >= HISTORY_EVERY_MS) {
      history.push({ mint: st.mint, priceUsd: q.usdPrice, at: now });
      s.lastPriceHistoryAt.set(st.mint, now.getTime());
    }
  }
  await d.store.stocks.addPriceHistory(history);
  const sol = quotes.get(NATIVE_SOL_MINT);
  if (sol) {
    s.solUsd = sol.usdPrice;
    s.solUsdAt = now.getTime();
    await d.store.settings.set(SETTINGS.priceSol, JSON.stringify({ usd: sol.usdPrice, change24hPct: sol.change24hPct, at: now.toISOString() }));
  }
  if (d.config.coinMint) {
    const coin = quotes.get(d.config.coinMint);
    if (coin) {
      s.coinUsd = coin.usdPrice;
      await d.store.settings.set(SETTINGS.priceCoin, JSON.stringify({ usd: coin.usdPrice, change24hPct: coin.change24hPct, at: now.toISOString() }));
    }
  }
  if (missing.length > 0) d.log.debug({ missing }, 'prices missing (kept last value)');
  return { priced: stocks.length - missing.length, missing };
}

/** Latest SOL price from memory, falling back to the database (for display: it may be old). */
export async function solUsd(d: WorkerDeps, s: WorkerState): Promise<number | null> {
  if (s.solUsd !== null) return s.solUsd;
  const raw = await d.store.settings.get(SETTINGS.priceSol);
  if (!raw) return null;
  const p = JSON.parse(raw) as { usd: number; at?: string };
  s.solUsd = p.usd;
  s.solUsdAt = p.at ? new Date(p.at).getTime() : 0;
  return s.solUsd;
}

/**
 * The SOL price for the hire price guard: null when older than PRICE_STALE_SEC, like a stock price. A stale SOL
 * price would let a quote that is much worse than fair pass the guard (SOL rose, the bot still sees the old price).
 */
export async function freshSolUsd(d: WorkerDeps, s: WorkerState): Promise<number | null> {
  const usd = await solUsd(d, s);
  if (usd === null || d.clock.now().getTime() - s.solUsdAt > d.config.priceStaleSec * 1000) return null;
  return usd;
}
