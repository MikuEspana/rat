// Wallet watch (live only). Looks at every new signature on the creator and fund wallets that the bot did
// not send itself (owner decision #7):
//  - a pump.fun claim of OUR creator vault (anyone can trigger one): credited and split 50/50 like our own;
//    the fund's share is owed and rides in our next claim tx
//  - any other SOL that arrives: alert, left unspent (never credited to the ledger)
//  - a transaction SIGNED by our creator or fund that we did not send: critical alert + kill switch
import { SETTINGS, formatSol, solDelta } from '@rat/core';
import { engageKillSwitch } from '@rat/safety';
import type { WorkerDeps } from '../deps';
import { creditClaim } from './claim';

export interface WatchResult {
  externalClaims: number;
  unexplainedInflows: number;
  unknownSigned: number;
}

async function watchWallet(d: WorkerDeps, role: 'creator' | 'fund', res: WatchResult): Promise<void> {
  const wallet = role === 'creator' ? d.creator : d.fund;
  const cursorKey = role === 'creator' ? SETTINGS.creatorWatchCursor : SETTINGS.fundWatchCursor;
  // null = never ran. '' = ran while the wallet had no history (process everything that comes).
  const cursor = await d.store.settings.get(cursorKey);
  const sigs = await d.chain.getSignaturesSince(wallet, cursor || null, 1000);
  if (cursor === null) {
    // First run: start watching from now; history before the bot started is not ours to book.
    await d.store.settings.set(cursorKey, sigs[0]?.signature ?? '');
    return;
  }
  if (sigs.length === 0) return;
  const unseen = new Set(await d.store.seen.unseen(sigs.map((s) => s.signature)));
  const ours = await d.store.attempts.signaturesKnown(sigs.map((s) => s.signature));
  const now = d.clock.now();
  // If a record is not visible yet (RPC indexing lag), keep the cursor where it was: the seen table stops
  // anything already booked from being booked twice, and the missing one is retried next loop.
  let incomplete = false;
  for (const info of [...sigs].reverse()) {
    const sig = info.signature;
    if (!unseen.has(sig)) continue;
    if (ours.has(sig)) {
      await d.store.seen.add(sig, wallet, 'ours', now);
      continue;
    }
    const record = await d.chain.getTransactionRecord(sig);
    if (!record) {
      incomplete = true;
      continue;
    }
    if (record.err) {
      await d.store.seen.add(sig, wallet, 'failed_other', now);
      continue;
    }
    if (record.signers.includes(wallet)) {
      res.unknownSigned++;
      await d.store.seen.add(sig, wallet, 'outflow_unknown', now);
      await engageKillSwitch(d.store.settings, `unknown transaction signed by the ${role} wallet: ${sig}`);
      await d.alerts.send('critical', `unknown_signed_${sig}`, `A transaction signed by the ${role} wallet was NOT sent by the bot: ${sig}. Kill switch engaged. Check for a key leak.`);
      continue;
    }
    if (role === 'creator') {
      const claim = d.pump.parseClaim(record, d.creator);
      if (claim && claim.totalLamports > 0n) {
        res.externalClaims++;
        await creditClaim(d, { claimed: claim.totalLamports, fee: 0n, toFund: 0n, source: 'external', sig });
        await d.store.seen.add(sig, wallet, 'external_claim', now);
        await d.alerts.send('info', `external_claim_${sig}`, `External claim of our creator fees (${formatSol(claim.totalLamports)} SOL) booked and split 50/50: ${sig}`);
        continue;
      }
    }
    const delta = solDelta(record, wallet);
    if (delta > 0n) {
      res.unexplainedInflows++;
      await d.store.seen.add(sig, wallet, 'inflow', now);
      await d.alerts.send('warn', `inflow_${sig}`, `${formatSol(delta)} SOL arrived in the ${role} wallet from an unknown source (${sig}). Left unspent.`);
      continue;
    }
    await d.store.seen.add(sig, wallet, 'other', now);
  }
  if (!incomplete) await d.store.settings.set(cursorKey, sigs[0]!.signature);
}

export async function runWatchStep(d: WorkerDeps): Promise<WatchResult> {
  const res: WatchResult = { externalClaims: 0, unexplainedInflows: 0, unknownSigned: 0 };
  if (d.store.mode === 'paper') return res;
  await watchWallet(d, 'creator', res);
  await watchWallet(d, 'fund', res);
  return res;
}
