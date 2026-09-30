// The mainnet rehearsal (docs/runbooks/rehearsal.md), end to end on SimChain in LIVE mode with STAGING on:
// launch with a 0.1 SOL dev buy, claims of real creator fees, a seed, 5 hires at the real salary, a burst of 10 under
// a 0.1 SOL/h cap with the worker killed right after one hire was broadcast, the kill switch tripped by an unexpected
// creator transaction, and `rat audit` proving the ledger equals the chain to the lamport. Same budget as the plan.
import { runAudit } from '@rat/cli';
import { type PreparedTx, SETTINGS, type TxOutcome, type TxSender, formatSol } from '@rat/core';
import { markStagingDatabase } from '@rat/db';
import { PumpFunClient } from '@rat/pump';
import { SOL, type SimWorld, createSimWorld, createWorker, runClaimStep, runMintStep, runPriceStep, runWatchStep } from '@rat/worker';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';

let w: SimWorld | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

async function ownerTx(world: SimWorld, lamports: bigint): Promise<string> {
  const req = {
    kind: 'claim' as const,
    label: 'owner',
    feePayer: world.creator,
    signers: [],
    instructions: [SystemProgram.transfer({ fromPubkey: world.creator.publicKey, toPubkey: Keypair.generate().publicKey, lamports })],
    computeUnitLimit: 50_000,
  };
  const out = await world.simSender.submit(await world.simSender.prepare(req));
  expect(out.status).toBe('confirmed');
  return out.signature;
}

/** Books seeded SOL exactly like `rat staging-seed` (which has its own tests in apps/cli). */
async function seed(world: SimWorld, lamports: bigint): Promise<void> {
  await world.store.ledger.append({ bucket: 'hire', deltaLamports: lamports, reason: 'seed_credit', refType: 'staging_seed', note: 'rehearsal seed, not a creator fee' });
}

async function loops(world: SimWorld, n: number, worker = world.worker): Promise<void> {
  for (let i = 0; i < n; i++) {
    await worker.tick();
    world.clock.advanceSeconds(35);
    world.chain.advanceBlocks(90);
  }
}

const active = async (world: SimWorld) => (await world.store.rats.listByStatus(['active'])).length;
const audit = (world: SimWorld) => runAudit({ store: world.store, chain: world.reader, pump: new PumpFunClient(world.reader), creator: world.creator.publicKey.toBase58() });

describe('mainnet rehearsal on SimChain (LIVE, STAGING)', () => {
  it('every phase passes and rat audit shows the ledger equals the chain', async () => {
    w = await createSimWorld({ dryRun: false, seed: 7, creatorSol: 470_000_000n, env: { STAGING: 'true', MIN_CLAIM_SOL: '0.0003' } });
    const creator = w.creator.publicKey.toBase58();
    expect(await markStagingDatabase(w.store, w.deps.config)).toBe('marked');
    await runPriceStep(w.deps, w.worker.state);
    await runMintStep(w.deps);

    // phase 1: the launch with a 0.1 SOL dev buy, listed in KNOWN_OWNER_TX_SIGS: never a fee, never a kill
    const launch = await ownerTx(w, SOL / 10n);
    w.deps.config.knownOwnerTxSigs.push(launch);
    await runWatchStep(w.deps);
    expect((await w.deps.killSwitch.status()).on).toBe(false);
    expect((await w.store.ledger.sumByReason()).get('hire:claim_credit') ?? 0n).toBe(0n);

    // phase 2: small trades make about 0.0009 SOL of creator fees; the claim books exactly that
    w.accrue({ bondingLamports: 900_000n });
    expect((await runClaimStep(w.deps, w.worker.state)).status).toBe('claimed');
    expect((await w.store.claims.totals()).claimed).toBe(900_000n);
    expect((await audit(w)).find((l) => l.check === 'claims')?.status).toBe('PASS');

    // phase 3: seed 0.14 SOL, 5 rats at the real 0.03 SOL salary (each costs a bit less: the unused overhead stays in the budget)
    await seed(w, 140_000_000n);
    await loops(w, 3);
    expect(await active(w)).toBe(5);
    expect((await w.store.claims.totals()).claimed, 'the seed is never a claim').toBe(900_000n);

    // phase 4 + 5: a burst at 0.01 SOL under a 0.05 SOL/h cap; the worker dies right after burst hire 3 is broadcast
    w.clock.advanceSeconds(3_700); // the phase 3 hires leave the rolling hour
    w.deps.config.salaryLamports = SOL / 100n;
    const cap = SOL / 20n;
    w.deps.config.spendCapLamportsPerHour.hire = cap;
    await seed(w, 125_000_000n);
    let hires = 0;
    let died!: () => void;
    const dead = new Promise<void>((r) => (died = r));
    const crashing: TxSender = {
      prepare: (req) => w!.simSender.prepare(req),
      simulate: (tx) => w!.simSender.simulate(tx),
      status: (sig, h) => w!.simSender.status(sig, h),
      simulateEffects: (tx, l) => w!.simSender.simulateEffects(tx, l),
      async submit(tx: PreparedTx): Promise<TxOutcome> {
        if (tx.request.kind === 'hire' && ++hires === 3) {
          await w!.simSender.submit(tx); // broadcast and landed...
          died(); // ...and the process is gone before it hears back
          return new Promise<TxOutcome>(() => undefined);
        }
        return w!.simSender.submit(tx);
      },
    };
    void createWorker(w.rebuildDeps({ sender: crashing })).tick();
    await dead;
    expect(await active(w)).toBe(7); // 5 + burst hires 1 and 2; hire 3 landed but is not booked yet
    expect(await w.store.rats.listByStatus(['hiring'])).toHaveLength(1);
    const restarted = createWorker(w.rebuildDeps());
    await loops(w, 3, restarted);
    // the cap: hiring pauses with alerts, and the last hour's spending never passes the cap
    const hourAgo = () => new Date(w!.clock.now().getTime() - 3_600_000);
    const capped = await active(w);
    expect(capped).toBeGreaterThan(7);
    expect(w.alerts.keys()).toEqual(expect.arrayContaining(['cap_alert_hire', 'cap_reached_hire']));
    expect(await w.store.ledger.netOutflowSince('hire', hourAgo())).toBeLessThanOrEqual(cap);
    await loops(w, 2, restarted);
    expect(await active(w), 'no hire while capped').toBe(capped);
    w.deps.config.spendCapLamportsPerHour.hire = SOL;
    await loops(w, 4, restarted);
    const burst = (await active(w)) - 5;
    expect(burst).toBeGreaterThanOrEqual(10);
    expect(await w.store.rats.listByStatus(['hiring', 'failed'])).toEqual([]);
    expect(await w.store.ledger.balance('hire'), 'the budget left is less than one hire').toBeLessThan(SOL / 100n + w.deps.config.hireOverheadEstLamports);

    // the audit: claims, every rat paid once, creator SOL equals the ledger to the lamport
    const lines = await audit(w);
    expect(lines.map((l) => `${l.status} ${l.check}`)).toEqual(['PASS claims', 'PASS rats', 'PASS money']);
    expect(lines.find((l) => l.check === 'money')?.detail).toContain('seeded 0.265 SOL kept apart');

    // phase 6: an unexpected creator transaction trips the kill switch with a critical alert; nothing is sent after
    await ownerTx(w, 1_000_000n);
    await runWatchStep(w.deps);
    expect((await w.deps.killSwitch.status()).on).toBe(true);
    expect(w.alerts.sent.some((a) => a.level === 'critical')).toBe(true);
    const attemptsBefore = (await w.store.attempts.all()).length;
    await seed(w, 20_000_000n);
    await loops(w, 2, restarted);
    expect((await w.store.attempts.all()).length).toBe(attemptsBefore);
    expect(await w.store.settings.get(SETTINGS.stagingMarker)).toBe(`staging:${creator}`);
    console.log(`rehearsal: ${await active(w)} rats, claimed ${formatSol((await w.store.claims.totals()).claimed)} SOL, audit ${lines.map((l) => l.status).join('/')}`);
  }, 300_000);

  it('the audit catches a ledger that disagrees with the chain', async () => {
    w = await createSimWorld({ dryRun: false, seed: 8, env: { STAGING: 'true' } });
    await runPriceStep(w.deps, w.worker.state);
    await runMintStep(w.deps);
    await runWatchStep(w.deps);
    w.accrue({ bondingLamports: SOL / 5n });
    await loops(w, 3);
    expect((await audit(w)).every((l) => l.status === 'PASS')).toBe(true);
    const [rat] = await w.store.rats.listByStatus(['active']);
    await w.store.rats.update(rat!.id, { tokenAmountRaw: (rat!.tokenAmountRaw ?? 0n) + 1n });
    await w.store.ledger.append({ bucket: 'hire', deltaLamports: 1n, reason: 'hire_release' });
    const lines = await audit(w);
    expect(lines.find((l) => l.check === 'rats')).toMatchObject({ status: 'FAIL', detail: expect.stringMatching(/database says/) });
    expect(lines.find((l) => l.check === 'money')).toMatchObject({ status: 'FAIL', detail: expect.stringMatching(/off by/) });
  }, 300_000);
});
