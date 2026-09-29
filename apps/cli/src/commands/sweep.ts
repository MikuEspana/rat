// EMERGENCY SWEEP (owner decision #11): CLI only, never run by the bot.
// Moves every live rat's stock tokens and SOL to a cold wallet. The creator pays the fees and the cold wallet's token
// account rent; when the creator cannot (drained after a key leak), each rat pays its own fee. Requires the exact
// typed confirmation phrase. In DRY RUN it only simulates.
//   - rats still being hired are only included with the kill switch ON (else a hire could fund them after the sweep)
//   - a token account frozen by the issuer, or a paused stock, keeps its tokens (they cannot move): the SOL still goes
//   - exit code 1 (main.ts) when anything is left behind, so scripts stop before deleting anything
import { type ChainReader, type KeyStore, type KillSwitch, TOKEN_2022_PROGRAM, formatSol, rawToDecimalString } from '@rat/core';
import type { GuardedSender } from '@rat/safety';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { type Keypair, PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';
import type { CliContext } from '../context';

export function sweepPhrase(to: string): string {
  return `SWEEP ALL RATS TO ${to}`;
}

/** below this the creator does not pay the fees: each rat pays its own */
export const SWEEP_CREATOR_MIN_LAMPORTS = 10_000_000n;
/** base fee of a one-signature tx sent with no priority fee (what a rat pays for its own SOL transfer) */
const ONE_SIGNATURE_FEE = 5_000n;

export interface SweepDeps {
  chain: ChainReader;
  keys: KeyStore;
  sender: GuardedSender;
  killSwitch: KillSwitch;
}

export interface SweepResult {
  executed: boolean;
  ok: number;
  failed: number;
  /** rats whose tokens could not move (frozen account, paused stock) */
  tokensLeft: number;
  /** rats still being hired, left out because the kill switch is off */
  skippedHiring: number;
}

export async function sweepCommand(
  ctx: CliContext,
  deps: SweepDeps,
  opts: { to: string; confirm?: string; limit?: number; parallel?: number },
): Promise<SweepResult> {
  const { store, out } = ctx;
  const coldKey = new PublicKey(opts.to);
  const cold = coldKey.toBase58();
  // The destination must be a normal wallet the owner controls: never one of the bot's own wallets (their keys
  // live on the server, which may be exactly what leaked) and never a program address (tokens could be stuck).
  if (!PublicKey.isOnCurve(coldKey.toBytes())) throw new Error(`sweep refused: ${cold} is not a normal wallet address (off-curve / program address)`);
  const own = [ctx.config.creatorPubkey].filter(Boolean);
  if (own.includes(cold) || (await store.keys.get(cold))) throw new Error(`sweep refused: ${cold} is one of the bot's own wallets; sweep to a cold wallet only the owner holds`);
  const liveStore = store.forMode('live');
  const killed = (await deps.killSwitch.status()).on;
  // failed rats are included: a two-step hire that funded the rat but never bought leaves its SOL there
  const hiring = await liveStore.rats.listByStatus(['hiring']);
  const rats = [...(await liveStore.rats.listByStatus(['active', 'frozen', 'failed'])), ...(killed ? hiring : [])].slice(0, opts.limit ?? Number.MAX_SAFE_INTEGER);
  const skippedHiring = killed ? 0 : hiring.length;
  const stocks = new Map((await store.stocks.list()).map((s) => [s.mint, s]));
  const accounts = await deps.chain.getTokenAccounts(
    rats.map((r) => ({ owner: r.wallet, mint: r.stockMint, tokenProgram: stocks.get(r.stockMint)?.tokenProgram ?? TOKEN_2022_PROGRAM })),
  );
  const sol = await deps.chain.getSolBalances(rats.map((r) => r.wallet));
  const mints = await deps.chain.getMintStates([...new Set(rats.map((r) => r.stockMint))]);
  const totals = new Map<string, bigint>();
  let totalSol = 0n;
  let holding = 0;
  rats.forEach((r, i) => {
    const a = accounts[i];
    totals.set(r.stockMint, (totals.get(r.stockMint) ?? 0n) + (a?.amount ?? 0n));
    const lamports = sol.get(r.wallet) ?? 0n;
    totalSol += lamports;
    if (lamports > 0n || a?.exists) holding++;
  });
  out(`SWEEP PLAN: ${rats.length} live rats -> ${cold}`);
  for (const [mint, amount] of totals) {
    const s = stocks.get(mint);
    out(`  ${s?.symbol ?? mint}: ${rawToDecimalString(amount, s?.decimals ?? 0)} tokens`);
  }
  out(`  SOL in rat wallets: ${formatSol(totalSol)}`);
  out(`  wallets holding anything: ${holding}`);
  if (skippedHiring > 0) out(`  ${skippedHiring} rats still being hired are left out: turn the kill switch on first (rat kill) to sweep them too.`);
  const phrase = sweepPhrase(cold);
  if (opts.confirm !== phrase) {
    out(`Not executed. To execute, pass exactly: --confirm "${phrase}"`);
    return { executed: false, ok: 0, failed: 0, tokensLeft: 0, skippedHiring };
  }
  out(ctx.config.dryRun ? 'DRY RUN: every sweep tx is simulated only.' : 'LIVE: sending sweep transactions.');
  const creator = await deps.keys.creator();
  const creatorSol = (await deps.chain.getSolBalances([creator.publicKey.toBase58()])).get(creator.publicKey.toBase58()) ?? 0n;
  const creatorPays = creatorSol >= SWEEP_CREATOR_MIN_LAMPORTS;
  if (!creatorPays) out(`The creator wallet holds ${formatSol(creatorSol)} SOL, too little for the fees (a key leak?): each rat pays its own fee.`);
  const res: SweepResult = { executed: true, ok: 0, failed: 0, tokensLeft: 0, skippedHiring };

  const send = (rat: { id: number }, feePayer: Keypair, signers: Keypair[], instructions: TransactionInstruction[], noPriority: boolean) =>
    deps.sender.execute({
      request: {
        kind: 'sweep',
        label: `sweep rat ${rat.id}`,
        feePayer,
        signers,
        instructions,
        computeUnitLimit: 200_000,
        // a rat paying for itself sends everything but the exact base fee: no priority fee on top
        ...(noPriority ? { computeUnitPriceMicroLamports: 0 } : {}),
      },
      ref: { type: 'sweep', id: String(rat.id) },
    });
  const landed = (r: Awaited<ReturnType<typeof send>>) => r.status === 'done' && (r.outcome.status === 'confirmed' || (r.outcome.status === 'simulated' && !r.outcome.error));
  const why = (r: Awaited<ReturnType<typeof send>>) => (r.status === 'done' ? `${r.outcome.status} ${r.outcome.error ?? ''}` : r.reason);

  const sweepOne = async (i: number) => {
    const rat = rats[i]!;
    const acct = accounts[i]!;
    const stock = stocks.get(rat.stockMint);
    const program = new PublicKey(stock?.tokenProgram ?? TOKEN_2022_PROGRAM);
    const signer = await deps.keys.ratSigner(rat.wallet);
    const mint = new PublicKey(rat.stockMint);
    const coldAta = getAssociatedTokenAddressSync(mint, coldKey, true, program);
    const paused = mints.get(rat.stockMint)?.paused ?? false;
    const movable = acct.exists && !acct.frozen && !paused;
    if (acct.exists && !movable) {
      res.tokensLeft++;
      out(`  rat ${rat.id} (${rat.wallet}): its ${stock?.symbol ?? rat.stockMint} tokens stay (${acct.frozen ? 'account frozen by the issuer' : 'stock paused'}); run the sweep again when that is lifted.`);
    }
    const payer = creatorPays ? creator : signer;
    const tokenIxs: TransactionInstruction[] = [];
    if (movable) {
      tokenIxs.push(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, coldAta, coldKey, mint, program));
      if (acct.amount > 0n) tokenIxs.push(createTransferCheckedInstruction(new PublicKey(acct.address), mint, coldAta, signer.publicKey, acct.amount, stock?.decimals ?? 0, [], program));
      // the account's rent goes to the cold wallet, or back to the rat when it pays its own way (then swept below)
      tokenIxs.push(createCloseAccountInstruction(new PublicKey(acct.address), creatorPays ? coldKey : signer.publicKey, signer.publicKey, [], program));
    }
    let good = true;
    let reason = '';
    if (creatorPays) {
      const lamports = sol.get(rat.wallet) ?? 0n;
      const ixs = [...tokenIxs];
      if (lamports > 0n) ixs.push(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: coldKey, lamports }));
      if (ixs.length === 0) return;
      const r = await send(rat, creator, [signer], ixs, false);
      good = landed(r);
      if (!good) reason = why(r);
    } else {
      if (tokenIxs.length > 0) {
        const r = await send(rat, signer, [], tokenIxs, true);
        good = landed(r);
        if (!good) reason = why(r);
      }
      if (good) {
        // everything left, minus the exact fee of this one-signature transfer
        const now = ctx.config.dryRun ? (sol.get(rat.wallet) ?? 0n) : ((await deps.chain.getSolBalances([rat.wallet])).get(rat.wallet) ?? 0n);
        if (now > ONE_SIGNATURE_FEE) {
          const r = await send(rat, signer, [], [SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: coldKey, lamports: now - ONE_SIGNATURE_FEE })], true);
          good = landed(r);
          if (!good) reason = why(r);
        } else if (tokenIxs.length === 0) return;
      }
    }
    if (good) {
      res.ok++;
      if (!ctx.config.dryRun) await liveStore.rats.update(rat.id, { status: 'frozen', freezeReason: 'swept' });
    } else {
      res.failed++;
      out(`  rat ${rat.id} (${rat.wallet}): ${reason}`);
    }
  };
  // a few rats at a time: after a key leak the sweep races the thief
  const parallel = Math.max(1, opts.parallel ?? 8);
  for (let i = 0; i < rats.length; i += parallel) {
    await Promise.all(rats.slice(i, i + parallel).map((_, j) => sweepOne(i + j)));
  }
  out(`sweep done: ${res.ok} ok, ${res.failed} failed${res.tokensLeft ? `, ${res.tokensLeft} with tokens that could not move` : ''}${ctx.config.dryRun ? ' (simulated)' : ''}.`);
  return res;
}
