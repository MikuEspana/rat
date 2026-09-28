// EMERGENCY SWEEP (owner decision #11): CLI only, never run by the bot.
// Moves every live rat's stock tokens and SOL to a cold wallet. The creator pays fees and the cold wallet's
// token account rent. Requires the exact typed confirmation phrase. In DRY RUN it only simulates.
import { type ChainReader, type KeyStore, TOKEN_2022_PROGRAM, formatSol, rawToDecimalString } from '@rat/core';
import type { GuardedSender } from '@rat/safety';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';
import type { CliContext } from '../context';

export function sweepPhrase(to: string): string {
  return `SWEEP ALL RATS TO ${to}`;
}

export interface SweepDeps {
  chain: ChainReader;
  keys: KeyStore;
  sender: GuardedSender;
}

export async function sweepCommand(ctx: CliContext, deps: SweepDeps, opts: { to: string; confirm?: string; limit?: number }): Promise<{ executed: boolean; ok: number; failed: number }> {
  const { store, out } = ctx;
  const coldKey = new PublicKey(opts.to);
  const cold = coldKey.toBase58();
  // The destination must be a normal wallet the owner controls: never one of the bot's own wallets (their keys
  // live on the server, which may be exactly what leaked) and never a program address (tokens could be stuck).
  if (!PublicKey.isOnCurve(coldKey.toBytes())) throw new Error(`sweep refused: ${cold} is not a normal wallet address (off-curve / program address)`);
  const own = [ctx.config.creatorPubkey].filter(Boolean);
  if (own.includes(cold) || (await store.keys.get(cold))) throw new Error(`sweep refused: ${cold} is one of the bot's own wallets; sweep to a cold wallet only the owner holds`);
  const liveStore = store.forMode('live');
  // failed rats are included: a two-step hire that funded the rat but never bought leaves its SOL there
  const rats = (await liveStore.rats.listByStatus(['active', 'frozen', 'failed'])).slice(0, opts.limit ?? Number.MAX_SAFE_INTEGER);
  const stocks = new Map((await store.stocks.list()).map((s) => [s.mint, s]));
  const accounts = await deps.chain.getTokenAccounts(
    rats.map((r) => ({ owner: r.wallet, mint: r.stockMint, tokenProgram: stocks.get(r.stockMint)?.tokenProgram ?? TOKEN_2022_PROGRAM })),
  );
  const sol = await deps.chain.getSolBalances(rats.map((r) => r.wallet));
  const totals = new Map<string, bigint>();
  let totalSol = 0n;
  rats.forEach((r, i) => {
    totals.set(r.stockMint, (totals.get(r.stockMint) ?? 0n) + (accounts[i]?.amount ?? 0n));
    totalSol += sol.get(r.wallet) ?? 0n;
  });
  out(`SWEEP PLAN: ${rats.length} live rats -> ${cold}`);
  for (const [mint, amount] of totals) {
    const s = stocks.get(mint);
    out(`  ${s?.symbol ?? mint}: ${rawToDecimalString(amount, s?.decimals ?? 0)} tokens`);
  }
  out(`  SOL in rat wallets: ${formatSol(totalSol)}`);
  const phrase = sweepPhrase(cold);
  if (opts.confirm !== phrase) {
    out(`Not executed. To execute, pass exactly: --confirm "${phrase}"`);
    return { executed: false, ok: 0, failed: 0 };
  }
  out(ctx.config.dryRun ? 'DRY RUN: every sweep tx is simulated only.' : 'LIVE: sending sweep transactions.');
  const creator = await deps.keys.creator();
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < rats.length; i++) {
    const rat = rats[i]!;
    const acct = accounts[i]!;
    const stock = stocks.get(rat.stockMint);
    const program = new PublicKey(stock?.tokenProgram ?? TOKEN_2022_PROGRAM);
    const signer = await deps.keys.ratSigner(rat.wallet);
    const mint = new PublicKey(rat.stockMint);
    const coldAta = getAssociatedTokenAddressSync(mint, new PublicKey(cold), true, program);
    const ixs: TransactionInstruction[] = [];
    if (acct.exists) {
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(creator.publicKey, coldAta, new PublicKey(cold), mint, program));
      if (acct.amount > 0n) {
        ixs.push(createTransferCheckedInstruction(new PublicKey(acct.address), mint, coldAta, signer.publicKey, acct.amount, stock?.decimals ?? 0, [], program));
      }
      ixs.push(createCloseAccountInstruction(new PublicKey(acct.address), new PublicKey(cold), signer.publicKey, [], program));
    }
    const lamports = sol.get(rat.wallet) ?? 0n;
    if (lamports > 0n) ixs.push(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: new PublicKey(cold), lamports }));
    if (ixs.length === 0) continue;
    const r = await deps.sender.execute({
      request: { kind: 'sweep', label: `sweep rat ${rat.id}`, feePayer: creator, signers: [signer], instructions: ixs, computeUnitLimit: 200_000 },
      ref: { type: 'sweep', id: String(rat.id) },
    });
    const good = r.status === 'done' && (r.outcome.status === 'confirmed' || (r.outcome.status === 'simulated' && !r.outcome.error));
    if (good) {
      ok++;
      if (!ctx.config.dryRun) await liveStore.rats.update(rat.id, { status: 'frozen', freezeReason: 'swept' });
    } else {
      failed++;
      out(`  rat ${rat.id} (${rat.wallet}): ${r.status === 'done' ? `${r.outcome.status} ${r.outcome.error ?? ''}` : r.reason}`);
    }
  }
  out(`sweep done: ${ok} ok, ${failed} failed${ctx.config.dryRun ? ' (simulated)' : ''}.`);
  return { executed: true, ok, failed };
}
