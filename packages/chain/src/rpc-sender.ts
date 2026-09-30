// THE ONLY FILE ALLOWED TO SEND TRANSACTIONS (enforced by scripts/check-guards.mjs).
//
// Refuses to send unless DRY_RUN=false AND LIVE_CONFIRM matched the exact phrase (config.liveConfirmed).
// The GuardedSender in @rat/safety adds the kill switch, spend reservations and the attempt log on top.
import { BlockedError, type Logger, type PreparedTx, type TxEffects, type TxLimits, type TxOutcome, type TxRequest, type TxSender, sleep } from '@rat/core';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  type Connection,
  PublicKey,
  SendTransactionError,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { normalizeTransaction } from './tx-normalize';

export type SenderConnection = Pick<
  Connection,
  | 'getLatestBlockhash'
  | 'getRecentPrioritizationFees'
  | 'sendRawTransaction'
  | 'getSignatureStatuses'
  | 'getBlockHeight'
  | 'getEpochInfo'
  | 'getTransaction'
  | 'simulateTransaction'
  | 'getMultipleAccountsInfoAndContext'
>;

export interface RpcTxSenderOptions {
  dryRun: boolean;
  liveConfirmed: boolean;
  priorityFeeMaxMicroLamports: number;
  /** poll interval while waiting for confirmation */
  pollMs?: number;
  /** give up waiting (status stays `unknown`) after this long */
  maxWaitMs?: number;
  /** blocks past lastValidBlockHeight before we call a tx expired (protects against status lag) */
  expiryMarginBlocks?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: Logger;
  /** rehearsal only (STAGING crash test): runs once the tx is broadcast, before waiting for confirmation */
  afterBroadcast?: (tx: PreparedTx) => Promise<void>;
}

const DEFAULT_PRIORITY_FALLBACK = 10_000;

/** Raw amount of an SPL / Token-2022 token account (mint 0..32, owner 32..64, amount u64 LE at 64). */
export function tokenAmountOf(data: Uint8Array | null): bigint {
  if (!data || data.length < 72) return 0n;
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).readBigUInt64LE(64);
}

function hasAllSignatures(tx: VersionedTransaction): boolean {
  return tx.signatures.every((s) => s.some((b) => b !== 0));
}

export class RpcTxSender implements TxSender {
  private readonly pollMs: number;
  private readonly maxWaitMs: number;
  private readonly margin: number;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(
    private readonly conn: SenderConnection,
    private readonly opts: RpcTxSenderOptions,
  ) {
    this.pollMs = opts.pollMs ?? 2_000;
    this.maxWaitMs = opts.maxWaitMs ?? 120_000;
    this.margin = opts.expiryMarginBlocks ?? 30;
    this.wait = opts.sleep ?? sleep;
  }

  private async estimatePriority(req: TxRequest): Promise<number> {
    const writable = new Set<string>();
    for (const ix of req.instructions) for (const k of ix.keys) if (k.isWritable) writable.add(k.pubkey.toBase58());
    try {
      const fees = await this.conn.getRecentPrioritizationFees({
        lockedWritableAccounts: [...writable].slice(0, 128).map((k) => new PublicKey(k)),
      });
      const values = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b);
      if (values.length === 0) return DEFAULT_PRIORITY_FALLBACK;
      return values[Math.floor(values.length * 0.75)] ?? DEFAULT_PRIORITY_FALLBACK;
    } catch {
      return DEFAULT_PRIORITY_FALLBACK;
    }
  }

  async prepare(req: TxRequest): Promise<PreparedTx> {
    const wanted = req.computeUnitPriceMicroLamports ?? (await this.estimatePriority(req));
    const price = Math.max(0, Math.min(wanted, this.opts.priorityFeeMaxMicroLamports));
    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: req.computeUnitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }),
      ...req.instructions,
    ];
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({
      payerKey: req.feePayer.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message(req.lookupTables ?? []);
    const tx = new VersionedTransaction(message);
    tx.sign([req.feePayer, ...req.signers]);
    if (!hasAllSignatures(tx)) throw new Error(`${req.label}: missing a required signer`);
    const serialized = tx.serialize();
    return { signature: bs58.encode(tx.signatures[0]!), lastValidBlockHeight, request: req, serialized };
  }

  async submit(p: PreparedTx): Promise<TxOutcome> {
    if (this.opts.dryRun || !this.opts.liveConfirmed) {
      throw new BlockedError('RpcTxSender refuses to send: DRY_RUN is on or LIVE_CONFIRM is not set', 'not_live');
    }
    try {
      await this.conn.sendRawTransaction(p.serialized, { skipPreflight: false, maxRetries: 0, preflightCommitment: 'confirmed' });
    } catch (err) {
      if (err instanceof SendTransactionError || /simulation failed/i.test(String((err as Error)?.message))) {
        // Rejected (preflight or any other JSON-RPC error). Most likely nothing was broadcast, but behind a
        // load-balanced RPC another node may already have forwarded it (a lagging node answers "Blockhash not
        // found"). Never rebroadcast it (it could land as a failed tx and cost a fee) and never call it `failed`:
        // it stays `unknown`, the caller keeps its reservation and re-checks it until the blockhash has expired.
        return { status: 'unknown', signature: p.signature, feeLamports: 0n, error: `preflight: ${(err as Error).message}` };
      }
      this.opts.log?.warn({ err, sig: p.signature }, 'send error, tx may or may not have been broadcast; polling');
    }
    if (this.opts.afterBroadcast) await this.opts.afterBroadcast(p);
    const started = Date.now();
    for (;;) {
      await this.wait(this.pollMs);
      const st = await this.status(p.signature, p.lastValidBlockHeight);
      if (st.status !== 'unknown') return st;
      if (Date.now() - started > this.maxWaitMs) return st;
      try {
        await this.conn.sendRawTransaction(p.serialized, { skipPreflight: true, maxRetries: 0 });
      } catch {
        // rebroadcast is best effort
      }
    }
  }

  async simulate(p: PreparedTx): Promise<TxOutcome> {
    const tx = VersionedTransaction.deserialize(p.serialized);
    const res = await this.conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
    return {
      status: 'simulated',
      signature: p.signature,
      feeLamports: 0n,
      error: res.value.err ? JSON.stringify(res.value.err) : undefined,
      logs: res.value.logs ?? [],
    };
  }

  /**
   * Balance changes the signed tx would cause, from `simulateTransaction` with the `accounts` option (post state)
   * against the same accounts read just before (pre state). Token amounts are the u64 at byte 64 of the account.
   */
  async simulateEffects(p: PreparedTx, limits: TxLimits): Promise<TxEffects> {
    const solKeys = limits.solOut.map((l) => l.account);
    const tokenKeys = (limits.tokens ?? []).map((t) =>
      getAssociatedTokenAddressSync(new PublicKey(t.mint), new PublicKey(t.owner), true, new PublicKey(t.tokenProgram)).toBase58(),
    );
    const addresses = [...solKeys, ...tokenKeys];
    const pre = await this.conn.getMultipleAccountsInfoAndContext(addresses.map((a) => new PublicKey(a)), 'confirmed');
    const tx = VersionedTransaction.deserialize(p.serialized);
    const res = await this.conn.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
      minContextSlot: pre.context.slot,
      accounts: { encoding: 'base64', addresses },
    });
    if (res.value.err) return { error: JSON.stringify(res.value.err), solDelta: [], tokenDelta: [] };
    const post = res.value.accounts;
    if (!post || post.length !== addresses.length) throw new Error('simulation returned no account states');
    const before = pre.value;
    return {
      solDelta: solKeys.map((_, i) => BigInt(post[i]?.lamports ?? 0) - BigInt(before[i]?.lamports ?? 0)),
      tokenDelta: tokenKeys.map((_, j) => {
        const i = solKeys.length + j;
        const after = post[i] ? Buffer.from(post[i]!.data[0] ?? '', 'base64') : null;
        return tokenAmountOf(after) - tokenAmountOf(before[i]?.data ?? null);
      }),
    };
  }

  async status(signature: string, lastValidBlockHeight: number): Promise<TxOutcome> {
    // Height first: if the blockhash is long expired, any landing already happened and must show in the status check.
    // Slot and height come from one call, and the status answer must come from a node at least at that slot: behind
    // a load-balanced RPC the two calls can reach different nodes, and a lagging one does not know a tx that landed.
    const epoch = await this.conn.getEpochInfo('confirmed');
    const { absoluteSlot } = epoch;
    // blockHeight is optional in the RPC answer: without it, ask for the height (still at least `absoluteSlot` old)
    const height = epoch.blockHeight ?? (await this.conn.getBlockHeight('confirmed'));
    const { context, value } = await this.conn.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const s = value[0];
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) {
      const tx = await this.conn.getTransaction(signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' });
      if (!tx) return { status: 'unknown', signature, feeLamports: 0n };
      const record = normalizeTransaction(tx);
      return {
        status: record.err ? 'failed' : 'confirmed',
        signature,
        feeLamports: record.feeLamports,
        record,
        error: record.err ? JSON.stringify(record.err) : undefined,
        logs: record.logs,
      };
    }
    if (height > lastValidBlockHeight + this.margin && context.slot >= absoluteSlot) return { status: 'expired', signature, feeLamports: 0n };
    return { status: 'unknown', signature, feeLamports: 0n };
  }
}
