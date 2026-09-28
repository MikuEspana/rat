// Claim (every ~35s). One tx signed by the creator: pump.fun claim(s) + WSOL unwrap + transfer of the fund's
// share to the fund wallet (the part HIRE_SPLIT_BPS does not send to hires; none by default, so no transfer). The amount claimed is measured from what left OUR vaults in that tx, so the
// math only uses what was actually claimed (fee-agnostic).
//
// DRY RUN: claims are paper. The paper amount is the growth of the real claimable since the last paper claim
// (so nothing is counted twice) plus DRY_RUN_FAKE_CLAIM_SOL_PER_HOUR for rehearsals.
import { SETTINGS, formatSol, fundShareOf, lamportsToSol, solDelta } from '@rat/core';
import type { ClaimRow } from '@rat/db';
import type { PumpClaimable } from '@rat/pump';
import { SystemProgram, PublicKey } from '@solana/web3.js';
import type { WorkerDeps, WorkerState } from '../deps';

export interface ClaimResult {
  status: 'skipped' | 'claimed' | 'failed' | 'pending' | 'paper';
  claimedLamports: bigint;
  reason?: string;
}

/** Books a confirmed claim (ours or external) into the ledger, the claims table and the event feed. */
export async function creditClaim(
  d: WorkerDeps,
  args: { claimed: bigint; fee: bigint; toFund: bigint; source: 'bot' | 'external'; sig: string | null; claimable?: bigint; claimId?: number },
): Promise<void> {
  const fundShare = fundShareOf(args.claimed, d.config.hireSplitBps);
  const hireShare = args.claimed - fundShare;
  const row = {
    status: d.store.mode === 'paper' ? 'simulated' : 'confirmed',
    sig: args.sig,
    claimedLamports: args.claimed,
    toFundLamports: args.toFund,
    fundShareLamports: fundShare,
    hireShareLamports: hireShare,
    feeLamports: args.fee,
  };
  let claimId = args.claimId;
  if (claimId) await d.store.claims.update(claimId, row);
  else claimId = await d.store.claims.insert({ source: args.source, claimableLamports: args.claimable ?? args.claimed, ...row });
  const ref = { refType: 'claim', refId: String(claimId) };
  if (hireShare > 0n) await d.store.ledger.append({ bucket: 'hire', deltaLamports: hireShare, reason: 'claim_credit', ...ref });
  if (fundShare > 0n) await d.store.ledger.append({ bucket: 'burn', deltaLamports: fundShare, reason: 'claim_credit', ...ref });
  if (args.fee > 0n) await d.store.ledger.append({ bucket: 'hire', deltaLamports: -args.fee, reason: 'claim_fee', ...ref });
  if (args.claimed > 0n) {
    await d.store.events.append({
      type: 'claim',
      txSig: args.sig,
      data: {
        amountSol: lamportsToSol(args.claimed),
        toHiresSol: lamportsToSol(hireShare),
        toFundSol: lamportsToSol(fundShare),
        source: args.source,
      },
    });
  }
  await d.store.settings.set(SETTINGS.lastClaimAt, d.clock.now().toISOString());
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
        await d.store.claims.update(c.id, { status: 'failed', toFundLamports: 0n });
        continue;
      }
      await d.store.claims.update(c.id, { sig: sent.signature });
      c = { ...c, sig: sent.signature };
    }
    const sig = c.sig!;
    const attempt = await d.store.attempts.bySignature(sig);
    if (!attempt) {
      // cannot be checked, and an open claim blocks new ones: close it (unbooked income is the safe direction)
      await d.store.claims.update(c.id, { status: 'failed', toFundLamports: 0n });
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
        toFund: c.toFundLamports,
        source: 'bot',
        sig: c.sig,
        claimId: c.id,
      });
    } else if (st.status === 'failed' || st.status === 'expired') {
      await d.store.claims.update(c.id, { status: st.status, toFundLamports: 0n });
      if (st.record) await d.store.ledger.append({ bucket: 'hire', deltaLamports: -st.record.feeLamports, reason: 'claim_fee', refType: 'claim', refId: String(c.id) });
    }
  }
}

export async function runClaimStep(d: WorkerDeps, s: WorkerState): Promise<ClaimResult> {
  const kill = await d.killSwitch.status();
  if (kill.on) return { status: 'skipped', claimedLamports: 0n, reason: 'kill_switch' };
  if (d.store.mode === 'paper') return runPaperClaim(d, s);

  await reconcileOpenClaims(d);
  // A claim that may still land would forward the same fund share twice: wait until it lands or expires.
  if ((await openBotClaims(d)).length > 0) return { status: 'skipped', claimedLamports: 0n, reason: 'previous claim unresolved' };
  const claimable = (await d.pump.getClaimable(d.creator)) as PumpClaimable;
  const owed = await d.store.claims.pendingFundTransfer();
  const worthClaiming = claimable.totalLamports >= d.config.minClaimLamports;
  const worthForwarding = owed >= d.config.minBurnLamports;
  if (!worthClaiming && !worthForwarding && claimable.creatorWsolLamports === 0n) {
    return { status: 'skipped', claimedLamports: 0n, reason: 'nothing to claim' };
  }
  const readable = worthClaiming ? claimable : { ...claimable, bondingLamports: 0n, ammLamports: 0n, totalLamports: 0n };
  const toFund = fundShareOf(readable.totalLamports, d.config.hireSplitBps) + owed;
  const creatorKp = await d.keys.creator();
  const ixs = d.pump.buildClaimInstructions({ creator: d.creator, claimable: readable });
  if (toFund > 0n) {
    ixs.push(SystemProgram.transfer({ fromPubkey: creatorKp.publicKey, toPubkey: new PublicKey(d.fund), lamports: toFund }));
  }
  if (ixs.length === 0) return { status: 'skipped', claimedLamports: 0n, reason: 'nothing to do' };

  const claimId = await d.store.claims.insert({
    source: 'bot',
    status: 'pending',
    claimableLamports: readable.totalLamports,
    toFundLamports: toFund,
  });
  const r = await d.sender.execute({
    request: {
      kind: 'claim',
      label: `claim #${claimId}`,
      feePayer: creatorKp,
      signers: [],
      instructions: ixs,
      computeUnitLimit: d.config.computeUnitLimitClaim,
      // the claim pays in; the creator may only lose what it already owes the fund, plus fees
      limits: { solOut: [{ account: d.creator, maxLamports: owed + d.config.hireOverheadEstLamports }] },
    },
    ref: { type: 'claim', id: String(claimId) },
  });
  if (r.status !== 'done') {
    await d.store.claims.update(claimId, { status: 'failed', toFundLamports: 0n });
    return { status: 'failed', claimedLamports: 0n, reason: r.reason };
  }
  const out = r.outcome;
  await d.store.claims.update(claimId, { sig: out.signature });
  if (out.status === 'confirmed' && out.record) {
    const m = d.pump.parseClaim(out.record, d.creator);
    const claimed = m?.totalLamports ?? 0n;
    await creditClaim(d, { claimed, fee: out.record.feeLamports, toFund, source: 'bot', sig: out.signature, claimId });
    d.log.info({ claimed: formatSol(claimed), toFund: formatSol(toFund), sig: out.signature }, 'claimed');
    return { status: 'claimed', claimedLamports: claimed };
  }
  if (out.status === 'unknown') {
    await d.store.claims.update(claimId, { status: 'unknown' });
    return { status: 'pending', claimedLamports: 0n, reason: 'confirmation pending' };
  }
  await d.store.claims.update(claimId, { status: out.status === 'expired' ? 'expired' : 'failed', toFundLamports: 0n });
  if (out.record) {
    // landed with an error: only the fee was spent (paid from the hire bucket)
    const fee = -solDelta(out.record, d.creator) > 0n ? out.record.feeLamports : 0n;
    if (fee > 0n) await d.store.ledger.append({ bucket: 'hire', deltaLamports: -fee, reason: 'claim_fee', refType: 'claim', refId: String(claimId) });
  }
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
    const toFund = fundShareOf(claimable.totalLamports, d.config.hireSplitBps);
    if (toFund > 0n) ixs.push(SystemProgram.transfer({ fromPubkey: creatorKp.publicKey, toPubkey: new PublicKey(d.fund), lamports: toFund }));
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
  const fundShare = fundShareOf(claimed, d.config.hireSplitBps);
  await creditClaim(d, { claimed, fee: 0n, toFund: fundShare, source: 'bot', sig, claimable: claimed });
  return { status: 'paper', claimedLamports: claimed };
}
