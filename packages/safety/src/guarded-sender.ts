// GuardedSender: the path every transaction takes.
//   - kill switch on: nothing is prepared or sent (the emergency `sweep` kind is the only exception)
//   - hire / burn need a spend reservation from the SpendGuard
//   - live claim / hire / burn: the signed tx is simulated first and refused if it would break its spend limits
//     (TxRequest.limits), so instructions from an outside API can never drain a wallet
//   - lease fence: a worker that lost the single-worker lease sends nothing
//   - every attempt is written to the database BEFORE it is sent (signature + last valid block height)
//   - a send that throws after the attempt was written counts as `unknown` (it may still land), never as "not sent"
//   - DRY RUN: simulate only, never submit
import {
  type Alerts,
  type AttemptStore,
  BlockedError,
  type KillSwitch,
  type Logger,
  type PreparedTx,
  SPENDING_TX_KINDS,
  type TxOutcome,
  type TxRequest,
  type TxSender,
  type TxStatus,
} from '@rat/core';
import { LIMITED_TX_KINDS, limitViolations } from './effects';
import type { Reservation } from './spend-guard';

export type GuardedResult =
  | { status: 'blocked'; reason: string }
  | { status: 'error'; reason: string }
  | { status: 'done'; outcome: TxOutcome; prepared: PreparedTx; attemptId: number };

export interface GuardedSenderDeps {
  attempts: AttemptStore;
  killSwitch: KillSwitch;
  dryRun: boolean;
  log?: Logger;
  alerts?: Alerts;
  /** false = this process no longer holds the single-worker lease: nothing is sent */
  fence?: () => Promise<boolean>;
}

export class GuardedSender {
  constructor(
    private readonly inner: TxSender,
    private readonly deps: GuardedSenderDeps,
  ) {}

  get dryRun(): boolean {
    return this.deps.dryRun;
  }

  /** Wired after construction: the worker's lease runner is created after the sender. */
  setFence(fence: () => Promise<boolean>): void {
    this.deps.fence = fence;
  }

  private async checkEffects(request: TxRequest, prepared: PreparedTx): Promise<string | null> {
    if (!request.limits) return `a live ${request.kind} transaction needs spend limits`;
    let effects;
    try {
      effects = await this.inner.simulateEffects(prepared, request.limits);
    } catch (err) {
      return `effects_check: simulation unavailable: ${(err as Error).message}`;
    }
    if (effects.error) return `effects_check: simulation failed: ${effects.error}`;
    const bad = limitViolations(request.limits, effects);
    if (bad.length === 0) return null;
    await this.deps.alerts?.send(
      'critical',
      `effects_${request.kind}`,
      `Refused to send "${request.label}": ${bad.join('; ')}. Nothing was sent. If this repeats, check the Jupiter API responses and the fee settings (HIRE_OVERHEAD_EST_SOL).`,
    );
    return `effects_check: ${bad.join('; ')}`;
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
    if (!this.deps.dryRun && LIMITED_TX_KINDS.includes(request.kind)) {
      const refused = await this.checkEffects(request, prepared);
      if (refused) {
        this.deps.log?.warn({ label: request.label, reason: refused }, 'tx refused by the effects check');
        return { status: 'blocked', reason: refused };
      }
    }
    if (this.deps.fence && !(await this.deps.fence())) {
      return { status: 'blocked', reason: 'lease_lost: another worker holds the worker lease' };
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
      const message = (err as Error).message;
      if (this.deps.dryRun || err instanceof BlockedError) {
        // Nothing was broadcast: a simulation, or the sender refused before sending.
        await this.deps.attempts.finish(attemptId, { status: 'failed', error: message });
        return { status: 'error', reason: `submit failed: ${message}` };
      }
      // It may have been broadcast (for example the RPC failed while we waited for confirmation). Treat it as
      // `unknown`: callers keep the reservation and re-check the signature until it lands or expires.
      await this.deps.attempts.finish(attemptId, { status: 'unknown', error: message });
      this.deps.log?.error({ err, sig: prepared.signature, label: request.label }, 'submit threw; status unknown');
      return { status: 'done', outcome: { status: 'unknown', signature: prepared.signature, feeLamports: 0n, error: message }, prepared, attemptId };
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
