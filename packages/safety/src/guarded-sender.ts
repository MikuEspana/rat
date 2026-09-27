// GuardedSender: the path every transaction takes.
//   - kill switch on: nothing is prepared or sent (the emergency `sweep` kind is the only exception)
//   - hire / burn need a spend reservation from the SpendGuard
//   - every attempt is written to the database BEFORE it is sent (signature + last valid block height)
//   - DRY RUN: simulate only, never submit
import {
  type AttemptStore,
  type KillSwitch,
  type Logger,
  type PreparedTx,
  SPENDING_TX_KINDS,
  type TxOutcome,
  type TxRequest,
  type TxSender,
  type TxStatus,
} from '@rat/core';
import type { Reservation } from './spend-guard';

export type GuardedResult =
  | { status: 'blocked'; reason: string }
  | { status: 'error'; reason: string }
  | { status: 'done'; outcome: TxOutcome; prepared: PreparedTx; attemptId: number };

export class GuardedSender {
  constructor(
    private readonly inner: TxSender,
    private readonly deps: { attempts: AttemptStore; killSwitch: KillSwitch; dryRun: boolean; log?: Logger },
  ) {}

  get dryRun(): boolean {
    return this.deps.dryRun;
  }

  async execute(args: { request: TxRequest; reservation?: Reservation; ref: { type: string; id: string } }): Promise<GuardedResult> {
    const { request, reservation, ref } = args;
    if (request.kind !== 'sweep') {
      const kill = await this.deps.killSwitch.status();
      if (kill.on) return { status: 'blocked', reason: `kill_switch: ${kill.reason}` };
    }
    if (SPENDING_TX_KINDS.includes(request.kind) && !reservation) {
      return { status: 'blocked', reason: `a ${request.kind} transaction needs a spend reservation` };
    }
    let prepared: PreparedTx;
    try {
      prepared = await this.inner.prepare(request);
    } catch (err) {
      return { status: 'error', reason: `prepare failed: ${(err as Error).message}` };
    }
    const attemptId = await this.deps.attempts.create({
      kind: request.kind,
      refType: ref.type,
      refId: ref.id,
      signature: prepared.signature,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
    });
    let outcome: TxOutcome;
    try {
      outcome = this.deps.dryRun ? await this.inner.simulate(prepared) : await this.inner.submit(prepared);
    } catch (err) {
      // Submission threw before we learned anything: status unknown, the attempt stays checkable by signature.
      await this.deps.attempts.finish(attemptId, { status: 'unknown', error: (err as Error).message });
      this.deps.log?.error({ err, sig: prepared.signature, label: request.label }, 'submit threw');
      return { status: 'error', reason: `submit failed: ${(err as Error).message}` };
    }
    await this.deps.attempts.finish(attemptId, {
      status: outcome.status as TxStatus,
      error: outcome.error,
      feeLamports: outcome.feeLamports,
    });
    this.deps.log?.info({ sig: outcome.signature, status: outcome.status, label: request.label, dryRun: this.deps.dryRun }, 'tx');
    return { status: 'done', outcome, prepared, attemptId };
  }

  /** Re-checks an earlier attempt (retries must never start while an attempt can still land). */
  status(signature: string, lastValidBlockHeight: number): Promise<TxOutcome> {
    return this.inner.status(signature, lastValidBlockHeight);
  }
}
