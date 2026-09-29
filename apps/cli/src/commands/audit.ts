// rat audit: the ledger against the chain, read-only. Three checks, each PASS / FAIL / WAIT:
//   claims  every booked claim equals what left the creator's fee vaults in its transaction, and its ledger credit
//   rats    every hired rat was paid by the creator exactly once, and holds the stock amount the database says
//   money   the creator wallet's SOL change over every bot transaction (and external claims) equals the ledger to
//           the lamport. Owner transactions (the launch, the dev buy, deposits) and seeded SOL are not bot money.
// WAIT means something is still in flight (an unresolved attempt or an open reservation): run it again shortly.
import { type ChainReader, type Pubkey, type TxRecord, formatSol, solDelta, tokenOwnerPost } from '@rat/core';
import type { Store } from '@rat/db';
import type { PumpFunClient } from '@rat/pump';

export type AuditStatus = 'PASS' | 'FAIL' | 'WAIT';
export interface AuditLine {
  status: AuditStatus;
  check: 'claims' | 'rats' | 'money';
  detail: string;
}
export interface AuditDeps {
  store: Store;
  chain: ChainReader;
  pump: Pick<PumpFunClient, 'parseClaim'>;
  creator: Pubkey;
  /** at most this many rats are checked (newest first); 0 = all */
  ratLimit?: number;
}

const LANDED = new Set(['confirmed', 'failed', 'expired']);

export async function runAudit(d: AuditDeps): Promise<AuditLine[]> {
  if (d.store.mode !== 'live') return [{ status: 'PASS', check: 'money', detail: 'DRY RUN: paper only, nothing on chain to audit.' }];
  const records = new Map<string, TxRecord | null>();
  const record = async (sig: string) => {
    if (!records.has(sig)) records.set(sig, await d.chain.getTransactionRecord(sig));
    return records.get(sig)!;
  };
  const lines: AuditLine[] = [];
  const ledger = await d.store.ledger.list(1_000_000);

  // claims
  const claims = (await d.store.claims.all()).filter((c) => c.status === 'confirmed');
  const creditOf = new Map<string, bigint>();
  for (const e of ledger) if (e.reason === 'claim_credit' && e.refType === 'claim' && e.refId) creditOf.set(e.refId, (creditOf.get(e.refId) ?? 0n) + e.deltaLamports);
  const claimBad: string[] = [];
  let claimTotal = 0n;
  for (const c of claims) {
    const booked = c.claimedLamports;
    claimTotal += booked;
    if ((creditOf.get(String(c.id)) ?? 0n) !== booked) claimBad.push(`claim ${c.id}: ledger credit ${formatSol(creditOf.get(String(c.id)) ?? 0n)} != booked ${formatSol(booked)}`);
    if (!c.sig) {
      claimBad.push(`claim ${c.id}: no signature`);
      continue;
    }
    const r = await record(c.sig);
    const measured = r ? (d.pump.parseClaim(r, d.creator)?.totalLamports ?? 0n) : null;
    if (measured === null) claimBad.push(`claim ${c.id}: transaction ${c.sig} not found`);
    else if (measured !== booked) claimBad.push(`claim ${c.id}: ${formatSol(measured)} left the vaults on chain, ${formatSol(booked)} booked`);
  }
  lines.push(
    claimBad.length > 0
      ? { status: 'FAIL', check: 'claims', detail: claimBad.slice(0, 5).join('; ') }
      : { status: 'PASS', check: 'claims', detail: `${claims.length} claims, ${formatSol(claimTotal)} SOL: each equals what left the fee vaults on chain, to the lamport.` },
  );

  // rats
  // an emergency sweep moves rat money out on purpose (the creator pays its fees): not part of the hire money
  const attempts = (await d.store.attempts.all()).filter((a) => a.kind !== 'sweep');
  const rats = await d.store.rats.listByStatus(['active', 'frozen']);
  const checked = d.ratLimit && d.ratLimit > 0 ? rats.slice(-d.ratLimit) : rats;
  const stocks = new Map((await d.store.stocks.list()).map((s) => [s.mint, s]));
  const ratBad: string[] = [];
  for (const rat of checked) {
    const paid: string[] = [];
    for (const sig of await d.chain.getSignaturesSince(rat.wallet, null, 100)) {
      const r = await record(sig.signature);
      if (r && !r.err && r.signers.includes(d.creator) && solDelta(r, rat.wallet) > 0n) paid.push(sig.signature);
    }
    if (paid.length !== 1) ratBad.push(`rat ${rat.id} (${rat.wallet}): paid ${paid.length} times by the creator`);
    const stock = stocks.get(rat.stockMint);
    if (stock?.tokenProgram) {
      const [acct] = await d.chain.getTokenAccounts([{ owner: rat.wallet, mint: rat.stockMint, tokenProgram: stock.tokenProgram }]);
      const onChain = acct?.amount ?? 0n;
      if (rat.status === 'active' && onChain !== (rat.tokenAmountRaw ?? 0n)) ratBad.push(`rat ${rat.id}: holds ${onChain} on chain, database says ${rat.tokenAmountRaw ?? 0n}`);
    }
  }
  const ratsInFlight = (await d.store.rats.listByStatus(['hiring'])).length;
  lines.push(
    ratBad.length > 0
      ? { status: 'FAIL', check: 'rats', detail: ratBad.slice(0, 5).join('; ') }
      : ratsInFlight > 0
        ? { status: 'WAIT', check: 'rats', detail: `${ratsInFlight} hires still in flight; ${checked.length} checked rats are fine.` }
        : { status: 'PASS', check: 'rats', detail: `${checked.length}${checked.length < rats.length ? ` of ${rats.length}` : ''} rats: each paid by the creator exactly once and holding what the database says.` },
  );

  // money: creator SOL over every bot transaction and external claim == ledger (claims, claim fees, hires)
  const open = await d.store.ledger.openReservations('hire');
  const inFlight = attempts.filter((a) => !LANDED.has(a.status) && a.status !== 'blocked' && a.status !== 'simulated');
  if (open.length > 0 || inFlight.length > 0) {
    lines.push({ status: 'WAIT', check: 'money', detail: `${open.length} open reservations and ${inFlight.length} unresolved transactions: run it again in a minute.` });
    return lines;
  }
  let chainNet = 0n;
  const counted = new Set<string>();
  for (const sig of [...attempts.filter((a) => LANDED.has(a.status)).map((a) => a.signature), ...claims.filter((c) => c.source === 'external' && c.sig).map((c) => c.sig!)]) {
    if (counted.has(sig)) continue;
    counted.add(sig);
    const r = await record(sig);
    if (r) chainNet += solDelta(r, d.creator);
  }
  const bot = new Set(['claim_credit', 'claim_fee', 'hire_reserve', 'hire_settle', 'hire_release']);
  const ledgerNet = ledger.filter((e) => e.bucket === 'hire' && bot.has(e.reason)).reduce((a, e) => a + e.deltaLamports, 0n);
  const seeded = ledger.filter((e) => e.reason === 'seed_credit').reduce((a, e) => a + e.deltaLamports, 0n);
  lines.push(
    chainNet === ledgerNet
      ? {
          status: 'PASS',
          check: 'money',
          detail: `creator SOL over ${counted.size} bot transactions: ${formatSol(chainNet)} SOL, ledger ${formatSol(ledgerNet)} SOL, equal to the lamport${seeded > 0n ? ` (seeded ${formatSol(seeded)} SOL kept apart)` : ''}.`,
        }
      : { status: 'FAIL', check: 'money', detail: `creator SOL over ${counted.size} bot transactions: ${formatSol(chainNet)} SOL, but the ledger says ${formatSol(ledgerNet)} SOL (off by ${formatSol(chainNet - ledgerNet)}).` },
  );
  return lines;
}

export function printAudit(lines: AuditLine[], out: (l: string) => void): boolean {
  for (const l of lines) out(`${l.status.padEnd(4)}  ${l.check.padEnd(7)} ${l.detail}`);
  const fail = lines.some((l) => l.status === 'FAIL');
  const wait = lines.some((l) => l.status === 'WAIT');
  out('');
  out(fail ? 'AUDIT FAILED: the ledger and the chain disagree (details above).' : wait ? 'AUDIT WAITING: something is in flight, run it again.' : 'AUDIT PASSED: the ledger equals the chain.');
  return !fail && !wait;
}
