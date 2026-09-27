// Wallet watch (live only). Looks at every new signature on the creator and fund wallets that the bot did
// not send itself (owner decision #7):
//  - a pump.fun claim of OUR creator vault (anyone can trigger one): credited and split 50/50 like our own;
//    the fund's share is owed and rides in our next claim tx
//  - any other SOL that arrives: alert, left unspent (never credited to the ledger)
//  - a transaction SIGNED by our creator or fund that we did not send: critical alert + kill switch
// Owner transactions are not attacks:
//  - nothing before the watch floor is ever looked at: WATCH_FROM_SLOT (set it right after the coin launch), else
//    the slot of the worker's first live run (stored once). This also covers a launch tx that the RPC indexes late.
//  - signatures in KNOWN_OWNER_TX_SIGS (the launch, a manual transfer) are accepted instead of engaging the kill switch.
import { SETTINGS, formatSol, solDelta } from '@rat/core';
import { engageKillSwitch } from '@rat/safety';
import type { WorkerDeps } from '../deps';
import { creditClaim } from './claim';

export interface WatchResult {
  externalClaims: number;
  unexplainedInflows: number;
  unknownSigned: number;
  /** skipped: older than the watch floor */
  beforeFloor: number;
  /** accepted: listed in KNOWN_OWNER_TX_SIGS */
  ownerKnown: number;
}

/** WATCH_FROM_SLOT, else the slot of the first live run (stored once, never moves). */
export async function watchFloor(d: WorkerDeps): Promise<number> {
  if (d.config.watchFromSlot > 0) return d.config.watchFromSlot;
  const stored = await d.store.settings.get(SETTINGS.watchFromSlot);
  if (stored) return Number(stored);
  const slot = await d.chain.getSlot();
  await d.store.settings.set(SETTINGS.watchFromSlot, String(slot));
  return slot;
}

async function watchWallet(d: WorkerDeps, role: 'creator' | 'fund', res: WatchResult, floor: number): Promise<void> {
  const wallet = role === 'creator' ? d.creator : d.fund;
  const cursorKey = role === 'creator' ? SETTINGS.creatorWatchCursor : SETTINGS.fundWatchCursor;
  // null = never ran. '' = ran while the wallet had no history (process everything that comes).
  const cursor = await d.store.settings.get(cursorKey);
  const sigs = await d.chain.getSignaturesSince(wallet, cursor || null, 1000);
  if (cursor === null && d.config.watchFromSlot <= 0) {
    // First run without WATCH_FROM_SLOT: start watching from now; history before the bot started is not ours to book.
    await d.store.settings.set(cursorKey, sigs[0]?.signature ?? '');
    return;
  }
  // With WATCH_FROM_SLOT, the first run also books what happened since that slot (for example an external claim).
  if (sigs.length === 0) {
    if (cursor === null) await d.store.settings.set(cursorKey, '');
    return;
  }
  const known = new Set(d.config.knownOwnerTxSigs);
  const unseen = new Set(await d.store.seen.unseen(sigs.map((s) => s.signature)));
  const ours = await d.store.attempts.signaturesKnown(sigs.map((s) => s.signature));
  const now = d.clock.now();
  // If a record is not visible yet (RPC indexing lag), keep the cursor where it was: the seen table stops
  // anything already booked from being booked twice, and the missing one is retried next loop.
  let incomplete = false;
  for (const info of [...sigs].reverse()) {
    const sig = info.signature;
    if (!unseen.has(sig)) continue;
    if (info.slot < floor) {
      res.beforeFloor++;
      await d.store.seen.add(sig, wallet, 'before_watch', now);
      continue;
    }
    if (ours.has(sig)) {
      await d.store.seen.add(sig, wallet, 'ours', now);
      continue;
    }
    if (known.has(sig)) {
      res.ownerKnown++;
      await d.store.seen.add(sig, wallet, 'owner_known', now);
      await d.alerts.send('info', `owner_tx_${sig}`, `Owner transaction on the ${role} wallet accepted (KNOWN_OWNER_TX_SIGS): ${sig}`);
      continue;
    }
    const record = await d.chain.getTransactionRecord(sig);
    if (!record) {
      incomplete = true;
      continue;
    }
    if (record.slot < floor) {
      res.beforeFloor++;
      await d.store.seen.add(sig, wallet, 'before_watch', now);
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
  const res: WatchResult = { externalClaims: 0, unexplainedInflows: 0, unknownSigned: 0, beforeFloor: 0, ownerKnown: 0 };
  if (d.store.mode === 'paper') return res;
  const floor = await watchFloor(d);
  await watchWallet(d, 'creator', res, floor);
  await watchWallet(d, 'fund', res, floor);
  return res;
}
