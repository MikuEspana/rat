// TxSender over SimChain with failure injection. In-memory only.
import type { PreparedTx, TxKind, TxOutcome, TxRequest, TxSender } from '@rat/core';
import { ComputeBudgetProgram } from '@solana/web3.js';
import type { SimChain } from './sim-chain';

/**
 * drop:          never lands, blockhash expires
 * fail:          lands with an on-chain error (fee charged, no effect)
 * land_timeout:  lands, but submit() reports `unknown` (a later status() shows it confirmed)
 * reject:        preflight rejects it (not broadcast, no fee)
 */
export type FailureMode = 'drop' | 'fail' | 'land_timeout' | 'reject';

interface Injection {
  mode: FailureMode;
  match: (req: TxRequest) => boolean;
  remaining: number;
}

export class SimTxSender implements TxSender {
  private readonly injections: Injection[] = [];
  private readonly prepared = new Map<string, TxRequest>();
  /** number of submit() calls that reached the chain (for assertions) */
  submitted = 0;
  simulated = 0;

  constructor(
    private readonly chain: SimChain,
    private readonly opts: { validBlocks?: number } = {},
  ) {}

  failNext(mode: FailureMode, match: TxKind | ((req: TxRequest) => boolean) = () => true, times = 1): void {
    const fn = typeof match === 'function' ? match : (req: TxRequest) => req.kind === match;
    this.injections.push({ mode, match: fn, remaining: times });
  }

  private takeInjection(req: TxRequest): FailureMode | null {
    const inj = this.injections.find((i) => i.remaining > 0 && i.match(req));
    if (!inj) return null;
    inj.remaining -= 1;
    return inj.mode;
  }

  private spec(p: PreparedTx) {
    const req = p.request;
    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: req.computeUnitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: req.computeUnitPriceMicroLamports ?? 0 }),
      ...req.instructions,
    ];
    return {
      signature: p.signature,
      feePayer: req.feePayer.publicKey.toBase58(),
      signers: [req.feePayer, ...req.signers].map((s) => s.publicKey.toBase58()),
      instructions,
    };
  }

  async prepare(req: TxRequest): Promise<PreparedTx> {
    const signature = this.chain.newSignature();
    this.prepared.set(signature, req);
    return {
      signature,
      lastValidBlockHeight: this.chain.blockHeight + (this.opts.validBlocks ?? 150),
      request: req,
      serialized: new Uint8Array(0),
    };
  }

  async submit(p: PreparedTx): Promise<TxOutcome> {
    this.submitted += 1;
    const mode = this.takeInjection(p.request);
    if (mode === 'reject') {
      return { status: 'failed', signature: p.signature, feeLamports: 0n, error: 'preflight: injected rejection' };
    }
    if (mode === 'drop') {
      this.chain.advanceBlocks(p.lastValidBlockHeight - this.chain.blockHeight + 1);
      return { status: 'expired', signature: p.signature, feeLamports: 0n };
    }
    const res = this.chain.execute(this.spec(p), { mutate: true, forceError: mode === 'fail' ? 'injected on-chain failure' : undefined });
    if (!res.landed) return { status: 'failed', signature: p.signature, feeLamports: 0n, error: `preflight: ${res.reason}` };
    const r = res.record;
    if (mode === 'land_timeout') return { status: 'unknown', signature: p.signature, feeLamports: 0n };
    return {
      status: r.err ? 'failed' : 'confirmed',
      signature: p.signature,
      feeLamports: r.feeLamports,
      record: r,
      error: r.err ? JSON.stringify(r.err) : undefined,
      logs: r.logs,
    };
  }

  async simulate(p: PreparedTx): Promise<TxOutcome> {
    this.simulated += 1;
    const res = this.chain.execute(this.spec(p), { mutate: false });
    if (!res.landed) return { status: 'simulated', signature: p.signature, feeLamports: 0n, error: res.reason };
    return {
      status: 'simulated',
      signature: p.signature,
      feeLamports: res.record.feeLamports,
      record: res.record,
      error: res.record.err ? JSON.stringify(res.record.err) : undefined,
      logs: res.record.logs,
    };
  }

  async status(signature: string, lastValidBlockHeight: number): Promise<TxOutcome> {
    const r = this.chain.transaction(signature);
    if (r) {
      return {
        status: r.err ? 'failed' : 'confirmed',
        signature,
        feeLamports: r.feeLamports,
        record: r,
        error: r.err ? JSON.stringify(r.err) : undefined,
      };
    }
    if (this.chain.blockHeight > lastValidBlockHeight) return { status: 'expired', signature, feeLamports: 0n };
    return { status: 'unknown', signature, feeLamports: 0n };
  }
}
