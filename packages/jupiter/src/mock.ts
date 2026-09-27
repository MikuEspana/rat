// Mocks for tests and simulations: a price source with a seeded random walk, and a swap builder whose
// instruction is executed by SimChain (debits SOL, credits the output token). In-memory only.
import { NATIVE_SOL_MINT, type PriceQuote, type PriceSource, type Pubkey, type Rng, type SwapBuild, type SwapBuildRequest, type SwapBuilder } from '@rat/core';
import { type SimChain, SimError } from '@rat/chain/sim';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';

/** Program id of the mock swap (never a real program). */
export const MOCK_SWAP_PROGRAM_ID = 'MockSwap11111111111111111111111111111111111';

export class MockPriceSource implements PriceSource {
  private readonly prices = new Map<Pubkey, { usd: number; open: number; vol: number }>();
  private readonly missing = new Set<Pubkey>();
  calls = 0;

  set(mint: Pubkey, usd: number, opts: { vol?: number; change24hPct?: number } = {}): void {
    const open = opts.change24hPct !== undefined ? usd / (1 + opts.change24hPct / 100) : (this.prices.get(mint)?.open ?? usd);
    this.prices.set(mint, { usd, open, vol: opts.vol ?? this.prices.get(mint)?.vol ?? 0.002 });
  }

  price(mint: Pubkey): number | undefined {
    return this.prices.get(mint)?.usd;
  }

  /** Makes a mint disappear from responses (like Jupiter omitting an unreliable price). */
  setMissing(mint: Pubkey, missing: boolean): void {
    if (missing) this.missing.add(mint);
    else this.missing.delete(mint);
  }

  /** One random walk step for every price. */
  step(rng: Rng): void {
    for (const p of this.prices.values()) {
      const shock = (rng.next() - 0.5) * 2 * p.vol;
      p.usd = Math.max(0.0001, p.usd * (1 + shock));
    }
  }

  async getPrices(mints: Pubkey[]): Promise<Map<Pubkey, PriceQuote>> {
    this.calls++;
    const out = new Map<Pubkey, PriceQuote>();
    for (const m of mints) {
      const p = this.prices.get(m);
      if (!p || this.missing.has(m)) continue;
      out.set(m, { mint: m, usdPrice: p.usd, change24hPct: ((p.usd - p.open) / p.open) * 100 });
    }
    return out;
  }
}

interface MockSwapData {
  taker: string;
  payer: string;
  inMint: string;
  outMint: string;
  outProgram: string;
  inAmount: string;
  outAmount: string;
}

export interface MockSwapOptions {
  /** mint -> decimals and token program */
  tokens: Map<Pubkey, { decimals: number; program: Pubkey }>;
  /** execution cost vs the oracle price, e.g. 50 = 0.5% worse */
  spreadBps?: number;
  /** mints with no route */
  noRoute?: Set<Pubkey>;
}

/** Quotes from MockPriceSource prices. SOL -> token only (what hires and burns need). */
export class MockSwapBuilder implements SwapBuilder {
  calls = 0;

  constructor(
    private readonly prices: MockPriceSource,
    private readonly opts: MockSwapOptions,
  ) {}

  async build(req: SwapBuildRequest): Promise<SwapBuild> {
    this.calls++;
    if (req.inputMint !== NATIVE_SOL_MINT) throw new Error('MockSwapBuilder only supports SOL input');
    if (this.opts.noRoute?.has(req.outputMint)) throw new Error(`no route for ${req.outputMint}`);
    const token = this.opts.tokens.get(req.outputMint);
    const solUsd = this.prices.price(NATIVE_SOL_MINT);
    const outUsd = this.prices.price(req.outputMint);
    if (!token || !solUsd || !outUsd) throw new Error(`no route for ${req.outputMint}`);
    const spread = 1 - (this.opts.spreadBps ?? 50) / 10_000;
    const outUi = ((Number(req.amount) / 1e9) * solUsd * spread) / outUsd;
    const outAmount = BigInt(Math.floor(outUi * 10 ** token.decimals));
    if (outAmount <= 0n) throw new Error('mock swap output rounds to zero');
    const minOut = (outAmount * BigInt(10_000 - req.slippageBps)) / 10_000n;
    const payer = req.payer ?? req.taker;
    const data: MockSwapData = {
      taker: req.taker,
      payer,
      inMint: req.inputMint,
      outMint: req.outputMint,
      outProgram: token.program,
      inAmount: req.amount.toString(),
      outAmount: outAmount.toString(),
    };
    const keys = [{ pubkey: new PublicKey(req.taker), isSigner: true, isWritable: true }];
    if (payer !== req.taker) keys.push({ pubkey: new PublicKey(payer), isSigner: true, isWritable: true });
    keys.push({ pubkey: new PublicKey(req.outputMint), isSigner: false, isWritable: true });
    // like a real swap, the taker's output token account is an instruction account
    const outAta = getAssociatedTokenAddressSync(new PublicKey(req.outputMint), new PublicKey(req.taker), true, new PublicKey(token.program));
    keys.push({ pubkey: outAta, isSigner: false, isWritable: true });
    const ix = new TransactionInstruction({
      programId: new PublicKey(MOCK_SWAP_PROGRAM_ID),
      keys,
      data: Buffer.from(JSON.stringify(data)),
    });
    return { instructions: [ix], lookupTables: [], inAmount: req.amount, outAmount, minOutAmount: minOut, priceImpactPct: 0 };
  }
}

/** Registers the mock swap with SimChain: taker pays SOL, receives tokens; payer pays the ATA rent. */
export function registerMockSwapProgram(chain: SimChain): void {
  chain.registerProgram(MOCK_SWAP_PROGRAM_ID, (ix, ctx) => {
    const d = JSON.parse(Buffer.from(ix.data).toString('utf8')) as MockSwapData;
    ctx.requireSigner(d.taker);
    ctx.requireSigner(d.payer);
    if (d.inMint !== NATIVE_SOL_MINT) throw new SimError('mock swap: SOL input only');
    ctx.debit(d.taker, BigInt(d.inAmount));
    const ata = ctx.ensureAta(d.taker, d.outMint, d.outProgram, d.payer);
    ctx.mintTo(ata, BigInt(d.outAmount));
    ctx.log(`mock swap ${d.inAmount} lamports -> ${d.outAmount} ${d.outMint}`);
  });
}
