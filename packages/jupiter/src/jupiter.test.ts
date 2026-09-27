import { NATIVE_SOL_MINT, SeededRng, TOKEN_2022_PROGRAM, type TxRequest } from '@rat/core';
import { SimChain, SimTxSender, TOKEN_2022_ACCOUNT_RENT } from '@rat/chain/sim';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { JupiterHttp } from './http';
import { MockPriceSource, MockSwapBuilder, registerMockSwapProgram } from './mock';
import { JupiterPriceSource } from './price';
import { SlidingWindowLimiter } from './rate-limiter';
import { type BuildResponse, JupiterSwapBuilder, parseBuildResponse } from './swap';

function virtualTime(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('SlidingWindowLimiter', () => {
  it('never exceeds the limit in any 60s window under 1,000 queued calls', async () => {
    const vt = virtualTime();
    const limiter = new SlidingWindowLimiter(55, 60_000, vt);
    const stamps: number[] = [];
    await Promise.all(
      Array.from({ length: 1000 }, () =>
        limiter.acquire().then(() => {
          stamps.push(vt.now());
        }),
      ),
    );
    expect(stamps.length).toBe(1000);
    for (let i = 0; i < stamps.length; i++) {
      const inWindow = stamps.filter((s) => s > stamps[i]! - 60_000 && s <= stamps[i]!).length;
      expect(inWindow).toBeLessThanOrEqual(55);
    }
    // 1000 calls at 55/min need a bit over 18 minutes
    expect(vt.now()).toBeGreaterThan(18 * 60_000);
    expect(vt.now()).toBeLessThan(19 * 60_000);
  });

  it('honors blockUntil after a 429', async () => {
    const vt = virtualTime(1_000);
    const limiter = new SlidingWindowLimiter(10, 60_000, vt);
    limiter.blockUntil(31_000);
    await limiter.acquire();
    expect(vt.now()).toBeGreaterThanOrEqual(31_000);
  });
});

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
}

describe('JupiterHttp', () => {
  it('sends the api key, retries 429 after the reset header, retries 5xx, throws on 4xx', async () => {
    const vt = virtualTime(1_000_000);
    const limiter = new SlidingWindowLimiter(55, 60_000, vt);
    const seen: { url: string; key: string | null }[] = [];
    const replies = [response(429, 'slow down', { 'x-ratelimit-reset': '1030' }), response(502, 'bad gateway'), response(200, { ok: 1 })];
    const http = new JupiterHttp({
      baseUrl: 'https://api.jup.ag',
      apiKey: 'test-key',
      limiter,
      sleep: vt.sleep,
      now: vt.now,
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push({ url, key: new Headers(init.headers).get('x-api-key') });
        return replies.shift()!;
      }) as unknown as typeof fetch,
    });
    expect(await http.get('/price/v3', { ids: 'a,b' })).toEqual({ ok: 1 });
    expect(seen.length).toBe(3);
    expect(seen.every((s) => s.key === 'test-key')).toBe(true);
    expect(seen[0]!.url).toBe('https://api.jup.ag/price/v3?ids=a%2Cb');
    expect(vt.now()).toBeGreaterThanOrEqual(1_030_000);

    const bad = new JupiterHttp({
      baseUrl: 'https://api.jup.ag',
      limiter,
      sleep: vt.sleep,
      fetchImpl: (async () => response(400, 'bad request')) as unknown as typeof fetch,
    });
    await expect(bad.get('/swap/v2/build', {})).rejects.toThrow(/400/);
  });
});

describe('JupiterPriceSource', () => {
  it('batches at most 50 ids per call and treats omitted or invalid prices as missing', async () => {
    const mints = Array.from({ length: 60 }, () => Keypair.generate().publicKey.toBase58());
    const calls: string[][] = [];
    const http = new JupiterHttp({
      baseUrl: 'https://api.jup.ag',
      apiKey: 'k',
      limiter: new SlidingWindowLimiter(1000),
      fetchImpl: (async (url: string) => {
        const ids = new URL(url).searchParams.get('ids')!.split(',');
        calls.push(ids);
        const body: Record<string, unknown> = {};
        for (const id of ids) {
          if (id === mints[3]) continue;
          body[id] = id === mints[4] ? { usdPrice: 0 } : { usdPrice: 100, priceChange24h: 1.29, decimals: 8 };
        }
        return response(200, body);
      }) as unknown as typeof fetch,
    });
    const prices = await new JupiterPriceSource(http).getPrices([...mints, mints[0]!]);
    expect(calls.map((c) => c.length)).toEqual([50, 10]);
    expect(prices.size).toBe(58);
    expect(prices.has(mints[3]!)).toBe(false);
    expect(prices.has(mints[4]!)).toBe(false);
    expect(prices.get(mints[0]!)).toEqual({ mint: mints[0], usdPrice: 100, change24hPct: 1.29 });
  });
});

describe('JupiterSwapBuilder', () => {
  const taker = Keypair.generate().publicKey.toBase58();
  const payer = Keypair.generate().publicKey.toBase58();
  const out = Keypair.generate().publicKey.toBase58();
  const ix = (programId: string) => ({ programId, accounts: [{ pubkey: taker, isSigner: true, isWritable: true }], data: Buffer.from([1, 2, 3]).toString('base64') });
  const sample: BuildResponse = {
    inputMint: NATIVE_SOL_MINT,
    outputMint: out,
    inAmount: '24500000',
    outAmount: '1413900',
    otherAmountThreshold: '1399761',
    swapMode: 'ExactIn',
    slippageBps: 100,
    computeBudgetInstructions: [ix('ComputeBudget111111111111111111111111111111')],
    setupInstructions: [ix('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')],
    swapInstruction: ix('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'),
    cleanupInstruction: ix('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    otherInstructions: [],
    tipInstruction: null,
    addressesByLookupTableAddress: { [Keypair.generate().publicKey.toBase58()]: [taker, out] },
  };

  it('parses instructions (without compute budget) and lookup tables', () => {
    const b = parseBuildResponse(sample, { inputMint: NATIVE_SOL_MINT, outputMint: out, amount: 24_500_000n, taker, slippageBps: 100 });
    expect(b.instructions.map((i) => i.programId.toBase58())).toEqual([
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
      'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    ]);
    expect(b.outAmount).toBe(1_413_900n);
    expect(b.minOutAmount).toBe(1_399_761n);
    expect(b.lookupTables[0]!.state.addresses.length).toBe(2);
    expect(() => parseBuildResponse({ ...sample, outputMint: taker }, { inputMint: NATIVE_SOL_MINT, outputMint: out, amount: 1n, taker, slippageBps: 100 })).toThrow(/different pair/);
    expect(() => parseBuildResponse({ ...sample, outAmount: '0' }, { inputMint: NATIVE_SOL_MINT, outputMint: out, amount: 1n, taker, slippageBps: 100 })).toThrow(/zero/);
  });

  it('red team: a quote that spends a different amount, or ignores our slippage, is rejected', () => {
    const req = { inputMint: NATIVE_SOL_MINT, outputMint: out, amount: 24_500_000n, taker, slippageBps: 100 };
    // spends more (or less) SOL than asked
    expect(() => parseBuildResponse({ ...sample, inAmount: '24500001' }, req)).toThrow(/quoted 24500001 in/);
    // minimum output far below outAmount - 1%: a sandwich could take the difference
    expect(() => parseBuildResponse({ ...sample, otherAmountThreshold: '1' }, req)).toThrow(/slippage floor/);
    expect(() => parseBuildResponse({ ...sample, otherAmountThreshold: '1385000' }, req)).toThrow(/slippage floor 1399761/);
    // exact floor and 1 raw unit of rounding are fine
    expect(parseBuildResponse(sample, req).minOutAmount).toBe(1_399_761n);
    expect(parseBuildResponse({ ...sample, otherAmountThreshold: '1399760' }, req).minOutAmount).toBe(1_399_760n);
    // Jupiter's own compute-budget and tip instructions are never used (we set our own)
    const programs = parseBuildResponse({ ...sample, tipInstruction: sample.swapInstruction }, req).instructions.map((i) => i.programId.toBase58());
    expect(programs).not.toContain('ComputeBudget111111111111111111111111111111');
    expect(programs.filter((p) => p === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4')).toHaveLength(1);
  });

  it('sends taker, payer (only when different), slippage and maxAccounts', async () => {
    const urls: URL[] = [];
    const http = new JupiterHttp({
      baseUrl: 'https://api.jup.ag',
      apiKey: 'k',
      limiter: new SlidingWindowLimiter(1000),
      fetchImpl: (async (url: string) => {
        urls.push(new URL(url));
        return response(200, sample);
      }) as unknown as typeof fetch,
    });
    const b = new JupiterSwapBuilder(http);
    await b.build({ inputMint: NATIVE_SOL_MINT, outputMint: out, amount: 24_500_000n, taker, payer, slippageBps: 100 });
    await b.build({ inputMint: NATIVE_SOL_MINT, outputMint: out, amount: 24_500_000n, taker, payer: taker, slippageBps: 100 });
    expect(urls[0]!.pathname).toBe('/swap/v2/build');
    expect(Object.fromEntries(urls[0]!.searchParams)).toMatchObject({ taker, payer, amount: '24500000', slippageBps: '100', maxAccounts: '40', wrapAndUnwrapSol: 'true' });
    expect(urls[1]!.searchParams.has('payer')).toBe(false);
  });
});

describe('mocks on SimChain', () => {
  it('a hire-shaped tx: creator funds the rat and pays rent, the rat buys the stock', async () => {
    const chain = new SimChain();
    registerMockSwapProgram(chain);
    const sender = new SimTxSender(chain);
    const stock = Keypair.generate().publicKey.toBase58();
    chain.createMint({ mint: stock, decimals: 8, tokenProgram: TOKEN_2022_PROGRAM });
    const prices = new MockPriceSource();
    prices.set(NATIVE_SOL_MINT, 185.4);
    prices.set(stock, 412.33);
    const swap = new MockSwapBuilder(prices, { tokens: new Map([[stock, { decimals: 8, program: TOKEN_2022_PROGRAM }]]) });
    const creator = Keypair.generate();
    const rat = Keypair.generate();
    chain.fundAccount(creator.publicKey.toBase58(), 1_000_000_000n);
    const salary = 27_500_000n;
    const build = await swap.build({ inputMint: NATIVE_SOL_MINT, outputMint: stock, amount: 24_500_000n, taker: rat.publicKey.toBase58(), payer: creator.publicKey.toBase58(), slippageBps: 100 });
    const req: TxRequest = {
      kind: 'hire',
      label: 'hire',
      feePayer: creator,
      signers: [rat],
      instructions: [SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: rat.publicKey, lamports: salary }), ...build.instructions],
      computeUnitLimit: 400_000,
    };
    const out = await sender.submit(await sender.prepare(req));
    expect(out.status).toBe('confirmed');
    expect(chain.tokenBalance(rat.publicKey.toBase58(), stock, TOKEN_2022_PROGRAM)).toBe(build.outAmount);
    expect(chain.sol(rat.publicKey.toBase58())).toBe(salary - 24_500_000n);
    expect(chain.sol(creator.publicKey.toBase58())).toBe(1_000_000_000n - salary - TOKEN_2022_ACCOUNT_RENT - out.feeLamports);

    chain.updateMint(stock, { paused: true });
    const rat2 = Keypair.generate();
    const b2 = await swap.build({ inputMint: NATIVE_SOL_MINT, outputMint: stock, amount: 24_500_000n, taker: rat2.publicKey.toBase58(), payer: creator.publicKey.toBase58(), slippageBps: 100 });
    const failed = await sender.submit(
      await sender.prepare({ ...req, signers: [rat2], instructions: [SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: rat2.publicKey, lamports: salary }), ...b2.instructions] }),
    );
    expect(failed.status).toBe('failed');
    expect(chain.sol(rat2.publicKey.toBase58())).toBe(0n);
  });

  it('mock prices walk deterministically and can go missing', async () => {
    const a = new MockPriceSource();
    const b = new MockPriceSource();
    const m = new PublicKey(Keypair.generate().publicKey).toBase58();
    a.set(m, 100, { vol: 0.01 });
    b.set(m, 100, { vol: 0.01 });
    const r1 = new SeededRng(9);
    const r2 = new SeededRng(9);
    for (let i = 0; i < 100; i++) {
      a.step(r1);
      b.step(r2);
    }
    expect(a.price(m)).toBe(b.price(m));
    a.setMissing(m, true);
    expect((await a.getPrices([m])).size).toBe(0);
  });
});
