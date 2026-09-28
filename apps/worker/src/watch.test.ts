// Coin launch vs the wallet watch: owner transactions before the watch floor (or allowlisted) never trip the
// kill switch; anything else signed by a bot wallet still does. In memory only (SimChain).
import type { ChainReader } from '@rat/core';
import { collectCreatorFeeV2Ix } from '@rat/pump';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';
import { runPreflight } from './preflight';
import { SOL, type SimWorld, createSimWorld } from './sim-world';
import { runMintStep } from './steps/mints';
import { runPriceStep } from './steps/prices';
import { runWatchStep } from './steps/watch';

let w: SimWorld;
afterEach(async () => w?.close());

/** A transaction the OWNER signs with the creator wallet (like the coin launch), not sent by the bot. */
async function ownerTx(world: SimWorld): Promise<string> {
  const req = {
    kind: 'claim' as const,
    label: 'owner',
    feePayer: world.creator,
    signers: [],
    instructions: [SystemProgram.transfer({ fromPubkey: world.creator.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1_000_000 })],
    computeUnitLimit: 50_000,
  };
  const out = await world.simSender.submit(await world.simSender.prepare(req));
  expect(out.status).toBe('confirmed');
  return out.signature;
}

/** Someone else triggers the claim of our creator vault (permissionless). */
async function externalClaim(world: SimWorld): Promise<void> {
  const stranger = Keypair.generate();
  world.chain.fundAccount(stranger.publicKey.toBase58(), SOL);
  world.accrue({ bondingLamports: SOL });
  const req = { kind: 'claim' as const, label: 'x', feePayer: stranger, signers: [], instructions: [collectCreatorFeeV2Ix(world.creator.publicKey.toBase58())], computeUnitLimit: 200_000 };
  expect((await world.simSender.submit(await world.simSender.prepare(req))).status).toBe('confirmed');
}

async function killSwitchOn(world: SimWorld): Promise<boolean> {
  return (await world.deps.killSwitch.status()).on;
}

describe('coin launch vs the wallet watch', () => {
  it('the launch tx never trips the kill switch, even when the RPC indexes it after the first live run', async () => {
    w = await createSimWorld({ dryRun: false });
    await runPriceStep(w.deps, w.worker.state);
    await runMintStep(w.deps);
    const launch = await ownerTx(w);
    w.chain.advanceBlocks(50);
    // RPC lag: the launch signature is missing from the first listing
    let first = true;
    const reader = w.deps.chain;
    const lagging: ChainReader = Object.assign(Object.create(Object.getPrototypeOf(reader)), reader, {
      getSignaturesSince: async (address: string, until: string | null, limit?: number) => {
        const all = await reader.getSignaturesSince(address, until, limit);
        if (!first) return all;
        first = false;
        return all.filter((s) => s.signature !== launch);
      },
    });
    w.deps.chain = lagging;
    await runWatchStep(w.deps); // first live run: sets the floor at the current slot
    const second = await runWatchStep(w.deps);
    expect(second.beforeFloor).toBe(1);
    expect(second.unknownSigned).toBe(0);
    expect(await killSwitchOn(w)).toBe(false);

    // the protection is still on for anything after the floor
    w.chain.advanceBlocks(5);
    await ownerTx(w);
    expect((await runWatchStep(w.deps)).unknownSigned).toBe(1);
    expect(await killSwitchOn(w)).toBe(true);
  });

  it('WATCH_FROM_SLOT: everything before it is ignored, everything after is booked or checked', async () => {
    w = await createSimWorld({ dryRun: false, env: { WATCH_FROM_SLOT: '1100' } });
    await runPriceStep(w.deps, w.worker.state);
    await runMintStep(w.deps);
    await ownerTx(w); // the launch, at slot 1000
    w.chain.advanceBlocks(100); // slot 1100
    await externalClaim(w); // someone claims our vault after the launch, before the worker went live
    const r = await runWatchStep(w.deps);
    expect(r).toMatchObject({ beforeFloor: 1, externalClaims: 1, unknownSigned: 0 });
    expect(await w.store.ledger.balance('hire')).toBe(SOL);
    expect(await killSwitchOn(w)).toBe(false);
  });

  it('KNOWN_OWNER_TX_SIGS: an allowlisted owner tx after the floor is accepted; an unlisted one still kills', async () => {
    w = await createSimWorld({ dryRun: false });
    await runWatchStep(w.deps);
    w.chain.advanceBlocks(10);
    const allowed = await ownerTx(w);
    w.deps.config.knownOwnerTxSigs.push(allowed);
    const r = await runWatchStep(w.deps);
    expect(r).toMatchObject({ ownerKnown: 1, unknownSigned: 0 });
    expect(await killSwitchOn(w)).toBe(false);
    expect(w.alerts.keys()).toContain(`owner_tx_${allowed}`);
    await ownerTx(w);
    expect((await runWatchStep(w.deps)).unknownSigned).toBe(1);
    expect(await killSwitchOn(w)).toBe(true);
  });
});

describe('preflight: WATCH_FROM_SLOT', () => {
  it('refuses to start LIVE when WATCH_FROM_SLOT is ahead of the chain (it would hide a key leak)', async () => {
    w = await createSimWorld({ dryRun: false, env: { WATCH_FROM_SLOT: '5000000' } });
    const r = await runPreflight(w.deps);
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatchObject({ check: 'watch_from_slot', blocking: true });
    expect(r.issues[0]!.message).toMatch(/ahead of the current slot 1000/);
  });

  it('only warns in DRY RUN; a sane value passes', async () => {
    w = await createSimWorld({ dryRun: true, env: { WATCH_FROM_SLOT: '5000000' } });
    const dry = await runPreflight(w.deps);
    expect(dry.ok).toBe(true);
    expect(dry.issues[0]).toMatchObject({ check: 'watch_from_slot', blocking: false });
    await w.close();
    w = await createSimWorld({ dryRun: false, env: { WATCH_FROM_SLOT: '1000' } });
    expect((await runPreflight(w.deps)).issues.filter((i) => i.check === 'watch_from_slot')).toEqual([]);
  });
});
