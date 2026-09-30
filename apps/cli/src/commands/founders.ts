// Founding rats: at launch the owner may pay for a few rats from the creator wallet's own SOL, so rats walk in before
// the trading fees cover a salary. Booked once, as hire budget (`hire:seed_credit`), never as a creator fee: the public
// "claimed" figure and the stage bar count claims only, and `rat audit` keeps seeded SOL apart.
import { type ChainReader, formatSol } from '@rat/core';
import type { CliContext } from '../context';

export const FOUNDERS_MAX_RATS = 5;

export function foundersPhrase(rats: number): string {
  return `FOUNDERS ${rats} RATS`;
}

export async function foundersSeedCommand(
  ctx: CliContext,
  deps: { chain: Pick<ChainReader, 'getSolBalances'> },
  opts: { rats: string; confirm?: string },
): Promise<{ executed: boolean }> {
  const { config: cfg, store, out } = ctx;
  const n = Number(opts.rats);
  if (!Number.isInteger(n) || n < 1 || n > FOUNDERS_MAX_RATS) throw new Error(`founders-seed: --rats must be a whole number from 1 to ${FOUNDERS_MAX_RATS}`);
  if (cfg.dryRun || !cfg.liveConfirmed || store.mode !== 'live' || !cfg.coinMint) {
    throw new Error('founders-seed: the bot must run LIVE with its coin first (scripts/launch.sh)');
  }
  const creator = cfg.creatorPubkey;
  if (!creator) throw new Error('founders-seed: CREATOR_PUBKEY is not set');
  const already = (await store.ledger.sumByReason()).get('hire:seed_credit') ?? 0n;
  if (already !== 0n) throw new Error(`founders-seed: ${formatSol(already)} SOL was already booked: founding rats are booked once`);
  const amount = BigInt(n) * cfg.salaryLamports;
  // only SOL really in the creator wallet, above its reserve and the hire budget already booked
  const onChain = (await deps.chain.getSolBalances([creator])).get(creator) ?? 0n;
  const budget = await store.ledger.balance('hire');
  const free = onChain - cfg.creatorReserveLamports - (budget > 0n ? budget : 0n);
  if (amount > free) {
    throw new Error(
      `founders-seed: ${n} founding rats need ${formatSol(amount)} SOL; the creator wallet holds ${formatSol(onChain)} SOL, and after the ${formatSol(cfg.creatorReserveLamports)} SOL reserve and ${formatSol(budget)} SOL already in the hire budget only ${formatSol(free > 0n ? free : 0n)} SOL is free. Send SOL to ${creator} first.`,
    );
  }
  const phrase = foundersPhrase(n);
  out(`Founding rats: ${n} hires paid with ${formatSol(amount)} SOL of your own SOL in the creator wallet ${creator}.`);
  out('Booked as hire budget (seed), never as a creator fee: the public claimed figure and the stages count claims only.');
  if (opts.confirm !== phrase) {
    out(`Not executed. To execute, pass exactly: --confirm "${phrase}"`);
    return { executed: false };
  }
  await store.ledger.append({ bucket: 'hire', deltaLamports: amount, reason: 'seed_credit', refType: 'founders_seed', note: `${n} founding rats: the owner's SOL, not a creator fee` });
  out(`Booked ${formatSol(amount)} SOL for ${n} founding rats. Hire budget now ${formatSol(await store.ledger.balance('hire'))} SOL: they are hired in the next loops.`);
  return { executed: true };
}
