// Claim (every ~35s). One tx signed by the creator: pump.fun claim(s) + WSOL unwrap. Every claimed lamport is
// credited to the hire bucket (there is no other spending). The amount claimed is measured from what left OUR
// vaults in that tx, so the math only uses what was actually claimed (fee-agnostic).
//
// DRY RUN: claims are paper. The paper amount is the growth of the real claimable since the last paper claim
// (so nothing is counted twice) plus DRY_RUN_FAKE_CLAIM_SOL_PER_HOUR for rehearsals.
import { SETTINGS, formatSol, lamportsToSol, solDelta } from '@rat/core';
import type { ClaimRow } from '@rat/db';
import type { PumpClaimable } from '@rat/pump';
import type { WorkerDeps, WorkerState } from '../deps';

export interface ClaimResult {
  status: 'skipped' | 'claimed' | 'failed' | 'pending' | 'paper';
  claimedLamports: bigint;
  reason?: string;
}

/**
 * Books a confirmed claim (ours or external) into the ledger, the claims table and the event feed, in one database
 * transaction: a crash never leaves a claim row without its credit. An external claim already booked (a retry after
 * a crash) is not booked again. Returns false when nothing was booked.
 */
export async function creditClaim(
  d: WorkerDeps,
  args: { claimed: bigint; fee: bigint; source: 'bot' | 'external'; sig: string | null; claimable?: bigint; claimId?: number },
): Promise<boolean> {
  return d.store.transaction(async (store) => {
    if (args.source === 'external' && args.sig && (await store.claims.bySig(args.sig))) return false;
    return bookClaim({ ...d, store }, args);
  });
}

/** A failed or expired bot claim: closed once, with the fee of a tx that landed with an error. */
async function closeFailedClaim(d: WorkerDeps, claimId: number, status: 'failed' | 'expired', feeLamports: bigint): Promise<void> {
  await d.store.transaction(async (store) => {
    if (!(await store.claims.closeOpen(claimId, { status }))) return; // another worker closed it already
    if (feeLamports > 0n) await store.ledger.append({ bucket: 'hire', deltaLamports: -feeLamports, reason: 'claim_fee', refType: 'claim', refId: String(claimId) });
  });
}

async function bookClaim(
  d: Pick<WorkerDeps, 'store' | 'clock'>,
  args: { claimed: bigint; fee: bigint; source: 'bot' | 'external'; sig: string | null; claimable?: bigint; claimId?: number },
): Promise<boolean> {
  const row = {
    status: d.store.mode === 'paper' ? ('simulated' as const) : ('confirmed' as const),
    sig: args.sig,
    claimedLamports: args.claimed,
    hireShareLamports: args.claimed,
    feeLamports: args.fee,
  };
  let claimId = args.claimId;
  // a bot claim is booked only while it is still open: a second worker (redeploy overlap) books nothing
  if (claimId) {
    if (!(await d.store.claims.closeOpen(claimId, row))) return false;
  } else claimId = await d.store.claims.insert({ source: args.source, claimableLamports: args.claimable ?? args.claimed, ...row });
  const ref = { refType: 'claim', refId: String(claimId) };
  if (args.claimed > 0n) await d.store.ledger.append({ bucket: 'hire', deltaLamports: args.claimed, reason: 'claim_credit', ...ref });
  if (args.fee > 0n) await d.store.ledger.append({ bucket: 'hire', deltaLamports: -args.fee, reason: 'claim_fee', ...ref });
  if (args.claimed > 0n) {
    await d.store.events.append({
      type: 'claim',
      txSig: args.sig,
      data: {
        amountSol: lamportsToSol(args.claimed),
        source: args.source,
      },
    });
  }
  await d.store.settings.set(SETTINGS.lastClaimAt, d.clock.now().toISOString());
  return true;
}

function openBotClaims(d: WorkerDeps): Promise<ClaimRow[]> {
  return d.store.claims.openBot();
}

/** Re-checks claims whose tx status was unknown (they may have landed later). */
async function reconcileOpenClaims(d: WorkerDeps): Promise<void> {
  for (let c of await openBotClaims(d)) {
    if (!c.sig) {
      // Crash between "attempt written" and "claim row updated": the attempt log knows the signature.
      const sent = await d.store.attempts.latestForRef('claim', String(c.id));
      if (!sent) {
        await d.store.claims.closeOpen(c.id, { status: 'failed' });
        continue;
      }
      await d.store.claims.update(c.id, { sig: sent.signature });
      c = { ...c, sig: sent.signature };
    }
    const sig = c.sig!;
    const attempt = await d.store.attempts.bySignature(sig);
    if (!attempt) {
      // cannot be checked, and an open claim blocks new ones: close it (unbooked income is the safe direction)
      if (!(await d.store.claims.closeOpen(c.id, { status: 'failed' }))) continue;
      await d.alerts.send('warn', `claim_unverifiable_${c.id}`, `Claim #${c.id} (${sig}) has no attempt record; marked failed. Check it on Solscan.`);
      continue;
    }
    const st = await d.sender.status(sig, attempt.lastValidBlockHeight);
    await d.store.attempts.finish(attempt.id, { status: st.status, error: st.error, feeLamports: st.feeLamports });
    if (st.status === 'confirmed' && st.record) {
      const m = d.pump.parseClaim(st.record, d.creator);
      await creditClaim(d, {
        claimed: m?.totalLamports ?? 0n,
        fee: st.record.feeLamports,
        source: 'bot',
        sig: c.sig,
        claimId: c.id,
      });
    } else if (st.status === 'failed' || st.status === 'expired') {
      await closeFailedClaim(d, c.id, st.status, st.record?.feeLamports ?? 0n);
    }
  }
}

export async function runClaimStep(d: WorkerDeps, s: WorkerState): Promise<ClaimResult> {
  // A claim sent before the kill switch went on may still land: book it even while killed (a status read and
  // bookkeeping, nothing is sent). The wallet watch skips our own signatures, so nothing else would book it.
  if (d.store.mode === 'live') await reconcileOpenClaims(d);
  const kill = await d.killSwitch.status();
  if (kill.on) return { status: 'skipped', claimedLamports: 0n, reason: 'kill_switch' };
  if (d.store.mode === 'paper') return runPaperClaim(d, s);

  // One claim at a time: a claim that may still land is resolved before the next one is sent.
  if ((await openBotClaims(d)).length > 0) return { status: 'skipped', claimedLamports: 0n, reason: 'previous claim unresolved' };
  const claimable = (await d.pump.getClaimable(d.creator)) as PumpClaimable;
  const worthClaiming = claimable.totalLamports >= d.config.minClaimLamports;
  if (!worthClaiming && claimable.creatorWsolLamports === 0n) {
    return { status: 'skipped', claimedLamports: 0n, reason: 'nothing to claim' };
  }
  const readable = worthClaiming ? claimable : { ...claimable, bondingLamports: 0n, ammLamports: 0n, totalLamports: 0n };
  const creatorKp = await d.keys.creator();
  const ixs = d.pump.buildClaimInstructions({ creator: d.creator, claimable: readable });
  if (ixs.length === 0) return { status: 'skipped', claimedLamports: 0n, reason: 'nothing to do' };

  const claimId = await d.store.claims.insert({
    source: 'bot',
    status: 'pending',
    claimableLamports: readable.totalLamports,
  });
  const r = await d.sender.execute({
    request: {
      kind: 'claim',
      label: `claim #${claimId}`,
      feePayer: creatorKp,
      signers: [],
      instructions: ixs,
      computeUnitLimit: d.config.computeUnitLimitClaim,
      // the claim only pays in: the creator may lose no more than the fees
      limits: { solOut: [{ account: d.creator, maxLamports: d.config.hireOverheadEstLamports }] },
    },
    ref: { type: 'claim', id: String(claimId) },
  });
  if (r.status !== 'done') {
    await d.store.claims.closeOpen(claimId, { status: 'failed' });
    return { status: 'failed', claimedLamports: 0n, reason: r.reason };
  }
  const out = r.outcome;
  await d.store.claims.update(claimId, { sig: out.signature });
  if (out.status === 'confirmed' && out.record) {
    const m = d.pump.parseClaim(out.record, d.creator);
    const claimed = m?.totalLamports ?? 0n;
    await creditClaim(d, { claimed, fee: out.record.feeLamports, source: 'bot', sig: out.signature, claimId });
    d.log.info({ claimed: formatSol(claimed), sig: out.signature }, 'claimed');
    return { status: 'claimed', claimedLamports: claimed };
  }
  if (out.status === 'unknown') {
    // only from pending: a claim another worker already booked is never reopened
    await d.store.claims.closeOpen(claimId, { status: 'unknown' }, ['pending']);
    return { status: 'pending', claimedLamports: 0n, reason: 'confirmation pending' };
  }
  // landed with an error: only the fee was spent (paid from the hire bucket)
  const fee = out.record && -solDelta(out.record, d.creator) > 0n ? out.record.feeLamports : 0n;
  await closeFailedClaim(d, claimId, out.status === 'expired' ? 'expired' : 'failed', fee);
  await d.alerts.send('warn', 'claim_failed', `claim ${out.status}: ${out.error ?? ''}`);
  return { status: 'failed', claimedLamports: 0n, reason: out.error };
}

async function runPaperClaim(d: WorkerDeps, s: WorkerState): Promise<ClaimResult> {
  const nowMs = d.clock.now().getTime();
  const claimable = (await d.pump.getClaimable(d.creator)) as PumpClaimable;
  const watermarkRaw = await d.store.settings.get(SETTINGS.paperClaimWatermark);
  let watermark = watermarkRaw ? BigInt(watermarkRaw) : 0n;
  // Someone really claimed (or the vault shrank): restart counting from the current level.
  if (claimable.totalLamports < watermark) {
    watermark = claimable.totalLamports;
    await d.store.settings.set(SETTINGS.paperClaimWatermark, watermark.toString());
  }
  const real = claimable.totalLamports - watermark;
  if (d.config.dryRunFakeClaimLamportsPerHour > 0n && s.lastPaperClaimAt !== null) {
    s.paperFakeAccrued += (d.config.dryRunFakeClaimLamportsPerHour * BigInt(nowMs - s.lastPaperClaimAt)) / 3_600_000n;
  }
  s.lastPaperClaimAt = nowMs;
  const claimed = real + s.paperFakeAccrued;
  if (claimed < d.config.minClaimLamports) return { status: 'skipped', claimedLamports: 0n, reason: 'under minimum' };

  // Simulate the real claim tx when there is something real to claim (proves the instructions build and simulate).
  let sig: string | null = null;
  if (real > 0n) {
    const creatorKp = await d.keys.creator();
    const ixs = d.pump.buildClaimInstructions({ creator: d.creator, claimable });
    const r = await d.sender.execute({
      request: { kind: 'claim', label: 'paper claim', feePayer: creatorKp, signers: [], instructions: ixs, computeUnitLimit: d.config.computeUnitLimitClaim },
      ref: { type: 'claim', id: 'paper' },
    });
    if (r.status === 'done') {
      sig = r.outcome.signature;
      if (r.outcome.error) d.log.debug({ err: r.outcome.error }, 'paper claim simulation error (ignored for paper accounting)');
    }
  }
  await d.store.settings.set(SETTINGS.paperClaimWatermark, claimable.totalLamports.toString());
  s.paperFakeAccrued = 0n;
  await creditClaim(d, { claimed, fee: 0n, source: 'bot', sig, claimable: claimed });
  return { status: 'paper', claimedLamports: claimed };
}
