// Liquidity and price sanity for every configured stock. Read-only: /build quotes with a throwaway taker,
// nothing is signed or sent. Needs RPC_URL and JUPITER_API_KEY.
//   pnpm --filter @rat/jupiter check:stocks
import { NATIVE_SOL_MINT, TOKEN_2022_PROGRAM, loadConfig, loadStocksFile, requireConfig } from '@rat/core';
import { RpcChainReader, createConnection } from '@rat/chain';
import { Keypair } from '@solana/web3.js';
import { JupiterHttp, JupiterPriceSource, JupiterSwapBuilder, SlidingWindowLimiter } from '../src';

const cfg = loadConfig();
requireConfig(cfg, ['rpcUrl']);
if (!cfg.jupiter.apiKey) throw new Error('JUPITER_API_KEY is required');
const stocks = loadStocksFile(cfg.stocksFile, new URL('../../..', import.meta.url).pathname, cfg.approvedStocks);
const reader = new RpcChainReader(createConnection(cfg.rpcUrl!));
const http = new JupiterHttp({ baseUrl: cfg.jupiter.baseUrl, apiKey: cfg.jupiter.apiKey, limiter: new SlidingWindowLimiter(cfg.jupiter.maxRpm) });
const mints = await reader.getMintStates(stocks.map((s) => s.mint));
const prices = await new JupiterPriceSource(http).getPrices([...stocks.map((s) => s.mint), NATIVE_SOL_MINT]);
const sol = prices.get(NATIVE_SOL_MINT)?.usdPrice ?? 0;
const swap = new JupiterSwapBuilder(http);
const salary = cfg.salaryLamports - cfg.hireOverheadEstLamports - cfg.ratBufferLamports;
const rows = [];
for (const s of stocks) {
  const m = mints.get(s.mint)!;
  const px = prices.get(s.mint)?.usdPrice ?? null;
  let deviationPct: number | null = null;
  let error: string | null = null;
  try {
    const q = await swap.build({ inputMint: NATIVE_SOL_MINT, outputMint: s.mint, amount: salary, taker: Keypair.generate().publicKey.toBase58(), slippageBps: cfg.slippageBpsStock });
    const implied = ((Number(salary) / 1e9) * sol) / ((Number(q.outAmount) / 10 ** m.decimals) * m.uiMultiplier);
    deviationPct = px ? ((implied - px) / px) * 100 : null;
  } catch (err) {
    error = (err as Error).message;
  }
  rows.push({
    symbol: s.symbol,
    token2022: m.tokenProgram === TOKEN_2022_PROGRAM,
    mintAuthority: m.mintAuthority,
    paused: m.paused,
    multiplier: m.uiMultiplier,
    priceUsd: px,
    buyDeviationPct: deviationPct === null ? null : Number(deviationPct.toFixed(2)),
    ok: !error && deviationPct !== null && Math.abs(deviationPct) <= cfg.maxPriceImpactPct,
    error,
  });
}
console.table(rows);
