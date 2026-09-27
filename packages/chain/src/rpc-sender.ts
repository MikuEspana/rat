// THE ONLY FILE ALLOWED TO SEND TRANSACTIONS (enforced by scripts/check-guards.mjs).
//
// Refuses to send unless DRY_RUN=false AND LIVE_CONFIRM matched the exact phrase (config.liveConfirmed).
// The GuardedSender in @rat/safety adds the kill switch, spend reservations and the attempt log on top.
// Optional Jito route (BURN_SEND_VIA=jito): chosen tx kinds go to the Jito block engine as bundle-only
// transactions (JSON-RPC sendTransaction on /transactions?bundleOnly=true, base64), never to a public RPC.
// Request shape from Jito's official client (github.com/jito-labs/jito-js-rpc src/index.ts).
import { BlockedError, type Logger, type PreparedTx, type TxKind, type TxOutcome, type TxRequest, type TxSender, sleep } from '@rat/core';
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
  | 'getTransaction'
  | 'simulateTransaction'
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
  /** send these tx kinds through the Jito block engine instead of the RPC */
  jito?: JitoRoute;
}

export interface JitoRoute {
  /** e.g. https://mainnet.block-engine.jito.wtf/api/v1 */
  url: string;
  kinds: TxKind[];
  /** rebroadcast at most this often while waiting (Jito rate limits per IP) */
  rebroadcastMs?: number;
  fetch?: typeof fetch;
}

const DEFAULT_PRIORITY_FALLBACK = 10_000;

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

  /** POSTs the signed tx to the Jito block engine as a bundle-only transaction. Throws on any error. */
  private async jitoBroadcast(route: JitoRoute, p: PreparedTx): Promise<void> {
    const res = await (route.fetch ?? fetch)(`${route.url}/transactions?bundleOnly=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendTransaction',
        params: [Buffer.from(p.serialized).toString('base64'), { encoding: 'base64' }],
      }),
    });
    const body = (await res.json().catch(() => null)) as { result?: string; error?: { message?: string } } | null;
    if (!res.ok || !body || body.error) throw new Error(`jito ${res.status}: ${body?.error?.message ?? 'bad response'}`);
    if (body.result && body.result !== p.signature) this.opts.log?.warn({ got: body.result, sig: p.signature }, 'jito returned a different signature');
  }

  async submit(p: PreparedTx): Promise<TxOutcome> {
    if (this.opts.dryRun || !this.opts.liveConfirmed) {
      throw new BlockedError('RpcTxSender refuses to send: DRY_RUN is on or LIVE_CONFIRM is not set', 'not_live');
    }
    const jito = this.opts.jito && this.opts.jito.kinds.includes(p.request.kind) ? this.opts.jito : null;
    if (jito) {
      try {
        await this.jitoBroadcast(jito, p);
      } catch (err) {
        // Never falls back to a public send. It may or may not have been forwarded: poll until it lands or expires.
        this.opts.log?.warn({ err, sig: p.signature }, 'jito send error; polling until the blockhash expires');
      }
    } else {
      try {
        await this.conn.sendRawTransaction(p.serialized, { skipPreflight: false, maxRetries: 0, preflightCommitment: 'confirmed' });
      } catch (err) {
        if (err instanceof SendTransactionError || /simulation failed/i.test(String((err as Error)?.message))) {
          // Preflight rejected it: the transaction was not broadcast, so it cannot land.
          return { status: 'failed', signature: p.signature, feeLamports: 0n, error: `preflight: ${(err as Error).message}` };
        }
        this.opts.log?.warn({ err, sig: p.signature }, 'send error, tx may or may not have been broadcast; polling');
      }
    }
    const started = Date.now();
    let lastRebroadcast = started;
    for (;;) {
      await this.wait(this.pollMs);
      const st = await this.status(p.signature, p.lastValidBlockHeight);
      if (st.status !== 'unknown') return st;
      if (Date.now() - started > this.maxWaitMs) return st;
      try {
        if (!jito) await this.conn.sendRawTransaction(p.serialized, { skipPreflight: true, maxRetries: 0 });
        else if (Date.now() - lastRebroadcast >= (jito.rebroadcastMs ?? 10_000)) {
          lastRebroadcast = Date.now();
          await this.jitoBroadcast(jito, p);
        }
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

  async status(signature: string, lastValidBlockHeight: number): Promise<TxOutcome> {
    // Height first: if the blockhash is long expired, any landing already happened and must show in the status check.
    const height = await this.conn.getBlockHeight('confirmed');
    const { value } = await this.conn.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const s = value[0];
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) {
      const tx = await this.conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
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
    if (height > lastValidBlockHeight + this.margin) return { status: 'expired', signature, feeLamports: 0n };
    return { status: 'unknown', signature, feeLamports: 0n };
  }
}
