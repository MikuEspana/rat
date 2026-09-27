// Fallback buy through the pump.fun bonding curve (when Jupiter has no route before graduation).
// Implements the SwapBuilder port so the burn executor can use it in place of Jupiter.
// Uses the official @pump-fun/pump-sdk (the unified buy needs the sharing_config account; the SDK handles it).
import { createRequire } from 'node:module';
import type * as PumpSdk from '@pump-fun/pump-sdk';
import { NATIVE_SOL_MINT, type SwapBuildRequest, type SwapBuild, type SwapBuilder } from '@rat/core';
import { type Connection, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';

/**
 * The SDK's ESM build fails to import under Node (its agent-payments dependency does a named import
 * from CommonJS anchor), so the CommonJS build is loaded lazily, only when the fallback is used.
 */
function loadPumpSdk(): typeof PumpSdk {
  return createRequire(import.meta.url)('@pump-fun/pump-sdk') as typeof PumpSdk;
}

/** The slice of the SDK we use, so tests can stub it. */
export interface PumpBuyApi {
  fetchGlobal(): Promise<unknown>;
  fetchFeeConfig(): Promise<unknown>;
  fetchBuyState(mint: PublicKey, user: PublicKey, tokenProgram?: PublicKey): Promise<{
    bondingCurveAccountInfo: unknown;
    bondingCurve: { complete: boolean };
    associatedUserAccountInfo: unknown;
  }>;
  quoteTokens(args: { global: unknown; feeConfig: unknown; mintSupply: bigint | null; bondingCurve: unknown; solAmount: bigint }): bigint;
  buyInstructions(args: {
    global: unknown;
    bondingCurveAccountInfo: unknown;
    bondingCurve: unknown;
    associatedUserAccountInfo: unknown;
    mint: PublicKey;
    user: PublicKey;
    amount: bigint;
    solAmount: bigint;
    slippagePct: number;
    tokenProgram: PublicKey;
  }): Promise<TransactionInstruction[]>;
}

export function sdkBuyApi(connection: Connection): PumpBuyApi {
  const { OnlinePumpSdk, PUMP_SDK, getBuyTokenAmountFromSolAmount } = loadPumpSdk();
  const online = new OnlinePumpSdk(connection);
  return {
    fetchGlobal: () => online.fetchGlobal(),
    fetchFeeConfig: () => online.fetchFeeConfig(),
    fetchBuyState: (mint, user, tokenProgram) => online.fetchBuyState(mint, user, tokenProgram),
    quoteTokens: ({ global, feeConfig, mintSupply, bondingCurve, solAmount }) =>
      BigInt(
        getBuyTokenAmountFromSolAmount({
          global: global as never,
          feeConfig: feeConfig as never,
          mintSupply: mintSupply === null ? null : new BN(mintSupply.toString()),
          bondingCurve: bondingCurve as never,
          amount: new BN(solAmount.toString()),
          quoteMint: new PublicKey(NATIVE_SOL_MINT),
        }).toString(),
      ),
    buyInstructions: (a) =>
      PUMP_SDK.buyInstructions({
        global: a.global as never,
        bondingCurveAccountInfo: a.bondingCurveAccountInfo as never,
        bondingCurve: a.bondingCurve as never,
        associatedUserAccountInfo: a.associatedUserAccountInfo as never,
        mint: a.mint,
        user: a.user,
        amount: new BN(a.amount.toString()),
        solAmount: new BN(a.solAmount.toString()),
        slippage: a.slippagePct,
        tokenProgram: a.tokenProgram,
      }),
  };
}

export class PumpDirectBuyBuilder implements SwapBuilder {
  constructor(
    private readonly api: PumpBuyApi,
    private readonly coin: { mint: string; tokenProgram: string; supply: bigint | null },
  ) {}

  async build(req: SwapBuildRequest): Promise<SwapBuild> {
    if (req.inputMint !== NATIVE_SOL_MINT) throw new Error('pump direct buy only supports SOL input');
    if (req.outputMint !== this.coin.mint) throw new Error('pump direct buy is configured for a different coin');
    const user = new PublicKey(req.taker);
    const mint = new PublicKey(this.coin.mint);
    const tokenProgram = new PublicKey(this.coin.tokenProgram);
    const [global, feeConfig, state] = await Promise.all([
      this.api.fetchGlobal(),
      this.api.fetchFeeConfig(),
      this.api.fetchBuyState(mint, user, tokenProgram),
    ]);
    if (state.bondingCurve.complete) throw new Error('bonding curve is complete (graduated): use Jupiter / PumpSwap');
    const out = this.api.quoteTokens({ global, feeConfig, mintSupply: this.coin.supply, bondingCurve: state.bondingCurve, solAmount: req.amount });
    if (out <= 0n) throw new Error('pump direct buy quote returned 0 tokens');
    const instructions = await this.api.buyInstructions({
      global,
      bondingCurveAccountInfo: state.bondingCurveAccountInfo,
      bondingCurve: state.bondingCurve,
      associatedUserAccountInfo: state.associatedUserAccountInfo,
      mint,
      user,
      amount: out,
      solAmount: req.amount,
      slippagePct: req.slippageBps / 100,
      tokenProgram,
    });
    const minOut = (out * BigInt(10_000 - req.slippageBps)) / 10_000n;
    return { instructions, lookupTables: [], inAmount: req.amount, outAmount: out, minOutAmount: minOut, priceImpactPct: 0 };
  }
}
