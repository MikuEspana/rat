// ChainReader over JSON-RPC, with failover to a backup endpoint for reads.
import type {
  ChainReader,
  Clock,
  MintState,
  Pubkey,
  SignatureInfo,
  TokenAccountQuery,
  TokenAccountState,
  TxRecord,
} from '@rat/core';
import { systemClock } from '@rat/core';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { type AccountInfo, type Commitment, Connection, PublicKey } from '@solana/web3.js';
import { parseMintAccount, parseTokenAccount } from './mint-parse';
import { normalizeTransaction } from './tx-normalize';

const CHUNK = 100;

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function createConnection(url: string, commitment: Commitment = 'confirmed'): Connection {
  return new Connection(url, { commitment, disableRetryOnRateLimit: false });
}

export class RpcChainReader implements ChainReader {
  private readonly connections: Connection[];

  constructor(
    primary: Connection,
    backup?: Connection,
    private readonly clock: Clock = systemClock,
  ) {
    this.connections = backup ? [primary, backup] : [primary];
  }

  /** Runs `fn` on the primary, then on the backup if the primary throws. */
  private async withFailover<T>(fn: (c: Connection) => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (const c of this.connections) {
      try {
        return await fn(c);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  async getAccountData(pubkey: Pubkey): Promise<{ owner: Pubkey; data: Uint8Array } | null> {
    const info = await this.withFailover((c) => c.getAccountInfo(new PublicKey(pubkey)));
    return info ? { owner: info.owner.toBase58(), data: new Uint8Array(info.data) } : null;
  }

  private async accounts(pubkeys: string[]): Promise<(AccountInfo<Buffer> | null)[]> {
    const out: (AccountInfo<Buffer> | null)[] = [];
    for (const part of chunks(pubkeys, CHUNK)) {
      const infos = await this.withFailover((c) => c.getMultipleAccountsInfo(part.map((p) => new PublicKey(p))));
      out.push(...infos);
    }
    return out;
  }

  async getSolBalances(pubkeys: Pubkey[]): Promise<Map<Pubkey, bigint>> {
    const infos = await this.accounts(pubkeys);
    return new Map(pubkeys.map((p, i) => [p, BigInt(infos[i]?.lamports ?? 0)]));
  }

  async getMintStates(mints: Pubkey[]): Promise<Map<Pubkey, MintState>> {
    const infos = await this.accounts(mints);
    const nowSec = Math.floor(this.clock.now().getTime() / 1000);
    return new Map(mints.map((m, i) => [m, parseMintAccount(m, infos[i] ?? null, nowSec)]));
  }

  async getTokenAccounts(queries: TokenAccountQuery[]): Promise<TokenAccountState[]> {
    const addresses = queries.map((q) =>
      getAssociatedTokenAddressSync(new PublicKey(q.mint), new PublicKey(q.owner), true, new PublicKey(q.tokenProgram)).toBase58(),
    );
    const infos = await this.accounts(addresses);
    return queries.map((q, i) => {
      const parsed = parseTokenAccount(addresses[i]!, infos[i] ?? null);
      return {
        address: addresses[i]!,
        owner: q.owner,
        mint: q.mint,
        exists: parsed.exists,
        amount: parsed.amount,
        frozen: parsed.frozen,
      };
    });
  }

  /** Pages back (1,000 per call, the RPC maximum) until `untilSignature` or `limit` signatures: none are skipped. */
  async getSignaturesSince(address: Pubkey, untilSignature: string | null, limit = 1000): Promise<SignatureInfo[]> {
    const out: SignatureInfo[] = [];
    let before: string | undefined;
    while (out.length < limit) {
      const page = Math.min(1000, limit - out.length);
      const res = await this.withFailover((c) =>
        c.getSignaturesForAddress(new PublicKey(address), { until: untilSignature ?? undefined, before, limit: page }, 'confirmed'),
      );
      out.push(...res.map((s) => ({ signature: s.signature, slot: s.slot, err: s.err, blockTime: s.blockTime ?? null })));
      if (res.length < page) break;
      before = res[res.length - 1]!.signature;
    }
    return out;
  }

  async getSlot(): Promise<number> {
    return this.withFailover((c) => c.getSlot('confirmed'));
  }

  async getTransactionRecord(signature: string): Promise<TxRecord | null> {
    const tx = await this.withFailover((c) =>
      c.getTransaction(signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }),
    );
    return tx ? normalizeTransaction(tx) : null;
  }
}
