// Owner decision #6: is Jupiter's usdPrice per SCALED UI token (after the Scaled UI multiplier) or per raw
// token? Read-only: reads the mint, the price, and asks /build for a quote with a throwaway taker address.
// Nothing is signed or sent. Needs RPC_URL and JUPITER_API_KEY.
//   pnpm --filter @rat/jupiter check:scaled-ui [SYMBOL]
import { NATIVE_SOL_MINT, loadConfig, loadStocksFile, requireConfig } from '@rat/core';
import { RpcChainReader, createConnection } from '@rat/chain';
import { Keypair } from '@solana/web3.js';
import { JupiterHttp, JupiterPriceSource, JupiterSwapBuilder, SlidingWindowLimiter } from '../src';

const cfg = loadConfig();
requireConfig(cfg, ['rpcUrl']);
if (!cfg.jupiter.apiKey) throw new Error('JUPITER_API_KEY is required');
const stocks = loadStocksFile(cfg.stocksFile, new URL('../../..', import.meta.url).pathname, cfg.approvedStocks);
const symbol = process.argv[2] ?? stocks[0]!.symbol;
const stock = stocks.find((s) => s.symbol === symbol);
if (!stock) throw new Error(`unknown symbol ${symbol}`);

const reader = new RpcChainReader(createConnection(cfg.rpcUrl!));
const http = new JupiterHttp({ baseUrl: cfg.jupiter.baseUrl, apiKey: cfg.jupiter.apiKey, limiter: new SlidingWindowLimiter(cfg.jupiter.maxRpm) });
const mint = (await reader.getMintStates([stock.mint])).get(stock.mint)!;
const prices = await new JupiterPriceSource(http).getPrices([stock.mint, NATIVE_SOL_MINT]);
const px = prices.get(stock.mint)?.usdPrice;
const sol = prices.get(NATIVE_SOL_MINT)?.usdPrice;
if (!px || !sol) throw new Error('missing price');
const lamports = 10_000_000n;
const q = await new JupiterSwapBuilder(http).build({
  inputMint: NATIVE_SOL_MINT,
  outputMint: stock.mint,
  amount: lamports,
  taker: Keypair.generate().publicKey.toBase58(),
  slippageBps: 100,
});
const rawUi = Number(q.outAmount) / 10 ** mint.decimals;
const usdIn = (Number(lamports) / 1e9) * sol;
const ifScaled = usdIn / px / mint.uiMultiplier;
const ifRaw = usdIn / px;
console.log({ symbol, multiplier: mint.uiMultiplier, usdPrice: px, rawUiOut: rawUi, expectedIfPricePerScaledUi: ifScaled, expectedIfPricePerRawUi: ifRaw });
const verdict = Math.abs(rawUi - ifScaled) < Math.abs(rawUi - ifRaw) ? 'price is per SCALED UI token (current code is right)' : 'price is per RAW token (switch valuation to raw amount)';
console.log(mint.uiMultiplier === 1 ? 'multiplier is 1, both readings are equal; pick a stock with a multiplier != 1' : verdict);
