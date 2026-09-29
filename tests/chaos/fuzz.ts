// Randomized chaos run (in-memory only, SimChain in live mode). One seed = one launch: fee bursts, strangers
// claiming our vault, transactions dropped / failed / timing out, RPC, database and Jupiter outages, stocks with
// no route or no price, price shocks, the worker killed mid-operation (a crash mid-send), a stalled worker waking
// up after its replacement took the lease (a redeploy overlap), a transaction signed by the creator key that the
// bot did not send (a key leak), and random hourly caps. Every process runs behind the real single-worker lease
// and send fence, like production (apps/worker/src/main.ts).
//
// Invariants, checked after EVERY loop:
//   - the creator's own SOL is never spent (only the fee of a claim that landed with an error can come out of it)
//   - the rolling-hour hire outflow never exceeds the hourly cap
//   - SOL spent never exceeds SOL claimed
//   - once the kill switch is on, nothing more is sent
//   - after a creator-signed transaction the bot did not send, the kill switch is on within 3 healthy loops
// and once everything has settled (40 calm loops): the full money check against the chain (every lamport that
// left our vaults credited exactly once, ledger = chain to the lamport, no rat wallet funded twice) and no rat
// left half hired (unless the kill switch stopped it).
import { LIVE_CONFIRM_PHRASE, NATIVE_SOL_MINT } from '@rat/core';
import type { Store } from '@rat/db';
import { JupiterError } from '@rat/jupiter';
import { collectCreatorFeeV2Ix } from '@rat/pump';
import { LockedRunner, SOL, type SimWorld, type Worker, type WorkerDeps, type WorldParts, createSimWorld, createWorker } from '@rat/worker';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { expect } from 'vitest';
import { type MoneyStart, checkMoney } from '../e2e/money-check';

type OpKind = 'db' | 'rpc' | 'jupiter';
const LOOP_SEC = 35;
const HOUR_MS = 3_600_000;
const CALM_LOOPS = 40;
/** an hour of loops */
const HOUR_LOOPS = Math.ceil(HOUR_MS / 1000 / LOOP_SEC);

/** mulberry32: the plan's own random numbers (the world has its own seeded rng for prices and failures) */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Outages shared by every process (the RPC, the database and Jupiter are outside the process). */
class Outside {
  readonly down = new Set<OpKind>();
  /** stock mints Jupiter has no route for */
  readonly noRoute = new Set<string>();
}

/** One worker process: its dependencies wrapped so it can be killed (hangs forever) or stalled (resumes later). */
class Proc {
  ops = 0;
  dead = false;
  /** hang forever at this operation (a crash); 0 = never */
  killAt = 0;
  /** stall at this operation until `resume()` (a frozen container); 0 = never */
  stallAt = 0;
  private gate: Promise<void> | null = null;
  private open: () => void = () => {};
  private signal: () => void = () => {};
  /** resolves when the process died or stalled */
  readonly stopped = new Promise<void>((r) => (this.signal = r));
  readonly deps: WorkerDeps;
  readonly worker: Worker;
  readonly runner: LockedRunner;

  constructor(
    w: SimWorld,
    private readonly outside: Outside,
    readonly name: string,
  ) {
    this.deps = w.rebuildDeps(this.parts(w));
    this.worker = createWorker(this.deps);
    this.runner = new LockedRunner(this.worker, { store: this.deps.store, clock: this.deps.clock, holder: name });
    this.deps.sender.setFence(() => this.runner.fence());
  }

  /** stopped at a stalled operation, waiting for resume() */
  get stalled(): boolean {
    return this.gate !== null;
  }

  resume(): void {
    this.gate = null;
    this.open();
  }

  private wrap<T extends object>(obj: T, kind: OpKind, label: string): T {
    const p = this;
    return new Proxy(obj, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function' || prop === 'constructor') return value;
        return (...args: unknown[]) => {
          if (p.dead) return new Promise(() => {});
          p.ops++;
          if (p.killAt > 0 && p.ops === p.killAt) {
            p.dead = true;
            p.signal();
            return new Promise(() => {});
          }
          const call = () => {
            if (p.outside.down.has(kind)) {
              return Promise.reject(kind === 'jupiter' ? new JupiterError('rate limited (429)', 429, 'chaos') : new Error(`${kind} down: ${label}.${String(prop)}`));
            }
            if (kind === 'jupiter' && label === 'swap' && p.outside.noRoute.has((args[0] as { outputMint: string }).outputMint)) {
              return Promise.reject(new Error('no route (chaos)'));
            }
            return value.apply(target, args);
          };
          if (p.stallAt > 0 && p.ops === p.stallAt) {
            p.gate = new Promise<void>((r) => (p.open = r));
            p.signal();
            return p.gate.then(call);
          }
          return call();
        };
      },
    });
  }

  private wrapStore(store: Store): Store {
    const cache = new Map<PropertyKey, unknown>();
    const p = this;
    return new Proxy(store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        // the repositories only: the raw handle and the clock are not outside calls
        if (prop === 'db' || prop === 'clock' || value === null || typeof value !== 'object') return value;
        if (!cache.has(prop)) cache.set(prop, p.wrap(value as object, 'db', String(prop)));
        return cache.get(prop);
      },
    });
  }

  private parts(w: SimWorld): WorldParts {
    return {
      store: this.wrapStore(w.store),
      reader: this.wrap(w.reader, 'rpc', 'chain'),
      sender: this.wrap(w.simSender, 'rpc', 'send'),
      swap: this.wrap(w.swap, 'jupiter', 'swap'),
      prices: this.wrap(w.prices, 'jupiter', 'prices'),
    };
  }

  /** One scheduler tick behind the lease; errors are the scheduler's (a failed lease read is just a lost tick). */
  tick(): Promise<unknown> {
    return this.runner.tryTick().catch(() => undefined);
  }
}

export interface FuzzReport {
  seed: number;
  loops: number;
  hireMode: string;
  capSol: number;
  crashes: number;
  stalls: number;
  outages: number;
  ownerTx: boolean;
  killed: boolean;
  rats: number;
  claimed: bigint;
  spent: bigint;
}

/** Runs one randomized launch. Throws (an expect failure) on any broken invariant. */
export async function fuzzLaunch(seed: number, trace?: (line: string) => void): Promise<FuzzReport> {
  const log = (i: number, msg: string) => trace?.(`[${i}] ${msg}`);
  const r = prng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const hireMode = pick(['single', 'two_step'] as const);
  const capSol = pick([0.05, 0.2, 1, 60]);
  const loops = int(20, 90);
  const w = await createSimWorld({
    dryRun: false,
    seed,
    creatorSol: pick([SOL / 10n, SOL / 2n, 2n * SOL]),
    env: {
      LIVE_CONFIRM: LIVE_CONFIRM_PHRASE,
      HIRE_MODE: hireMode,
      MAX_HIRES_PER_LOOP: String(pick([1, 3, 6, 20])),
      SPEND_CAP_SOL_PER_HOUR_HIRE: String(capSol),
      // like production: scripts/launch.sh sets the watch floor to the launch slot (SimChain starts at slot 1000)
      WATCH_FROM_SLOT: '1000',
    },
  });
  const report: FuzzReport = { seed, loops, hireMode, capSol, crashes: 0, stalls: 0, outages: 0, ownerTx: false, killed: false, rats: 0, claimed: 0n, spent: 0n };
  try {
    const creator = w.creator.publicKey.toBase58();
    const start: MoneyStart = { creator: w.chain.sol(creator), accrued: 0n };
    const stranger = Keypair.generate();
    w.chain.fundAccount(stranger.publicKey.toBase58(), SOL);
    const outside = new Outside();
    const outageLeft = new Map<OpKind, number>();
    const stocks = [...w.stockMints.values()];
    const missing = new Map<string, number>();
    const noRouteLeft = new Map<string, number>();
    let procs: Proc[] = [];
    let seq = 0;
    const spawn = () => {
      const p = new Proc(w, outside, `p${++seq}`);
      procs.push(p);
      return p;
    };
    spawn();

    let ownerTxAt = -1;
    let healthySinceOwnerTx = 0;
    let attemptsAtKill: number | null = null;
    const liveAttempts = async () => (await w.store.db.query.txAttempts.findMany({ where: (a, { eq }) => eq(a.mode, 'live') })).length;
    const failedClaimFees = async () => {
      let fees = 0n;
      for (const a of await w.store.db.query.txAttempts.findMany({ where: (x, { and, eq }) => and(eq(x.mode, 'live'), eq(x.kind, 'claim')) })) {
        const rec = w.chain.transaction(a.signature);
        if (rec?.err) fees += rec.feeLamports;
      }
      return fees;
    };
    const cap = BigInt(Math.round(capSol * 1e9));

    const check = async (i: number) => {
      const at = `seed ${seed} loop ${i}`;
      expect(w.chain.sol(creator), `${at}: the creator's own SOL was spent`).toBeGreaterThanOrEqual(start.creator - (await failedClaimFees()));
      const hourOut = await w.store.ledger.netOutflowSince('hire', new Date(w.clock.now().getTime() - HOUR_MS));
      expect(hourOut, `${at}: hourly cap exceeded`).toBeLessThanOrEqual(cap);
      const totals = await w.store.claims.totals();
      expect(await w.store.ledger.netOutflowSince('hire', new Date(0)), `${at}: spent more than claimed`).toBeLessThanOrEqual(totals.hireShare);
      const kill = await w.deps.killSwitch.status();
      const n = await liveAttempts();
      if (kill.on) {
        if (attemptsAtKill === null) attemptsAtKill = n;
        else expect(n, `${at}: sent after the kill switch was on (${kill.reason})`).toBe(attemptsAtKill);
      }
      // healthy = nothing outside is down AND a live worker holds the lease (after a crash the new one waits up
      // to 120 s for the dead one's lease: detection then takes that long, by design)
      const lease = await w.store.locks.holder('worker');
      const holder = procs.find((p) => p.name === lease?.holder);
      if (ownerTxAt >= 0 && outside.down.size === 0 && holder && !holder.dead && !holder.stalled) {
        healthySinceOwnerTx++;
        if (healthySinceOwnerTx >= 3) expect(kill.on, `${at}: kill switch not on after a creator-signed transaction the bot did not send`).toBe(true);
      }
    };

    const advance = () => {
      w.clock.advanceSeconds(LOOP_SEC);
      w.chain.advanceBlocks(90);
      w.prices.step(w.rng);
    };

    for (let i = 0; i < loops; i++) {
      // ---- the outside world changes
      if (r() < 0.3) {
        const bonding = r() < 0.8 ? BigInt(Math.floor(r() * 2e9)) : BigInt(Math.floor(r() * 5e7));
        const amm = r() < 0.3 ? BigInt(Math.floor(r() * 1e9)) : 0n;
        w.accrue({ bondingLamports: bonding, ammLamports: amm });
        start.accrued += bonding + amm;
        log(i, `accrue bonding ${bonding} amm ${amm}`);
        if (bonding > 0n && r() < 0.15) {
          const req = { kind: 'claim' as const, label: 'stranger', feePayer: stranger, signers: [], instructions: [collectCreatorFeeV2Ix(creator)], computeUnitLimit: 200_000 };
          const out = await w.simSender.submit(await w.simSender.prepare(req));
          log(i, `stranger claim ${out.status} ${out.signature}`);
        }
      }
      if (r() < 0.1) {
        w.simSender.clearFailures();
        const rate = pick([0, 0.1, 0.3, 0.6]);
        if (rate > 0) w.simSender.setRandomFailures(rate, w.rng);
        log(i, `tx failure rate ${rate}`);
      }
      for (const kind of ['rpc', 'db', 'jupiter'] as const) {
        const left = outageLeft.get(kind) ?? 0;
        if (left > 0) {
          outageLeft.set(kind, left - 1);
          if (left === 1) outside.down.delete(kind);
        } else if (r() < (kind === 'jupiter' ? 0.05 : 0.03)) {
          outside.down.add(kind);
          outageLeft.set(kind, int(1, kind === 'jupiter' ? 10 : 5));
          report.outages++;
          log(i, `${kind} down for ${outageLeft.get(kind)} loops`);
        }
      }
      if (r() < 0.05) {
        const mint = pick([...stocks, NATIVE_SOL_MINT]);
        const now = w.prices.price(mint)!;
        w.prices.set(mint, now * (0.4 + r() * 1.2), { vol: 0.003 });
      }
      if (r() < 0.03) {
        const mint = pick(stocks);
        w.prices.setMissing(mint, true);
        missing.set(mint, int(1, 6));
      }
      if (r() < 0.03) {
        const mint = pick(stocks);
        outside.noRoute.add(mint);
        noRouteLeft.set(mint, int(1, 8));
      }
      for (const [mint, left] of missing) {
        if (left <= 1) {
          w.prices.setMissing(mint, false);
          missing.delete(mint);
        } else missing.set(mint, left - 1);
      }
      for (const [mint, left] of noRouteLeft) {
        if (left <= 1) {
          outside.noRoute.delete(mint);
          noRouteLeft.delete(mint);
        } else noRouteLeft.set(mint, left - 1);
      }
      if (ownerTxAt < 0 && i > 3 && r() < 0.01) {
        // the creator key signs something the bot did not send (a leaked key draining the wallet)
        const req = {
          kind: 'sweep' as const,
          label: 'leak',
          feePayer: w.creator,
          signers: [],
          instructions: [SystemProgram.transfer({ fromPubkey: w.creator.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1_000_000 })],
          computeUnitLimit: 200_000,
        };
        const before = w.chain.sol(creator);
        const out = await w.simSender.submit(await w.simSender.prepare(req));
        if (out.status === 'confirmed' || out.status === 'failed') {
          start.creator -= before - w.chain.sol(creator); // not the bot's money: take it out of the owner's start
          ownerTxAt = i;
          report.ownerTx = true;
          log(i, `leaked-key tx ${out.status}`);
        }
      }

      // ---- the worker processes run
      const live = procs.filter((p) => !p.dead);
      const cur = live[live.length - 1]!;
      const event = r();
      if (event < 0.04) {
        // crash mid-operation, then a new container starts (it waits for the dead one's lease to expire)
        cur.killAt = cur.ops + int(1, 60);
        await Promise.race([cur.tick(), cur.stopped]);
        if (cur.dead) {
          report.crashes++;
          log(i, `${cur.name} crashed at op ${cur.killAt}`);
          spawn();
        } else cur.killAt = 0;
      } else if (event < 0.06 && live.length === 1) {
        // the container freezes mid-operation; a replacement takes over; then the old one wakes up
        cur.stallAt = cur.ops + int(1, 60);
        let finished = false;
        const first = cur.tick().then(() => {
          finished = true;
        });
        await Promise.race([first, cur.stopped]);
        cur.stallAt = 0;
        const next = spawn();
        if (!finished) {
          report.stalls++;
          log(i, `${cur.name} stalled at op ${cur.ops}`);
          const waits = int(1, 6);
          for (let k = 0; k < waits; k++) {
            advance();
            await next.tick();
          }
          cur.resume();
          await Promise.all([first, next.tick()]);
        }
        // the old container either stops now or keeps running next to the new one (only the lease holder works)
        if (finished || r() < 0.5) cur.dead = true;
      } else {
        await Promise.all(live.map((p) => p.tick()));
      }
      await check(i);
      advance();
    }

    // ---- calm: every outage ends, old processes stop, a fresh one settles everything
    outside.down.clear();
    outside.noRoute.clear();
    for (const mint of missing.keys()) w.prices.setMissing(mint, false);
    w.simSender.clearFailures();
    for (const p of procs) p.dead = true;
    procs = [];
    const last = spawn();
    // a small hourly cap can hold the last hires back for up to an hour: keep going until they are done
    const salary = w.deps.config.salaryLamports;
    for (let i = 0; i < CALM_LOOPS + HOUR_LOOPS; i++) {
      await last.tick();
      await check(loops + i);
      advance();
      if (i >= CALM_LOOPS && ((await w.store.rats.listByStatus(['hiring'])).length === 0 || (await w.deps.killSwitch.status()).on)) break;
      if (i >= CALM_LOOPS && (await w.deps.guard.remainingCap('hire')) >= salary && (await w.store.ledger.balance('hire')) < salary) break;
    }

    if (trace) {
      // the end state, to read a failing seed (CHAOS_TRACE=1)
      const big = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
      trace(`kill switch ${big(await w.deps.killSwitch.status())}, hire budget ${await w.store.ledger.balance('hire')}, cap left ${await w.deps.guard.remainingCap('hire')}`);
      for (const c of await w.store.claims.all()) trace(`claim ${c.id} ${c.source} ${c.status} ${c.claimedLamports}`);
      for (const a of await w.store.db.query.txAttempts.findMany({ where: (x, { eq }) => eq(x.kind, 'claim') })) {
        const rec = w.chain.transaction(a.signature);
        trace(`claim attempt for #${a.refId}: ${a.status}, on chain ${rec ? (rec.err ? 'with an error' : 'ok') : 'no'}`);
      }
      for (const h of await w.store.heartbeats.all()) if (h.lastError) trace(`loop ${h.loop}: ${h.lastError}`);
      for (const rat of await w.store.rats.listByStatus(['hiring'])) trace(`rat still hiring ${big(rat)}`);
    }
    await checkMoney(w, start);
    const kill = await w.deps.killSwitch.status();
    report.killed = kill.on;
    if (!kill.on) {
      // a rat may wait in line only while the budget cannot pay its salary, or the rolling-hour cap has no room for
      // one (a small cap hires about one rat an hour: seeds 306 and 1790 at 0.05 SOL end with two in line after the
      // calm hour): no reservation, no SOL sent to it
      const waiting = await w.store.rats.listByStatus(['hiring']);
      const budgetShort = (await w.store.ledger.balance('hire')) < salary;
      const capShort = (await w.deps.guard.remainingCap('hire')) < salary;
      for (const rat of waiting) {
        const inLine = (budgetShort || capShort) && rat.reserveLedgerId === null && !rat.funded && w.chain.sol(rat.wallet) === 0n;
        expect(inLine, `seed ${seed} (cap ${capSol}): rat ${rat.id} left half hired`).toBe(true);
      }
    }
    if (report.ownerTx) expect(kill.on, `seed ${seed}: kill switch off after a leaked-key transaction`).toBe(true);
    const totals = await w.store.claims.totals();
    report.claimed = totals.claimed;
    report.spent = await w.store.ledger.netOutflowSince('hire', new Date(0));
    report.rats = (await w.store.rats.listByStatus(['active', 'frozen'])).length;
    return report;
  } finally {
    await w.close();
  }
}
