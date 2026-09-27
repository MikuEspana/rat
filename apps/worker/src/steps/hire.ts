// Hire (right after each claim). Budget = hire bucket of the ledger. Each new rat:
//   fresh keypair (encrypted + stored before anything is sent) -> spend reservation (SpendGuard)
//   -> Jupiter /build (taker = rat, payer = creator)
//   -> price deviation check vs the Price API -> rat row -> ONE tx: creator sends salary, rat buys its stock.
// Safety rules of the state machine:
//   - an attempt is recorded before sending; a rat is never retried while an attempt can still land
//   - before any retry the rat's wallet is read on-chain: if it already holds the stock it is simply activated
//   - reservations are settled with the real cost (fee-agnostic) or released when the tx definitely did not land
// HIRE_MODE=two_step: tx 1 funds the rat, tx 2 (signed and paid by the rat) buys the stock.
import {
  NATIVE_SOL_MINT,
  SETTINGS,
  type Pubkey,
  type SwapBuild,
  type TxOutcome,
  type TxRecord,
  avatarSeedFor,
  formatSol,
  hireWeights,
  lamportsToSol,
  pickWeighted,
  ratName,
  solDelta,
  tokenOwnerDelta,
} from '@rat/core';
import type { RatRow, StockRow } from '@rat/db';
import type { GuardedResult, Reservation } from '@rat/safety';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import type { WorkerDeps, WorkerState } from '../deps';
import { solUsd } from './prices';

export const MAX_HIRE_ATTEMPTS = 5;

export interface HireResult {
  hired: number;
  attempted: number;
  retried: number;
  gaveUp: number;
  blocked?: string;
  skipped?: string;
}

interface Amounts {
  /** SOL the creator sends to the rat */
  transfer: bigint;
  /** SOL the rat swaps into its stock */
  swap: bigint;
}

function amounts(d: WorkerDeps): Amounts {
  const c = d.config;
  if (c.hireMode === 'two_step') {
    // The rat pays its own token account rent and fees out of the overhead allowance.
    return { transfer: c.salaryLamports, swap: c.salaryLamports - c.hireOverheadEstLamports - c.ratBufferLamports };
  }
  // The creator pays fee + rent (Jupiter `payer`) out of the overhead allowance.
  const transfer = c.salaryLamports - c.hireOverheadEstLamports;
  return { transfer, swap: transfer - c.ratBufferLamports };
}

function isEligible(d: WorkerDeps, st: StockRow): boolean {
  const fresh = st.priceAt !== null && d.clock.now().getTime() - st.priceAt.getTime() <= d.config.priceStaleSec * 1000;
  return (
    st.enabled &&
    st.verified &&
    st.status === 'active' &&
    st.priceUsd !== null &&
    fresh &&
    st.decimals !== null &&
    st.tokenProgram !== null &&
    (d.store.mode === 'paper' || st.approved)
  );
}

export async function eligibleStocks(d: WorkerDeps): Promise<StockRow[]> {
  return (await d.store.stocks.list()).filter((st) => isEligible(d, st));
}

type Built = { ok: true; build: SwapBuild } | { ok: false; reason: string };

async function buildSwap(d: WorkerDeps, s: WorkerState, wallet: Pubkey, stock: StockRow, a: Amounts): Promise<Built> {
  const sol = await solUsd(d, s);
  if (sol === null) return { ok: false, reason: 'no SOL price' };
  let build: SwapBuild;
  try {
    build = await d.swap.build({
      inputMint: NATIVE_SOL_MINT,
      outputMint: stock.mint,
      amount: a.swap,
      taker: wallet,
      payer: d.config.hireMode === 'single' ? d.creator : wallet,
      slippageBps: d.config.slippageBpsStock,
    });
  } catch (err) {
    return { ok: false, reason: `no route: ${(err as Error).message}` };
  }
  const outUi = (Number(build.outAmount) / 10 ** stock.decimals!) * stock.uiMultiplier;
  const implied = ((Number(a.swap) / 1e9) * sol) / outUi;
  const deviationPct = ((implied - stock.priceUsd!) / stock.priceUsd!) * 100;
  if (deviationPct > d.config.maxPriceImpactPct) {
    return { ok: false, reason: `price deviation ${deviationPct.toFixed(2)}% > ${d.config.maxPriceImpactPct}%` };
  }
  return { ok: true, build };
}

function reservationOf(rat: RatRow): Reservation | null {
  if (rat.reserveLedgerId === null) return null;
  return { ledgerId: rat.reserveLedgerId, bucket: 'hire', lamports: rat.salaryLamports, refType: 'rat_wallet', refId: rat.wallet };
}

/** Marker reservation for the second tx of a two-step hire (the spend was already booked with tx 1). */
function prefunded(rat: RatRow): Reservation {
  return { ledgerId: 0, bucket: 'hire', lamports: 0n, refType: 'rat_wallet', refId: rat.wallet };
}

async function activate(
  d: WorkerDeps,
  s: WorkerState,
  rat: RatRow,
  stock: StockRow,
  args: { sig: string | null; tokens: bigint; swapped: bigint },
): Promise<void> {
  const sol = (await solUsd(d, s)) ?? 0;
  const costUsd = (Number(args.swapped) / 1e9) * sol;
  await d.store.rats.activate(rat.id, {
    hireSig: args.sig ?? '',
    solSwappedLamports: args.swapped,
    tokenAmountRaw: args.tokens,
    tokenDecimals: stock.decimals ?? 0,
    costUsd,
    solUsdAtHire: sol,
    hiredAt: d.clock.now(),
  });
  await d.store.rats.update(rat.id, { reserveLedgerId: null });
  await d.store.events.append({
    type: 'hire',
    txSig: args.sig,
    data: {
      ratId: rat.id,
      ratName: ratName(rat.id),
      wallet: rat.wallet,
      stock: stock.symbol,
      salarySol: lamportsToSol(rat.salaryLamports),
      costUsd: Math.round(costUsd * 100) / 100,
    },
  });
}

/** Creator lamports spent in a landed tx (transfer + rent + fee). */
function creatorSpent(d: WorkerDeps, record: TxRecord): bigint {
  const spent = -solDelta(record, d.creator);
  return spent > 0n ? spent : 0n;
}

type Step = 'hired' | 'funded' | 'pending' | 'retry_later' | 'failed';

async function handleOutcome(
  d: WorkerDeps,
  s: WorkerState,
  rat: RatRow,
  stock: StockRow,
  reservation: Reservation,
  r: GuardedResult,
  a: Amounts,
  expectedOut: bigint | null,
  phase: 'single' | 'fund' | 'swap',
): Promise<Step> {
  const releaseIfReal = async (note: string) => {
    if (reservation.ledgerId > 0) await d.guard.release(reservation, note);
    await d.store.rats.update(rat.id, { reserveLedgerId: null });
  };
  if (r.status !== 'done') {
    await releaseIfReal(r.reason);
    d.log.warn({ rat: rat.id, reason: r.reason }, 'hire not sent');
    return 'retry_later';
  }
  const out: TxOutcome = r.outcome;
  if (out.status === 'simulated') {
    if (out.error) d.log.debug({ rat: rat.id, err: out.error }, 'paper hire simulation error (ignored for paper accounting)');
    if (phase === 'fund') {
      await d.store.rats.update(rat.id, { funded: true, reserveLedgerId: null });
      return 'funded';
    }
    if (reservation.ledgerId > 0) await d.guard.settle(reservation, d.config.salaryLamports);
    await activate(d, s, rat, stock, { sig: out.signature, tokens: expectedOut ?? 0n, swapped: a.swap });
    return 'hired';
  }
  if (out.status === 'confirmed' && out.record) {
    if (phase === 'fund') {
      await d.guard.settle(reservation, creatorSpent(d, out.record));
      await d.store.rats.update(rat.id, { funded: true, reserveLedgerId: null });
      return 'funded';
    }
    if (reservation.ledgerId > 0) await d.guard.settle(reservation, creatorSpent(d, out.record));
    const tokens = tokenOwnerDelta(out.record, rat.wallet, stock.mint);
    if (tokens <= 0n) {
      await d.alerts.send('critical', `hire_no_tokens_${rat.id}`, `Hire tx ${out.signature} confirmed but rat ${rat.id} received no tokens.`);
      await d.store.rats.update(rat.id, { status: 'failed', reserveLedgerId: null });
      return 'failed';
    }
    await activate(d, s, rat, stock, { sig: out.signature, tokens, swapped: a.swap });
    return 'hired';
  }
  if (out.status === 'unknown') return 'pending';
  // failed or expired: the hire did not happen
  if (out.record && reservation.ledgerId > 0) {
    await d.guard.settle(reservation, creatorSpent(d, out.record));
    await d.store.rats.update(rat.id, { reserveLedgerId: null });
  } else {
    await releaseIfReal(`${out.status}: ${out.error ?? ''}`);
  }
  d.log.warn({ rat: rat.id, status: out.status, err: out.error }, 'hire attempt failed');
  return 'retry_later';
}

async function sendHire(
  d: WorkerDeps,
  s: WorkerState,
  rat: RatRow,
  stock: StockRow,
  reservation: Reservation,
  build: SwapBuild | null,
): Promise<Step> {
  const a = amounts(d);
  const creatorKp = await d.keys.creator();
  const ratKp = await d.keys.ratSigner(rat.wallet);
  const ref = { type: 'rat', id: String(rat.id) };

  if (d.config.hireMode === 'two_step') {
    if (!rat.funded) {
      await d.store.rats.incrementAttempts(rat.id);
      const r1 = await d.sender.execute({
        request: {
          kind: 'hire',
          label: `fund ${ratName(rat.id)}`,
          feePayer: creatorKp,
          signers: [],
          instructions: [SystemProgram.transfer({ fromPubkey: creatorKp.publicKey, toPubkey: ratKp.publicKey, lamports: a.transfer })],
          computeUnitLimit: 50_000,
        },
        reservation,
        ref,
      });
      const step = await handleOutcome(d, s, rat, stock, reservation, r1, a, null, 'fund');
      if (step !== 'funded') return step;
      rat = (await d.store.rats.get(rat.id))!;
    }
    let swapBuild = build;
    if (!swapBuild) {
      const b = await buildSwap(d, s, rat.wallet, stock, a);
      if (!b.ok) return 'retry_later';
      swapBuild = b.build;
    }
    await d.store.rats.incrementAttempts(rat.id);
    const r2 = await d.sender.execute({
      request: {
        kind: 'hire',
        label: `buy ${ratName(rat.id)}`,
        feePayer: ratKp,
        signers: [],
        instructions: swapBuild.instructions,
        lookupTables: swapBuild.lookupTables,
        computeUnitLimit: d.config.computeUnitLimitSwap,
      },
      reservation: prefunded(rat),
      ref,
    });
    return handleOutcome(d, s, rat, stock, prefunded(rat), r2, a, swapBuild.outAmount, 'swap');
  }

  if (!build) return 'retry_later';
  await d.store.rats.incrementAttempts(rat.id);
  const r = await d.sender.execute({
    request: {
      kind: 'hire',
      label: `hire ${ratName(rat.id)}`,
      feePayer: creatorKp,
      signers: [ratKp],
      instructions: [SystemProgram.transfer({ fromPubkey: creatorKp.publicKey, toPubkey: new PublicKey(rat.wallet), lamports: a.transfer }), ...build.instructions],
      lookupTables: build.lookupTables,
      computeUnitLimit: d.config.computeUnitLimitSwap,
    },
    reservation,
    ref,
  });
  return handleOutcome(d, s, rat, stock, reservation, r, a, build.outAmount, 'single');
}

/** Continues a rat stuck in `hiring` (crash, unknown status, failed attempt). */
async function resumeHire(d: WorkerDeps, s: WorkerState, rat: RatRow, stocks: Map<string, StockRow>): Promise<Step | 'waiting' | 'gave_up'> {
  const stock = stocks.get(rat.stockMint);
  if (!stock) return 'waiting';
  const a = amounts(d);
  const latest = await d.store.attempts.latestForRef('rat', String(rat.id));
  if (latest && (latest.status === 'pending' || latest.status === 'unknown' || latest.status === 'confirmed')) {
    const st = await d.sender.status(latest.signature, latest.lastValidBlockHeight);
    await d.store.attempts.finish(latest.id, { status: st.status, error: st.error, feeLamports: st.feeLamports });
    if (st.status === 'unknown') return 'waiting';
    const reservation = reservationOf(rat) ?? prefunded(rat);
    const phase = d.config.hireMode === 'two_step' && !rat.funded ? 'fund' : d.config.hireMode === 'two_step' ? 'swap' : 'single';
    const step = await handleOutcome(d, s, rat, stock, reservation, { status: 'done', outcome: st, prepared: null as never, attemptId: latest.id }, a, null, phase);
    if (step === 'hired' || step === 'pending') return step;
    rat = (await d.store.rats.get(rat.id))!;
    if (step === 'funded') return sendHire(d, s, rat, stock, prefunded(rat), null);
  }

  if (rat.hireAttempts >= MAX_HIRE_ATTEMPTS) {
    const res = reservationOf(rat);
    if (res) await d.guard.release(res, 'gave up');
    await d.store.rats.update(rat.id, { status: 'failed', reserveLedgerId: null });
    await d.alerts.send('warn', `hire_gave_up_${rat.id}`, `Gave up hiring rat ${rat.id} (${rat.wallet}) after ${rat.hireAttempts} attempts.`);
    return 'gave_up';
  }

  // Live: never retry blindly. If the wallet already holds the stock, a previous attempt landed.
  if (d.store.mode === 'live' && stock.tokenProgram) {
    const [acct] = await d.chain.getTokenAccounts([{ owner: rat.wallet, mint: stock.mint, tokenProgram: stock.tokenProgram }]);
    if (acct && acct.amount > 0n) {
      const res = reservationOf(rat);
      if (res) await d.guard.settle(res, d.config.salaryLamports);
      await activate(d, s, rat, stock, { sig: latest?.signature ?? null, tokens: acct.amount, swapped: a.swap });
      return 'hired';
    }
  }

  if (!isEligible(d, stock)) return 'waiting';
  const kill = await d.killSwitch.status();
  if (kill.on) return 'waiting';

  let reservation = reservationOf(rat);
  if (!reservation && !(d.config.hireMode === 'two_step' && rat.funded)) {
    const auth = await d.guard.authorize({ bucket: 'hire', lamports: rat.salaryLamports, refType: 'rat_wallet', refId: rat.wallet });
    if (!auth.ok) return 'waiting';
    reservation = auth.reservation;
    await d.store.rats.update(rat.id, { reserveLedgerId: reservation.ledgerId });
  }
  const b = await buildSwap(d, s, rat.wallet, stock, a);
  if (!b.ok) {
    if (reservation && reservation.ledgerId > 0 && !(d.config.hireMode === 'two_step' && rat.funded)) {
      await d.guard.release(reservation, b.reason);
      await d.store.rats.update(rat.id, { reserveLedgerId: null });
    }
    return 'waiting';
  }
  return sendHire(d, s, rat, stock, reservation ?? prefunded(rat), b.build);
}

/**
 * Money sitting idle: no rat hired for HIRE_IDLE_ALERT_MIN minutes while the hire budget is above
 * HIRE_IDLE_ALERT_SOL (for example on a weekend when stock prices go stale). The kill switch is not idle money.
 */
async function checkIdle(d: WorkerDeps, res: HireResult): Promise<void> {
  const cfg = d.config.hireIdleAlert;
  const budget = await d.store.ledger.balance('hire');
  const idle = res.hired === 0 && budget > cfg.lamports && res.skipped !== 'kill_switch';
  const since = await d.store.settings.get(SETTINGS.hireIdleSince);
  if (!idle) {
    if (since) await d.store.settings.set(SETTINGS.hireIdleSince, '');
    return;
  }
  const now = d.clock.now();
  if (!since) {
    await d.store.settings.set(SETTINGS.hireIdleSince, now.toISOString());
    return;
  }
  const minutes = (now.getTime() - new Date(since).getTime()) / 60_000;
  if (minutes >= cfg.minutes) {
    const why = res.skipped ?? res.blocked ?? (res.attempted > 0 ? 'hire transactions did not confirm' : 'no hire attempted');
    await d.alerts.send(
      'warn',
      'hire_idle',
      `No rat hired for ${Math.round(minutes)} min while ${formatSol(budget)} SOL waits in the hire budget. Reason: ${why}. Check stock prices (weekend?), approvals and rat status.`,
    );
  }
}

export async function runHireStep(d: WorkerDeps, s: WorkerState): Promise<HireResult> {
  const res = await hire(d, s);
  await checkIdle(d, res);
  return res;
}

async function hire(d: WorkerDeps, s: WorkerState): Promise<HireResult> {
  const res: HireResult = { hired: 0, attempted: 0, retried: 0, gaveUp: 0 };
  let slots = d.config.maxHiresPerLoop;
  const allStocks = new Map((await d.store.stocks.list()).map((st) => [st.mint, st]));

  // 1. rats already in flight
  for (const rat of await d.store.rats.listByStatus(['hiring'])) {
    if (slots <= 0) break;
    const step = await resumeHire(d, s, rat, allStocks);
    if (step === 'waiting') continue;
    if (step === 'gave_up') {
      res.gaveUp++;
      continue;
    }
    slots--;
    res.retried++;
    if (step === 'hired') res.hired++;
  }

  // 2. new rats
  const kill = await d.killSwitch.status();
  if (kill.on) return { ...res, skipped: 'kill_switch' };
  const stocks = await eligibleStocks(d);
  if (stocks.length === 0) {
    await d.alerts.send('warn', 'no_eligible_stocks', 'No stock is eligible for hires (approved + mint verified + active + fresh price).');
    return { ...res, skipped: 'no eligible stocks' };
  }
  if ((await solUsd(d, s)) === null) return { ...res, skipped: 'no SOL price' };
  const bySymbol = new Map(stocks.map((st) => [st.mint, st]));
  const weights = hireWeights(stocks.map((st) => ({ key: st.mint, change24hPct: st.change24hPct })), d.config.minStockWeightBps);
  const a = amounts(d);

  while (slots > 0) {
    if ((await d.store.ledger.balance('hire')) < d.config.salaryLamports) break;
    const mint = pickWeighted(weights, d.rng);
    if (!mint) break;
    const stock = bySymbol.get(mint)!;
    // the key is stored encrypted (and read back) before this returns: a crash after sending never loses it
    const wallet = await d.keys.newRatKey();
    const auth = await d.guard.authorize({ bucket: 'hire', lamports: d.config.salaryLamports, refType: 'rat_wallet', refId: wallet });
    if (!auth.ok) {
      await d.keys.discardRatKey(wallet);
      res.blocked = auth.reason;
      break;
    }
    const b = await buildSwap(d, s, wallet, stock, a);
    if (!b.ok) {
      await d.guard.release(auth.reservation, b.reason);
      await d.keys.discardRatKey(wallet);
      weights.set(mint, 0);
      d.log.warn({ stock: stock.symbol, reason: b.reason }, 'skipping stock this loop');
      if ([...weights.values()].every((w) => w === 0)) {
        res.skipped = `every stock failed the route or price check (last: ${stock.symbol}: ${b.reason})`;
        break;
      }
      continue;
    }
    const rat = await d.store.rats.create({ wallet, stockMint: mint, salaryLamports: d.config.salaryLamports, avatarSeed: avatarSeedFor(wallet) });
    await d.store.rats.update(rat.id, { reserveLedgerId: auth.reservation.ledgerId });
    const fresh = (await d.store.rats.get(rat.id))!;
    slots--;
    res.attempted++;
    const step = await sendHire(d, s, fresh, stock, auth.reservation, b.build);
    if (step === 'hired') res.hired++;
  }
  if (res.hired > 0) d.log.info({ hired: res.hired, budgetLeft: formatSol(await d.store.ledger.balance('hire')) }, 'hired rats');
  return res;
}
