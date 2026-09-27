// Red-team tests (SECURITY-REVIEW.md): each test is one attack or failure on a money path, run against the
// in-memory SimChain in live mode. Nothing here can reach mainnet.
import { type SwapBuild, type SwapBuildRequest, TOKEN_2022_PROGRAM } from '@rat/core';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkerState } from './deps';
import { SOL, type SimWorld, createSimWorld } from './sim-world';
import { runBurnStep } from './steps/burn';
import { runClaimStep } from './steps/claim';
import { runHireStep } from './steps/hire';
import { runMintStep } from './steps/mints';
import { runPriceStep } from './steps/prices';
import { WATCH_RECORDS_PER_LOOP, runWatchStep } from './steps/watch';
import { LockedRunner } from './worker';

let w: SimWorld;
afterEach(async () => w?.close());

async function liveWorld(env: Record<string, string> = {}, claimSol = SOL): Promise<SimWorld> {
  w = await createSimWorld({ dryRun: false, env });
  await runPriceStep(w.deps, w.worker.state);
  await runMintStep(w.deps);
  if (claimSol > 0n) {
    w.accrue({ bondingLamports: claimSol });
    expect((await runClaimStep(w.deps, w.worker.state)).status).toBe('claimed');
  }
  return w;
}

const sol = (world: SimWorld, kp: Keypair | string) => world.chain.sol(typeof kp === 'string' ? kp : kp.publicKey.toBase58());

/** A Jupiter that has been compromised: `tamper` rewrites every build. */
function compromiseJupiter(world: SimWorld, tamper: (b: SwapBuild, req: SwapBuildRequest) => Promise<SwapBuild> | SwapBuild) {
  const honest = world.deps.swap;
  world.deps.swap = { build: async (req) => tamper(await honest.build(req), req) };
  return () => {
    world.deps.swap = honest;
  };
}

/** Makes the next submit land on-chain and then hang forever: the process is "killed" mid-send. */
function killDuringNextSubmit(world: SimWorld): Promise<void> {
  const sim = world.simSender;
  const honest = sim.submit.bind(sim);
  return new Promise((landed) => {
    sim.submit = async (p) => {
      await honest(p);
      sim.submit = honest;
      landed();
      return new Promise(() => {});
    };
  });
}

describe('red team: compromised Jupiter API (live, SimChain)', () => {
  it('an extra instruction draining the creator is refused; nothing is sent, the reservation comes back', async () => {
    await liveWorld();
    const thief = Keypair.generate().publicKey;
    const hireBudget = await w.store.ledger.balance('hire');
    const creatorBefore = sol(w, w.creator);
    const restore = compromiseJupiter(w, (b) => ({
      ...b,
      instructions: [...b.instructions, SystemProgram.transfer({ fromPubkey: w.creator.publicKey, toPubkey: thief, lamports: 50_000_000 })],
    }));
    const submittedBefore = w.simSender.submitted;
    const r = await runHireStep(w.deps, w.worker.state);
    expect(r.hired).toBe(0);
    expect(w.simSender.submitted).toBe(submittedBefore);
    expect(w.chain.sol(thief.toBase58())).toBe(0n);
    expect(sol(w, w.creator)).toBe(creatorBefore);
    expect(await w.store.ledger.balance('hire')).toBe(hireBudget);
    expect(w.alerts.sent.some((a) => a.key === 'effects_hire' && a.level === 'critical')).toBe(true);
    // once Jupiter is honest again the waiting rats are hired normally
    restore();
    const again = await runHireStep(w.deps, w.worker.state);
    expect(again.hired).toBeGreaterThan(0);
    expect(w.chain.sol(thief.toBase58())).toBe(0n);
  });

  it('a swap that delivers less than the quoted minimum is refused (rat token check)', async () => {
    await liveWorld();
    compromiseJupiter(w, async (b, req) => {
      // the instructions buy a tenth of what the quote promises
      const small = await w.swap.build({ ...req, amount: req.amount / 10n });
      return { ...b, instructions: small.instructions };
    });
    const r = await runHireStep(w.deps, w.worker.state);
    expect(r.hired).toBe(0);
    expect(w.alerts.sent.find((a) => a.key === 'effects_hire')?.text).toMatch(/needs at least/);
    for (const rat of await w.store.rats.listByStatus(['hiring', 'active'])) {
      expect(w.chain.tokenBalance(rat.wallet, rat.stockMint, TOKEN_2022_PROGRAM)).toBe(0n);
    }
  });

  it('a burn build that also drains the fund is refused; the burn budget is intact', async () => {
    await liveWorld();
    const thief = Keypair.generate().publicKey;
    const budget = await w.store.ledger.balance('burn');
    const fundBefore = sol(w, w.fund);
    compromiseJupiter(w, (b) => ({
      ...b,
      instructions: [...b.instructions, SystemProgram.transfer({ fromPubkey: w.fund.publicKey, toPubkey: thief, lamports: 5_000_000 })],
    }));
    const r = await runBurnStep(w.deps, w.worker.state);
    expect(r.status).toBe('failed');
    expect(w.chain.sol(thief.toBase58())).toBe(0n);
    expect(sol(w, w.fund)).toBe(fundBefore);
    expect(await w.store.ledger.balance('burn')).toBe(budget);
    expect(w.alerts.sent.some((a) => a.key === 'effects_burn')).toBe(true);
  });
});

describe('red team: crash and RPC failure windows', () => {
  it('burn: worker killed after the tx landed but before the burn row got its signature; the restart books it, never re-credits', async () => {
    await liveWorld();
    const fundBefore = sol(w, w.fund);
    const budget = await w.store.ledger.balance('burn');
    const landed = killDuringNextSubmit(w);
    void runBurnStep(w.deps, w.worker.state); // never finishes: the process "died" mid-send
    await landed;
    const spent = fundBefore - sol(w, w.fund);
    expect(spent).toBeGreaterThan(0n);

    // restart: fresh in-memory state, same database
    const r = await runBurnStep(w.deps, new WorkerState());
    expect(r.status).toBe('skipped'); // the budget was spent by the landed burn: nothing left to burn
    expect((await w.store.burns.listByStatus(['confirmed'])).length).toBe(1);
    expect(await w.store.ledger.balance('burn')).toBe(budget - spent);
    // the fund's own SOL (its reserve and starting balance) was never touched
    expect(sol(w, w.fund)).toBe(fundBefore - spent);
  });

  it('claim: worker killed mid-send; the restart credits the claim exactly once', async () => {
    await liveWorld({}, 0n);
    w.accrue({ bondingLamports: SOL });
    const landed = killDuringNextSubmit(w);
    void runClaimStep(w.deps, w.worker.state);
    await landed;
    expect(await w.store.ledger.balance('burn')).toBe(0n);
    await runClaimStep(w.deps, new WorkerState());
    expect(await w.store.ledger.balance('burn')).toBe(SOL / 2n);
    await runClaimStep(w.deps, new WorkerState());
    expect((await w.store.claims.totals()).claimed).toBe(SOL);
  });

  it('hire: the RPC fails while waiting for confirmation of a landed hire; the budget is not re-credited', async () => {
    await liveWorld({ MAX_HIRES_PER_LOOP: '1' });
    const hireBudget = await w.store.ledger.balance('hire');
    const creatorBefore = sol(w, w.creator);
    const sim = w.simSender;
    const honest = sim.submit.bind(sim);
    sim.submit = async (p) => {
      await honest(p);
      sim.submit = honest;
      throw new Error('fetch failed: getSignatureStatuses 503');
    };
    const first = await runHireStep(w.deps, w.worker.state);
    expect(first.hired).toBe(0);
    const [rat] = await w.store.rats.listByStatus(['hiring']);
    expect(rat?.reserveLedgerId).not.toBeNull(); // reservation kept while the tx may have landed
    await runHireStep(w.deps, w.worker.state);
    const active = await w.store.rats.get(rat!.id);
    expect(active?.status).toBe('active');
    // exactly one salary (at most) left the ledger for exactly what left the creator wallet for this rat
    const creatorSpent = creatorBefore - sol(w, w.creator);
    const hires = (await w.store.rats.listByStatus(['active'])).length;
    expect(await w.store.ledger.balance('hire')).toBe(hireBudget - creatorSpent);
    expect(creatorSpent).toBeLessThanOrEqual(BigInt(hires) * w.deps.config.salaryLamports);
  });
});

describe('red team: claims', () => {
  it('a claim that may still land blocks the next one (the fund share is never forwarded twice)', async () => {
    await liveWorld({}, 0n);
    w.accrue({ bondingLamports: SOL });
    const fundBefore = sol(w, w.fund);
    const sim = w.simSender;
    const honest = sim.submit.bind(sim);
    sim.submit = async () => {
      sim.submit = honest;
      throw new Error('socket hang up'); // never broadcast, but we cannot know that
    };
    expect((await runClaimStep(w.deps, w.worker.state)).status).toBe('pending');
    const sent = sim.submitted;
    expect(await runClaimStep(w.deps, w.worker.state)).toMatchObject({ status: 'skipped', reason: 'previous claim unresolved' });
    expect(sim.submitted).toBe(sent);
    // once its blockhash expired, the open claim is closed and the next claim goes out
    w.chain.advanceBlocks(500);
    expect((await runClaimStep(w.deps, w.worker.state)).status).toBe('claimed');
    expect(sol(w, w.fund) - fundBefore).toBe(SOL / 2n);
    expect(await w.store.claims.pendingFundTransfer()).toBe(0n);
  });
});

describe('red team: wallet watch', () => {
  it('a FAILED transaction signed by our creator key still trips the kill switch (the key has leaked)', async () => {
    await liveWorld({}, 0n);
    await runWatchStep(w.deps);
    const thief = Keypair.generate().publicKey;
    w.simSender.failNext('fail');
    const req = { kind: 'claim' as const, label: 'x', feePayer: w.creator, signers: [], instructions: [SystemProgram.transfer({ fromPubkey: w.creator.publicKey, toPubkey: thief, lamports: 1 })], computeUnitLimit: 1 };
    expect((await w.simSender.submit(await w.simSender.prepare(req))).status).toBe('failed');
    expect((await runWatchStep(w.deps)).unknownSigned).toBe(1);
    expect((await w.deps.killSwitch.status()).on).toBe(true);
  });

  it('dust spam: one alert key per wallet, every transfer checked, none skipped', async () => {
    await liveWorld({}, 0n);
    await runWatchStep(w.deps);
    const spammer = Keypair.generate();
    w.chain.fundAccount(spammer.publicKey.toBase58(), SOL);
    const n = WATCH_RECORDS_PER_LOOP + 50;
    for (let i = 0; i < n; i++) {
      const req = { kind: 'claim' as const, label: 'dust', feePayer: spammer, signers: [], instructions: [SystemProgram.transfer({ fromPubkey: spammer.publicKey, toPubkey: w.creator.publicKey, lamports: 1 })], computeUnitLimit: 1 };
      await w.simSender.submit(await w.simSender.prepare(req));
    }
    const first = await runWatchStep(w.deps);
    expect(first.unexplainedInflows).toBe(WATCH_RECORDS_PER_LOOP); // fetch budget per loop
    const second = await runWatchStep(w.deps);
    expect(first.unexplainedInflows + second.unexplainedInflows).toBe(n);
    expect(new Set(w.alerts.keys().filter((k) => k.startsWith('inflow_')))).toEqual(new Set(['inflow_creator']));
    expect(await w.store.ledger.balance('hire')).toBe(0n); // never credited
  });

  it('a key-leak tx hidden behind 1,100 dust transfers is still caught (no page is skipped)', async () => {
    await liveWorld({}, 0n);
    await runWatchStep(w.deps);
    const thief = Keypair.generate().publicKey;
    const steal = { kind: 'claim' as const, label: 'x', feePayer: w.creator, signers: [], instructions: [SystemProgram.transfer({ fromPubkey: w.creator.publicKey, toPubkey: thief, lamports: 1_000 })], computeUnitLimit: 1 };
    await w.simSender.submit(await w.simSender.prepare(steal));
    const spammer = Keypair.generate();
    w.chain.fundAccount(spammer.publicKey.toBase58(), SOL);
    for (let i = 0; i < 1_100; i++) {
      const req = { ...steal, feePayer: spammer, instructions: [SystemProgram.transfer({ fromPubkey: spammer.publicKey, toPubkey: w.creator.publicKey, lamports: 1 })] };
      await w.simSender.submit(await w.simSender.prepare(req));
    }
    expect((await runWatchStep(w.deps)).unknownSigned).toBe(1);
    expect((await w.deps.killSwitch.status()).on).toBe(true);
  });
});

describe('red team: two workers', () => {
  it('a worker whose lease was taken over (long tick, redeploy) sends nothing more', async () => {
    await liveWorld({}, 0n);
    const a = new LockedRunner(w.worker, { store: w.store, clock: w.clock, holder: 'A', ttlSec: 120 });
    w.deps.sender.setFence(() => a.fence());
    expect(await a.fence()).toBe(true);
    // A's tick runs long; its lease expires and B takes over
    w.clock.advanceSeconds(200);
    expect(await w.store.locks.acquire('worker', 'B', w.clock.now(), 120)).toBe(true);
    w.accrue({ bondingLamports: SOL });
    const sent = w.simSender.submitted;
    const r = await runClaimStep(w.deps, w.worker.state);
    expect(r).toMatchObject({ status: 'failed', reason: expect.stringMatching(/lease_lost/) });
    expect(w.simSender.submitted).toBe(sent);
  });
});

describe('red team: two-step hires never cost more than the salary', () => {
  it('the funding tx fee comes out of the salary (it used to be paid on top)', async () => {
    await liveWorld({ HIRE_MODE: 'two_step', MAX_HIRES_PER_LOOP: '3' });
    const budget = await w.store.ledger.balance('hire');
    const creatorBefore = sol(w, w.creator);
    const r = await runHireStep(w.deps, w.worker.state);
    expect(r.hired).toBe(3);
    const spent = creatorBefore - sol(w, w.creator);
    expect(spent).toBeLessThanOrEqual(3n * w.deps.config.salaryLamports);
    expect(await w.store.ledger.balance('hire')).toBe(budget - spent);
    expect(w.alerts.keys().some((k) => k.startsWith('overspend_'))).toBe(false);
    for (const rat of await w.store.rats.listByStatus(['active'])) {
      expect(w.chain.sol(rat.wallet)).toBeGreaterThanOrEqual(w.deps.config.ratBufferLamports);
      expect(new PublicKey(rat.wallet).toBase58()).toBe(rat.wallet);
    }
  });
});
