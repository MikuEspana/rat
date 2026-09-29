// Red-team tests (SECURITY-REVIEW.md): each test is one attack or failure on a money path, run against the
// in-memory SimChain in live mode. Nothing here can reach mainnet.
import { ASSOCIATED_TOKEN_PROGRAM, type SwapBuild, type SwapBuildRequest, TOKEN_2022_PROGRAM } from '@rat/core';
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkerState } from './deps';
import { SOL, type SimWorld, createSimWorld } from './sim-world';
import { runClaimStep } from './steps/claim';
import { runHireStep } from './steps/hire';
import { runMintStep } from './steps/mints';
import { runPriceStep } from './steps/prices';
import { WATCH_RECORDS_PER_LOOP, runWatchStep } from './steps/watch';
import { LeaseLostError, fenceWrites } from './fenced-store';
import { LockedRunner, createWorker } from './worker';

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

const ataProgram = new PublicKey(ASSOCIATED_TOKEN_PROGRAM);
const ata = (owner: PublicKey, mint: PublicKey, program: PublicKey) => PublicKey.findProgramAddressSync([owner.toBuffer(), program.toBuffer(), mint.toBuffer()], ataProgram)[0];
/** Token TransferChecked (instruction 12), built by hand. */
function transferCheckedIx(from: PublicKey, mint: PublicKey, to: PublicKey, owner: PublicKey, amount: bigint, decimals: number, program: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(amount, 1);
  data[9] = decimals;
  const keys = [
    { pubkey: from, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: to, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: true, isWritable: false },
  ];
  return new TransactionInstruction({ programId: program, keys, data });
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

  it('an extra instruction moving the dev-buy coins out of the creator wallet is refused (SECURITY-REVIEW A3)', async () => {
    await liveWorld();
    const creator = w.creator.publicKey;
    const coin = new PublicKey(w.coinMint);
    const devBuy = 35_000_000n * 1_000_000n; // the coins bought at launch, kept in the creator wallet forever
    w.chain.setTokenBalance(creator.toBase58(), w.coinMint, devBuy, TOKEN_2022_PROGRAM);
    const thief = Keypair.generate().publicKey;
    const program = new PublicKey(TOKEN_2022_PROGRAM);
    // the thief's account exists already, so the theft costs the creator no SOL at all (the SOL limit cannot see it)
    w.chain.setTokenBalance(thief.toBase58(), w.coinMint, 0n, TOKEN_2022_PROGRAM);
    compromiseJupiter(w, (b) => ({
      ...b,
      instructions: [...b.instructions, transferCheckedIx(ata(creator, coin, program), coin, ata(thief, coin, program), creator, devBuy, 6, program)],
    }));
    const submittedBefore = w.simSender.submitted;
    const r = await runHireStep(w.deps, w.worker.state);
    expect(r.hired).toBe(0);
    expect(w.simSender.submitted).toBe(submittedBefore);
    expect(w.chain.tokenBalance(creator.toBase58(), w.coinMint, TOKEN_2022_PROGRAM)).toBe(devBuy);
    expect(w.chain.tokenBalance(thief.toBase58(), w.coinMint, TOKEN_2022_PROGRAM)).toBe(0n);
    expect(w.alerts.sent.find((a) => a.key === 'effects_hire')?.text).toMatch(new RegExp(w.coinMint));
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
});

describe('red team: crash and RPC failure windows', () => {
  it('hire: worker killed after the tx landed but before it saw the result; the restart books it once, never funds twice', async () => {
    await liveWorld({ MAX_HIRES_PER_LOOP: '1' });
    const creatorBefore = sol(w, w.creator);
    const budget = await w.store.ledger.balance('hire');
    const landed = killDuringNextSubmit(w);
    void runHireStep(w.deps, w.worker.state); // never finishes: the process "died" mid-send
    await landed;
    const spent = creatorBefore - sol(w, w.creator);
    expect(spent).toBeGreaterThan(0n);
    expect(spent).toBeLessThanOrEqual(w.deps.config.salaryLamports);
    const [rat] = await w.store.rats.listByStatus(['hiring']);
    expect(rat).toBeDefined();
    const tokens = w.chain.tokenBalance(rat!.wallet, rat!.stockMint, TOKEN_2022_PROGRAM);
    expect(tokens).toBeGreaterThan(0n);

    // restart: fresh in-memory state, same database
    const r = await runHireStep(w.deps, new WorkerState());
    expect(r.retried).toBe(1);
    expect((await w.store.rats.get(rat!.id))?.status).toBe('active');
    // the landed hire is booked, never sent again: same tokens, one attempt, one salary
    expect(w.chain.tokenBalance(rat!.wallet, rat!.stockMint, TOKEN_2022_PROGRAM)).toBe(tokens);
    expect((await w.store.attempts.forRef('rat', String(rat!.id))).length).toBe(1);
    expect(w.chain.sol(rat!.wallet)).toBe(w.deps.config.ratBufferLamports);
    // the ledger moved by exactly what left the creator wallet: the creator's own SOL was never touched
    const creatorSpent = creatorBefore - sol(w, w.creator);
    expect(await w.store.ledger.balance('hire')).toBe(budget - creatorSpent);
    expect(w.alerts.keys().some((k) => k.startsWith('overspend_'))).toBe(false);
  });

  it('claim: worker killed mid-send; the restart credits the claim exactly once', async () => {
    await liveWorld({}, 0n);
    w.accrue({ bondingLamports: SOL });
    const landed = killDuringNextSubmit(w);
    void runClaimStep(w.deps, w.worker.state);
    await landed;
    expect(await w.store.ledger.balance('hire')).toBe(0n);
    await runClaimStep(w.deps, new WorkerState());
    const t = await w.store.claims.totals();
    expect(t).toMatchObject({ claimed: SOL, hireShare: SOL, count: 1 });
    expect(await w.store.ledger.balance('hire')).toBe(SOL - t.fee);
    await runClaimStep(w.deps, new WorkerState());
    expect(await w.store.claims.totals()).toEqual(t);
    expect(await w.store.ledger.balance('hire')).toBe(SOL - t.fee);
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
  it('a claim that may still land blocks the next one (a claim is never credited twice)', async () => {
    await liveWorld({}, 0n);
    w.accrue({ bondingLamports: SOL });
    const creatorBefore = sol(w, w.creator);
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
    const t = await w.store.claims.totals();
    expect(t).toMatchObject({ claimed: SOL, hireShare: SOL, count: 1 });
    expect(await w.store.ledger.balance('hire')).toBe(SOL - t.fee);
    // the whole claim stayed with the creator (minus the network fee): nothing was forwarded anywhere
    expect(sol(w, w.creator) - creatorBefore).toBe(SOL - t.fee);
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

  /** Worker A wired like production (main.ts): its sends AND its database writes prove the lease first. */
  const workerA = () => {
    let a: LockedRunner | null = null;
    const deps = w.rebuildDeps({ store: fenceWrites(w.store, () => a!.fence()) });
    a = new LockedRunner(createWorker(deps), { store: w.store, clock: w.clock, holder: 'A', ttlSec: 120 });
    deps.sender.setFence(() => a!.fence());
    return { a, deps };
  };
  const takeOver = async () => {
    w.clock.advanceSeconds(200); // A froze past its lease
    expect(await w.store.locks.acquire('worker', 'B', w.clock.now(), 120)).toBe(true);
  };

  it('a worker that woke up after losing the lease cannot release a reservation the new worker pays a hire with (chaos seed 2789)', async () => {
    await liveWorld();
    const { a, deps } = workerA();
    expect(await a.fence()).toBe(true);
    const wallet = Keypair.generate().publicKey.toBase58();
    const auth = await deps.guard.authorize({ bucket: 'hire', lamports: w.deps.config.salaryLamports, refType: 'rat_wallet', refId: wallet });
    if (!auth.ok) throw new Error(auth.reason);
    await takeOver();
    // A's send is fenced; the release it then made used to go through, and B's settle of the same reservation was
    // refused as a duplicate: the hire's SOL left the creator and never reached the ledger
    await expect(deps.guard.release(auth.reservation, 'lease_lost')).rejects.toBeInstanceOf(LeaseLostError);
    expect(await w.store.ledger.isOpen(auth.reservation.ledgerId)).toBe(true);
    await w.deps.guard.settle(auth.reservation, w.deps.config.salaryLamports - 10_000n);
    expect(await w.store.ledger.isOpen(auth.reservation.ledgerId)).toBe(false);
  });

  it('nor clear a rat\'s pointer to the new worker\'s reservation, which was then released as an orphan (chaos seed 2711)', async () => {
    await liveWorld();
    const { a, deps } = workerA();
    expect(await a.fence()).toBe(true);
    const rat = await w.store.rats.create({ wallet: Keypair.generate().publicKey.toBase58(), stockMint: 'mint', salaryLamports: w.deps.config.salaryLamports, avatarSeed: 'x' });
    await takeOver();
    const b = await w.deps.guard.authorize({ bucket: 'hire', lamports: w.deps.config.salaryLamports, refType: 'rat_wallet', refId: rat.wallet });
    if (!b.ok) throw new Error(b.reason);
    await w.store.rats.update(rat.id, { reserveLedgerId: b.reservation.ledgerId });
    // A, from the row it read before it froze, books the funding it sees confirmed
    await expect(deps.store.rats.update(rat.id, { funded: true, reserveLedgerId: null })).rejects.toBeInstanceOf(LeaseLostError);
    expect((await w.store.rats.get(rat.id))!.reserveLedgerId).toBe(b.reservation.ledgerId);
    // reads still work: a standby worker may look, never write
    expect(await deps.store.ledger.isOpen(b.reservation.ledgerId)).toBe(true);
  });

  it('a whole tick of a worker that lost the lease writes nothing: ledger, rats, attempts and claims unchanged', async () => {
    await liveWorld({}, 2n * SOL);
    const { a, deps } = workerA();
    expect(await a.fence()).toBe(true);
    await takeOver();
    w.accrue({ bondingLamports: SOL });
    const snapshot = async () => ({
      ledger: (await w.store.ledger.list(100_000)).length,
      rats: (await w.store.rats.countByStatus()),
      attempts: (await w.store.attempts.all()).length,
      claims: (await w.store.claims.all()).length,
    });
    const before = await snapshot();
    const sent = w.simSender.submitted;
    await runClaimStep(deps, new WorkerState()).catch(() => undefined);
    await runHireStep(deps, new WorkerState()).catch(() => undefined);
    expect(await snapshot()).toEqual(before);
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
