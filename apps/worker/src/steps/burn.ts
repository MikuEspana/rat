// Buy and burn. Each ROUND starts at a random time 8 to 12 minutes after the previous one (BURN_INTERVAL_MIN/MAX_SEC),
// never on a fixed public schedule. The round budget = min(burn bucket, fund wallet - reserve, room under the hourly
// cap); under MIN_BURN_SOL the round is skipped. Budgets above BURN_CHUNK_MAX_SOL are split into equal chunks sent
// 3 to 8 seconds apart, each its own tx: Jupiter SOL -> coin at SLIPPAGE_BPS_COIN (1.5%), then BurnChecked of the
// guaranteed minimum output plus leftover coin from earlier rounds. Smaller, less predictable buys with a tight
// slippage limit are poor sandwich targets. BURN_SEND_VIA=jito adds a tip and sends through the Jito block engine.
// Fees (and the tip) come out of the chunk, so the fund's own SOL is never spent. Fallback: direct pump.fun buy.
// Profits never go to holders: the only way they leave is this buy and burn.
import { NATIVE_SOL_MINT, SETTINGS, type SwapBuild, formatSol, lamportsToSol, minBig, rawToDecimalString, solDelta } from '@rat/core';
import { PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';
import type { BurnRow } from '@rat/db';
import type { GuardedResult, Reservation } from '@rat/safety';
import type { WorkerDeps, WorkerState } from '../deps';

export interface BurnResult {
  status: 'skipped' | 'burned' | 'paper' | 'failed' | 'pending';
  spentLamports: bigint;
  burnedRaw: bigint;
  reason?: string;
  /** this chunk's position in the round (1-based) and the planned chunk count */
  chunk?: { index: number; of: number };
  /** seconds until the burn step runs again: a chunk gap, or a random 8 to 12 minutes for the next round */
  nextInSec?: number;
}

type ChunkResult = Omit<BurnResult, 'chunk' | 'nextInSec'>;

const uniform = (d: WorkerDeps, lo: number, hi: number) => lo + d.rng.next() * (hi - lo);

/** Random delay before the next burn round. */
export function nextBurnRoundSec(d: WorkerDeps): number {
  return uniform(d, d.config.intervals.burnMinSec, d.config.intervals.burnMaxSec);
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

function reservationOf(b: BurnRow): Reservation | null {
  if (b.reserveLedgerId === null) return null;
  return { ledgerId: b.reserveLedgerId, bucket: 'burn', lamports: b.reservedLamports, refType: 'burn', refId: String(b.id) };
}

async function finish(
  d: WorkerDeps,
  burn: BurnRow,
  reservation: Reservation,
  r: GuardedResult,
  burnAmount: bigint,
  decimals: number,
): Promise<BurnResult> {
  if (r.status !== 'done') {
    await d.guard.release(reservation, r.reason);
    await d.store.burns.update(burn.id, { status: 'released', reserveLedgerId: null });
    return { status: 'failed', spentLamports: 0n, burnedRaw: 0n, reason: r.reason };
  }
  const out = r.outcome;
  await d.store.burns.update(burn.id, { sig: out.signature });
  const book = async (spent: bigint, status: 'confirmed' | 'simulated') => {
    await d.guard.settle(reservation, spent);
    await d.store.burns.update(burn.id, { status, solSpentLamports: spent, tokensBurnedRaw: burnAmount, coinDecimals: decimals, reserveLedgerId: null });
    await d.store.events.append({
      type: 'burn',
      txSig: out.signature,
      data: { solSpent: lamportsToSol(spent), tokensBurned: rawToDecimalString(burnAmount, decimals) },
    });
    await d.store.settings.set(SETTINGS.lastBurnAt, d.clock.now().toISOString());
  };
  if (out.status === 'simulated') {
    if (out.error) d.log.debug({ err: out.error }, 'paper burn simulation error (ignored for paper accounting)');
    await book(reservation.lamports, 'simulated');
    return { status: 'paper', spentLamports: reservation.lamports, burnedRaw: burnAmount };
  }
  if (out.status === 'confirmed' && out.record) {
    const spent = -solDelta(out.record, d.fund);
    await book(spent > 0n ? spent : 0n, 'confirmed');
    d.log.info({ spent: formatSol(spent), burned: burnAmount.toString(), sig: out.signature }, 'bought and burned');
    return { status: 'burned', spentLamports: spent, burnedRaw: burnAmount };
  }
  if (out.status === 'unknown') {
    await d.store.burns.update(burn.id, { status: 'unknown' });
    return { status: 'pending', spentLamports: 0n, burnedRaw: 0n, reason: 'confirmation pending' };
  }
  if (out.record) {
    const fee = -solDelta(out.record, d.fund);
    await d.guard.settle(reservation, fee > 0n ? fee : 0n);
  } else {
    await d.guard.release(reservation, `${out.status}: ${out.error ?? ''}`);
  }
  await d.store.burns.update(burn.id, { status: out.status === 'expired' ? 'expired' : 'failed', reserveLedgerId: null });
  await d.alerts.send('warn', 'burn_failed', `buy + burn ${out.status}: ${out.error ?? ''}`);
  return { status: 'failed', spentLamports: 0n, burnedRaw: 0n, reason: out.error };
}

async function reconcileOpenBurns(d: WorkerDeps): Promise<void> {
  const open = await d.store.burns.listByStatus(['pending', 'unknown']);
  // a crash between "reserve" and "insert the burn row" leaves a reservation nothing refers to
  await d.guard.releaseOrphans('burn', new Set(open.flatMap((b) => (b.reserveLedgerId === null ? [] : [b.reserveLedgerId]))));
  for (let b of open) {
    const res = reservationOf(b);
    if (!b.sig) {
      // Crash between "attempt written" and "burn row updated": the attempt log knows the signature, and that
      // tx may have landed. Only a burn with no attempt at all was never sent.
      const sent = await d.store.attempts.latestForRef('burn', String(b.id));
      if (sent) {
        await d.store.burns.update(b.id, { sig: sent.signature });
        b = { ...b, sig: sent.signature };
      }
    }
    if (!b.sig || !res) {
      if (res) await d.guard.release(res, 'burn never sent');
      await d.store.burns.update(b.id, { status: 'released', reserveLedgerId: null });
      continue;
    }
    const attempt = await d.store.attempts.bySignature(b.sig);
    if (!attempt) continue;
    const st = await d.sender.status(b.sig, attempt.lastValidBlockHeight);
    if (st.status === 'unknown') continue;
    await d.store.attempts.finish(attempt.id, { status: st.status, error: st.error, feeLamports: st.feeLamports });
    await finish(d, b, res, { status: 'done', outcome: st, prepared: null as never, attemptId: attempt.id }, b.tokensBurnedRaw ?? 0n, b.coinDecimals ?? 0);
  }
}

/**
 * SOL the fund may burn right now: min(burn bucket - fund share still owed, fund wallet - reserve, room under the
 * hourly cap). A fund share that is booked but still sits in the creator wallet (it rides in the next claim tx)
 * is not burnable yet: burning it early would spend the fund's own SOL.
 */
async function burnSpendable(d: WorkerDeps, alertOnCap: boolean): Promise<bigint> {
  let spendable = (await d.store.ledger.balance('burn')) - (await d.store.claims.pendingFundTransfer());
  if (d.store.mode === 'live') {
    const sol = (await d.chain.getSolBalances([d.fund])).get(d.fund) ?? 0n;
    spendable = minBig(spendable, sol - d.config.fundReserveLamports);
  }
  // burn up to the room left under the hourly cap instead of skipping the whole burn
  const capRoom = await d.guard.remainingCap('burn');
  if (capRoom < spendable) {
    if (alertOnCap) {
      await d.alerts.send('critical', 'cap_reached_burn', `burn spend cap reached: burning ${formatSol(capRoom)} of ${formatSol(spendable)} SOL now, the rest carries over.`);
    }
    spendable = capRoom;
  }
  return spendable > 0n ? spendable : 0n;
}

export async function runBurnStep(d: WorkerDeps, s: WorkerState): Promise<BurnResult> {
  const c = d.config;
  const now = d.clock.now();
  const endRound = async (r: ChunkResult, chunk?: BurnResult['chunk']): Promise<BurnResult> => {
    s.burnRound = null;
    const next = nextBurnRoundSec(d);
    // publish only the earliest possible start of the next round, never the exact (random) time
    await d.store.settings.set(SETTINGS.burnWindowOpensAt, new Date(now.getTime() + c.intervals.burnMinSec * 1000).toISOString());
    return { ...r, chunk, nextInSec: next };
  };
  const skip = (reason: string): ChunkResult => ({ status: 'skipped', spentLamports: 0n, burnedRaw: 0n, reason });

  let spendableNow: bigint;
  if (!s.burnRound) {
    await d.store.settings.set(SETTINGS.lastBurnRunAt, now.toISOString());
    if (!c.coinMint) return endRound(skip('COIN_MINT not set'));
    if ((await d.killSwitch.status()).on) return endRound(skip('kill_switch'));
    await reconcileOpenBurns(d);
    spendableNow = await burnSpendable(d, true);
    // optional pacing: a round burns at most BURN_ROUND_MAX_SOL, the rest waits for the next rounds
    if (c.burn.roundMaxLamports > 0n) spendableNow = minBig(spendableNow, c.burn.roundMaxLamports);
    if (spendableNow < c.minBurnLamports) {
      return endRound(skip(`under ${formatSol(c.minBurnLamports)} SOL (have ${formatSol(spendableNow)})`));
    }
    const chunks = ceilDiv(spendableNow, c.burn.chunkMaxLamports);
    s.burnRound = { remaining: spendableNow, chunkSize: ceilDiv(spendableNow, chunks), chunks: Number(chunks), done: 0 };
  } else {
    if ((await d.killSwitch.status()).on) return endRound(skip('kill_switch'));
    spendableNow = await burnSpendable(d, false);
  }

  const round = s.burnRound;
  const amount = minBig(minBig(round.remaining, round.chunkSize), spendableNow);
  if (amount < c.minBurnLamports) return endRound(skip(`round done (${formatSol(amount)} SOL left under the minimum)`));
  const r = await burnChunk(d, amount);
  round.done++;
  round.remaining -= amount;
  const chunk = { index: round.done, of: round.chunks };
  // a failed or unconfirmed chunk ends the round: the rest carries over to the next round
  if (r.status !== 'burned' && r.status !== 'paper') return endRound(r, chunk);
  if (round.done >= round.chunks || round.remaining < c.minBurnLamports) return endRound(r, chunk);
  return { ...r, chunk, nextInSec: uniform(d, c.burn.chunkGapMinSec, c.burn.chunkGapMaxSec) };
}

/** One buy + burn transaction for `amount` lamports of the burn budget. */
async function burnChunk(d: WorkerDeps, amount: bigint): Promise<ChunkResult> {
  const c = d.config;
  const coin = await d.pump.getCoinInfo(c.coinMint!);

  // Jito: tip one of the block engine's tip accounts from inside the same tx (paid from this chunk).
  let tipIx: TransactionInstruction | null = null;
  const tip = c.burn.jitoTipLamports;
  if (c.burn.sendVia === 'jito') {
    const accounts = await (d.jitoTipAccounts?.() ?? Promise.resolve([])).catch(() => [] as string[]);
    if (accounts.length === 0) {
      // no silent fallback to a public send: the owner chose MEV protection for burns
      await d.alerts.send('warn', 'burn_jito_unavailable', 'Jito tip accounts unavailable: burn skipped, the budget carries over.');
      return { status: 'failed', spentLamports: 0n, burnedRaw: 0n, reason: 'jito unavailable' };
    }
    const to = accounts[Math.floor(d.rng.next() * accounts.length)]!;
    tipIx = SystemProgram.transfer({ fromPubkey: new PublicKey(d.fund), toPubkey: new PublicKey(to), lamports: tip });
  }

  const auth = await d.guard.authorize({ bucket: 'burn', lamports: amount, refType: 'burn', refId: `burn@${d.clock.now().toISOString()}` });
  if (!auth.ok) return { status: 'skipped', spentLamports: 0n, burnedRaw: 0n, reason: auth.reason };

  // Fees, the fund's coin account rent and the Jito tip come out of the reservation: only claimed money is spent.
  const swapAmount = amount - c.hireOverheadEstLamports - (tipIx ? tip : 0n);
  const req = { inputMint: NATIVE_SOL_MINT, outputMint: coin.mint, amount: swapAmount, taker: d.fund, slippageBps: c.slippageBpsCoin };
  let build: SwapBuild;
  try {
    build = await d.swap.build(req);
  } catch (err) {
    if (!d.fallbackSwap) {
      await d.guard.release(auth.reservation, 'no route');
      await d.alerts.send('warn', 'burn_no_route', `No Jupiter route to buy the coin: ${(err as Error).message}`);
      return { status: 'failed', spentLamports: 0n, burnedRaw: 0n, reason: 'no route' };
    }
    try {
      build = await d.fallbackSwap(coin).build(req);
      d.log.warn('Jupiter had no route, using the direct pump.fun buy');
    } catch (err2) {
      await d.guard.release(auth.reservation, 'no route');
      await d.alerts.send('warn', 'burn_no_route', `No route to buy the coin (Jupiter and pump.fun): ${(err2 as Error).message}`);
      return { status: 'failed', spentLamports: 0n, burnedRaw: 0n, reason: 'no route' };
    }
  }

  const [held] = await d.chain.getTokenAccounts([{ owner: d.fund, mint: coin.mint, tokenProgram: coin.tokenProgram }]);
  const leftover = d.store.mode === 'live' ? (held?.amount ?? 0n) : 0n;
  const burnAmount = leftover + build.minOutAmount;
  const burnId = await d.store.burns.insert({ status: 'pending', reservedLamports: amount, reserveLedgerId: auth.reservation.ledgerId, coinDecimals: coin.decimals, tokensBurnedRaw: burnAmount });
  const reservation: Reservation = { ...auth.reservation, refId: String(burnId) };
  const fundKp = await d.keys.fund();
  const r = await d.sender.execute({
    request: {
      kind: 'burn',
      label: `buy + burn #${burnId}`,
      feePayer: fundKp,
      signers: [],
      instructions: [
        ...build.instructions,
        d.pump.buildBurnInstruction({ owner: d.fund, mint: coin.mint, amount: burnAmount, decimals: coin.decimals, tokenProgram: coin.tokenProgram }),
        ...(tipIx ? [tipIx] : []),
      ],
      lookupTables: build.lookupTables,
      computeUnitLimit: c.computeUnitLimitSwap,
      // the fund signs Jupiter's instructions: it may spend this chunk (swap + fees + rent + tip) and nothing more
      limits: { solOut: [{ account: d.fund, maxLamports: amount }] },
    },
    reservation,
    ref: { type: 'burn', id: String(burnId) },
  });
  const burn = (await d.store.burns.get(burnId))!;
  return finish(d, burn, reservation, r, burnAmount, coin.decimals);
}
