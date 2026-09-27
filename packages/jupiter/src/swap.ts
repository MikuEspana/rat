// Swap API v2 router path: GET /swap/v2/build returns the quote and raw instructions in one call
// (VERIFIED: github.com/jup-ag/docs swap/build/index.mdx). `payer` lets another wallet pay fees and rent.
// The response has no price impact field: the worker checks the implied price against the Price API.
import type { SwapBuild, SwapBuildRequest, SwapBuilder } from '@rat/core';
import { AddressLookupTableAccount, PublicKey, TransactionInstruction } from '@solana/web3.js';
import type { JupiterHttp } from './http';

export interface ApiInstruction {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
}

export interface BuildResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  computeBudgetInstructions: ApiInstruction[];
  setupInstructions: ApiInstruction[];
  swapInstruction: ApiInstruction;
  cleanupInstruction: ApiInstruction | null;
  otherInstructions: ApiInstruction[];
  tipInstruction: ApiInstruction | null;
  addressesByLookupTableAddress: Record<string, string[]> | null;
}

export function toInstruction(ix: ApiInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(ix.data, 'base64'),
  });
}

export function toLookupTables(raw: Record<string, string[]> | null): AddressLookupTableAccount[] {
  if (!raw) return [];
  return Object.entries(raw).map(
    ([key, addresses]) =>
      new AddressLookupTableAccount({
        key: new PublicKey(key),
        state: {
          deactivationSlot: BigInt('18446744073709551615'),
          lastExtendedSlot: 0,
          lastExtendedSlotStartIndex: 0,
          addresses: addresses.map((a) => new PublicKey(a)),
        },
      }),
  );
}

export class JupiterSwapBuilder implements SwapBuilder {
  calls = 0;

  constructor(
    private readonly http: JupiterHttp,
    private readonly opts: { maxAccounts?: number } = {},
  ) {}

  async build(req: SwapBuildRequest): Promise<SwapBuild> {
    this.calls++;
    const res = await this.http.get<BuildResponse>('/swap/v2/build', {
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      amount: req.amount.toString(),
      taker: req.taker,
      payer: req.payer && req.payer !== req.taker ? req.payer : undefined,
      slippageBps: String(req.slippageBps),
      maxAccounts: String(this.opts.maxAccounts ?? 40),
      wrapAndUnwrapSol: 'true',
    });
    return parseBuildResponse(res, req);
  }
}

export function parseBuildResponse(res: BuildResponse, req: SwapBuildRequest): SwapBuild {
  if (res.inputMint !== req.inputMint || res.outputMint !== req.outputMint) {
    throw new Error(`Jupiter /build returned a different pair (${res.inputMint} -> ${res.outputMint})`);
  }
  if (!res.swapInstruction) throw new Error('Jupiter /build returned no swap instruction');
  const inAmount = BigInt(res.inAmount);
  const outAmount = BigInt(res.outAmount);
  const minOut = BigInt(res.otherAmountThreshold);
  if (outAmount <= 0n || minOut <= 0n) throw new Error('Jupiter /build returned a zero output');
  // The quote must spend exactly what we asked, and its minimum output must honour OUR slippage: a wider
  // minimum would let a sandwich bot take the difference. 1 raw unit of rounding is tolerated.
  if (inAmount !== req.amount) throw new Error(`Jupiter /build quoted ${inAmount} in, asked for ${req.amount}`);
  const floor = (outAmount * BigInt(10_000 - req.slippageBps)) / 10_000n;
  if (minOut + 1n < floor) {
    throw new Error(`Jupiter /build minimum output ${minOut} is below the ${req.slippageBps} bps slippage floor ${floor}`);
  }
  const instructions = [
    ...res.setupInstructions.map(toInstruction),
    toInstruction(res.swapInstruction),
    ...(res.cleanupInstruction ? [toInstruction(res.cleanupInstruction)] : []),
    ...res.otherInstructions.map(toInstruction),
  ];
  return {
    instructions,
    lookupTables: toLookupTables(res.addressesByLookupTableAddress),
    inAmount,
    outAmount,
    minOutAmount: minOut,
    priceImpactPct: 0,
  };
}
