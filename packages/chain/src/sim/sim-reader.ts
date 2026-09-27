// ChainReader over SimChain.
import type {
  ChainReader,
  MintState,
  Pubkey,
  SignatureInfo,
  TokenAccountQuery,
  TokenAccountState,
  TxRecord,
} from '@rat/core';
import { missingMint } from '../mint-parse';
import { type SimChain, ataAddress } from './sim-chain';

export class SimChainReader implements ChainReader {
  /** number of read calls (for assertions on RPC load) */
  calls = 0;

  constructor(private readonly chain: SimChain) {}

  async getSolBalances(pubkeys: Pubkey[]): Promise<Map<Pubkey, bigint>> {
    this.calls++;
    return new Map(pubkeys.map((p) => [p, this.chain.sol(p)]));
  }

  async getMintStates(mints: Pubkey[]): Promise<Map<Pubkey, MintState>> {
    this.calls++;
    return new Map(mints.map((m) => [m, this.chain.mintState(m) ?? missingMint(m)]));
  }

  async getTokenAccounts(queries: TokenAccountQuery[]): Promise<TokenAccountState[]> {
    this.calls++;
    return queries.map((q) => {
      const address = ataAddress(q.owner, q.mint, q.tokenProgram);
      const t = this.chain.tokenAccount(address);
      return { address, owner: q.owner, mint: q.mint, exists: Boolean(t), amount: t?.amount ?? 0n, frozen: t?.frozen ?? false };
    });
  }

  async getSignaturesSince(address: Pubkey, untilSignature: string | null, limit = 1000): Promise<SignatureInfo[]> {
    this.calls++;
    const all = this.chain.signaturesFor(address).reverse();
    const out: SignatureInfo[] = [];
    for (const sig of all) {
      if (sig === untilSignature) break;
      const r = this.chain.transaction(sig);
      out.push({ signature: sig, slot: r?.slot ?? 0, err: r?.err ?? null, blockTime: null });
      if (out.length >= limit) break;
    }
    return out;
  }

  async getSlot(): Promise<number> {
    this.calls++;
    return this.chain.slot;
  }

  async getTransactionRecord(signature: string): Promise<TxRecord | null> {
    this.calls++;
    return this.chain.transaction(signature) ?? null;
  }
}
