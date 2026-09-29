// Rehearsal only (docs/runbooks/rehearsal.md). Both commands refuse unless STAGING=true with a test creator (never the
// production one) and, for the seed, a database that `staging-init` marked for that creator.
import { type ChainReader, STAGING_SEED_MAX_LAMPORTS, STAGING_SEED_TOTAL_MAX_LAMPORTS, formatSol, solToLamports } from '@rat/core';
import { markStagingDatabase, requireStagingDatabase } from '@rat/db';
import type { CliContext } from '../context';

export async function stagingInitCommand(ctx: CliContext): Promise<void> {
  const r = await markStagingDatabase(ctx.store, ctx.config);
  ctx.out(r === 'marked' ? `Staging database marked for the test creator ${ctx.config.creatorPubkey}.` : 'Already a staging database for this test creator.');
}

export function seedPhrase(lamports: bigint): string {
  return `SEED ${formatSol(lamports)} SOL`;
}

/**
 * Books SOL the owner already sent to the test creator as hire budget (`hire:seed_credit`), so rats can be hired
 * without trading volume. It is never a creator fee: the public "claimed" figure comes from the claims table only.
 */
export async function stagingSeedCommand(
  ctx: CliContext,
  deps: { chain: Pick<ChainReader, 'getSolBalances'> },
  opts: { sol: string; confirm?: string },
): Promise<{ executed: boolean }> {
  const { config: cfg, store, out } = ctx;
  await requireStagingDatabase(store, cfg);
  const creator = cfg.creatorPubkey!;
  let amount: bigint;
  try {
    amount = solToLamports(opts.sol);
  } catch {
    throw new Error(`staging-seed: not a SOL amount: "${opts.sol}"`);
  }
  if (amount <= 0n) throw new Error('staging-seed: the amount must be more than 0');
  if (amount > STAGING_SEED_MAX_LAMPORTS) throw new Error(`staging-seed: at most ${formatSol(STAGING_SEED_MAX_LAMPORTS)} SOL per seed`);
  const seeded = (await store.ledger.sumByReason()).get('hire:seed_credit') ?? 0n;
  if (seeded + amount > STAGING_SEED_TOTAL_MAX_LAMPORTS) {
    throw new Error(`staging-seed: ${formatSol(seeded)} SOL already seeded; the total may not pass ${formatSol(STAGING_SEED_TOTAL_MAX_LAMPORTS)} SOL`);
  }
  // only SOL that is really in the test creator wallet, above its reserve and the hire budget already booked
  const onChain = (await deps.chain.getSolBalances([creator])).get(creator) ?? 0n;
  const budget = await store.ledger.balance('hire');
  const free = onChain - cfg.creatorReserveLamports - (budget > 0n ? budget : 0n);
  if (amount > free) {
    throw new Error(
      `staging-seed: the test creator holds ${formatSol(onChain)} SOL; after the ${formatSol(cfg.creatorReserveLamports)} SOL reserve and ${formatSol(budget)} SOL already in the hire budget only ${formatSol(free > 0n ? free : 0n)} SOL can be seeded. Send more SOL to ${creator} first.`,
    );
  }
  const phrase = seedPhrase(amount);
  out(`Seed ${formatSol(amount)} SOL of hire budget on the test creator ${creator} (${store.mode}).`);
  out(`It is booked as hire:seed_credit, never as a creator fee. About ${(amount / cfg.salaryLamports).toString()} rats at the ${formatSol(cfg.salaryLamports)} SOL salary.`);
  if (opts.confirm !== phrase) {
    out(`Not executed. To execute, pass exactly: --confirm "${phrase}"`);
    return { executed: false };
  }
  await store.ledger.append({ bucket: 'hire', deltaLamports: amount, reason: 'seed_credit', refType: 'staging_seed', note: 'rehearsal seed, not a creator fee' });
  out(`Seeded ${formatSol(amount)} SOL. Hire budget now ${formatSol(await store.ledger.balance('hire'))} SOL.`);
  return { executed: true };
}
