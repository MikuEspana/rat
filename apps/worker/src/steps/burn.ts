// Buy and burn (every ~10 min). Spendable = min(burn bucket, fund wallet - reserve). Under MIN_BURN_SOL it
// is skipped. The swap uses spendable minus the tx overhead allowance, so fees never touch the fund's own SOL. One tx signed by the fund wallet: Jupiter SOL -> coin, then BurnChecked of the guaranteed
// minimum output plus any leftover coin from earlier rounds. Fallback: direct pump.fun buy.
// Profits never go to holders: the only way they leave is this buy and burn.
import { NATIVE_SOL_MINT, SETTINGS, type SwapBuild, formatSol, lamportsToSol, minBig, rawToDecimalString, solDelta } from '@rat/core';
import type { BurnRow } from '@rat/db';
import type { GuardedResult, Reservation } from '@rat/safety';
import type { WorkerDeps, WorkerState } from '../deps';

export interface BurnResult {
  status: 'skipped' | 'burned' | 'paper' | 'failed' | 'pending';
  spentLamports: bigint;
  burnedRaw: bigint;
  reason?: string;
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
  for (const b of await d.store.burns.listByStatus(['pending', 'unknown'])) {
    const res = reservationOf(b);
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

export async function runBurnStep(d: WorkerDeps, _s: WorkerState): Promise<BurnResult> {
  await d.store.settings.set(SETTINGS.lastBurnRunAt, d.clock.now().toISOString());
  if (!d.config.coinMint) return { status: 'skipped', spentLamports: 0n, burnedRaw: 0n, reason: 'COIN_MINT not set' };
  const kill = await d.killSwitch.status();
  if (kill.on) return { status: 'skipped', spentLamports: 0n, burnedRaw: 0n, reason: 'kill_switch' };
  await reconcileOpenBurns(d);

  let spendable = await d.store.ledger.balance('burn');
  if (d.store.mode === 'live') {
    const sol = (await d.chain.getSolBalances([d.fund])).get(d.fund) ?? 0n;
    spendable = minBig(spendable, sol - d.config.fundReserveLamports);
  }
  if (spendable < d.config.minBurnLamports) {
    return { status: 'skipped', spentLamports: 0n, burnedRaw: 0n, reason: `under ${formatSol(d.config.minBurnLamports)} SOL (have ${formatSol(spendable > 0n ? spendable : 0n)})` };
  }

  const coin = await d.pump.getCoinInfo(d.config.coinMint);
  const auth = await d.guard.authorize({ bucket: 'burn', lamports: spendable, refType: 'burn', refId: `burn@${d.clock.now().toISOString()}` });
  if (!auth.ok) return { status: 'skipped', spentLamports: 0n, burnedRaw: 0n, reason: auth.reason };

  // Fees and the fund's coin account rent come out of the reservation too: only claimed money is spent.
  const swapAmount = spendable - d.config.hireOverheadEstLamports;
  const req = { inputMint: NATIVE_SOL_MINT, outputMint: coin.mint, amount: swapAmount, taker: d.fund, slippageBps: d.config.slippageBpsCoin };
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
  const burnId = await d.store.burns.insert({ status: 'pending', reservedLamports: spendable, reserveLedgerId: auth.reservation.ledgerId, coinDecimals: coin.decimals, tokensBurnedRaw: burnAmount });
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
      ],
      lookupTables: build.lookupTables,
      computeUnitLimit: d.config.computeUnitLimitSwap,
    },
    reservation,
    ref: { type: 'burn', id: String(burnId) },
  });
  const burn = (await d.store.burns.get(burnId))!;
  return finish(d, burn, reservation, r, burnAmount, coin.decimals);
}
